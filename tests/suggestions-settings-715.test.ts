import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import * as page from '../src/routes/settings/suggestions/+page.server';
import * as account from '../src/routes/account/+page.server';
import {
	GENERAL_LIMITS,
	RULE_KEYS,
	RULE_THRESHOLDS,
	SUGGESTION_KINDS,
	defaultSuggestionsConfig,
	suggestionsConfigFromForm,
	suggestionsConfigProblems,
	type SuggestionsConfig
} from '../src/lib/suggestions';
import { CONFIG_KEY, RULES_AT_KEY, getSuggestionsConfig } from '../src/lib/server/suggestions/config';
import { suggestionsModelLine } from '../src/lib/server/suggestions/settings';
import { setSuggestionsPanel, suggestionsPanelOn } from '../src/lib/server/suggestions/panel-pref';
import { suggestionViewer } from '../src/lib/server/suggestions/visibility';
import { runSuggestions } from '../src/lib/server/suggestions/engine';

// #715: Settings → Suggestions (admin only, every threshold checked against its range) and the
// per-user Account → Show the suggestions panel toggle (migration 0135).

const db = (env as any).DB as D1Database;
const admin = { id: 1, github_login: 'ourco-admin', role: 'admin', navLayout: 'top' };
const DAY = 86_400_000;

function ev(path: string, user: unknown, fields: Record<string, string> = {}) {
	const url = new URL(`https://crm.myapp.example${path}`);
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		request: new Request(url, { method: 'POST', body, headers: { origin: url.origin } }),
		platform: { env },
		url,
		params: {},
		depends: () => {},
		locals: { user, authed: !!user }
	} as any;
}

async function status(p: Promise<unknown>): Promise<number | undefined> {
	try {
		const r = (await p) as { status?: number } | undefined;
		return r?.status;
	} catch (e) {
		return (e as { status?: number }).status;
	}
}

