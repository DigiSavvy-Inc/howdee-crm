import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enroll, tick, addTag } from '../src/lib/server/automations';
import { actions } from '../src/routes/automations/[id]/+page.server';

// #75: branch steps route enrollments down labeled child paths that re-join the trunk.
const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		// Campaigns reference steps (automation_step_id) — clear them first.
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		// Null self-referencing parents next — a bulk DELETE trips the FK otherwise.
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeAutomation(): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status) VALUES ('B', 'active') RETURNING id")
		.first<{ id: number }>();
	return a!.id;
}

type StepOpts = {
	parent?: number;
	label?: string;
	delay?: number;
	kind?: string;
	name?: string;
	value?: string;
	refId?: number;
	splitPct?: number;
};

async function step(aid: number, position: number, type: string, tagOrSubject: string, o: StepOpts = {}): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type,
			    tag_action, tag_name, gate_kind, gate_name, gate_value, parent_step_id, branch_label, gate_ref_id, split_pct)
			 VALUES (?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			aid,
			position,
			o.delay ?? 0,
			type === 'email' ? tagOrSubject : '',
			type,
			type === 'tag' ? 'add' : null,
			type === 'tag' ? tagOrSubject : null,
			o.kind ?? null,
			o.name ?? null,
			o.value ?? null,
			o.parent ?? null,
			o.label ?? null,
			o.refId ?? null,
			o.splitPct ?? null
		)
		.first<{ id: number }>();
	return s!.id;
}

async function makeContact(email: string, meta?: string): Promise<number> {
	const c = await db
		.prepare('INSERT INTO contacts (email, meta) VALUES (?, ?) RETURNING id')
		.bind(email, meta ?? null)
		.first<{ id: number }>();
	return c!.id;
}

async function tagsOf(contactId: number): Promise<string[]> {
	const rows = await db
		.prepare(
			`SELECT l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id
			 WHERE lm.contact_id = ? AND l.kind = 'tag' ORDER BY l.name`
		)
		.bind(contactId)
		.all<{ name: string }>();
	return rows.results.map((r) => r.name);
}

/** Tick until nothing is due (delays are 0 in these tests) — cap guards runaway loops. */
async function drain(maxTicks = 10): Promise<void> {
	for (let i = 0; i < maxTicks; i++) {
		const s = await tick(db, cfg);
		if (s.processed === 0) return;
	}
}

