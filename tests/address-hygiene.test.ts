import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	checkAddressSync,
	hygieneMeta,
	isDisposableDomain,
	isRoleAddress,
	suggestDomain
} from '../src/lib/email-hygiene';
import {
	backfillState,
	clearMxCache,
	hygieneCounts,
	mxStatus,
	runHygieneBackfill,
	startHygieneBackfill,
	MX_TTL_MS,
	HYGIENE_INVALID_TAG
} from '../src/lib/server/hygiene';
import { parseFixes, previewImportHygiene } from '../src/lib/server/import-hygiene';
import { contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { actions as contactActions } from '../src/routes/contacts/+page.server';
import { POST as ingest } from '../src/routes/api/ingest/+server';
import { POST as upsert } from '../src/routes/api/contacts/upsert/+server';
import { POST as createContact } from '../src/routes/api/v1/contacts/+server';
import { generateApiKey } from '../src/lib/server/api-keys';

// #306: address hygiene at every entry path.
const db = (env as any).DB as D1Database;
const realFetch = globalThis.fetch;

/** DoH stub: any domain containing "nomx" has no MX and no A record; the rest have MX. */
function stubDoh(): { calls: string[] } {
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const name = url.searchParams.get('name') ?? '';
		calls.push(`${name}/${url.searchParams.get('type')}`);
		const answer = name.includes('nomx') ? [] : [{ type: url.searchParams.get('type') === 'MX' ? 15 : 1 }];
		return new Response(JSON.stringify({ Answer: answer }), { status: 200 });
	}) as typeof fetch;
	return { calls };
}

async function contact(email: string, subscribed = 1): Promise<number> {
	return (await db
		.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id')
		.bind(email, subscribed)
		.first<{ id: number }>())!.id;
}
async function row(email: string) {
	return db
		.prepare('SELECT id, subscribed, meta FROM contacts WHERE email = ?')
		.bind(email)
		.first<{ id: number; subscribed: number; meta: string | null }>();
}
async function hygieneOf(email: string): Promise<string | null> {
	const r = await row(email);
	return r?.meta ? ((JSON.parse(r.meta) as { hygiene?: string }).hygiene ?? null) : null;
}
async function tagged(email: string): Promise<boolean> {
	const r = await db
		.prepare(
			`SELECT 1 AS x FROM list_members lm JOIN lists l ON l.id = lm.list_id JOIN contacts c ON c.id = lm.contact_id
			 WHERE l.kind = 'tag' AND l.name = ? AND c.email = ?`
		)
		.bind(HYGIENE_INVALID_TAG, email)
		.first();
	return !!r;
}
function contactsEvent(action: string, fd: FormData) {
	return {
		platform: { env },
		request: new Request(`https://app.test/contacts?/${action}`, { method: 'POST', body: fd })
	} as any;
}
function csvForm(csv: string, extra: Record<string, string> = {}): FormData {
	const fd = new FormData();
	fd.set('file', new File([csv], 'people.csv', { type: 'text/csv' }));
	fd.set('email_col', 'email');
	fd.set('list_name', 'Hygiene import');
	for (const [k, v] of Object.entries(extra)) fd.set(k, v);
	return fd;
}