/** The form a browser posts for `c` (checkbox fields only when ticked). */
function formFor(c: SuggestionsConfig): Record<string, string> {
	const f: Record<string, string> = {
		cooldown_days: String(c.cooldown_days),
		daily_cap: String(c.daily_cap),
		audience: c.audience,
		score_id: c.score_id === null ? '' : String(c.score_id)
	};
	if (c.enabled) f.enabled = '1';
	if (c.use_ai) f.use_ai = '1';
	for (const k of SUGGESTION_KINDS) if (c.kinds[k]) f[`kind_${k}`] = '1';
	for (const r of RULE_KEYS) {
		if (c.rules[r].on) f[`rule_${r}_on`] = '1';
		for (const t of RULE_THRESHOLDS[r]) f[`rule_${r}_${t.key}`] = String(c.rules[r][t.key]);
	}
	return f;
}
function on(over: (c: SuggestionsConfig) => void = () => {}): SuggestionsConfig {
	const c = defaultSuggestionsConfig();
	c.enabled = true;
	over(c);
	return c;
}
async function storedConfig(): Promise<string | null> {
	return (await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(CONFIG_KEY).first<{ value: string }>())?.value ?? null;
}
async function newUser(login: string, role: 'admin' | 'member') {
	return (await db.prepare(`INSERT INTO users (github_login, role) VALUES (?, ?) RETURNING id`).bind(login, role).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'suggestions_%'`),
		db.prepare('DELETE FROM suggestions'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('UPDATE users SET suggestions_panel = 1'),
		db.prepare(`DELETE FROM users WHERE github_login LIKE '%-715'`)
	]);
});

describe('Settings → Suggestions is admin only', () => {
	it('a member gets 403 on the load and the save; nothing is written', async () => {
		const member = { id: await newUser('jdoe-715', 'member'), github_login: 'jdoe-715', role: 'member', navLayout: 'top' };
		expect(await status(page.load(ev('/settings/suggestions', member)) as Promise<unknown>)).toBe(403);
		expect(await status(page.actions.save(ev('/settings/suggestions?/save', member, formFor(on()))) as Promise<unknown>)).toBe(403);
		expect(await status(page.load(ev('/settings/suggestions', null)) as Promise<unknown>)).toBe(403);
		expect(await storedConfig()).toBeNull();
	});

	it('an admin loads the defaults (off) and the model line says rules only', async () => {
		const data = (await page.load(ev('/settings/suggestions', admin))) as any;
		expect(data.cfg).toEqual(defaultSuggestionsConfig());
		expect(data.cfg.enabled).toBe(false);
		expect(data.modelLine.model).toBeNull();
		expect(suggestionsModelLine(on((c) => (c.use_ai = false))).text).toBe('Use AI is off.');
	});
});

describe('saving', () => {
	it('the form round-trips every field; a save stores it and asks the next tick for a rules pass', async () => {
		const want = on((c) => {
			c.kinds.marketing = false;
			c.rules.stalled_deal.on = false;
			c.rules.awaiting_reply.hours = 24;
			c.rules.group_unmailed.min_members = 1500;
			c.audience = 'everyone';
			c.cooldown_days = 7;
			c.daily_cap = 50;
			c.use_ai = false;
		});
		const raw = suggestionsConfigFromForm((k) => formFor(want)[k] ?? null);
		expect(suggestionsConfigProblems(raw)).toEqual([]);
		await db.prepare(`INSERT INTO app_state (key, value) VALUES (?, '2026-01-01 00:00:00')`).bind(RULES_AT_KEY).run();
		const res = (await page.actions.save(ev('/settings/suggestions?/save', admin, formFor(want)))) as any;
		expect(res.saved).toBe(true);
		expect(await getSuggestionsConfig(db)).toEqual(want);
		expect(await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(RULES_AT_KEY).first()).toBeNull();
	});

	it('every threshold is checked: below, above, blank and fractional values are refused with the range', async () => {
		const cases: [string, number, number][] = [];
		for (const r of RULE_KEYS) for (const t of RULE_THRESHOLDS[r]) cases.push([`rule_${r}_${t.key}`, t.min, t.max]);
		cases.push(['cooldown_days', GENERAL_LIMITS.cooldown_days.min, GENERAL_LIMITS.cooldown_days.max]);
		cases.push(['daily_cap', GENERAL_LIMITS.daily_cap.min, GENERAL_LIMITS.daily_cap.max]);
		for (const [field, min, max] of cases) {
			const path = field.startsWith('rule_')
				? (() => {
						const r = RULE_KEYS.find((k) => field.startsWith(`rule_${k}_`))!;
						return `rules.${r}.${field.slice(`rule_${r}_`.length)}`;
					})()
				: field;
			for (const bad of [String(min - 1), String(max + 1), '', '2.5', 'abc']) {
				const res = (await page.actions.save(ev('/settings/suggestions?/save', admin, { ...formFor(on()), [field]: bad }))) as any;
				expect(res.status, `${field}=${bad}`).toBe(400);
				expect(res.data.problems.map((p: { path: string }) => p.path), `${field}=${bad}`).toContain(path);
				expect(res.data.problems.find((p: { path: string }) => p.path === path).message).toContain(`from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}`);
			}
			// The bounds themselves are accepted.
			for (const good of [min, max]) {
				const raw = suggestionsConfigFromForm((k) => ({ ...formFor(on()), [field]: String(good) })[k] ?? null);
				expect(suggestionsConfigProblems(raw), `${field}=${good}`).toEqual([]);
			}
		}
		expect(await storedConfig()).toBeNull();
	});

	it('the score must be an active one; an unknown audience is refused', async () => {
		const res = (await page.actions.save(ev('/settings/suggestions?/save', admin, { ...formFor(on()), score_id: '987654' }))) as any;
		expect(res.status).toBe(400);
		expect(res.data.problems).toContainEqual({ path: 'score_id', message: 'Pick an active score.' });
		const lead = await db.prepare(`SELECT id FROM score_defs WHERE slug = 'lead-score'`).first<{ id: number }>();
		if (lead) {
			const ok = (await page.actions.save(ev('/settings/suggestions?/save', admin, { ...formFor(on()), score_id: String(lead.id) }))) as any;
			expect(ok.saved).toBe(true);
			expect((await getSuggestionsConfig(db)).score_id).toBe(lead.id);
		}
		const aud = (await page.actions.save(ev('/settings/suggestions?/save', admin, { ...formFor(on()), audience: 'nobody' }))) as any;
		expect(aud.status).toBe(400);
		expect(aud.data.problems.map((p: { path: string }) => p.path)).toContain('audience');
	});

	it('turning it off hides the panel at once and the tick does no suggestions work', async () => {
		await page.actions.save(ev('/settings/suggestions?/save', admin, formFor(on())));
		expect(await suggestionViewer(db, admin)).not.toBeNull();
		const c = (await db.prepare(`INSERT INTO contacts (email, first_name) VALUES ('ana@ourco.example', 'Ana') RETURNING id`).first<{ id: number }>())!.id;
		const at = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 19).replace('T', ' ');
		await db.prepare(`INSERT INTO replies (contact_id, from_email, subject, text, received_at) VALUES (?, 'ana@ourco.example', 'Hi', 'Hi', ?)`).bind(c, at).run();

		await page.actions.save(ev('/settings/suggestions?/save', admin, formFor(on((x) => (x.enabled = false)))));
		expect(await suggestionViewer(db, admin)).toBeNull();
		expect(await runSuggestions(db, { force: true })).toMatchObject({ off: true });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM suggestions').first<{ n: number }>())!.n).toBe(0);

		// Back on: the next tick runs the rules.
		await page.actions.save(ev('/settings/suggestions?/save', admin, formFor(on())));
		const res = await runSuggestions(db);
		expect(res).not.toMatchObject({ off: true });
		expect((await db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE rule = 'awaiting_reply'`).first<{ n: number }>())!.n).toBe(1);
	});
});

