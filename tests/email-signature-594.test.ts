// #594: the email signature is a setting (app_state email_signature_html / _text).
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import migrationSql from '../migrations/0121_email_signature.sql?raw';
import { renderEmailHtml, renderEmailHtmlFromContent, renderEmailText } from '../src/lib/server/email';
import { renderBody } from '../src/lib/server/compose-body';
import {
	buildSignature,
	clearSignature,
	getSignature,
	getSignatureSetting,
	saveSignature,
	sanitizeSignatureHtml,
	SIGNATURE_KEYS
} from '../src/lib/server/email-signature';
import { beforeSignature, renderForChecks } from '../src/lib/server/presend-checks';
import { issueContentHtml, scrubPublicHtml, stripSignatureBlocks } from '../src/lib/server/newsletter-archive';
import { MERGE_TAGS, signatureHtml, signatureText, simpleSignatureHtml, simpleSignatureText } from '../src/lib/signature';
import { load as settingsLoad, actions as settingsActions } from '../src/routes/settings/signature/+page.server';
import { LEGACY_SIGNATURE } from './fixtures/legacy-signature';

const db = (env as any).DB as D1Database;

const CUSTOM = { html: '<div><strong>Jo Doe</strong><div>Acme <a href="https://acme.test">acme.test</a></div></div>', text: 'Jo Doe\nAcme acme.test' };

/** The migration's statements, run one by one (the leading comment block dropped; the text
 *  value itself has a line starting with "--", so comments can't be stripped line by line). */
async function runSeedMigration(transform: (sql: string) => string = (x) => x) {
	const body = migrationSql.slice(migrationSql.indexOf('INSERT'));
	for (const stmt of body.split(/;\s*\n(?=INSERT)/)) await db.prepare(transform(stmt.replace(/;\s*$/, ''))).run();
}

async function campaignCount(): Promise<number> {
	return (await db.prepare('SELECT COUNT(*) AS n FROM campaigns').first<{ n: number }>())!.n;
}

beforeEach(async () => {
	await clearSignature(db);
});

describe('rendering', () => {
	it('no signature set: no signature and no empty wrapper, in HTML and text', async () => {
		expect(await getSignature(db)).toBeNull();
		const html = renderEmailHtml('Hello', { signature: await getSignature(db) });
		expect(html).not.toContain('class="signature"');
		expect(html).toContain('<p>Hello</p>');
		const canvas = renderEmailHtmlFromContent('<p>Hi</p>', { canvas: { backdrop: '#eeeeee' }, signature: null });
		expect(canvas).not.toContain('class="signature"');
		expect(renderEmailText('Hello', { signature: null })).toBe('Hello\n\n—\nUnsubscribe: %%UNSUB_URL%%');
		expect(renderEmailText('Hello', { unsubscribe: false })).toBe('Hello');
		expect(signatureHtml(null)).toBe('');
		expect(signatureText(undefined)).toBe('');
	});

	it('a set signature renders in the HTML and text parts', async () => {
		await saveSignature(db, { ...CUSTOM, source: null });
		const signature = await getSignature(db);
		expect(signature).toEqual({ html: CUSTOM.html, text: CUSTOM.text });
		const html = renderEmailHtml('Hello', { signature });
		expect(html).toContain(`\n<div class="signature">${CUSTOM.html}</div>\n</div>`);
		expect(renderEmailText('Hello', { signature })).toBe(`Hello\n\n${CUSTOM.text}\n\n—\nUnsubscribe: %%UNSUB_URL%%`);
		const blocks = renderBody({ blocks: [{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] as any, md: 'Hi' }, { signature });
		expect(blocks.html).toContain(CUSTOM.html);
		expect(blocks.text).toContain(CUSTOM.text);
	});

	it('MERGE_TAGS is still exported for its importers', () => {
		expect(MERGE_TAGS.some((t) => t.tag === '{{first_name}}')).toBe(true);
	});
});

describe('migration 0121 seed', () => {
	it('a fresh database (no campaigns) gets no signature', async () => {
		// The test D1 may already hold campaigns from other suites: then the same statements run
		// against an empty stand-in table, which is what a fresh database looks like.
		if ((await campaignCount()) === 0) await runSeedMigration();
		else {
			await db.prepare('CREATE TABLE IF NOT EXISTS t594_empty (id INTEGER PRIMARY KEY)').run();
			expect(migrationSql.match(/FROM campaigns\)/g)).toHaveLength(2);
			await runSeedMigration((sql) => sql.replaceAll('FROM campaigns)', 'FROM t594_empty)'));
			await db.prepare('DROP TABLE t594_empty').run();
		}
		expect(await getSignature(db)).toBeNull();
	});

	it('an install with data gets the signature it sent before, byte for byte', async () => {
		await db.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('Old send', 'x', '<p>x</p>', 'a@b.example.net', 'sent')").run();
		await runSeedMigration();
		const seeded = await getSignature(db);
		expect(seeded).toEqual(LEGACY_SIGNATURE);
		// The pre-setting shell: content, then the wrapper with the signature, then the card end.
		const html = renderEmailHtml('Hello', { signature: seeded });
		expect(html).toContain(`<p>Hello</p>\n`);
		expect(html).toContain(`\n<div class="signature">${LEGACY_SIGNATURE.html}</div>\n</div>\n`);
		expect(renderEmailText('Hello', { signature: seeded })).toBe(
			`Hello\n\n--\nJane Doe\nFounder\n\nOurco — Built For Where You're Growing\n@ourco: https://social.example.net/ourco\nGet Support: support@ourco.example\nBook a Call: https://ourco.example/book/\n\n—\nUnsubscribe: %%UNSUB_URL%%`
		);
		// A second run never overwrites a signature changed since.
		await saveSignature(db, { ...CUSTOM, source: null });
		await runSeedMigration();
		expect(await getSignature(db)).toEqual({ html: CUSTOM.html, text: CUSTOM.text });
	});
});