describe('branch step (#75)', () => {
	it('routes yes/no by tag, runs the chosen path, re-joins the trunk, records the hit', async () => {
		const aid = await makeAutomation();
		const branch = await step(aid, 0, 'branch', '', { kind: 'tag', name: 'hot' });
		await step(aid, 0, 'tag', 'yes-path', { parent: branch, label: 'yes' });
		await step(aid, 0, 'tag', 'no-path', { parent: branch, label: 'no' });
		await step(aid, 1, 'tag', 'after-join'); // trunk continuation

		const hot = await makeContact('hot@x.example.net');
		const cold = await makeContact('cold@x.example.net');
		await addTag(db, 'hot', hot);
		await enroll(db, aid, [hot, cold]);
		await drain();

		expect(await tagsOf(hot)).toEqual(['after-join', 'hot', 'yes-path']);
		expect(await tagsOf(cold)).toEqual(['after-join', 'no-path']);

		const hits = await db
			.prepare('SELECT label, COUNT(*) AS n FROM automation_branch_hits WHERE step_id = ? GROUP BY label ORDER BY label')
			.bind(branch)
			.all<{ label: string; n: number }>();
		expect(hits.results).toEqual([
			{ label: 'no', n: 1 },
			{ label: 'yes', n: 1 }
		]);
	});

	it('an empty chosen path skips straight past the branch', async () => {
		const aid = await makeAutomation();
		const branch = await step(aid, 0, 'branch', '', { kind: 'tag', name: 'vip' });
		await step(aid, 0, 'tag', 'vip-only', { parent: branch, label: 'yes' });
		// no 'no' path at all
		await step(aid, 1, 'tag', 'everyone');

		const pleb = await makeContact('p@x.example.net');
		await enroll(db, aid, [pleb]);
		await drain();
		expect(await tagsOf(pleb)).toEqual(['everyone']);
	});

	it('nested branches: a branch inside a path evaluates and re-joins through both parents', async () => {
		const aid = await makeAutomation();
		const outer = await step(aid, 0, 'branch', '', { kind: 'tag', name: 'a' });
		const inner = await step(aid, 0, 'branch', '', { parent: outer, label: 'yes', kind: 'tag', name: 'b' });
		await step(aid, 0, 'tag', 'a-and-b', { parent: inner, label: 'yes' });
		await step(aid, 0, 'tag', 'a-not-b', { parent: inner, label: 'no' });
		await step(aid, 1, 'tag', 'end');

		const both = await makeContact('ab@x.example.net');
		await addTag(db, 'a', both);
		await addTag(db, 'b', both);
		const onlyA = await makeContact('a@x.example.net');
		await addTag(db, 'a', onlyA);
		await enroll(db, aid, [both, onlyA]);
		await drain();

		expect(await tagsOf(both)).toEqual(['a', 'a-and-b', 'b', 'end']);
		expect(await tagsOf(onlyA)).toEqual(['a', 'a-not-b', 'end']);
	});

	it('list-member: hand-picked list AND dynamic segment both resolve', async () => {
		const aid = await makeAutomation();
		const list = await db.prepare("INSERT INTO lists (name, kind) VALUES ('VIPs','list') RETURNING id").first<{ id: number }>();
		const rules = JSON.stringify({ match: 'all', rules: [{ field: 'tag', op: 'has', value: 'dyn' }] });
		const seg = await db.prepare("INSERT INTO lists (name, kind, rules) VALUES ('Dyn','segment', ?) RETURNING id").bind(rules).first<{ id: number }>();

		const b1 = await step(aid, 0, 'branch', '', { kind: 'list-member', refId: list!.id });
		await step(aid, 0, 'tag', 'in-list', { parent: b1, label: 'yes' });
		const b2 = await step(aid, 1, 'branch', '', { kind: 'list-member', refId: seg!.id });
		await step(aid, 0, 'tag', 'in-seg', { parent: b2, label: 'yes' });

		const member = await makeContact('m@x.example.net');
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list!.id, member).run();
		await addTag(db, 'dyn', member);
		const outsider = await makeContact('o@x.example.net');
		await enroll(db, aid, [member, outsider]);
		await drain();

		expect(await tagsOf(member)).toEqual(['dyn', 'in-list', 'in-seg']);
		expect(await tagsOf(outsider)).toEqual([]);
	});

	it('opened: routes by whether the contact opened the referenced email step', async () => {
		const aid = await makeAutomation();
		// A fake earlier email step + its campaign + an open event for one contact.
		const emailStep = await step(aid, 0, 'email', 'Welcome'); // will be skipped via pointer seed below
		const camp = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id, automation_step_id)
				 VALUES ('Welcome','m','h','f@x.example.net','sent', ?, ?) RETURNING id`
			)
			.bind(aid, emailStep)
			.first<{ id: number }>();

		const branch = await step(aid, 1, 'branch', '', { kind: 'opened', refId: emailStep });
		await step(aid, 0, 'tag', 'opened-it', { parent: branch, label: 'yes' });
		await step(aid, 0, 'tag', 'ignored-it', { parent: branch, label: 'no' });

		const opener = await makeContact('op@x.example.net');
		const ghost = await makeContact('gh@x.example.net');
		await db.prepare("INSERT INTO events (campaign_id, contact_id, type) VALUES (?, ?, 'open')").bind(camp!.id, opener).run();

		// Enroll, then hand-place both contacts on the branch (skipping the email step —
		// no Postmark in tests).
		await enroll(db, aid, [opener, ghost]);
		await db.prepare("UPDATE automation_enrollments SET current_step_id = ?, next_run_at = datetime('now')").bind(branch).run();
		await drain();

		expect(await tagsOf(opener)).toEqual(['opened-it']);
		expect(await tagsOf(ghost)).toEqual(['ignored-it']);
	});

	it('split: deterministic per enrollment and both sides reachable', async () => {
		const aid = await makeAutomation();
		const branch = await step(aid, 0, 'branch', '', { kind: 'split', splitPct: 50 });
		await step(aid, 0, 'tag', 'side-a', { parent: branch, label: 'yes' });
		await step(aid, 0, 'tag', 'side-b', { parent: branch, label: 'no' });

		// #288: one batched round trip for the 20 contacts instead of 20 sequential inserts.
		const inserted = await db.batch<{ id: number }>(
			Array.from({ length: 20 }, (_, i) =>
				db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(`s${i}@x.example.net`)
			)
		);
		const ids = inserted.map((r) => r.results[0].id);
		await enroll(db, aid, ids);
		await drain();

		const hits = await db
			.prepare('SELECT label, COUNT(*) AS n FROM automation_branch_hits WHERE step_id = ? GROUP BY label')
			.bind(branch)
			.all<{ label: string; n: number }>();
		const byLabel = Object.fromEntries(hits.results.map((h) => [h.label, h.n]));
		expect((byLabel.yes ?? 0) + (byLabel.no ?? 0)).toBe(20);
		expect(byLabel.yes ?? 0).toBeGreaterThan(0); // both sides reachable at 50%
		expect(byLabel.no ?? 0).toBeGreaterThan(0);

		// Determinism: re-running the decision for the same enrollment can't flip it —
		// hits table is keyed (step, enrollment); label unchanged after a forced re-run.
		const before = await db.prepare('SELECT enrollment_id, label FROM automation_branch_hits WHERE step_id = ? ORDER BY enrollment_id').bind(branch).all();
		await db.prepare("UPDATE automation_enrollments SET current_step_id = ?, next_run_at = datetime('now'), status = 'active'").bind(branch).run();
		await drain();
		const after = await db.prepare('SELECT enrollment_id, label FROM automation_branch_hits WHERE step_id = ? ORDER BY enrollment_id').bind(branch).all();
		expect(after.results).toEqual(before.results);
		// #288: two drains over 20 enrollments; under a loaded parallel run this went past 30s.
	}, 60_000);

	it('field-contains / field-not-contains route by substring, case-insensitive (#78)', async () => {
		const aid = await makeAutomation();
		const b1 = await step(aid, 0, 'branch', '', { kind: 'field-contains', name: 'interests', value: 'AI' });
		await step(aid, 0, 'tag', 'ai-fan', { parent: b1, label: 'yes' });
		const b2 = await step(aid, 1, 'branch', '', { kind: 'field-not-contains', name: 'interests', value: 'crypto' });
		await step(aid, 0, 'tag', 'no-crypto', { parent: b2, label: 'yes' });

		const ai = await makeContact('ai@x.example.net', '{"interests":"ai, automation, workflows"}');
		const crypto = await makeContact('cr@x.example.net', '{"interests":"Crypto, NFTs"}');
		const blank = await makeContact('bl@x.example.net'); // no meta at all
		await enroll(db, aid, [ai, crypto, blank]);
		await drain();

		expect(await tagsOf(ai)).toEqual(['ai-fan', 'no-crypto']); // 'AI' matches 'ai' (case-insensitive)
		expect(await tagsOf(crypto)).toEqual([]); // no 'ai'; contains 'crypto' → both NO
		expect(await tagsOf(blank)).toEqual(['no-crypto']); // empty field: no 'ai', no 'crypto'
	});

	it('contains with empty value goes NO (misconfigured, #395)', async () => {
		const aid = await makeAutomation();
		const b = await step(aid, 0, 'branch', '', { kind: 'field-contains', name: 'interests' }); // no value
		await step(aid, 0, 'tag', 'passed', { parent: b, label: 'yes' });
		await step(aid, 0, 'tag', 'failed', { parent: b, label: 'no' });
		const c = await makeContact('fo@x.example.net');
		await enroll(db, aid, [c]);
		await drain();
		expect(await tagsOf(c)).toEqual(['failed']);
	});

	it('a misconfigured branch goes NO and says so on the enrollment (#395)', async () => {
		const aid = await makeAutomation();
		const branch = await step(aid, 0, 'branch', '', { kind: 'list-member' }); // no refId
		await step(aid, 0, 'tag', 'main', { parent: branch, label: 'yes' });
		await step(aid, 0, 'tag', 'other', { parent: branch, label: 'no' });
		const c = await makeContact('f@x.example.net');
		await enroll(db, aid, [c]);
		await drain();
		expect(await tagsOf(c)).toEqual(['other']);
		const enr = await db.prepare('SELECT last_error FROM automation_enrollments WHERE contact_id = ?').bind(c).first<{ last_error: string }>();
		expect(enr!.last_error).toBe('Branch condition is not configured');
	});

	it('deleteStep on a branch removes the subtree and re-points parked contacts to the continuation', async () => {
		const aid = await makeAutomation();
		const branch = await step(aid, 0, 'branch', '', { kind: 'tag', name: 'hot' });
		const inPath = await step(aid, 0, 'tag', 'path-a', { parent: branch, label: 'yes', delay: 3600 });
		await step(aid, 1, 'tag', 'end');

		const c = await makeContact('parked@x.example.net');
		await addTag(db, 'hot', c);
		await enroll(db, aid, [c]);
		await tick(db, cfg); // branch → parked on inPath (+1h)

		const parkedOn = await db.prepare('SELECT current_step_id FROM automation_enrollments WHERE contact_id = ?').bind(c).first<{ current_step_id: number }>();
		expect(parkedOn!.current_step_id).toBe(inPath);

		const fd = new FormData();
		fd.append('step_id', String(branch));
		await actions.deleteStep({
			platform: { env },
			params: { id: String(aid) },
			request: new Request('https://app.test/automations/x', { method: 'POST', body: fd })
		} as any);

		// Subtree gone; contact re-pointed to the trunk continuation.
		const left = await db.prepare('SELECT COUNT(*) AS n FROM automation_steps WHERE automation_id = ?').bind(aid).first<{ n: number }>();
		expect(left!.n).toBe(1); // only 'end'
		await db.prepare("UPDATE automation_enrollments SET next_run_at = datetime('now') WHERE contact_id = ?").bind(c).run();
		await drain();
		expect(await tagsOf(c)).toEqual(['end', 'hot']); // path-a never applied
	});
});

describe('end step', () => {
	it('an end step on the trunk completes the enrollment; later steps never run', async () => {
		const aid = await makeAutomation();
		await step(aid, 0, 'tag', 'first');
		await step(aid, 1, 'end', '');
		await step(aid, 2, 'tag', 'never');

		const c = await makeContact('e@x.example.net');
		await enroll(db, aid, [c]);
		await drain();

		expect(await tagsOf(c)).toEqual(['first']);
		const enr = await db
			.prepare('SELECT status FROM automation_enrollments WHERE contact_id = ?')
			.bind(c)
			.first<{ status: string }>();
		expect(enr!.status).toBe('completed');
	});

	it('an end step inside a NO path stops the flow instead of re-joining', async () => {
		const aid = await makeAutomation();
		const branch = await step(aid, 0, 'branch', '', { kind: 'tag', name: 'hot' });
		await step(aid, 0, 'tag', 'yes-ran', { parent: branch, label: 'yes' });
		await step(aid, 0, 'end', '', { parent: branch, label: 'no' });
		await step(aid, 1, 'tag', 'after'); // trunk continuation — should only run for YES

		const withTag = await makeContact('hot@x.example.net');
		const noTag = await makeContact('cold@x.example.net');
		await addTag(db, 'hot', withTag);
		await enroll(db, aid, [withTag, noTag]);
		await drain();

		// YES path: yes-ran + re-joins trunk → after
		expect(await tagsOf(withTag)).toEqual(['after', 'hot', 'yes-ran']);
		// NO path: end step terminates — 'after' must NOT run
		expect(await tagsOf(noTag)).toEqual([]);
	});
});
