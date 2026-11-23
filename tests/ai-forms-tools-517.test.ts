import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import type { ToolContext, WriteTool } from '../src/lib/server/ai/tools/types';
import { actionForUser, resolvePending, undoAction } from '../src/lib/server/ai/actions';
import { createThread } from '../src/lib/server/ai/threads';
import { listSkills } from '../src/lib/server/ai/skills';
import { systemPrompt } from '../src/lib/server/ai/system';
import { modelInfo } from '../src/lib/ai-models';
import { estimateTokens } from '../src/lib/ai-skills';
import { actionIcon, openLabel } from '../src/lib/assistant-actions';
import { TOOL_LABELS } from '../src/lib/assistant-view';
import { normalizeFormSpec } from '../src/lib/forms';
import { createForm, getForm, recordSubmission } from '../src/lib/server/forms';
import { FORM_EXAMPLES, FORM_SPEC_DOC, prepareFormSpec } from '../src/lib/server/ai/tools/form-input';
import { MCP_TOOLS, toolsForScope } from '../src/lib/server/mcp/tools';

// #517 (Forms 5/7): the assistant reads forms and submissions, drafts forms with logic
// (create_form_draft, Approve first, the form in words on the card) and changes draft forms
// (update_form). It never publishes, unpublishes, archives or deletes a form, and never sets
// allowed origins or the notify webhook.

const db = (env as any).DB as D1Database;
const T = `f${Date.now()}`;
const sonnet = modelInfo('claude-sonnet-5-5')!;

type U = { id: number; github_login: string; role: 'admin' | 'member' };
let member: U;
let seq = 0;

function sessionUser(u: U) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}

const count = async (sql: string, ...binds: unknown[]) => (await one<{ n: number }>(sql, ...binds)).n;

async function freshCtx(): Promise<ToolContext> {
	const threadId = await createThread(db, member.id, sonnet.id, 'medium', 'test');
	return { db, user: sessionUser(member), baseUrl: 'https://app.test', now: new Date(), threadId };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
	return runTool(ctx, name, input, TOOLS, `tu_${++seq}`);
}

async function read(ctx: ToolContext, name: string, input: Record<string, unknown>) {
	const r = await call(ctx, name, input);
	expect(r.ok, r.content).toBe(true);
	return JSON.parse(r.content);
}

async function approve(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return resolvePending(ctx, row!, 'approve', toolByName(row!.tool) as WriteTool);
}

async function undo(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return undoAction(ctx, row!, toolByName(row!.tool) as WriteTool);
}

const formIdOf = (url: string | null) => Number(/\/forms\/(\d+)$/.exec(url ?? '')![1]);

const EMAIL_Q = { type: 'email', key: 'email', label: 'Email', required: true, map: { to: 'contact', field: 'email' } };

/** "Show Platform only when Role is not Developer", with settings the assistant may not set. */
function roleSpec(title: string) {
	return {
		title,
		fields: [
			EMAIL_Q,
			{ type: 'radio', key: 'role', label: 'Role', required: true, options: ['Developer', 'Manager'] },
			{ type: 'short_text', key: 'platform', label: 'Platform', show_when: { match: 'all', rules: [{ field: 'role', op: 'neq', value: 'Developer' }] } }
		],
		outcomes: [
			{ id: 'default', when: null, actions: [{ type: 'message_md', md: 'Thanks!' }] },
			{ id: 'managers', when: { match: 'all', rules: [{ field: 'role', op: 'eq', value: 'Manager' }] }, actions: [{ type: 'add_tag', tag: `manager-${T}` }] }
		],
		settings: { submit_label: 'Send', allowed_origins: ['https://example.com'], notify_webhook: 'https://hooks.example.com/secret' }
	};
}

let published: number;

