import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { defaultSuggestionsConfig, type SuggestionsConfig } from '../src/lib/suggestions';
import {
	allSteps,
	countLabel,
	nextStepHref,
	OPENING_MAX,
	panelHiddenOn,
	parsePanelAction,
	readMemory,
	readOpening,
	shouldAutoOpen,
	swipeDirection,
	wrapIndex
} from '../src/lib/suggestions-panel';
import { runSuggestions } from '../src/lib/server/suggestions/engine';
import { CONFIG_KEY } from '../src/lib/server/suggestions/config';
import { suggestionViewer } from '../src/lib/server/suggestions/visibility';
import { applyPanelAction, panelSuggestions, panelSummary } from '../src/lib/server/suggestions/panel';
import { GET as listGET } from '../src/routes/api/suggestions/+server';
import { POST as actPOST } from '../src/routes/api/suggestions/[id]/+server';
import layoutServer from '../src/routes/+layout.server.ts?raw';
import layoutSvelte from '../src/routes/+layout.svelte?raw';
import panelSvelte from '../src/lib/components/SuggestionsPanel.svelte?raw';

// #714: Suggestions 3/5 — the panel: its load, its actions and the prefill links.
const db = (env as any).DB as D1Database;
const DAY = 86_400_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString().slice(0, 19).replace('T', ' ');
const ADMIN = { id: 1, role: 'admin' };

function cfg(over: (c: SuggestionsConfig) => void = () => {}): SuggestionsConfig {
	const c = defaultSuggestionsConfig();
	c.enabled = true;
	over(c);
	return c;
}
async function setConfig(c: SuggestionsConfig | Record<string, unknown>) {
	await db
		.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		.bind(CONFIG_KEY, JSON.stringify(c))
		.run();
}
async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM suggestions'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'suggestions_%'`),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM users WHERE id <> 1`)
	]);
});

/** One team suggestion (awaiting reply) and one assigned to the admin (stalled deal). */
async function seed() {
	await setConfig(cfg());
	const ana = await id(`INSERT INTO contacts (email, first_name, last_name, subscribed) VALUES ('ana@example.com', 'Ana', 'Example', 1) RETURNING id`);
	await db
		.prepare(`INSERT INTO replies (contact_id, from_email, subject, text, received_at) VALUES (?, 'ana@example.com', 'Pricing question', 'Hi there', ?)`)
		.bind(ana, ago(3 * DAY))
		.run();
	const ben = await id(`INSERT INTO contacts (email, first_name, last_name, subscribed) VALUES ('ben@example.com', 'Ben', 'Example', 1) RETURNING id`);
	const stage = (await db.prepare(`SELECT id FROM pipeline_stages WHERE kind = 'open' LIMIT 1`).first<{ id: number }>())!.id;
	const deal = await id(
		`INSERT INTO pipeline_cards (contact_id, stage_id, owner_user_id, entered_stage_at) VALUES (?, ?, 1, ?) RETURNING id`,
		ben,
		stage,
		ago(40 * DAY)
	);
	await runSuggestions(db, { now, force: true });
	const member = await id(`INSERT INTO users (github_login, role) VALUES ('jdoe-714', 'member') RETURNING id`);
	return { ana, ben, deal, member };
}

function ev(user: unknown, opts: { id?: string; body?: unknown; raw?: string } = {}) {
	const url = new URL(`http://localhost/api/suggestions${opts.id ? `/${opts.id}` : ''}`);
	const init: RequestInit = opts.body !== undefined || opts.raw !== undefined
		? { method: 'POST', headers: { 'content-type': 'application/json' }, body: opts.raw ?? JSON.stringify(opts.body) }
		: {};
	return { request: new Request(url, init), platform: { env }, url, params: { id: opts.id ?? '' }, locals: { user } } as any;
}
async function statusOf(fn: () => Response | Promise<Response>): Promise<number> {
	try {
		return (await fn()).status;
	} catch (e: any) {
		return e?.status ?? 500;
	}
}