describe('pre-send checks', () => {
	const input = (md: string) => ({ subject: 'S', preheader: '', body: { blocks: null, md }, templateId: null });

	it('beforeSignature: no signature keeps the whole text (splitting on "" would keep one character)', () => {
		expect(beforeSignature('Hello world', null)).toBe('Hello world');
		expect(beforeSignature('Hello\n\nJo Doe\nAcme acme.test', { html: '', text: CUSTOM.text })).toBe('Hello\n\n');
		expect(beforeSignature('Hello', { html: '', text: 'Not there' })).toBe('Hello');
	});

	it('the content text stops at the signature when one is set, and is the whole body without one', async () => {
		const body = 'A '.repeat(150).trim();
		const none = await renderForChecks(db, input(body));
		expect(none.contentText.trim()).toBe(body);
		expect(none.html).not.toContain('class="signature"');

		await saveSignature(db, { ...CUSTOM, source: null });
		const withSig = await renderForChecks(db, input(body));
		expect(withSig.contentText.trim()).toBe(body);
		expect(withSig.html).toContain(CUSTOM.html);
		expect(withSig.text).toContain(CUSTOM.text);
	});
});

describe('newsletter archive', () => {
	const sent = (sig: { html: string; text: string } | null) => renderEmailHtml('Issue body', { signature: sig, originNote: 'Joined the list' });

	it('campaigns sent with the old signature, a new one, or none all show without it', () => {
		for (const sig of [LEGACY_SIGNATURE, CUSTOM, null]) {
			const html = issueContentHtml({ body_blocks: null, body_md: '', body_html: sent(sig), from_email: null, template_kind: 'html' });
			expect(html).toContain('Issue body');
			for (const bad of ['class="signature"', 'missive_signature', 'Jane Doe', 'Jo Doe', 'Joined the list']) expect(html).not.toContain(bad);
		}
	});

	it('stripSignatureBlocks removes nested markup and keeps what follows', () => {
		const html = '<p>a</p><div class="signature" style="x"><div><div>deep</div></div><span>s</span></div><p>b</p>';
		expect(stripSignatureBlocks(html)).toBe('<p>a</p><p>b</p>');
		expect(scrubPublicHtml('<p>a</p><div class="missive_signature"><div>--</div></div>', null)).toBe('<p>a</p>');
	});
});