beforeAll(async () => {
	const id = (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-m`)).id;
	member = { id, github_login: `${T}-m`, role: 'member' };
	await db
		.prepare(
			`INSERT INTO lists (name, kind) SELECT 'Newsletter', 'list'
			 WHERE NOT EXISTS (SELECT 1 FROM lists WHERE kind = 'list' AND name = 'Newsletter' COLLATE NOCASE)`
		)
		.run();

	// A published form with submissions: 2 this week, 1 older, 1 spam.
	published = await createForm(db, `Feedback ${T}`, null);
	const spec = normalizeFormSpec({
		title: 'Feedback',
		fields: [
			EMAIL_Q,
			{ type: 'radio', key: 'role', label: 'Role', options: ['Developer', 'Designer'] },
			{ type: 'checkboxes', key: 'interests', label: 'Interests', options: ['Tips', 'Events'] }
		],
		settings: { notify_webhook: 'https://hooks.example.com/secret-token' }
	});
	await db.prepare("UPDATE forms SET spec = ?, status = 'published', published_at = datetime('now') WHERE id = ?").bind(JSON.stringify(spec), published).run();
	const sub = (email: string, status: 'added' | 'spam', answers: Record<string, unknown>) =>
		recordSubmission(db, { form_id: published, form_version: 1, contact_id: null, email, status, answers: answers as any });
	await sub(`a-${T}@x.co`, 'added', { email: `a-${T}@x.co`, role: 'Developer', interests: ['Tips', 'Events'] });
	await sub(`b-${T}@x.co`, 'added', { email: `b-${T}@x.co`, role: 'Designer', interests: ['Tips'] });
	const old = await sub(`c-${T}@x.co`, 'added', { email: `c-${T}@x.co`, role: 'Developer' });
	await db.prepare("UPDATE form_submissions SET created_at = datetime('now', '-10 days') WHERE id = ?").bind(old).run();
	await sub(`spam-${T}@x.co`, 'spam', { email: `spam-${T}@x.co` });
});

describe('registry', () => {
	it('has the five tools, read and approve, with labels and icons', () => {
		const tiers = Object.fromEntries(TOOLS.filter((t) => /form/.test(t.name)).map((t) => [t.name, t.tier]));
		expect(tiers).toMatchObject({
			list_forms: 'read',
			get_form: 'read',
			get_form_submissions: 'read',
			create_form_draft: 'approve',
			update_form: 'approve'
		});
		for (const n of ['list_forms', 'get_form', 'get_form_submissions', 'create_form_draft', 'update_form']) expect(TOOL_LABELS[n], n).toBeTruthy();
		expect(actionIcon('create_form_draft')).toBe('forms');
		expect(openLabel({ url: 'https://app.test/forms/12' })).toBe('Open in builder');
		// Nothing that publishes, archives or deletes a form.
		expect(TOOLS.map((t) => t.name).filter((n) => /form/.test(n) && /publish|archive|delete|restore|duplicate/.test(n))).toEqual([]);
	});

	it('the spec reference stays under ~1,200 tokens and every worked example saves cleanly', async () => {
		expect(estimateTokens(FORM_SPEC_DOC.length)).toBeLessThanOrEqual(1200);
		const desc = TOOLS.find((t) => t.name === 'create_form_draft')!.description;
		expect(desc).toContain(FORM_SPEC_DOC);
		for (const [key, example] of Object.entries(FORM_EXAMPLES)) {
			const p = await prepareFormSpec(db, example, { name: key, userId: member.id });
			expect(p.ok ? [] : p.problems, key).toEqual([]);
		}
		const nps = await prepareFormSpec(db, FORM_EXAMPLES.nps, { name: 'nps', userId: member.id });
		expect(nps.ok && nps.spec.outcomes[2].actions[1]).toEqual({ type: 'notify', user_ids: [member.id] }); // "me"
		const rsvp = await prepareFormSpec(db, FORM_EXAMPLES.rsvp, { name: 'rsvp', userId: member.id });
		expect(rsvp.ok && rsvp.spec.pages.map((p) => p.id)).toEqual(['start', 'details']);
	});

	it('the system prompt and the Forms skill describe the tools', async () => {
		const prompt = systemPrompt({ appName: 'App', timezone: 'UTC', today: '2026-11-18', userLogin: 'me' });
		expect(prompt).toMatch(/create_form_draft/);
		expect(prompt).toMatch(/publish, unpublish or archive a form/);
		const s = (await listSkills(db)).find((r) => r.name === 'forms');
		expect(s).toMatchObject({ mode: 'on_demand', enabled: 1 });
		expect(s!.body).toMatch(/create_form_draft/);
		expect(s!.body).toMatch(/consent/);
		expect(s!.body).toMatch(/under 8 questions/);
		expect(s!.description.length).toBeLessThanOrEqual(200);
	});
});

describe('read tools', () => {
	it('list_forms: status, submissions this week and in total, links', async () => {
		const ctx = await freshCtx();
		const r = await read(ctx, 'list_forms', {});
		const f = r.forms.find((x: any) => x.id === published);
		expect(f).toMatchObject({
			name: `Feedback ${T}`,
			status: 'published',
			submissions_7d: 2,
			submissions_total: 3,
			url: `https://app.test/forms/${published}`,
			public_url: expect.stringMatching(/^https:\/\/app\.test\/f\//)
		});
		expect((await read(ctx, 'list_forms', { status: 'draft' })).forms.some((x: any) => x.id === published)).toBe(false);
		expect((await call(ctx, 'list_forms', { status: 'nope' })).ok).toBe(false);
	});

	it('get_form: the spec, the outline, never the webhook address', async () => {
		const ctx = await freshCtx();
		const r = await read(ctx, 'get_form', { form_id: published });
		expect(r).toMatchObject({ id: published, status: 'published', editable: false, submissions: 3, notify_webhook: 'set (address not shown)' });
		expect(r.spec.settings.notify_webhook).toBe('');
		expect(JSON.stringify(r)).not.toContain('secret-token');
		expect(r.spec.fields.map((f: any) => f.key)).toEqual(['email', 'role', 'interests']);
		expect(r.outline).toContain('2. “Role” (Multiple choice): Developer / Designer');
		expect((await call(ctx, 'get_form', { form_id: 99999999 })).content).toBe('No form with id 99999999.');
	});

	it('get_form_submissions: key: value lines, filters, counts by option', async () => {
		const ctx = await freshCtx();
		const r = await read(ctx, 'get_form_submissions', { form_id: published });
		expect(r.total).toBe(3);
		expect(r.submissions[0].answers).toEqual([`email: b-${T}@x.co`, 'role: Designer', 'interests: Tips']);
		expect((await read(ctx, 'get_form_submissions', { form_id: published, status: 'hidden' })).submissions.map((s: any) => s.email)).toEqual([`spam-${T}@x.co`]);
		const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
		expect((await read(ctx, 'get_form_submissions', { form_id: published, since: day })).total).toBe(2);
		expect((await read(ctx, 'get_form_submissions', { form_id: published, search: `c-${T}` })).total).toBe(1);
		expect((await call(ctx, 'get_form_submissions', { form_id: published, since: 'soon' })).ok).toBe(false);

		const s = await read(ctx, 'get_form_submissions', { form_id: published, summarize: true, limit: 1 });
		expect(s.submissions).toHaveLength(1);
		expect(s.counted).toBe(3);
		const role = s.summary.find((x: any) => x.key === 'role');
		expect(role).toEqual({ key: 'role', question: 'Role', answered: 3, options: [{ option: 'Developer', count: 2 }, { option: 'Designer', count: 1 }] });
		expect(s.summary.find((x: any) => x.key === 'interests').options).toEqual([
			{ option: 'Tips', count: 2 },
			{ option: 'Events', count: 1 }
		]);
	});
});