describe('pure helpers', () => {
	it('parses the action body strictly', () => {
		expect(parsePanelAction({ op: 'done' })).toEqual({ op: 'done' });
		expect(parsePanelAction({ op: 'snooze', days: 7 })).toEqual({ op: 'snooze', days: 7 });
		expect(typeof parsePanelAction({ op: 'snooze', days: 3 })).toBe('string');
		expect(parsePanelAction({ op: 'dismiss', reason: '  Already called them ' })).toEqual({ op: 'dismiss', reason: 'Already called them' });
		expect(parsePanelAction({ op: 'dismiss' })).toEqual({ op: 'dismiss', reason: '' });
		expect(typeof parsePanelAction({ op: 'dismiss', reason: 'x'.repeat(201) })).toBe('string');
		expect(typeof parsePanelAction({ op: 'send' })).toBe('string');
		expect(typeof parsePanelAction(null)).toBe('string');
	});

	it('next steps are app paths; the draft opening rides along only on reply / email', () => {
		expect(nextStepHref({ type: 'reply', url: '/conversations/k?reply=1' }, 'Thanks, Ana.')).toBe('/conversations/k?reply=1&opening=Thanks%2C%20Ana.');
		expect(nextStepHref({ type: 'email_them', url: '/compose?direct=1&contact=4' }, 'Hi')).toBe('/compose?direct=1&contact=4&opening=Hi');
		expect(nextStepHref({ type: 'open_deal', url: '/contacts/4#pipeline' }, 'Hi')).toBe('/contacts/4#pipeline');
		expect(nextStepHref({ type: 'reply', url: '/conversations/k' }, null)).toBe('/conversations/k');
		expect(nextStepHref({ type: 'reply', url: 'https://elsewhere.invalid/x' }, null)).toBe('/');
		expect(nextStepHref({ type: 'reply', url: '//elsewhere.invalid/x' }, null)).toBe('/');
		expect(allSteps({ type: 'a', label: 'A', url: '/a', more: [{ type: 'b', label: 'B', url: '/b' }] }).map((s) => s.type)).toEqual(['a', 'b']);
		expect(allSteps(null)).toEqual([]);
		expect(readOpening(new URLSearchParams(`opening=${'x'.repeat(OPENING_MAX + 50)}`)).length).toBe(OPENING_MAX);
	});

	it('carousel, swipe, hidden paths, memory and the once-per-session pop-up', () => {
		expect(wrapIndex(-1, 3)).toBe(2);
		expect(wrapIndex(3, 3)).toBe(0);
		expect(wrapIndex(5, 0)).toBe(0);
		expect(swipeDirection(-80, 5)).toBe(-1);
		expect(swipeDirection(80, 5)).toBe(1);
		expect(swipeDirection(20, 0)).toBe(0);
		expect(swipeDirection(-80, 90)).toBe(0);
		for (const p of ['/compose', '/login', '/setup', '/f/signup', '/p/page', '/newsletter/x', '/unsubscribe', '/confirm/t', '/reset']) expect(panelHiddenOn(p)).toBe(true);
		for (const p of ['/', '/contacts/4', '/composer-notes', '/automations']) expect(panelHiddenOn(p)).toBe(false);
		expect(readMemory('junk')).toEqual({ minimized: false, seen: '' });
		expect(readMemory(JSON.stringify({ minimized: true, seen: '2026-11-20 10:00:00' }))).toEqual({ minimized: true, seen: '2026-11-20 10:00:00' });
		const memory = { minimized: true, seen: '2026-11-20 10:00:00' };
		expect(shouldAutoOpen({ count: 2, latest: '2026-11-21 10:00:00', memory, openedThisSession: false })).toBe(true);
		expect(shouldAutoOpen({ count: 2, latest: '2026-11-21 10:00:00', memory, openedThisSession: true })).toBe(false);
		expect(shouldAutoOpen({ count: 2, latest: '2026-11-19 10:00:00', memory, openedThisSession: false })).toBe(false);
		expect(shouldAutoOpen({ count: 0, latest: '2026-11-21 10:00:00', memory, openedThisSession: false })).toBe(false);
		expect(countLabel(1)).toBe('1 suggestion');
		expect(countLabel(4)).toBe('4 suggestions');
	});
});