describe('settings', () => {
	it('simple text → HTML with bold, italic and safe links; plain text without formatting', () => {
		const src = '--\n**Jo Doe**\n*Founder*\n\n[Acme](https://acme.test) | [Mail](mailto:jo@acme.test) | [bad](javascript:alert(1))';
		const html = simpleSignatureHtml(src);
		expect(html).toContain('<div><strong>Jo Doe</strong></div>');
		expect(html).toContain('<div><em>Founder</em></div>');
		expect(html).toContain('<div><br></div>');
		expect(html).toContain('<a href="https://acme.test">Acme</a>');
		expect(html).toContain('<a href="mailto:jo@acme.test">Mail</a>');
		expect(html).not.toContain('href="javascript');
		expect(simpleSignatureText(src)).toBe('--\nJo Doe\nFounder\n\nAcme: https://acme.test | Mail: jo@acme.test | bad: javascript:alert(1)');
		expect(simpleSignatureHtml('<b>x</b>')).toBe('<div><div>&lt;b&gt;x&lt;/b&gt;</div></div>');
		expect(simpleSignatureHtml('  \n ')).toBe('');
	});

	it('pasted HTML is sanitised; the text is generated when left empty', () => {
		const res = buildSignature({ mode: 'html', source: '', text: '', html: '<html><body><style>p{}</style><p onclick="x()">Hi <a href="javascript:evil()">x</a></p><script>bad()</script></body></html>' });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.html).not.toMatch(/script|onclick|javascript:|<style|<html|<body/i);
		expect(res.value.html).toContain('Hi');
		expect(res.value.text).toContain('Hi');
		expect(res.value.source).toBeNull();
		expect(sanitizeSignatureHtml(LEGACY_SIGNATURE.html)).toBe(LEGACY_SIGNATURE.html);
		expect(buildSignature({ mode: 'html', source: '', text: '', html: 'x'.repeat(20_001) }).ok).toBe(false);
	});

	it('saving an empty signature removes it', async () => {
		await saveSignature(db, { ...CUSTOM, source: null });
		const res = buildSignature({ mode: 'simple', source: '   ', html: '', text: '' });
		expect(res.ok && res.value).toEqual({ html: '', text: '', source: '' });
		if (res.ok) await saveSignature(db, res.value);
		expect(await getSignature(db)).toBeNull();
		const rows = await db.prepare('SELECT COUNT(*) AS n FROM app_state WHERE key IN (?, ?, ?)').bind(SIGNATURE_KEYS.html, SIGNATURE_KEYS.text, SIGNATURE_KEYS.source).first<{ n: number }>();
		expect(rows!.n).toBe(0);
	});

	const event = (role: 'admin' | 'member', fields?: Record<string, string>) => {
		const url = new URL('http://localhost/settings/signature');
		const body = new FormData();
		for (const [k, v] of Object.entries(fields ?? {})) body.set(k, v);
		return {
			url,
			params: {},
			locals: { user: { id: 1, login: 'x', role } },
			platform: { env },
			request: new Request(url, { method: 'POST', body })
		} as any;
	};

	it('admin-only: load and every action refuse a member', async () => {
		for (const run of [() => settingsLoad(event('member')), () => (settingsActions.save as any)(event('member')), () => (settingsActions.clear as any)(event('member'))]) {
			try {
				await run();
				expect.unreachable();
			} catch (e) {
				expect(isHttpError(e) && e.status).toBe(403);
			}
		}
	});

	it('the save action stores a simple signature; load returns it with its source', async () => {
		const res = await (settingsActions.save as any)(event('admin', { mode: 'simple', source: '**Jo**\n[Acme](https://acme.test)', html: '', text: '' }));
		expect(res).toMatchObject({ saved: true, empty: false });
		const setting = await getSignatureSetting(db);
		expect(setting.source).toBe('**Jo**\n[Acme](https://acme.test)');
		expect(setting.html).toBe('<div><div><strong>Jo</strong></div><div><a href="https://acme.test">Acme</a></div></div>');
		expect(setting.text).toBe('Jo\nAcme: https://acme.test');
		const loaded = (await settingsLoad(event('admin'))) as any;
		expect(loaded.signature).toEqual(setting);
		await (settingsActions.clear as any)(event('admin'));
		expect(await getSignature(db)).toBeNull();
	});
});