describe('create_form_draft', () => {
	it('shows the form in words and waits for Approve; nothing is stored until then', async () => {
		const ctx = await freshCtx();
		const before = await count('SELECT COUNT(*) AS n FROM forms');
		const r = await call(ctx, 'create_form_draft', { name: `Roles ${T}`, spec: roleSpec('Tell us your role') });
		expect(r.pending).toBe(true);
		expect(r.action).toMatchObject({ tool: 'create_form_draft', status: 'pending', icon: 'forms' });
		expect(r.action!.summary).toBe(`Create draft form “Roles ${T}” · 3 questions · 1 conditional outcome`);
		const notes = r.action!.scope!.notes!;
		expect(notes).toContain('2. “Role” (Multiple choice, required): Developer / Manager');
		expect(notes).toContain('   Show “Platform” when Role is not “Developer”');
		expect(notes).toContain(`When Role is “Manager”: add tag “manager-${T}”`);
		expect(notes.some((n) => /Allowed origins were left out/.test(n))).toBe(true);
		expect(notes.some((n) => /notify webhook was left out/.test(n))).toBe(true);
		expect(await count('SELECT COUNT(*) AS n FROM forms')).toBe(before);
	});

	it('Approve creates a draft (no origins, no webhook) with an Open in builder link; Undo deletes it', async () => {
		const ctx = await freshCtx();
		const r = await call(ctx, 'create_form_draft', { name: `Roles ${T} b`, spec: roleSpec('Roles') });
		const done = await approve(ctx, r.action!.id);
		expect(done.ok && done.card.status).toBe('approved');
		const card = done.ok ? done.card : null;
		expect(openLabel(card!)).toBe('Open in builder');
		const id = formIdOf(card!.url);
		const f = (await getForm(db, id))!;
		expect(f).toMatchObject({ name: `Roles ${T} b`, status: 'draft' });
		expect(f.spec.settings.allowed_origins).toEqual([]);
		expect(f.spec.settings.notify_webhook).toBe('');
		expect(f.spec.fields[2].show_when).toEqual({ match: 'all', rules: [{ field: 'role', op: 'neq', value: 'Developer' }] });

		const u = await undo(ctx, card!.id);
		expect(u.ok).toBe(true);
		expect(await getForm(db, id)).toBeNull();
	});

	it('Undo keeps a draft that already has a submission', async () => {
		const ctx = await freshCtx();
		const r = await call(ctx, 'create_form_draft', { name: `Kept ${T}`, spec: roleSpec('Kept') });
		const done = await approve(ctx, r.action!.id);
		const id = formIdOf(done.ok ? done.card.url : null);
		await recordSubmission(db, { form_id: id, form_version: 1, contact_id: null, email: `k-${T}@x.co`, status: 'added', answers: { role: 'Manager' } });
		const u = await undo(ctx, r.action!.id);
		expect(u.ok).toBe(false);
		expect(!u.ok && u.error).toMatch(/was kept: it has submissions/);
		expect(await getForm(db, id)).not.toBeNull();
	});

	it('an invalid spec comes back as path: message problems and stores nothing', async () => {
		const ctx = await freshCtx();
		const before = await count('SELECT COUNT(*) AS n FROM forms');
		const noOptions = await call(ctx, 'create_form_draft', {
			name: `Bad ${T}`,
			spec: { fields: [EMAIL_Q, { type: 'radio', key: 'pick', label: 'Pick one', options: [] }] }
		});
		expect(noOptions.ok).toBe(false);
		expect(noOptions.content).toMatch(/^Nothing was saved — the form has 1 problem\. Fix them and call create_form_draft again:/);
		expect(noOptions.content).toContain('- fields[1].options: Add at least one option.');

		const unknown = await call(ctx, 'create_form_draft', {
			name: `Bad ${T}`,
			spec: {
				fields: [EMAIL_Q, { type: 'signature', label: 'Sign here' }, { type: 'short_text', key: 'x', label: 'X', show_when: { match: 'all', rules: [{ field: 'pick' }] } }],
				pages: [{ id: 'p9', next: [] }],
				outcomes: [{ id: 'o', when: null, actions: [{ type: 'send_email' }, { type: 'add_to_list', list_id: `No such list ${T}` }] }]
			}
		});
		expect(unknown.ok).toBe(false);
		expect(unknown.content).toContain('- fields[1].type: Unknown type “signature”.');
		expect(unknown.content).toContain('- fields[2].show_when: Each rule needs field');
		expect(unknown.content).toContain('- pages[0].id: No page “p9”.');
		expect(unknown.content).toContain('- outcomes[0].actions[0]: Not an action this form understands.');
		expect(unknown.content).toContain(`- outcomes[0].actions[1].list_id: No list named “No such list ${T}”.`);

		expect(await count('SELECT COUNT(*) AS n FROM forms')).toBe(before);
		expect(await count("SELECT COUNT(*) AS n FROM ai_actions WHERE thread_id = ? AND tool = 'create_form_draft'", ctx.threadId)).toBe(0);
	});
});