describe('Account → Show the suggestions panel', () => {
	it('on by default; turning it off hides the panel for that user only; the assistant can still read', async () => {
		await page.actions.save(ev('/settings/suggestions?/save', admin, formFor(on((c) => (c.audience = 'everyone')))));
		const otherId = await newUser('other-715', 'member');
		const other = { id: otherId, github_login: 'other-715', role: 'member', navLayout: 'top' };

		expect(((await account.load(ev('/account', admin))) as any).suggestionsPanel).toBe(true);
		expect(await suggestionsPanelOn(db, admin.id)).toBe(true);

		const off = (await account.actions.suggestionsPanel(ev('/account?/suggestionsPanel', admin, {}))) as any;
		expect(off.panelOk).toContain('hidden');
		expect(((await account.load(ev('/account', admin))) as any).suggestionsPanel).toBe(false);
		expect(await suggestionViewer(db, admin)).toBeNull();
		expect(await suggestionViewer(db, admin, { panel: false })).not.toBeNull();
		expect(await suggestionViewer(db, other)).not.toBeNull();

		const back = (await account.actions.suggestionsPanel(ev('/account?/suggestionsPanel', admin, { show: '1' }))) as any;
		expect(back.panelOk).toContain('on');
		expect(await suggestionViewer(db, admin)).not.toBeNull();
	});

	it('needs a signed-in user; only touches your own row', async () => {
		expect(await status(account.actions.suggestionsPanel(ev('/account?/suggestionsPanel', null, {})) as Promise<unknown>)).toBe(401);
		const otherId = await newUser('peer-715', 'member');
		await setSuggestionsPanel(db, admin.id, false);
		expect(await suggestionsPanelOn(db, otherId)).toBe(true);
		expect(await suggestionsPanelOn(db, 99_999_715)).toBe(true); // unknown user reads as on
	});
});
