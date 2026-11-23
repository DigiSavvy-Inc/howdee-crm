import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { archiveGroups, archiveProblem, loadArchiveChecks, restoreGroups } from '../src/lib/server/groups-bulk';
import { forPicker, listGroupsForApi } from '../src/lib/server/group-archive';
import { generateApiKey } from '../src/lib/server/api-keys';
import { GET as listListsApi } from '../src/routes/api/v1/lists/+server';
import { load as groupsLoad, actions as groupsActions } from '../src/routes/groups/[kind]/+page.server';
import { load as composeLoad } from '../src/routes/compose/+page.server';
import { load as automationLoad } from '../src/routes/automations/[id]/+page.server';
import { load as listLoad } from '../src/routes/lists/[id]/+page.server';
import { TOOLS, runTool } from '../src/lib/server/ai/tools';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';

// #472: archive / restore lists and segments.
const db = (env as any).DB as D1Database;
const T = `a${Date.now()}`;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function group(name: string, kind = 'list', extra: { rules?: string; public_topic?: number } = {}): Promise<number> {
	return (await db
		.prepare('INSERT INTO lists (name, kind, rules, public_topic) VALUES (?, ?, ?, ?) RETURNING id')
		.bind(name, kind, extra.rules ?? null, extra.public_topic ?? 0)
		.first<{ id: number }>())!.id;
}

async function contact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>())!.id;
}

async function campaign(listId: number, status: string): Promise<void> {
	await db
		.prepare("INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status) VALUES ('S', 'b', 'b', ?, 'f@x.example.net', ?)")
		.bind(listId, status)
		.run();
}

async function automation(status: string, triggerListId: number | null): Promise<number> {
	return (await db
		.prepare("INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES (?, ?, 'list_added', ?) RETURNING id")
		.bind(`Auto ${status}`, status, triggerListId)
		.first<{ id: number }>())!.id;
}

async function archivedAt(id: number): Promise<string | null> {
	return (await db.prepare('SELECT archived_at FROM lists WHERE id = ?').bind(id).first<{ archived_at: string | null }>())!.archived_at;
}

const admin = { id: 0, github_login: 'adm', role: 'admin', name: null, avatar_url: null } as any;

function pageEvent(path: string, params: Record<string, string>, user = admin, body?: FormData) {
	const url = new URL(`https://app.test${path}`);
	return {
		platform: { env },
		url,
		params,
		locals: { user },
		request: new Request(url, body ? { method: 'POST', body } : {})
	} as any;
}

