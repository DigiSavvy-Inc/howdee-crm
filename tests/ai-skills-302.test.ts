// #302: assistant skills — operator-editable instructions (always-on + on-demand via
// load_skill), seeded starters, Settings → Assistant → Skills (admin-only).
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import {
	ALWAYS_ON_TOKEN_WARN,
	SKILL_BODY_MAX,
	alwaysOnSize,
	estimateTokens,
	skillTitle,
	validateSkill
} from '../src/lib/ai-skills';
import { createSkill, deleteSkill, listSkills, promptSkills, setSkillEnabled } from '../src/lib/server/ai/skills';
import { skillsSection, systemPrompt, withSkills } from '../src/lib/server/ai/system';
import { runTool, toolByName } from '../src/lib/server/ai/tools';
import { threadToItems, toolLabel } from '../src/lib/assistant-view';
import * as listPage from '../src/routes/settings/assistant/skills/+page.server';
import * as editPage from '../src/routes/settings/assistant/skills/[id]/+page.server';

const db = (env as any).DB as D1Database;

let admin: any;
let member: any;

function sessionUser(u: { id: number; github_login: string; role: 'admin' | 'member' }) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function makeUser(login: string, role: 'admin' | 'member') {
	const r = await db.prepare('INSERT INTO users (github_login, role) VALUES (?, ?) RETURNING id').bind(login, role).first<{ id: number }>();
	return sessionUser({ id: r!.id, github_login: login, role });
}

beforeAll(async () => {
	admin = await makeUser(`skills-admin-${Date.now()}`, 'admin');
	member = await makeUser(`skills-member-${Date.now()}`, 'member');
});

