import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #534: the editor's "Simulate a contact" and "Check all emails" buttons posted to routes that
// didn't exist. These tests call the route handlers (not just the library functions), and check
// that every `/automations/${id}/<segment>` the editor fetches has a server route.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import { POST as simulate } from '../src/routes/automations/[id]/simulate/+server';
import { POST as checksAll } from '../src/routes/automations/[id]/checks-all/+server';
import { createFromSpec, setStepVariant, type Actor } from '../src/lib/server/automation-write';

const db = (env as any).DB as D1Database;
const actor: Actor = { kind: 'system' };
const FROM = 'alan@ourco.example';

beforeEach(async () => {
	vi.clearAllMocks();
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;
const contact = async (email: string) => (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', email)).id;

// An omitted `user` means the default signed-in member. An explicit `null` or `undefined` means
// "no user" (a default parameter would turn an explicit `undefined` back into the member).
function ev(path: string, id: string, fields: Record<string, string>, ...rest: [user?: unknown]) {
	const user = rest.length > 0 ? rest[0] : { id: 1, role: 'member' };
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	const url = new URL(`https://app.test/automations/${id}/${path}`);
	return {
		platform: { env },
		params: { id },
		url,
		locals: user === undefined ? undefined : { user },
		request: new Request(url, { method: 'POST', body: fd })
	} as any;
}

// Takes what a SvelteKit RequestHandler returns (`Response | Promise<Response>`). Both handlers
// under test are async, so a thrown `error(...)` arrives as a rejected promise and is caught here.
async function status(p: Response | Promise<Response>): Promise<number> {
	try {
		return (await p).status;
	} catch (e) {
		return (e as { status?: number }).status ?? -1;
	}
}

async function flow(): Promise<{ id: number; refs: Record<string, number> }> {
	const r = await createFromSpec(
		db,
		{
			name: 'Flow',
			trigger: { type: 'manual' },
			steps: [
				{ type: 'email', ref: 'ok', subject: 'Fine subject', preheader: 'Preview', body_md: 'A real body with enough words to read well.' },
				{ type: 'tag', tag_action: 'add', tag_name: 'seen' },
				{ type: 'email', ref: 'bad', subject: 'Has a fake link', body_md: 'Read [this](https://example.com/page) now.' }
			]
		},
		actor,
		{ defaultFrom: FROM }
	);
	if (!r.ok) throw new Error(r.error);
	return { id: r.data.automation_id, refs: r.data.step_ids };
}

describe('POST /automations/[id]/simulate', () => {
	it('returns the path for a contact and writes nothing', async () => {
		const { id } = await flow();
		const cid = await contact('sim@example.com');
		const countAll = () =>
			one<{ n: number }>(
				`SELECT (SELECT COUNT(*) FROM automation_enrollments) + (SELECT COUNT(*) FROM recipients)
				  + (SELECT COUNT(*) FROM automation_branch_hits) + (SELECT COUNT(*) FROM automation_enrollment_events)
				  + (SELECT COUNT(*) FROM list_members) + (SELECT COUNT(*) FROM lists) + (SELECT COUNT(*) FROM campaigns) AS n`
			);
		const before = await countAll();
		const res = await simulate(ev('simulate', String(id), { contact_id: String(cid) }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { contact: { id: number }; path: { type: string }[]; notes: string[]; end: string };
		expect(body.contact.id).toBe(cid);
		expect(body.notes).toEqual([]);
		expect(body.path.map((s) => s.type)).toEqual(['email', 'tag', 'email']);
		expect(body.end).toMatch(/^Completes after/);
		expect((await countAll()).n).toBe(before.n);
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('needs a signed-in user and valid ids', async () => {
		const { id } = await flow();
		const cid = await contact('sim2@example.com');
		expect(await status(simulate(ev('simulate', String(id), { contact_id: String(cid) }, null)))).toBe(401);
		expect(await status(simulate(ev('simulate', String(id), { contact_id: String(cid) }, undefined)))).toBe(401);
		expect(await status(simulate(ev('simulate', 'abc', { contact_id: String(cid) })))).toBe(400);
		expect(await status(simulate(ev('simulate', String(id), {})))).toBe(400);
		expect(await status(simulate(ev('simulate', String(id), { contact_id: '999999' })))).toBe(404);
		expect(await status(simulate(ev('simulate', '999999', { contact_id: String(cid) })))).toBe(404);
	});
});

describe('POST /automations/[id]/checks-all', () => {
	it('checks every email step (and variant B) in canvas order', async () => {
		const { id, refs } = await flow();
		await setStepVariant(db, id, { step_id: refs.ok, variant: { subject: 'Hi *|FNAME|*' } }, actor);
		const res = await checksAll(ev('checks-all', String(id), {}));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			steps: { step_id: number; variant: string | null; report: { blocks: number; checks: { category: string }[] } }[];
			blocks: number;
			warns: number;
		};
		expect(body.steps.map((s) => [s.step_id, s.variant])).toEqual([
			[refs.ok, null],
			[refs.ok, 'b'],
			[refs.bad, null]
		]);
		expect(body.steps[0].report.blocks).toBe(0);
		expect(body.steps[1].report.blocks).toBeGreaterThan(0);
		expect(body.steps[2].report.blocks).toBeGreaterThan(0);
		expect(body.blocks).toBe(body.steps.reduce((n, s) => n + s.report.blocks, 0));
		expect(body.steps.every((s) => s.report.checks.every((c) => c.category !== 'audience'))).toBe(true);
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('needs a signed-in user and an existing automation', async () => {
		const { id } = await flow();
		expect(await status(checksAll(ev('checks-all', String(id), {}, null)))).toBe(401);
		expect(await status(checksAll(ev('checks-all', String(id), {}, undefined)))).toBe(401);
		expect(await status(checksAll(ev('checks-all', '0', {})))).toBe(400);
		expect(await status(checksAll(ev('checks-all', '999999', {})))).toBe(404);
	});
});

// Every `/automations/${…}/<segment>` the editor fetches must have a server route, so a
// button pointing at a missing endpoint fails CI instead of failing in the browser.
const sources = import.meta.glob(['../src/lib/components/automations/*.svelte', '../src/routes/automations/**/*.svelte'], {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;
const routes = Object.keys(import.meta.glob('../src/routes/automations/[[]id]/*/+server.ts'));

describe('editor fetch targets', () => {
	it('every /automations/[id]/<segment> fetched by the editor has a +server.ts', () => {
		const used = new Set<string>();
		for (const src of Object.values(sources)) {
			for (const m of src.matchAll(/fetch\(\s*`\/automations\/\$\{[^}]+\}\/([a-z0-9-]+)/g)) used.add(m[1]);
		}
		expect(used).toContain('simulate');
		expect(used).toContain('checks-all');
		for (const seg of used) {
			expect(routes.some((r) => r.endsWith(`/${seg}/+server.ts`)), `missing route for /automations/[id]/${seg}`).toBe(true);
		}
	});
});