describe('archiveProblem', () => {
	const base = { kind: 'list', public_topic: 0, archived_at: null, liveCampaigns: 0, activeAutomations: 0 };

	it('allows a plain list or segment, refuses tags and companies', () => {
		expect(archiveProblem(base)).toBeNull();
		expect(archiveProblem({ ...base, kind: 'segment' })).toBeNull();
		expect(archiveProblem({ ...base, kind: 'tag' })).toMatch(/only lists and segments/);
		expect(archiveProblem({ ...base, kind: 'company' })).toMatch(/only lists and segments/);
	});

	it('names each reason', () => {
		expect(archiveProblem({ ...base, public_topic: 1 })).toMatch(/turn the topic off first/);
		expect(archiveProblem({ ...base, liveCampaigns: 2 })).toMatch(/2 scheduled or sending campaigns/);
		expect(archiveProblem({ ...base, activeAutomations: 1 })).toMatch(/1 active automation$/);
		expect(archiveProblem({ ...base, archived_at: '2026-10-01 00:00:00' })).toBe('already archived');
	});

	it('reads the reasons from the database: scheduled / sending campaigns, active triggers, topics', async () => {
		const sent = await group('Sent to');
		await campaign(sent, 'sent');
		const scheduled = await group('Scheduled');
		await campaign(scheduled, 'scheduled');
		const sending = await group('Sending');
		await campaign(sending, 'sending');
		const viaAudience = await group('Audience');
		const other = await group('Other');
		await campaign(other, 'scheduled');
		const cid = (await db.prepare('SELECT MAX(id) AS id FROM campaigns').first<{ id: number }>())!.id;
		await db.prepare("INSERT INTO campaign_audiences (campaign_id, list_id, mode) VALUES (?, ?, 'include')").bind(cid, viaAudience).run();
		const active = await group('Active trigger');
		await automation('active', active);
		const paused = await group('Paused trigger');
		await automation('paused', paused);
		await automation('draft', paused);
		const topic = await group('Topic', 'list', { public_topic: 1 });

		const checks = new Map((await loadArchiveChecks(db, [sent, scheduled, sending, viaAudience, active, paused, topic])).map((c) => [c.id, archiveProblem(c)]));
		expect(checks.get(sent)).toBeNull();
		expect(checks.get(scheduled)).toMatch(/scheduled or sending/);
		expect(checks.get(sending)).toMatch(/scheduled or sending/);
		expect(checks.get(viaAudience)).toMatch(/scheduled or sending/);
		expect(checks.get(active)).toMatch(/active automation/);
		expect(checks.get(paused)).toBeNull();
		expect(checks.get(topic)).toMatch(/topic/);

		const r = await archiveGroups(db, [sent, scheduled, active, paused, topic]);
		expect(r.changed.map((g) => g.id).sort()).toEqual([sent, paused].sort());
		expect(r.skipped.map((s) => s.id).sort()).toEqual([scheduled, active, topic].sort());
		expect(await archivedAt(scheduled)).toBeNull();
	});
});

describe('archive / restore', () => {
	it('round-trips with memberships, rules and campaigns kept', async () => {
		const list = await group('Old list');
		const seg = await group('Old seg', 'segment', { rules: JSON.stringify({ match: 'all', rules: [{ field: 'list', op: 'in', value: '1' }] }) });
		const a = await contact(`a-${T}@x.example.net`);
		const b = await contact(`b-${T}@x.example.net`);
		await db.batch([
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, a),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, b)
		]);
		await campaign(list, 'sent');
		const segRules = (await db.prepare('SELECT rules FROM lists WHERE id = ?').bind(seg).first<{ rules: string }>())!.rules;

		const r = await archiveGroups(db, [list, seg]);
		expect(r.changed).toHaveLength(2);
		expect(await archivedAt(list)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?').bind(list).first<{ n: number }>())!.n).toBe(2);

		// Archiving again is refused, not re-stamped.
		expect((await archiveGroups(db, [list])).skipped[0].reason).toBe('already archived');

		const back = await restoreGroups(db, [list, seg]);
		expect(back.changed).toHaveLength(2);
		expect(await archivedAt(list)).toBeNull();
		expect((await db.prepare('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?').bind(list).first<{ n: number }>())!.n).toBe(2);
		expect((await db.prepare('SELECT rules FROM lists WHERE id = ?').bind(seg).first<{ rules: string }>())!.rules).toBe(segRules);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE list_id = ?').bind(list).first<{ n: number }>())!.n).toBe(1);
		expect((await restoreGroups(db, [list])).skipped[0].reason).toBe('not archived');
	});

	it('the Groups page hides archived by default, lists them with ?archived=1, and archive / restore are admin-only', async () => {
		const keep = await group('Keep');
		const old = await group('Old');
		const fd = new FormData();
		fd.append('id', String(old));
		const member = { ...admin, role: 'member' };
		const refused = (await groupsActions.archive(pageEvent('/groups/list?/archive', { kind: 'list' }, member, fd))) as any;
		expect(refused.status).toBe(403);
		expect(await archivedAt(old)).toBeNull();

		const fd2 = new FormData();
		fd2.append('id', String(old));
		const ok = (await groupsActions.archive(pageEvent('/groups/list?/archive', { kind: 'list' }, admin, fd2))) as any;
		expect(ok.bulkMessage).toMatch(/Archived 1 list/);

		const active = (await groupsLoad(pageEvent('/groups/list', { kind: 'list' }))) as any;
		expect(active.groups.map((g: any) => g.id)).toEqual([keep]);
		const archived = (await groupsLoad(pageEvent('/groups/list?archived=1', { kind: 'list' }))) as any;
		expect(archived.groups.map((g: any) => g.id)).toEqual([old]);
		expect(archived.archived).toBe(true);

		const fd3 = new FormData();
		fd3.append('id', String(old));
		const restored = (await groupsActions.restore(pageEvent('/groups/list?/restore', { kind: 'list' }, admin, fd3))) as any;
		expect(restored.bulkMessage).toMatch(/Restored 1 list/);
		expect(await archivedAt(old)).toBeNull();
	});
});

