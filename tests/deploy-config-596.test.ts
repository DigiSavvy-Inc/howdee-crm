// #596: company-specific values moved out of the source into configuration. Each fallback is
// exercised with its var / setting set and unset.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { jobEmailSubject, reviewToAddress } from '../src/lib/server/ai/jobs-email';
import { sendJobEmail } from '../src/lib/server/job-email-send';
import { REVIEW_TO_KEY } from '../src/lib/ai-jobs';
import { setSettings } from '../src/lib/server/settings';
import { buildReplyForward, forwardNameSuffix } from '../src/lib/server/reply-forward';
import { NO_DEFAULT_LIST_ERROR, defaultListName } from '../src/lib/server/default-list';
import { workerName } from '../src/lib/server/public-url';
import { archiveRequestMode, archiveRouteHosts, type ArchivePublicConfig } from '../src/lib/server/archive-public';
import { mcpInstructions } from '../src/lib/server/mcp/server';
import { USER_AGENT } from '../src/lib/server/user-agent';
import { DEFAULT_APP_NAME } from '../src/lib/branding';
import { POST as ingest } from '../src/routes/api/ingest/+server';
import { POST as luma } from '../src/routes/api/luma/+server';

const db = (env as any).DB as D1Database;

describe('job email sender + REVIEW_TO', () => {
	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM recipients'),
			db.prepare('DELETE FROM campaigns'),
			db.prepare("DELETE FROM app_state WHERE key IN ('default_from', 'approved_senders')")
		]);
	});

	it('REVIEW_TO when set, else Settings Default From, else not configured', () => {
		expect(reviewToAddress({ REVIEW_TO: ' review@example.com ' }, 'from@example.com')).toBe('review@example.com');
		expect(reviewToAddress({}, 'from@example.com')).toBe('from@example.com');
		expect(reviewToAddress({}, null)).toBe('');
		expect(reviewToAddress(undefined)).toBe('');
	});

	const fakeDeliver = (froms: string[], tos: string[]) =>
		(async (_db: D1Database, o: any) => {
			froms.push(o.from);
			tos.push(...o.recipients.map((r: { email: string }) => r.email));
			return { accepted: o.recipients.length, failed: 0, skipped: 0, firstError: null, results: [] };
		}) as any;
	const msg = { subject: 's', html: '<p>h</p>', text: 't' };

	it('From = REVIEW_FROM when set', async () => {
		const froms: string[] = [];
		const tos: string[] = [];
		const r = await sendJobEmail(db, { POSTMARK_TOKEN: 't', REVIEW_FROM: 'jobs@example.com', REVIEW_TO: 'boss@example.com' }, 'https://crm.test', [REVIEW_TO_KEY], msg, fakeDeliver(froms, tos));
		expect(r.status).toBe('sent');
		expect(froms).toEqual(['jobs@example.com']);
		expect(tos).toEqual(['boss@example.com']);
	});

	it('REVIEW_FROM / REVIEW_TO unset → Settings Default From for both', async () => {
		await setSettings(db, { default_from: 'owner@example.com' });
		const froms: string[] = [];
		const tos: string[] = [];
		const r = await sendJobEmail(db, { POSTMARK_TOKEN: 't' }, 'https://crm.test', [REVIEW_TO_KEY], msg, fakeDeliver(froms, tos));
		expect(r.status).toBe('sent');
		expect(froms).toEqual(['owner@example.com']);
		expect(tos).toEqual(['owner@example.com']);
	});

	it('nothing configured → "not configured", nothing sent, no built-in address', async () => {
		const froms: string[] = [];
		const r = await sendJobEmail(db, { POSTMARK_TOKEN: 't' }, 'https://crm.test', [REVIEW_TO_KEY], msg, fakeDeliver(froms, []));
		expect(r).toMatchObject({ status: 'failed', sent: 0 });
		expect(r.error).toMatch(/No sender configured/);
		expect(froms).toEqual([]);
	});
});