describe('load', () => {
	it('the pill count: null when off or not open to the user; team + mine otherwise', async () => {
		const { member } = await seed();
		expect(await panelSummary(db, { id: member, role: 'member' })).toBeNull();
		const admin = (await panelSummary(db, ADMIN))!;
		expect(admin.count).toBe(2);
		expect(admin.latest).toBeTruthy();
		await setConfig(cfg((c) => (c.audience = 'everyone')));
		expect((await panelSummary(db, { id: member, role: 'member' }))!.count).toBe(1); // the deal is the admin's
		await setConfig({ enabled: false });
		expect(await panelSummary(db, ADMIN)).toBeNull();
		expect(await panelSummary(db, null)).toBeNull();
	});

	it('cards carry a subject link; unsubscribed / archived subjects never appear', async () => {
		const { ana, ben } = await seed();
		const viewer = (await suggestionViewer(db, ADMIN))!;
		const items = await panelSuggestions(db, viewer);
		expect(items.map((i) => [i.rule, i.subject_url])).toEqual([
			['awaiting_reply', `/contacts/${ana}`],
			['stalled_deal', `/contacts/${ben}#pipeline`]
		]);
		expect(items[0].action?.url).toMatch(/^\/conversations\/.+\?reply=1$/);
		expect(items[1].action?.more?.[0].url).toBe(`/compose?direct=1&contact=${ben}`);
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(ana).run();
		await db.prepare(`UPDATE contacts SET archived_at = datetime('now') WHERE id = ?`).bind(ben).run();
		expect(await panelSuggestions(db, viewer)).toEqual([]);
	});

	it('GET /api/suggestions: session-gated, 403 when off or not open, the cards otherwise', async () => {
		const { member } = await seed();
		expect(await statusOf(() => listGET(ev(null)))).toBe(401);
		expect(await statusOf(() => listGET(ev({ id: member, role: 'member' })))).toBe(403);
		const res = await listGET(ev(ADMIN));
		const body = JSON.parse(await res.text());
		expect(body.count).toBe(2);
		expect(body.items[0]).not.toHaveProperty('input_hash');
		expect(body.items[0].evidence.every((e: object) => !('ref' in e))).toBe(true);
	});

	it('the layout returns the count only and never fails the page; the panel mounts from it', () => {
		expect(layoutServer).toContain('panelSummary(db, locals.user)');
		expect(layoutServer).toMatch(/try \{\s*suggestions = await panelSummary/);
		expect(layoutSvelte).toContain('<SuggestionsPanel summary={data.suggestions}');
		expect(layoutSvelte).toContain('aboveFab={data.showAssistant}');
	});
});

describe('actions', () => {
	it('Done / Dismiss close it for the team (closed_by user + who); Snooze hides it until then', async () => {
		await seed();
		const viewer = (await suggestionViewer(db, ADMIN))!;
		const [a, b] = await panelSuggestions(db, viewer);
		expect(await applyPanelAction(db, viewer, a.id, { op: 'dismiss', reason: 'Already called them' }, now)).toEqual({ ok: true, status: 'dismissed' });
		const row = (await db.prepare('SELECT * FROM suggestions WHERE id = ?').bind(a.id).first<any>())!;
		expect([row.status, row.closed_by, row.closed_by_user_id, row.dismiss_reason]).toEqual(['dismissed', 'user', 1, 'Already called them']);
		expect(row.closed_at).toBeTruthy();
		// Already closed → 409, nothing changes.
		expect(await applyPanelAction(db, viewer, a.id, { op: 'done' }, now)).toMatchObject({ ok: false, status: 409 });
		expect(await applyPanelAction(db, viewer, b.id, { op: 'snooze', days: 7 }, now)).toEqual({ ok: true, status: 'snoozed' });
		const snoozed = (await db.prepare('SELECT status, snooze_until, closed_by FROM suggestions WHERE id = ?').bind(b.id).first<any>())!;
		expect(snoozed.status).toBe('snoozed');
		expect(snoozed.closed_by).toBeNull();
		expect(Date.parse(snoozed.snooze_until.replace(' ', 'T') + 'Z') - now.getTime()).toBeGreaterThan(6.9 * DAY);
		expect((await panelSummary(db, ADMIN))!.count).toBe(0);
		// The cooldown applies on the next rules pass: a dismissed one doesn't come back.
		await runSuggestions(db, { now, force: true });
		expect((await db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE rule = 'awaiting_reply' AND status = 'open'`).first<{ n: number }>())!.n).toBe(0);
	});

	it("someone else's suggestion (assigned to another user) is not actionable from a panel", async () => {
		const { member } = await seed();
		await setConfig(cfg((c) => (c.audience = 'everyone')));
		const m = (await suggestionViewer(db, { id: member, role: 'member' }))!;
		const deal = (await db.prepare(`SELECT id FROM suggestions WHERE rule = 'stalled_deal'`).first<{ id: number }>())!.id;
		expect(await applyPanelAction(db, m, deal, { op: 'done' }, now)).toMatchObject({ ok: false, status: 404 });
	});

	it('POST /api/suggestions/<id>: session-gated, validated, a status change only', async () => {
		const { member } = await seed();
		const sid = (await db.prepare(`SELECT id FROM suggestions WHERE rule = 'awaiting_reply'`).first<{ id: number }>())!.id;
		expect(await statusOf(() => actPOST(ev(null, { id: String(sid), body: { op: 'done' } })))).toBe(401);
		expect(await statusOf(() => actPOST(ev({ id: member, role: 'member' }, { id: String(sid), body: { op: 'done' } })))).toBe(403);
		expect(await statusOf(() => actPOST(ev(ADMIN, { id: 'x', body: { op: 'done' } })))).toBe(400);
		expect(await statusOf(() => actPOST(ev(ADMIN, { id: String(sid), raw: 'not json' })))).toBe(400);
		expect(await statusOf(() => actPOST(ev(ADMIN, { id: String(sid), body: { op: 'snooze', days: 2 } })))).toBe(400);
		expect(await statusOf(() => actPOST(ev(ADMIN, { id: '999999', body: { op: 'done' } })))).toBe(404);
		const res = await actPOST(ev(ADMIN, { id: String(sid), body: { op: 'done' } }));
		expect(JSON.parse(await res.text())).toEqual({ ok: true, status: 'done' });
		expect(await statusOf(() => actPOST(ev(ADMIN, { id: String(sid), body: { op: 'done' } })))).toBe(409);
	});
});

describe('panel markup', () => {
	it('real buttons, a polite count, a focus-trapped dialog, Escape, reduced motion, a phone sheet', () => {
		expect(panelSvelte).toContain('aria-live="polite"');
		expect(panelSvelte).toContain('role="dialog"');
		expect(panelSvelte).toContain('aria-modal="true"');
		expect(panelSvelte).toContain("e.key === 'Escape'");
		expect(panelSvelte).toContain("e.key !== 'Tab'");
		expect(panelSvelte).toContain('prefers-reduced-motion: no-preference');
		expect(panelSvelte).toContain('@media (max-width: 768px)');
		expect(panelSvelte).toContain('--sticky-actions-bottom');
		expect(panelSvelte).toContain('safe-area-inset-bottom');
		expect(panelSvelte).toMatch(/aria-label="Previous suggestion"/);
		expect(panelSvelte).toMatch(/aria-label="Next suggestion"/);
		// The only write is the status endpoint; a next step is a plain link.
		expect([...panelSvelte.matchAll(/fetch\(`?'?([^`'),]+)/g)].map((m) => m[1])).toEqual(['/api/suggestions', '/api/suggestions/${id}']);
	});
});