describe('pickers', () => {
	it('forPicker drops archived rows unless kept, and labels the kept ones', () => {
		const rows = [
			{ id: 1, name: 'A', archived_at: null },
			{ id: 2, name: 'B', archived_at: '2026-10-01 00:00:00' },
			{ id: 3, name: 'C', archived_at: '2026-10-01 00:00:00' }
		];
		expect(forPicker(rows, [3]).map((r) => r.name)).toEqual(['A', 'C (archived)']);
		expect(forPicker(rows).map((r) => r.id)).toEqual([1]);
	});

	it('compose leaves archived groups out, but keeps one a draft already uses — "(archived)"', async () => {
		const live = await group('Live list');
		const old = await group('Old list');
		await archiveGroups(db, [old]);

		const fresh = (await composeLoad(pageEvent('/compose', {}))) as any;
		expect(fresh.lists.map((l: any) => l.id)).toContain(live);
		expect(fresh.lists.map((l: any) => l.id)).not.toContain(old);

		const draftId = (await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status) VALUES ('D', 'b', 'b', ?, 'f@x.example.net', 'draft') RETURNING id")
			.bind(old)
			.first<{ id: number }>())!.id;
		const editing = (await composeLoad(pageEvent(`/compose?draft=${draftId}`, {}))) as any;
		const kept = editing.lists.find((l: any) => l.id === old);
		expect(kept).toMatchObject({ name: 'Old list (archived)', archived: true });
	});

	it('the automation editor leaves archived groups out, but keeps its own trigger list — "(archived)"', async () => {
		const live = await group('Live list');
		const old = await group('Old list');
		const unused = await group('Unused old');
		const autoId = await automation('paused', old);
		await archiveGroups(db, [old, unused]);

		const data = (await automationLoad(pageEvent(`/automations/${autoId}`, { id: String(autoId) }))) as any;
		const ids = data.lists.map((l: any) => l.id);
		expect(ids).toContain(live);
		expect(ids).not.toContain(unused);
		expect(data.lists.find((l: any) => l.id === old)).toMatchObject({ name: 'Old list (archived)', archived: true });
	});

	it('the segment rule builder leaves archived groups out, but keeps one its rules use — "(archived)"', async () => {
		const live = await group('Live list');
		const old = await group('Old list');
		const unused = await group('Unused old');
		await archiveGroups(db, [old, unused]);
		const seg = await group('Seg', 'segment', { rules: JSON.stringify({ match: 'all', rules: [{ field: 'list', op: 'in', value: String(old) }] }) });

		const data = (await listLoad(pageEvent(`/lists/${seg}`, { id: String(seg) }))) as any;
		const ids = data.groups.map((g: any) => g.id);
		expect(ids).toContain(live);
		expect(ids).not.toContain(unused);
		expect(data.groups.find((g: any) => g.id === old)).toMatchObject({ name: 'Old list (archived)', archived: true });
	});

	it('an archived list page loads (readable) with its archived date', async () => {
		const old = await group('Old list');
		await archiveGroups(db, [old]);
		const data = (await listLoad(pageEvent(`/lists/${old}`, { id: String(old) }))) as any;
		expect(data.group.archived_at).toBeTruthy();
		expect(data.archive).toMatchObject({ isAdmin: true, archivable: true });
	});
});

