import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';

// #668: account emails (invite / reset / verify, #639) are marked `campaigns.system_kind =
// 'account'` and stay out of Conversations, the send log, the dashboard, reports, search, the
// API and the campaign page; a transport error never stores the live link; a reset link used
// between opening the page and saving shows the dead-link view. No email leaves: Postmark's
// sendBatch is replaced, as in the #639 tests.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({
	...(await orig<object>()),
	sendBatch: spies.sendBatch
}));

import { claimToken, issueToken, sendAccountEmail, sqlTime } from '../src/lib/server/account-tokens';
import { ACCOUNT_MAIL_KIND } from '../src/lib/server/system-mail';
import { findConversation, listedThreads, recentConversations } from '../src/lib/server/conversations';
import { parseSendLogFilter, sendLogRows } from '../src/lib/server/sendlog-query';
import { lastCampaign, loadTiles, recentCampaigns, stuckSends } from '../src/lib/server/dashboard';
import { runReport } from '../src/lib/server/reports/engine';
import { parseReportSpec } from '../src/lib/report-spec';
import { siteSearch } from '../src/lib/server/site-search';
import { getCampaign, listCampaigns } from '../src/lib/server/campaigns-api';
import { load as campaignLoad } from '../src/routes/campaign/[id]/+page.server';
import { load as resetLoad, actions as resetActions } from '../src/routes/reset/[token]/+page.server';

const db = (env as { DB: D1Database }).DB;
const SECRET = 'account-mail-668';
const GOOD_PASSWORD = 'plum tractor velvet';
const BASE = 'https://crm.test';
const testEnv = { DB: db, SESSION_SECRET: SECRET, POSTMARK_TOKEN: 'pm-test', POSTMARK_FROM: 'from@example.com', PUBLIC_BASE_URL: BASE };
const SUBJECT_WORD = 'Zebracorn'; // unique, so search / filters only see this file's rows

function event(path: string, opts: { fields?: Record<string, string>; params?: Record<string, string> } = {}) {
	const url = new URL(`${BASE}${path}`);
	const headers = { 'cf-connecting-ip': 'ip-668', origin: BASE };
	let request: Request;
	if (opts.fields) {
		const body = new FormData();
		for (const [k, v] of Object.entries(opts.fields)) body.set(k, v);
		request = new Request(url, { method: 'POST', body, headers });
	} else {
		request = new Request(url, { method: 'GET', headers });
	}
	const jar: Record<string, string | undefined> = {};
	return {
		request,
		url,
		params: opts.params ?? {},
		platform: { env: testEnv },
		locals: { user: { id: 1, role: 'admin', github_login: 'ourco-admin' }, authed: true },
		cookies: {
			get: (n: string) => jar[n],
			set: (n: string, v: string) => (jar[n] = v),
			delete: (n: string) => (jar[n] = undefined),
			getAll: () => [],
			serialize: () => ''
		},
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {}
	} as any;
}

async function makeUser(login: string, email: string): Promise<number> {
	const res = await db
		.prepare(`INSERT INTO users (github_login, role, email, email_verified_at) VALUES (?, 'member', ?, ?)`)
		.bind(login, email, sqlTime(Date.now()))
		.run();
	return res.meta.last_row_id as number;
}

/** Send one account email for real (through sendCampaignEmail, Postmark mocked); its campaign id. */
async function accountMail(kind: 'invite' | 'reset' | 'verify', to: string): Promise<number> {
	const r = await sendAccountEmail(db, testEnv, { kind, to, token: `tok${'x'.repeat(40)}` }, { baseUrl: BASE });
	expect(r.ok).toBe(true);
	const row = await db.prepare(`SELECT MAX(id) AS id FROM campaigns`).first<{ id: number }>();
	return row!.id;
}