describe('update_form', () => {
	it('refuses a published form', async () => {
		const ctx = await freshCtx();
		const r = await call(ctx, 'update_form', { form_id: published, spec: { title: 'New title' } });
		expect(r.ok).toBe(false);
		expect(r.content).toMatch(/is published, and the assistant only edits draft forms\. Unpublish it first, or duplicate it/);
		expect((await getForm(db, published))!.spec.title).toBe('Feedback');
	});

	it('changes a draft after Approve, keeps origins / webhook, and Undo puts the previous version back', async () => {
		const ctx = await freshCtx();
		const id = await createForm(db, `Draft ${T}`, member.id);
		// The user set allowed origins on the draft; the assistant can't change or clear them.
		const start = normalizeFormSpec({ ...roleSpec('Draft'), settings: { allowed_origins: ['https://example.com'] } });
		await db.prepare('UPDATE forms SET spec = ? WHERE id = ?').bind(JSON.stringify(start), id).run();
		const beforeSpec = JSON.stringify((await getForm(db, id))!.spec);

		const got = await read(ctx, 'get_form', { form_id: id });
		expect(got.editable).toBe(true);
		const spec = got.spec;
		spec.fields.push({ type: 'short_text', key: 'company', label: 'Company', map: { to: 'contact', field: 'company' } });
		spec.settings.allowed_origins = ['https://evil.example.org'];
		const r = await call(ctx, 'update_form', { form_id: id, spec });
		expect(r.pending).toBe(true);
		expect(r.action!.summary).toBe(`Update draft form “Draft ${T}” · 4 questions · 1 conditional outcome`);
		const notes = r.action!.scope!.notes!;
		expect(notes).toContain('Added: “Company”');
		expect(notes.some((n) => /Allowed origins were kept as they are/.test(n))).toBe(true);

		const done = await approve(ctx, r.action!.id);
		expect(done.ok && done.card.status).toBe('approved');
		const after = (await getForm(db, id))!;
		expect(after.spec.fields.map((f) => f.key)).toEqual(['email', 'role', 'platform', 'company']);
		expect(after.spec.settings.allowed_origins).toEqual(['https://example.com']);
		expect(after.status).toBe('draft');

		const u = await undo(ctx, r.action!.id);
		expect(u.ok).toBe(true);
		expect(JSON.stringify((await getForm(db, id))!.spec)).toBe(beforeSpec);
		const again = await undo(ctx, r.action!.id);
		expect(again.ok && again.already).toBe(true);
	});

	it('top-level keys left out keep the form’s own; Undo refuses once the draft was edited', async () => {
		const ctx = await freshCtx();
		const id = await createForm(db, `Partial ${T}`, member.id);
		await db.prepare('UPDATE forms SET spec = ? WHERE id = ?').bind(JSON.stringify(normalizeFormSpec(roleSpec('Partial'))), id).run();
		const r = await call(ctx, 'update_form', { form_id: id, spec: { title: 'Partial, renamed' } });
		const done = await approve(ctx, r.action!.id);
		expect(done.ok && done.card.status).toBe('approved');
		const f = (await getForm(db, id))!;
		expect(f.spec.title).toBe('Partial, renamed');
		expect(f.spec.fields.map((x) => x.key)).toEqual(['email', 'role', 'platform']);

		await db.prepare("UPDATE forms SET name = 'Edited by hand' WHERE id = ?").bind(id).run();
		const u = await undo(ctx, r.action!.id);
		expect(u.ok).toBe(false);
		expect(!u.ok && u.error).toMatch(/was edited since/);
	});
});