beforeEach(async () => {
	clearMxCache();
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM webhook_events'),
		db.prepare('DELETE FROM webhook_keys'),
		db.prepare("DELETE FROM app_state WHERE key = 'hygiene_backfill'"),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('typo suggestions', () => {
	it('fixes common consumer-domain misspellings', () => {
		expect(suggestDomain('gmial.com')).toBe('gmail.com');
		expect(suggestDomain('gmail.co')).toBe('gmail.com');
		expect(suggestDomain('hotmial.com')).toBe('hotmail.com');
		expect(suggestDomain('yaho.com')).toBe('yahoo.com');
		expect(suggestDomain('outlok.com')).toBe('outlook.com');
		expect(suggestDomain('icloud.co')).toBe('icloud.com');
		expect(checkAddressSync('Jane.Doe@Gmial.com').suggestion).toBe('jane.doe@gmail.com');
	});

	it('leaves real domains alone', () => {
		for (const d of ['gmail.com', 'yahoo.com', 'gmx.net', 'ourco.example', 'acme.co', 'me.com', 'mi.com']) {
			expect(suggestDomain(d)).toBeNull();
		}
	});
});

describe('role and disposable detection', () => {
	it('flags role mailboxes (warning) and disposable domains (invalid)', () => {
		expect(isRoleAddress('info@acme.example.net')).toBe(true);
		expect(isRoleAddress('Sales+leads@acme.example.net')).toBe(true);
		expect(isRoleAddress('noreply@acme.example.net')).toBe(true);
		expect(isRoleAddress('jane@acme.example.net')).toBe(false);
		expect(isDisposableDomain('Mailinator.com')).toBe(true);
		expect(isDisposableDomain('acme.example.net')).toBe(false);

		expect(hygieneMeta({ ...checkAddressSync('info@gmial.com'), mx: 'ok' })).toBe('warn role typo:gmail.com');
		expect(hygieneMeta(checkAddressSync('x@mailinator.com'))).toBe('invalid disposable');
		expect(hygieneMeta({ ...checkAddressSync('x@acme.example.net'), mx: 'none' })).toBe('invalid no-mx');
		expect(hygieneMeta({ ...checkAddressSync('x@acme.example.net'), mx: 'ok' })).toBe('ok');
	});
});

describe('MX cache', () => {
	it('caches a definitive answer per domain for 24 h, never a failed lookup', async () => {
		let n = 0;
		const lookup = async () => (n++, 'ok' as const);
		const t0 = 1_000_000;
		expect(await mxStatus('Acme.example.net', { lookup, now: t0 })).toBe('ok');
		expect(await mxStatus('acme.example.net', { lookup, now: t0 + 1000 })).toBe('ok');
		expect(n).toBe(1);
		expect(await mxStatus('acme.example.net', { lookup, now: t0 + MX_TTL_MS })).toBe('ok');
		expect(n).toBe(2);

		let m = 0;
		const flaky = async () => (m++, 'unknown' as const);
		await mxStatus('flaky.com', { lookup: flaky, now: t0 });
		await mxStatus('flaky.com', { lookup: flaky, now: t0 });
		expect(m).toBe(2);
	});
});

describe('CSV import preview and accept-fix', () => {
	it('previews issues with counts; only our own suggestion is accepted as a fix', async () => {
		stubDoh();
		const preview = await previewImportHygiene(['ok@acme.example.net', 'jane.doe@gmial.com', 'x@mailinator.com', 'y@nomx.test', 'info@acme.example.net', 'bad']);
		expect(preview.counts).toMatchObject({ rows: 6, syntax: 1, invalid: 2, disposable: 1, noMx: 1, role: 1, typo: 1 });
		expect(preview.issues.map((i) => i.row)).toEqual([2, 3, 4, 5, 6]);
		expect(preview.issues.find((i) => i.row === 2)?.suggestion).toBe('jane.doe@gmail.com');

		const fixes = parseFixes(JSON.stringify({ 'jane.doe@gmial.com': 'jane.doe@gmail.com', 'ok@acme.example.net': 'evil@x.example.net' }));
		expect([...fixes]).toEqual([['jane.doe@gmial.com', 'jane.doe@gmail.com']]);
	});

	it('the preview action reads the email column without writing anything', async () => {
		stubDoh();
		const out = (await contactActions.importPreview(contactsEvent('importPreview', csvForm('email\njane.doe@gmial.com\n')))) as any;
		expect(out.preview.issues[0].suggestion).toBe('jane.doe@gmail.com');
		expect(await row('jane.doe@gmial.com')).toBeNull();
	});

	it('imports with fixes applied; invalid rows come in unsubscribed + tagged (default)', async () => {
		stubDoh();
		const csv = 'email\nok@acme.example.net\njane.doe@gmial.com\nx@mailinator.com\ny@nomx.test\n';
		const out = (await contactActions.import(
			contactsEvent('import', csvForm(csv, { fixes: JSON.stringify({ 'jane.doe@gmial.com': 'jane.doe@gmail.com' }) }))
		)) as any;
		expect(out.success).toBe(true);
		expect(out.hygiene).toMatchObject({ fixed: 1, invalid: 2, skipped: 0 });
		expect(await row('jane.doe@gmial.com')).toBeNull();
		expect((await row('jane.doe@gmail.com'))?.subscribed).toBe(1);
		expect((await row('x@mailinator.com'))?.subscribed).toBe(0);
		expect((await row('y@nomx.test'))?.subscribed).toBe(0);
		expect(await tagged('x@mailinator.com')).toBe(true);
		expect(await tagged('ok@acme.example.net')).toBe(false);
		expect(await hygieneOf('ok@acme.example.net')).toBe('ok');
	});

	it('skips invalid rows when the importer chooses to', async () => {
		stubDoh();
		const out = (await contactActions.import(
			contactsEvent('import', csvForm('email\nok@acme.example.net\ny@nomx.test\n', { invalid_mode: 'skip' }))
		)) as any;
		expect(out.imported).toBe(1);
		expect(out.hygiene.skipped).toBe(1);
		expect(await row('y@nomx.test')).toBeNull();
	});
});

describe('API paths tag but never reject', () => {
	it('/api/ingest accepts a disposable address and tags it', async () => {
		stubDoh();
		await db.prepare("INSERT INTO webhook_keys (label, token, default_list) VALUES ('Form', 'wk_hy', 'Hy list')").run();
		const url = 'https://crm.test/api/ingest';
		const res = await ingest({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer wk_hy' },
				body: JSON.stringify({ email: 'test@mailinator.com' })
			}),
			url: new URL(url),
			platform: { env }
		} as any);
		expect(res.status).toBe(200);
		expect(await tagged('test@mailinator.com')).toBe(true);
		expect(await hygieneOf('test@mailinator.com')).toBe('invalid disposable');
	});

	it('/api/contacts/upsert stores meta.hygiene and tags no-MX', async () => {
		stubDoh();
		const res = await upsert({
			request: new Request('https://crm.test/api/contacts/upsert', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer ik' },
				body: JSON.stringify({ email: 'z@nomx.test' })
			}),
			url: new URL('https://crm.test/api/contacts/upsert'),
			platform: { env: { ...(env as object), INGEST_KEY: 'ik' } }
		} as any);
		expect(res.status).toBe(200);
		expect(await tagged('z@nomx.test')).toBe(true);
		expect((await row('z@nomx.test'))?.subscribed).toBe(1); // tagged, not unsubscribed
	});

	it('POST /api/v1/contacts creates a role/typo address with a warning, no tag', async () => {
		stubDoh();
		const k = await generateApiKey();
		await db
			.prepare('INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)')
			.bind('t', k.tokenHash, k.prefix, k.last4, 'read_write')
			.run();
		const res = await createContact({
			request: new Request('https://crm.test/api/v1/contacts', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${k.token}` },
				body: JSON.stringify({ email: 'info@gmial.com' })
			}),
			url: new URL('https://crm.test/api/v1/contacts'),
			params: {},
			platform: { env }
		} as any);
		expect(res.status).toBe(201);
		expect(await hygieneOf('info@gmial.com')).toBe('warn role typo:gmail.com');
		expect(await tagged('info@gmial.com')).toBe(false);
	});
});

describe('backfill', () => {
	it('walks subscribed contacts in batches capped by domains, idempotently', async () => {
		const a = await contact('a@one.test');
		await contact('b@one.test');
		await contact('c@nomx.test');
		await contact('d@three.test');
		await contact('u@nomx.test', 0); // unsubscribed — not checked
		let lookups = 0;
		const lookup = async (d: string) => (lookups++, d.includes('nomx') ? ('none' as const) : ('ok' as const));

		expect(await runHygieneBackfill(db, { lookup })).toEqual({ skipped: 'idle' });
		await startHygieneBackfill(db);
		const s1 = await runHygieneBackfill(db, { lookup, maxDomains: 1 });
		expect(s1).toMatchObject({ checked: 2, domains: 1, done: false }); // one.test ×2
		expect((await backfillState(db))?.cursor).toBeGreaterThan(a);
		const s2 = await runHygieneBackfill(db, { lookup, maxDomains: 1 });
		expect(s2).toMatchObject({ checked: 1, invalid: 1 });
		const s3 = await runHygieneBackfill(db, { lookup, maxDomains: 1 });
		expect(s3).toMatchObject({ checked: 1, done: true });
		expect(lookups).toBe(3);
		expect(await tagged('c@nomx.test')).toBe(true);
		expect(await hygieneOf('u@nomx.test')).toBeNull();
		expect((await row('c@nomx.test'))?.subscribed).toBe(1); // never unsubscribed

		const before = await hygieneCounts(db, await backfillState(db));
		// A second full pass (cached domains) changes nothing.
		await startHygieneBackfill(db);
		await runHygieneBackfill(db, { lookup });
		expect(await hygieneCounts(db, await backfillState(db))).toEqual(before);
		expect(before).toMatchObject({ checked: 4, invalid: 1, remaining: 0 });
		const tagRows = await db
			.prepare(`SELECT COUNT(*) AS n FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE l.name = ?`)
			.bind(HYGIENE_INVALID_TAG)
			.first<{ n: number }>();
		expect(tagRows?.n).toBe(1);
	});

	it('the contacts filter finds what the backfill flagged', async () => {
		await contact('c@nomx.test');
		await contact('info@acme.test');
		await startHygieneBackfill(db);
		await runHygieneBackfill(db, { lookup: async (d) => (d.includes('nomx') ? 'none' : 'ok') });
		const find = async (h: string) => {
			const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams({ hygiene: h })));
			const r = await db.prepare(`SELECT email FROM contacts ${where}`).bind(...params).all<{ email: string }>();
			return r.results.map((x) => x.email);
		};
		expect(await find('invalid')).toEqual(['c@nomx.test']);
		expect(await find('role')).toEqual(['info@acme.test']);
		expect(await find('typo')).toEqual([]);
	});
});