function ev(path: string, action: string | null, opts: { user: any; params?: Record<string, string>; form?: Record<string, string> }) {
	const url = new URL(`https://app.test${path}${action ? `?/${action}` : ''}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(opts.form ?? {})) fd.append(k, v);
	return {
		url,
		params: opts.params ?? {},
		request: new Request(url, action ? { method: 'POST', body: fd } : undefined),
		locals: { user: opts.user, authed: !!opts.user },
		platform: { env: env as any }
	} as any;
}

async function thrown(fn: () => Promise<unknown>): Promise<any> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	return null;
}

const ctx = () => ({ db, user: member, baseUrl: 'https://app.test', now: new Date() });

describe('validation (#302)', () => {
	const ok = { name: 'campaign-strategy', description: 'When to use it.', body: 'Do this.', mode: 'on_demand', enabled: 'on' };

	it('accepts a slug name and normalises case and whitespace', () => {
		const v = validateSkill({ ...ok, name: '  Campaign-Strategy ' });
		expect(v).toMatchObject({ ok: true, skill: { name: 'campaign-strategy', mode: 'on_demand', enabled: true } });
	});

	it('rejects names that are not slug-safe', () => {
		for (const name of ['', 'has space', 'under_score', '-lead', 'trail-', 'dou--ble', '9start', 'émoji', 'a/b']) {
			expect(validateSkill({ ...ok, name }).ok, name).toBe(false);
		}
		expect(validateSkill({ ...ok, name: 'a'.repeat(65) }).ok).toBe(false);
		expect(validateSkill({ ...ok, name: 'a2-b3' }).ok).toBe(true);
	});

	it('enforces description ≤ 200, body ≤ 20k, a known mode', () => {
		expect(validateSkill({ ...ok, description: '' }).ok).toBe(false);
		expect(validateSkill({ ...ok, description: 'x'.repeat(200) }).ok).toBe(true);
		expect(validateSkill({ ...ok, description: 'x'.repeat(201) }).ok).toBe(false);
		expect(validateSkill({ ...ok, body: '   ' }).ok).toBe(false);
		expect(validateSkill({ ...ok, body: 'x'.repeat(SKILL_BODY_MAX) }).ok).toBe(true);
		expect(validateSkill({ ...ok, body: 'x'.repeat(SKILL_BODY_MAX + 1) }).ok).toBe(false);
		expect(validateSkill({ ...ok, mode: 'sometimes' }).ok).toBe(false);
		expect(validateSkill({ ...ok, enabled: undefined })).toMatchObject({ ok: true, skill: { enabled: false } });
	});
});

describe('size warning maths (#302)', () => {
	it('estimates chars / 4 rounded up over enabled always-on skills only', () => {
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(1)).toBe(1);
		expect(estimateTokens(4000)).toBe(1000);
		expect(estimateTokens(4001)).toBe(1001);
		const s = alwaysOnSize([
			{ mode: 'always', enabled: true, chars: 1000 },
			{ mode: 'always', enabled: false, chars: 50_000 },
			{ mode: 'on_demand', enabled: true, chars: 50_000 },
			{ mode: 'always', enabled: 1, chars: 3 }
		]);
		expect(s).toEqual({ chars: 1003, tokens: 251, warn: false });
	});

	it('warns only above ~6k tokens', () => {
		expect(alwaysOnSize([{ mode: 'always', enabled: true, chars: ALWAYS_ON_TOKEN_WARN * 4 }]).warn).toBe(false);
		expect(alwaysOnSize([{ mode: 'always', enabled: true, chars: ALWAYS_ON_TOKEN_WARN * 4 + 1 }]).warn).toBe(true);
	});
});

describe('seeded starters (#302)', () => {
	it('exist after migrate, enabled, in order', async () => {
		const rows = await listSkills(db);
		const byName = new Map(rows.map((r) => [r.name, r]));
		expect(byName.get('answer-style')).toMatchObject({ mode: 'always', enabled: 1 });
		for (const n of ['campaign-strategy', 'deliverability-triage', 'crm-data-guide']) {
			expect(byName.get(n), n).toMatchObject({ mode: 'on_demand', enabled: 1 });
			expect(byName.get(n)!.body.length).toBeGreaterThan(500);
			expect(byName.get(n)!.description.length).toBeLessThanOrEqual(200);
		}
		expect(byName.get('campaign-strategy')!.body).toContain('0.1%');
		expect(byName.get('answer-style')!.body).toContain('50');
	});
});

describe('system prompt (#302)', () => {
	it('includes always-on bodies and the on-demand index, not disabled skills', async () => {
		const always = await createSkill(db, { name: 'zz-house-voice', description: 'Voice.', body: 'Always sign off with CHEERS-302.', mode: 'always', enabled: true }, admin.id);
		const od = await createSkill(db, { name: 'zz-pricing-help', description: 'Use for pricing questions.', body: 'SECRET-OD-BODY', mode: 'on_demand', enabled: true }, admin.id);
		const off = await createSkill(db, { name: 'zz-disabled-one', description: 'Hidden.', body: 'DISABLED-BODY', mode: 'always', enabled: false }, admin.id);
		const offOd = await createSkill(db, { name: 'zz-disabled-od', description: 'Hidden OD.', body: 'x', mode: 'on_demand', enabled: false }, admin.id);
		try {
			const skills = await promptSkills(db);
			const base = systemPrompt({ appName: 'App', timezone: 'UTC', today: '2026-10-17', userLogin: 'me' });
			const prompt = withSkills(base, skills);
			expect(prompt.startsWith(base)).toBe(true);
			expect(prompt).toContain('# Your skills');
			expect(prompt).toMatch(/trusted/);
			expect(prompt).toContain('Always sign off with CHEERS-302.');
			expect(prompt).toContain('- zz-pricing-help: Use for pricing questions.');
			expect(prompt).not.toContain('SECRET-OD-BODY');
			expect(prompt).not.toContain('DISABLED-BODY');
			expect(prompt).not.toContain('zz-disabled-one');
			expect(prompt).not.toContain('zz-disabled-od');
			// Starters too, in sort order: answer-style body before the index.
			expect(prompt).toContain('## Skill: answer-style');
			expect(prompt.indexOf('- campaign-strategy:')).toBeLessThan(prompt.indexOf('- deliverability-triage:'));
			// Deterministic.
			expect(withSkills(base, await promptSkills(db))).toBe(prompt);
		} finally {
			for (const r of [always, od, off, offOd]) if (r.ok) await deleteSkill(db, r.id);
		}
	});

	it('adds nothing when there are no enabled skills', () => {
		expect(skillsSection({ always: [], onDemand: [] })).toBe('');
		expect(withSkills('BASE', { always: [], onDemand: [] })).toBe('BASE');
	});
});

describe('load_skill (#302)', () => {
	it('is a read tool that returns the body, case-insensitive on name', async () => {
		expect(toolByName('load_skill')?.tier).toBe('read');
		const r = await runTool(ctx(), 'load_skill', { name: 'Campaign-Strategy' });
		expect(r.ok).toBe(true);
		const v = JSON.parse(r.content);
		expect(v).toMatchObject({ name: 'campaign-strategy', mode: 'on_demand' });
		expect(v.instructions).toContain('0.1%');
		expect(r.summary).toBe('Campaign strategy');
	});

	it('errors clearly for unknown, disabled or missing names', async () => {
		const unknown = await runTool(ctx(), 'load_skill', { name: 'no-such-skill' });
		expect(unknown.ok).toBe(false);
		expect(unknown.content).toContain('No enabled skill named "no-such-skill"');
		expect(unknown.content).toContain('campaign-strategy');

		const c = await createSkill(db, { name: 'zz-turned-off', description: 'x', body: 'OFF-BODY', mode: 'on_demand', enabled: true }, admin.id);
		if (!c.ok) throw new Error(c.error);
		try {
			expect((await runTool(ctx(), 'load_skill', { name: 'zz-turned-off' })).ok).toBe(true);
			await setSkillEnabled(db, c.id, false, admin.id);
			const off = await runTool(ctx(), 'load_skill', { name: 'zz-turned-off' });
			expect(off.ok).toBe(false);
			expect(off.content).not.toContain('OFF-BODY');
			expect(off.content).not.toContain('zz-turned-off.'); // not listed as available
		} finally {
			await deleteSkill(db, c.id);
		}
		expect(await runTool(ctx(), 'load_skill', {})).toMatchObject({ ok: false, content: '"name" is required.' });
	});
});

describe('panel label (#302)', () => {
	it('reads "Used skill: Campaign strategy"', () => {
		expect(skillTitle('campaign-strategy')).toBe('Campaign strategy');
		expect(toolLabel({ name: 'load_skill', summary: 'Campaign strategy' })).toBe('Used skill: Campaign strategy');
		expect(toolLabel({ name: 'get_dashboard', summary: 'dashboard tiles' })).toBe('Read the dashboard');
		const items = threadToItems([
			{ kind: 'assistant', id: 1, text: '', tools: [{ id: 't1', name: 'load_skill', skill: 'deliverability-triage' }], at: '', costMicros: 0, tokens: 0 },
			{ kind: 'tool', id: 2, results: [{ tool_use_id: 't1', ok: true, preview: '' }], at: '' }
		]);
		const tool = (items[0] as any).tools[0];
		expect(toolLabel(tool)).toBe('Used skill: Deliverability triage');
	});
});

describe('Settings → Assistant → Skills is admin-only (#302)', () => {
	it('members get 403 on load and every action', async () => {
		expect((await thrown(() => listPage.load(ev('/settings/assistant/skills', null, { user: member })) as any))?.status).toBe(403);
		expect((await thrown(() => editPage.load(ev('/settings/assistant/skills/new', null, { user: member, params: { id: 'new' } })) as any))?.status).toBe(403);
		for (const a of ['toggle', 'move', 'duplicate', 'delete'] as const) {
			const r: any = await (listPage.actions as any)[a](ev('/settings/assistant/skills', a, { user: member, form: { id: '1' } }));
			expect(r?.status, a).toBe(403);
		}
		const r: any = await (editPage.actions as any).save(
			ev('/settings/assistant/skills/new', 'save', { user: member, params: { id: 'new' }, form: { name: 'nope', description: 'x', body: 'y', mode: 'always' } })
		);
		expect(r?.status).toBe(403);
		expect((await listSkills(db)).some((s) => s.name === 'nope')).toBe(false);
	});

	it('admins create, edit, toggle, reorder, duplicate and delete', async () => {
		const loaded: any = await listPage.load(ev('/settings/assistant/skills', null, { user: admin }) as any);
		expect(loaded.skills.some((s: any) => s.name === 'answer-style')).toBe(true);

		// Create → redirect to the editor.
		const created = await thrown(() =>
			(editPage.actions as any).save(
				ev('/settings/assistant/skills/new', 'save', {
					user: admin,
					params: { id: 'new' },
					form: { name: 'ZZ-Admin-Made', description: 'For tests.', body: 'Body one.', mode: 'on_demand', enabled: 'on' }
				})
			)
		);
		expect(created?.status).toBe(303);
		const row = (await listSkills(db)).find((s) => s.name === 'zz-admin-made')!;
		expect(row).toMatchObject({ created_by: admin.id, enabled: 1, body: 'Body one.' });

		// Validation and duplicate names come back as 400 with the values kept.
		const bad: any = await (editPage.actions as any).save(
			ev(`/settings/assistant/skills/${row.id}`, 'save', { user: admin, params: { id: String(row.id) }, form: { name: 'bad name', description: 'x', body: 'y', mode: 'always' } })
		);
		expect(bad.status).toBe(400);
		expect(bad.data.values.name).toBe('bad name');
		const dup: any = await (editPage.actions as any).save(
			ev(`/settings/assistant/skills/${row.id}`, 'save', { user: admin, params: { id: String(row.id) }, form: { name: 'Answer-Style', description: 'x', body: 'y', mode: 'always' } })
		);
		expect(dup.status).toBe(400);
		expect(dup.data.error).toContain('already exists');

		// Edit.
		const saved: any = await (editPage.actions as any).save(
			ev(`/settings/assistant/skills/${row.id}`, 'save', {
				user: admin,
				params: { id: String(row.id) },
				form: { name: 'zz-admin-made', description: 'Edited.', body: 'Body two.', mode: 'always' }
			})
		);
		expect(saved).toEqual({ saved: true });
		const edited: any = await editPage.load(ev(`/settings/assistant/skills/${row.id}`, null, { user: admin, params: { id: String(row.id) } }) as any);
		expect(edited.skill).toMatchObject({ description: 'Edited.', body: 'Body two.', mode: 'always', enabled: false, updated_by_login: admin.github_login });
		expect((await thrown(() => editPage.load(ev('/settings/assistant/skills/999999', null, { user: admin, params: { id: '999999' } })) as any))?.status).toBe(404);

		// Toggle.
		await (listPage.actions as any).toggle(ev('/settings/assistant/skills', 'toggle', { user: admin, form: { id: String(row.id), enabled: '1' } }));
		expect((await listSkills(db)).find((s) => s.id === row.id)!.enabled).toBe(1);

		// Reorder: it's last; move it up one.
		const before = (await listSkills(db)).map((s) => s.id);
		const at = before.indexOf(row.id);
		await (listPage.actions as any).move(ev('/settings/assistant/skills', 'move', { user: admin, form: { id: String(row.id), dir: 'up' } }));
		const after = (await listSkills(db)).map((s) => s.id);
		expect(after.indexOf(row.id)).toBe(at - 1);

		// Duplicate: a disabled copy right after the original.
		const d: any = await (listPage.actions as any).duplicate(ev('/settings/assistant/skills', 'duplicate', { user: admin, form: { id: String(row.id) } }));
		expect(d.done).toContain('zz-admin-made-copy');
		const list = await listSkills(db);
		const copy = list.find((s) => s.name === 'zz-admin-made-copy')!;
		expect(copy).toMatchObject({ enabled: 0, body: 'Body two.', mode: 'always' });
		expect(list.findIndex((s) => s.id === copy.id)).toBe(list.findIndex((s) => s.id === row.id) + 1);

		// Delete.
		for (const id of [row.id, copy.id]) {
			const r: any = await (listPage.actions as any).delete(ev('/settings/assistant/skills', 'delete', { user: admin, form: { id: String(id) } }));
			expect(r.done).toBe('Skill deleted.');
		}
		expect((await listSkills(db)).some((s) => s.name.startsWith('zz-admin-made'))).toBe(false);
	});
});