// ── The hard rule, structurally: no publish / unpublish / archive / delete path ──────────

const sources = import.meta.glob('../src/lib/server/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const FORM_TOOL_FILES = [
	'../src/lib/server/ai/tools/forms.ts',
	'../src/lib/server/ai/tools/write-forms.ts',
	'../src/lib/server/ai/tools/form-input.ts'
];

function importSpecs(text: string): { spec: string; names: string }[] {
	const out: { spec: string; names: string }[] = [];
	for (const m of text.matchAll(/(?:import|export)\s([^;]*?)\sfrom\s+['"]([^'"]+)['"]/g)) out.push({ names: m[1], spec: m[2] });
	for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ names: '', spec: m[1] });
	return out;
}

/** The module a spec points at, as a path under src/lib/server ('' when elsewhere). */
function serverModule(from: string, spec: string): string {
	let path: string;
	if (spec.startsWith('$lib/')) path = `../src/lib/${spec.slice(5)}`;
	else if (spec.startsWith('.')) {
		const parts = from.split('/').slice(0, -1);
		for (const seg of spec.split('/')) {
			if (seg === '..') parts.pop();
			else if (seg !== '.') parts.push(seg);
		}
		path = parts.join('/');
	} else return '';
	path = path.replace(/\.ts$/, '');
	return path.startsWith('../src/lib/server/') ? path.slice('../src/lib/server/'.length) : '';
}