/** A person's 1:1 send to an address that isn't a contact — the control that must stay listed. */
async function directSend(to: string): Promise<number> {
	const c = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, sent_at, recipient_count)
			 VALUES (?, 'hi', '<p>hi</p>', 'hi', NULL, 'from@example.com', 'sent', datetime('now'), 1) RETURNING id`
		)
		.bind(`${SUBJECT_WORD} hello`)
		.first<{ id: number }>();
	await db
		.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status, message_id) VALUES (?, NULL, ?, 'accepted', ?)`)
		.bind(c!.id, to, `direct-${c!.id}`)
		.run();
	return c!.id;
}

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	await db.prepare(`DELETE FROM account_tokens`).run();
	await db.prepare(`DELETE FROM account_token_events`).run();
	await db.prepare(`DELETE FROM login_attempts`).run();
	await db.prepare(`DELETE FROM users WHERE id != 1`).run();
});

describe('#668 account emails are marked', () => {
	it('stores invite / reset / verify rows as account mail, with the link redacted', async () => {
		for (const kind of ['invite', 'reset', 'verify'] as const) {
			const id = await accountMail(kind, `${kind}-mark@example.com`);
			const row = await db
				.prepare(`SELECT system_kind, status, body_text, body_html FROM campaigns WHERE id = ?`)
				.bind(id)
				.first<{ system_kind: string | null; status: string; body_text: string; body_html: string }>();
			expect(row).toMatchObject({ system_kind: ACCOUNT_MAIL_KIND, status: 'sent' });
			expect(row!.body_text).toContain(`${BASE}/${kind}/…`);
			expect(row!.body_text).not.toContain('tokxxxx');
			expect(row!.body_html).not.toContain('tokxxxx');
		}
	});

	it('migration 0132 backfills account rows sent before it, and nothing else', async () => {
		const files = import.meta.glob('../migrations/0132_*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
		const sql = Object.values(files)[0];
		const update = sql.slice(sql.indexOf('UPDATE campaigns'));
		const insert = async (body: string, listId: number | null = null) =>
			(
				await db
					.prepare(
						`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status) VALUES ('old', ?, '<p>x</p>', ?, ?, 'f@example.com', 'sent') RETURNING id`
					)
					.bind(body, body, listId)
					.first<{ id: number }>()
			)!.id;
		const oldReset = await insert(`Reset it:\n\n${BASE}/reset/…\n\nBye`);
		const oldVerify = await insert(`Verify:\n\n${BASE}/verify/…`);
		const personal = await insert('Thanks for the call, see you Tuesday.');
		await db.prepare(update).run();
		const kinds = await db
			.prepare(`SELECT id, system_kind FROM campaigns WHERE id IN (?, ?, ?)`)
			.bind(oldReset, oldVerify, personal)
			.all<{ id: number; system_kind: string | null }>();
		const by = new Map(kinds.results.map((r) => [r.id, r.system_kind]));
		expect(by.get(oldReset)).toBe('account');
		expect(by.get(oldVerify)).toBe('account');
		expect(by.get(personal)).toBeNull();
	});
});

describe('#668 Conversations leave account emails out', () => {
	it('lists the 1:1 send but not the invite / reset / verify mail, in the list, counts and thread lookup', async () => {
		await directSend('client-668@example.net');
		await accountMail('invite', 'invitee-668@example.net');
		await accountMail('reset', 'resetter-668@example.net');
		await accountMail('verify', 'verifier-668@example.net');

		const emails = (await listedThreads(db)).map((t) => t.email);
		expect(emails).toContain('client-668@example.net');
		expect(emails).not.toContain('invitee-668@example.net');
		expect(emails).not.toContain('resetter-668@example.net');
		expect(emails).not.toContain('verifier-668@example.net');

		const recent = await recentConversations(db, { q: '668@example.net', limit: 50 });
		expect(recent.rows.map((t) => t.email)).toEqual(['client-668@example.net']);
		expect(recent.counts.all).toBe(1);
		expect(recent.counts.sent).toBe(1);

		// The thread page re-threads by party; an account email has no thread to find.
		const invitee = await db
			.prepare(`SELECT 1 FROM recipients WHERE email = 'invitee-668@example.net'`)
			.first();
		expect(invitee).not.toBeNull(); // the recipient row exists (webhook attribution) …
		const threads = await listedThreads(db, 'invitee-668');
		expect(threads).toEqual([]); // … but no conversation
		expect(await findConversation(db, { contactId: null, email: 'invitee-668@example.net' }, 'any')).toBeNull();
	});
});

describe('#668 Campaigns, dashboard, reports, search and API leave account emails out', () => {
	it('keeps them out of every list and count', async () => {
		const direct = await directSend('client-list-668@example.net');
		const invite = await accountMail('invite', 'invitee-list-668@example.net');
		// Make the account row findable by the same word, so only the marker keeps it out.
		await db.prepare(`UPDATE campaigns SET subject = ? WHERE id = ?`).bind(`${SUBJECT_WORD} invite`, invite).run();

		// Send log.
		const log = await sendLogRows(db, parseSendLogFilter(new URLSearchParams({ q: SUBJECT_WORD })), {
			sort: 'date',
			dir: 'desc',
			limit: 100,
			offset: 0
		});
		expect(log.map((r) => r.id)).toContain(direct);
		expect(log.map((r) => r.id)).not.toContain(invite);

		// Dashboard: recent / last campaign / tiles / stuck sends.
		expect((await recentCampaigns(db)).map((r) => r.id)).not.toContain(invite);
		expect((await lastCampaign(db, 'UTC'))?.id ?? null).not.toBe(invite);
		const before = await loadTiles(db);
		await db.prepare(`UPDATE campaigns SET system_kind = NULL WHERE id = ?`).bind(invite).run();
		const unmarked = await loadTiles(db);
		await db.prepare(`UPDATE campaigns SET system_kind = ? WHERE id = ?`).bind(ACCOUNT_MAIL_KIND, invite).run();
		expect(unmarked.sent_7d - before.sent_7d).toBe(1); // the marker is what kept it out
		await db.prepare(`UPDATE campaigns SET status = 'sending', sent_at = datetime('now', '-2 hours') WHERE id = ?`).bind(invite).run();
		expect((await stuckSends(db)).map((s) => s.id)).not.toContain(invite);
		await db.prepare(`UPDATE campaigns SET status = 'sent' WHERE id = ?`).bind(invite).run();

		// Reports.
		const report = await runReport(
			db,
			parseReportSpec({ entity: 'campaigns', filters: { match: 'all', rules: [] }, columns: ['subject'], limit: 1000 }),
			{ role: 'admin' }
		);
		expect(report.rows.map((r) => r.subject)).toContain(`${SUBJECT_WORD} hello`);
		expect(report.rows.map((r) => r.subject)).not.toContain(`${SUBJECT_WORD} invite`);

		// Site search.
		const search = await siteSearch(db, SUBJECT_WORD, 10);
		expect(search.campaigns.items.map((c) => c.id)).toContain(direct);
		expect(search.campaigns.items.map((c) => c.id)).not.toContain(invite);

		// Data API / assistant / MCP (all read through campaigns-api).
		const api = await listCampaigns(db, { q: SUBJECT_WORD, limit: 50, offset: 0 }, BASE);
		expect(api.rows.map((r) => r.id)).toContain(direct);
		expect(api.rows.map((r) => r.id)).not.toContain(invite);
		expect(await getCampaign(db, invite, BASE)).toBeNull();
		expect(await getCampaign(db, direct, BASE)).not.toBeNull();

		// The campaign page by id.
		let status = 0;
		try {
			await campaignLoad(event(`/campaign/${invite}`, { params: { id: String(invite) } }));
		} catch (e) {
			status = isHttpError(e) ? e.status : -1;
		}
		expect(status).toBe(404);
	});
});

describe('#668 sendAccountEmail never stores the link from a transport error', () => {
	it('redacts result.firstError before storing and returning it', async () => {
		const token = `leak${'y'.repeat(40)}`;
		const url = `${BASE}/reset/${token}`;
		const r = await sendAccountEmail(
			db,
			testEnv,
			{ kind: 'reset', to: 'leak-668@example.com', token },
			{ baseUrl: BASE, deliver: (async () => ({ accepted: 0, failed: 1, firstError: `Rejected body containing ${url}` })) as any }
		);
		expect(r.ok).toBe(false);
		expect(r.ok ? '' : r.error).not.toContain(token);
		expect(r.ok ? '' : r.error).toContain(`${BASE}/reset/…`);
		const row = await db.prepare(`SELECT error, status FROM campaigns ORDER BY id DESC LIMIT 1`).first<{ error: string; status: string }>();
		expect(row!.status).toBe('failed');
		expect(row!.error).not.toContain(token);
		expect(row!.error).toContain(`${BASE}/reset/…`);
	});

	it('still redacts a thrown error', async () => {
		const token = `boom${'z'.repeat(40)}`;
		const r = await sendAccountEmail(
			db,
			testEnv,
			{ kind: 'verify', to: 'boom-668@example.com', token },
			{
				baseUrl: BASE,
				deliver: (async () => {
					throw new Error(`fetch failed for ${BASE}/verify/${token}`);
				}) as any
			}
		);
		expect(r.ok ? '' : r.error).not.toContain(token);
		const row = await db.prepare(`SELECT error FROM campaigns ORDER BY id DESC LIMIT 1`).first<{ error: string }>();
		expect(row!.error).not.toContain(token);
	});
});

describe('#668 reset link used between opening the page and saving', () => {
	it('shows the dead-link view, not the form with an error', async () => {
		const id = await makeUser('race-user', 'race@example.com');
		const t = await issueToken(db, { kind: 'reset', email: 'race@example.com', userId: id });
		const loaded = await resetLoad(event(`/reset/${t.token}`, { params: { token: t.token } }));
		expect(loaded).toMatchObject({ ready: true });

		// Another tab uses it — modelled as the claim landing right after the action's own check,
		// so the action's openToken still passes and completePasswordReset loses the claim.
		const tokenRow = await db.prepare(`SELECT id FROM account_tokens WHERE email = 'race@example.com'`).first<{ id: number }>();
		const realPrepare = db.prepare.bind(db);
		let claimedElsewhere = false;
		const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
			if (!claimedElsewhere && /UPDATE account_tokens SET used_at/i.test(sql)) {
				claimedElsewhere = true;
				return {
					bind: (...args: unknown[]) => ({
						run: async () => {
							await claimToken(db, tokenRow!.id); // the other tab wins
							return realPrepare(sql).bind(...args).run();
						},
						first: async () => {
							await claimToken(db, tokenRow!.id);
							return realPrepare(sql).bind(...args).first();
						}
					})
				} as any;
			}
			return realPrepare(sql);
		});
		let res: any;
		try {
			res = await resetActions.default(
				event(`/reset/${t.token}`, { params: { token: t.token }, fields: { password: GOOD_PASSWORD, confirm: GOOD_PASSWORD } })
			);
		} finally {
			spy.mockRestore();
		}
		expect(claimedElsewhere).toBe(true);
		expect(res.status).toBe(400);
		expect(res.data.dead).toBe(true);
	});

	it('keeps the form for a password-rule error', async () => {
		const id = await makeUser('rule-user', 'rule@example.com');
		const t = await issueToken(db, { kind: 'reset', email: 'rule@example.com', userId: id });
		const res: any = await resetActions.default(
			event(`/reset/${t.token}`, { params: { token: t.token }, fields: { password: 'short', confirm: 'short' } })
		);
		expect(res.status).toBe(400);
		expect(res.data.dead).toBe(false);
	});
});