describe('Data API', () => {
	async function key(): Promise<string> {
		const k = await generateApiKey();
		await db
			.prepare('INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)')
			.bind('t', k.tokenHash, k.prefix, k.last4, 'read')
			.run();
		return k.token;
	}

	function apiEvent(qs: string, token: string) {
		const url = new URL(`https://app.test/api/v1/lists${qs}`);
		return { request: new Request(url, { headers: { authorization: `Bearer ${token}` } }), platform: { env }, url, params: {} } as any;
	}

	it('leaves archived groups out by default and returns them with include_archived=1', async () => {
		const live = await group('Live list');
		const old = await group('Old seg', 'segment');
		await group('A tag', 'tag');
		await archiveGroups(db, [old]);
		const token = await key();

		const def = JSON.parse(await (await listListsApi(apiEvent('', token))).text());
		expect(def.data.map((g: any) => g.id)).toEqual([live]);
		expect(def.data[0]).toMatchObject({ archived_at: null, kind: 'list' });

		const all = JSON.parse(await (await listListsApi(apiEvent('?include_archived=1', token))).text());
		expect(all.data.map((g: any) => g.id).sort()).toEqual([live, old].sort());
		expect(all.data.find((g: any) => g.id === old).archived_at).toBeTruthy();
		expect(all.pagination.total).toBe(2);

		expect((await listGroupsForApi(db, { kind: 'segment', limit: 50, offset: 0 })).rows).toHaveLength(0);
		expect((await listListsApi(apiEvent('?kind=tag', token))).status).toBe(400);
	});
});

describe('assistant', () => {
	const sonnet = modelInfo('claude-sonnet-5-5')!;
	let seq = 0;

	async function ctx(role: 'admin' | 'member') {
		const id = (await db
			.prepare('INSERT INTO users (github_login, role) VALUES (?, ?) RETURNING id')
			.bind(`${T}-${role}-${++seq}`, role)
			.first<{ id: number }>())!.id;
		const user = { id, github_login: `${T}-${role}-${seq}`, role, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
		const threadId = await createThread(db, id, sonnet.id, 'medium', 'test');
		return { db, user, baseUrl: 'https://app.test', now: new Date(), threadId };
	}

	it('list_groups leaves archived out unless include_archived', async () => {
		const live = await group('Live list');
		const old = await group('Old list');
		await archiveGroups(db, [old]);
		const c = await ctx('member');
		const def = JSON.parse((await runTool(c, 'list_groups', { kind: 'list' }, TOOLS, 'tu_1')).content);
		expect(def.groups.map((g: any) => g.id)).toEqual([live]);
		const all = JSON.parse((await runTool(c, 'list_groups', { kind: 'list', include_archived: true }, TOOLS, 'tu_2')).content);
		expect(all.groups.map((g: any) => g.id).sort()).toEqual([live, old].sort());
		expect(all.groups.find((g: any) => g.id === old).archived_at).toBeTruthy();
	});

	it('archive_group / restore_group: admin-only, refused with the reason, round-trip', async () => {
		const old = await group('Old list');
		const busy = await group('Busy list');
		await campaign(busy, 'scheduled');

		const m = await ctx('member');
		expect((await runTool(m, 'archive_group', { group_id: old }, TOOLS, 'tu_3')).ok).toBe(false);
		expect(await archivedAt(old)).toBeNull();

		const a = await ctx('admin');
		const refused = await runTool(a, 'archive_group', { group_id: busy }, TOOLS, 'tu_4');
		expect(refused.ok).toBe(false);
		expect(refused.content).toMatch(/scheduled or sending/);

		expect((await runTool(a, 'archive_group', { group_id: old }, TOOLS, 'tu_5')).ok).toBe(true);
		expect(await archivedAt(old)).toBeTruthy();
		expect((await runTool(a, 'restore_group', { group_id: old }, TOOLS, 'tu_6')).ok).toBe(true);
		expect(await archivedAt(old)).toBeNull();
	});
});