describe('app name from branding', () => {
	it('job email subjects', () => {
		const now = new Date('2026-10-21T15:00:00Z');
		expect(jobEmailSubject({ name: 'Digest', schedule_kind: 'weekly' }, now, 'UTC')).toBe(`${DEFAULT_APP_NAME} digest, week of October 19, 2026`);
		expect(jobEmailSubject({ name: 'Digest', schedule_kind: 'weekly' }, now, 'UTC', 'Acme CRM')).toBe('Acme CRM digest, week of October 19, 2026');
		expect(jobEmailSubject({ name: 'Pulse', schedule_kind: 'daily' }, now, 'UTC', 'Acme CRM')).toBe('Acme CRM: Pulse, October 21, 2026');
	});

	it('reply forward display name', () => {
		expect(forwardNameSuffix('Acme CRM')).toBe('via Acme CRM');
		expect(forwardNameSuffix('')).toBe(`via ${DEFAULT_APP_NAME}`);
		const base = {
			senderAddress: 'crm@example.com',
			to: 'owner@example.com',
			stream: 'outbound',
			contactEmail: 'jordan@example.org',
			contactName: 'Jordan Rivera',
			subject: 'Hi',
			text: 'Hello',
			crmUrl: 'https://crm.test/c'
		};
		expect(buildReplyForward(base).From).toBe(`"Jordan Rivera via ${DEFAULT_APP_NAME}" <crm@example.com>`);
		expect(buildReplyForward({ ...base, appName: 'Acme CRM' }).From).toBe('"Jordan Rivera via Acme CRM" <crm@example.com>');
	});

	it('MCP instructions', () => {
		expect(mcpInstructions('Acme CRM')).toMatch(/^Acme CRM \(contacts/);
	});

	it('User-Agent is neutral', () => {
		expect(USER_AGENT).not.toMatch(/ds-postmark/i);
	});
});

describe('deploy vars', () => {
	it('DEFAULT_LIST_NAME', () => {
		expect(defaultListName({ DEFAULT_LIST_NAME: ' Newsletter ' })).toBe('Newsletter');
		expect(defaultListName({})).toBe('');
		expect(defaultListName(undefined)).toBe('');
	});

	it('WORKER_NAME', () => {
		expect(workerName({ WORKER_NAME: ' crm-worker ' })).toBe('crm-worker');
		expect(workerName({})).toBe('');
	});

	it('ARCHIVE_ROUTE_HOSTS: comma-separated, lowercased; unset = none', async () => {
		expect(archiveRouteHosts({ ARCHIVE_ROUTE_HOSTS: 'Example.com, www.example.com ,' })).toEqual(['example.com', 'www.example.com']);
		expect(archiveRouteHosts({})).toEqual([]);
		const cfg: ArchivePublicConfig = { host: null, redirect: false, status: null, secretHash: null };
		const url = new URL('https://example.com/newsletter');
		// A route host whose archive isn't saved yet is never served the app.
		expect(await archiveRequestMode(url, new Headers(), cfg, ['example.com'])).toEqual({ kind: 'blocked' });
		// Not a route host (var unset): a normal request.
		expect(await archiveRequestMode(url, new Headers(), cfg)).toEqual({ kind: 'crm' });
	});
});

describe('default list on /api/ingest and /api/luma', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM luma_events'),
			db.prepare('DELETE FROM list_members'),
			db.prepare('DELETE FROM lists'),
			db.prepare('DELETE FROM webhook_events'),
			db.prepare('DELETE FROM contacts'),
			db.prepare("DELETE FROM app_state WHERE key LIKE 'luma%'")
		]);
		globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch; // DoH fails open
	});

	const lists = async (email: string) =>
		(
			await db
				.prepare(
					`SELECT l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id JOIN contacts c ON c.id = lm.contact_id
					 WHERE c.email = ? AND l.kind = 'list'`
				)
				.bind(email)
				.all<{ name: string }>()
		).results.map((r) => r.name);
	const contact = (email: string) => db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first();

	function postIngest(email: string, extraEnv: Record<string, string> = {}) {
		const url = 'https://crm.test/api/ingest';
		return ingest({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer ik' },
				body: JSON.stringify({ email })
			}),
			url: new URL(url),
			platform: { env: { ...(env as object), INGEST_KEY: 'ik', ...extraEnv } }
		} as any);
	}

	it('ingest: DEFAULT_LIST_NAME set → joins that list', async () => {
		const res = await postIngest('lead@example.org', { DEFAULT_LIST_NAME: 'Newsletter' });
		expect(res.status).toBe(200);
		expect(await lists('lead@example.org')).toEqual(['Newsletter']);
	});

	it('ingest: no list anywhere → 400 with a clear error, nothing stored', async () => {
		const res = await postIngest('lead@example.org');
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(NO_DEFAULT_LIST_ERROR);
		expect(await contact('lead@example.org')).toBeNull();
	});

	const SECRET = 'whsec_test596';
	async function postLuma(email: string, extraEnv: Record<string, string> = {}) {
		await setSettings(db, { luma_webhook_secret: SECRET });
		const body = JSON.stringify({ type: 'guest.registered', data: { email, name: 'Jordan Rivera', approval_status: 'approved' } });
		const t = String(Math.floor(Date.now() / 1000));
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)))]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		return luma({
			request: new Request('https://app.test/api/luma', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'webhook-signature': `t=${t},v1=${sig}`, 'webhook-id': `evt-${email}-${Object.keys(extraEnv).length}` },
				body
			}),
			platform: { env: { ...(env as object), ...extraEnv } },
			url: new URL('https://app.test/api/luma')
		} as any);
	}

	it('luma: DEFAULT_LIST_NAME set (no Settings list) → joins that list', async () => {
		const res = await postLuma('guest@example.org', { DEFAULT_LIST_NAME: 'Events' });
		expect(res.status).toBe(200);
		expect(await lists('guest@example.org')).toEqual(['Events']);
	});

	it('luma: no Settings list and no var → rejected with a clear error, no contact', async () => {
		const res = await postLuma('guest@example.org');
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: string }).error).toBe(NO_DEFAULT_LIST_ERROR);
		expect(await contact('guest@example.org')).toBeNull();
	});
});