// Structural: the panel's server code never sends, schedules, activates or enrolls.
const sources = import.meta.glob(['../src/lib/**/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
function resolve(from: string, spec: string): string | null {
	let b: string;
	if (spec.startsWith('$lib/')) b = `../src/lib/${spec.slice(5)}`;
	else if (spec.startsWith('.')) {
		const parts = from.split('/').slice(0, -1);
		for (const seg of spec.split('/')) {
			if (seg === '..') parts.pop();
			else if (seg !== '.') parts.push(seg);
		}
		b = parts.join('/');
	} else return null;
	b = b.replace(/\.ts$/, '');
	for (const c of [b, `${b}.ts`, `${b}/index.ts`]) if (c in sources) return c;
	return null;
}
function graph(entries: string[]): Set<string> {
	const seen = new Set<string>();
	const stack = [...entries];
	while (stack.length) {
		const f = stack.pop()!;
		if (seen.has(f)) continue;
		seen.add(f);
		const text = sources[f] ?? '';
		for (const m of text.matchAll(/(?:import|export)\s(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g)) {
			const r = resolve(f, m[1]);
			if (r) stack.push(r);
		}
		for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
			const r = resolve(f, m[1]);
			if (r) stack.push(r);
		}
	}
	return seen;
}

describe('structural: the panel never sends, schedules, activates or enrolls', () => {
	it('panel.ts and the helpers reach no engine, send, postmark, scheduler, bulk write or ai/', () => {
		const g = graph(['../src/lib/server/suggestions/panel.ts', '../src/lib/suggestions-panel.ts']);
		expect(g.has('../src/lib/server/suggestions/visibility.ts')).toBe(true);
		const banned = ['automations', 'automation-enroll', 'automation-bulk', 'send', 'postmark', 'scheduled', 'resend', 'best-time', 'contact-bulk', 'contact-write'].map(
			(f) => `../src/lib/server/${f}.ts`
		);
		expect([...g].filter((f) => banned.includes(f) || /\/ai\//.test(f) || /\/mail\//.test(f))).toEqual([]);
	});
});