describe('structural: the assistant never publishes, archives or deletes a form', () => {
	it('the form tool modules import no status-changing or delete helper and write no status', () => {
		const STATUS_HELPERS = /\b(publishForm|unpublishForm|archiveForm|restoreForm|duplicateForm|deleteSubmission|pruneSubmissions)\b/;
		for (const f of FORM_TOOL_FILES) {
			const text = sources[f];
			expect(text, f).toBeTruthy();
			for (const { names } of importSpecs(text)) expect(names, f).not.toMatch(STATUS_HELPERS);
			expect(text, f).not.toMatch(/UPDATE\s+forms\b/i);
			expect(text, f).not.toMatch(/SET\s+status\b|status\s*=\s*'(published|archived)'/i);
			expect(text, f).not.toMatch(/form_submissions\s+SET|DELETE\s+FROM\s+form_submissions/i);
			// The only delete: the assistant's own untouched draft.
			for (const m of text.matchAll(/DELETE FROM forms[^"`]*/g)) expect(m[0], f).toMatch(/status = 'draft'/);
		}
		expect(sources['../src/lib/server/ai/tools/write-forms.ts']).toMatch(/DELETE FROM forms WHERE id = \? AND status = 'draft'/); // not vacuous
	});

	it('nothing they reach sends, enrolls, submits, publishes or calls a webhook, even transitively', () => {
		const BANNED = ['send', 'postmark', 'scheduled', 'resend', 'automations', 'automation-bulk', 'form-submit', 'form-trigger', 'form-webhook', 'double-optin', 'contact-bulk'];
		const seen = new Set<string>();
		const offenders: string[] = [];
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const { spec, names } of importSpecs(sources[file] ?? '')) {
				if (/^type\s/.test(names.trim())) continue;
				const mod = serverModule(file, spec);
				if (!mod) continue;
				if (BANNED.includes(mod)) offenders.push(`${file} → ${mod}`);
				const next = `../src/lib/server/${mod}.ts`;
				if (sources[next]) walk(next);
				else if (sources[`../src/lib/server/${mod}/index.ts`]) walk(`../src/lib/server/${mod}/index.ts`);
			}
		};
		FORM_TOOL_FILES.forEach(walk);
		expect(offenders).toEqual([]);
		expect(seen.has('../src/lib/server/forms.ts')).toBe(true); // the walk is not vacuous
	});

	it('tools/index.ts lists the form actions that are deliberately not tools', () => {
		const index = sources['../src/lib/server/ai/tools/index.ts'];
		expect(index).toMatch(/publishing, unpublishing, archiving, restoring, duplicating or deleting a\s*\/\/\s*form, its allowed origins and its notify webhook/);
	});
});

describe('MCP', () => {
	it('exposes the form read tools; the form writes stay off MCP (no forms draft scope or /api/v1 write route)', () => {
		const names = MCP_TOOLS.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(['list_forms', 'get_form_submissions']));
		expect(toolsForScope('read')).toEqual(expect.arrayContaining(['list_forms', 'get_form_submissions']));
		expect(names).not.toContain('create_form_draft');
		expect(names).not.toContain('update_form');
		expect(names.filter((n) => /form/.test(n) && /publish|archive|delete/.test(n))).toEqual([]);
	});
});
