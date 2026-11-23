import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// #448: one Conditions area per trigger — the contact-rule vocabulary gains topic opt-out /
// opt-in (plus created-within and source, which compile through the same segment compiler),
// the grouped kind picker, entry_rules round-tripping unchanged through the write layer, and a
// manual enroll that ignores the contact conditions.

import { compileRule, compileSegment } from '../src/lib/server/segment-query';
import { evaluateRules, contactsMatchingRules } from '../src/lib/server/condition-eval';
import { RULE_KIND_GROUPS, ruleKindGroups, ruleIncomplete } from '../src/lib/condition-rules';
import { ruleText } from '../src/lib/automation-action-labels';
import { createAutomation, readSpec, setEntryRules, type Actor } from '../src/lib/server/automation-write';
import { enroll } from '../src/lib/server/automations';
import { contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { filterToRules } from '../src/lib/server/contacts-overview';
import { parseReportSpec } from '../src/lib/report-spec';

const db = (env as any).DB as D1Database;
const actor: Actor = { kind: 'system' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM topic_optouts'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;

async function contact(email: string, extra: { source?: string; createdDaysAgo?: number } = {}): Promise<number> {
	const created = `-${extra.createdDaysAgo ?? 0} days`;
	return (
		await one<{ id: number }>(
			"INSERT INTO contacts (email, subscribed, source, created_at) VALUES (?, 1, ?, datetime('now', ?)) RETURNING id",
			email,
			extra.source ?? null,
			created
		)
	).id;
}
async function topic(name: string): Promise<number> {
	return (await one<{ id: number }>("INSERT INTO lists (name, kind, public_topic) VALUES (?, 'list', 1) RETURNING id", name)).id;
}
async function matching(rule: { field: string; op: string; value?: string; value2?: string }): Promise<number[]> {
	const seg = compileSegment({ match: 'all', rules: [rule] });
	const rows = await db.prepare(`${seg.sql} ORDER BY c.id`).bind(...seg.binds).all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

describe('#448 new rule kinds', () => {
	it('topic out / in compile with bound values and match the fixtures', async () => {
		const news = await topic('Newsletter');
		const out = await contact('out@x.test');
		const member = await contact('in@x.test');
		const neither = await contact('none@x.test');
		await db.prepare('INSERT INTO topic_optouts (contact_id, list_id) VALUES (?, ?)').bind(out, news).run();
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(news, member).run();

		const c = compileRule({ field: 'topic', op: 'out', value: String(news) })!;
		expect(c.binds).toEqual([news]);
		expect(c.clause.includes('?')).toBe(true);
		expect(c.clause).not.toContain(`= ${news}`);
		expect(c.clause).not.toContain(`(${news}`);
		expect(await matching({ field: 'topic', op: 'out', value: String(news) })).toEqual([out]);
		expect(await matching({ field: 'topic', op: 'in', value: String(news) })).toEqual([member]);
		expect(compileRule({ field: 'topic', op: 'out', value: '' })).toBeNull();
		expect(compileRule({ field: 'topic', op: 'bogus', value: String(news) })).toBeNull();
		expect(neither).toBeGreaterThan(0);

		// Same rule in a Condition step / entry conditions.
		const set = { match: 'all' as const, rules: [{ field: 'topic', op: 'out', value: String(news) }] };
		expect((await evaluateRules(db, out, set)).pass).toBe(true);
		expect((await evaluateRules(db, member, set)).pass).toBe(false);
		expect(ruleIncomplete({ field: 'topic', op: 'out' })).toBe('a topic');
		expect(ruleText({ field: 'topic', op: 'out', value: String(news) }, { list: () => 'Newsletter' })).toBe('opted out of topic “Newsletter”');
	});

	it('created within N days and source equals match the fixtures', async () => {
		const fresh = await contact('fresh@x.test', { source: 'WS-Form', createdDaysAgo: 2 });
		const old = await contact('old@x.test', { source: 'csv', createdDaysAgo: 40 });
		const created = compileRule({ field: 'created', op: 'within', value: '7' })!;
		expect(created.binds).toEqual(['-7 days']);
		expect(await matching({ field: 'created', op: 'within', value: '7' })).toEqual([fresh]);
		const source = compileRule({ field: 'source', op: 'is', value: 'ws-form' })!;
		expect(source.binds).toEqual(['ws-form']);
		expect(await matching({ field: 'source', op: 'is', value: 'ws-form' })).toEqual([fresh]);
		expect(await matching({ field: 'source', op: 'is', value: 'csv' })).toEqual([old]);
	});

	it('custom field text works in segments too', async () => {
		const a = await contact('a@x.test');
		await db.prepare('UPDATE contacts SET meta = ? WHERE id = ?').bind(JSON.stringify({ role: 'Head of Growth' }), a).run();
		const b = await contact('b@x.test');
		expect(await matching({ field: 'field_contains', op: 'contains', value: 'growth', value2: 'role' })).toEqual([a]);
		expect(await matching({ field: 'field_contains', op: 'not', value: 'growth', value2: 'role' })).toEqual([b]);
	});
});

describe('#448 kind picker', () => {
	it('groups every kind under the issue headings', () => {
		const trigger = ruleKindGroups({ automation: true, noStepRules: true });
		expect(trigger.map((g) => g.group)).toEqual([...RULE_KIND_GROUPS]);
		const fields = (gs: ReturnType<typeof ruleKindGroups>, group: string) => gs.find((g) => g.group === group)!.kinds.map((k) => k.field);
		expect(fields(trigger, 'Subscription')).toEqual(['subscribed', 'topic', 'bounced', 'spam_complaint']);
		expect(fields(trigger, 'Engagement')).toEqual(expect.arrayContaining(['engagement_tier', 'last_open_within_days', 'never_opened']));
		expect(fields(trigger, 'Engagement')).not.toContain('step_opened');
		expect(fields(trigger, 'Groups')).toEqual(['tag', 'list']);
		expect(fields(trigger, 'Fields')).toEqual(['field', 'field_contains']);
		expect(fields(trigger, 'Company')).toEqual(expect.arrayContaining(['company_id', 'company_metric']));
		expect(fields(trigger, 'Pipeline')).toEqual(['pipeline_stage']);
		expect(fields(trigger, 'Contact')).toEqual(expect.arrayContaining(['created', 'source']));

		const step = ruleKindGroups({ automation: true });
		expect(fields(step, 'Engagement')).toEqual(expect.arrayContaining(['step_opened', 'step_clicked']));
		const segment = ruleKindGroups({ automation: false });
		expect(fields(segment, 'Contact')).not.toContain('email');
		expect(fields(segment, 'Subscription')).toContain('topic');
	});
});

describe('#448 everywhere the vocabulary is read', () => {
	it('entry_rules round-trip unchanged; a manual enroll with ignore bypasses them', async () => {
		const news = await topic('Newsletter');
		const out = await contact('out@x.test');
		const ok = await contact('ok@x.test', { createdDaysAgo: 1 });
		await db.prepare('INSERT INTO topic_optouts (contact_id, list_id) VALUES (?, ?)').bind(out, news).run();
		const created = await createAutomation(db, { name: 'Flow' }, actor);
		if (!created.ok) throw new Error(created.error);
		const aid = created.data.automation_id;
		await db
			.prepare("INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email) VALUES (?, 0, 'tag', 'add', 'x', '', '', '')")
			.bind(aid)
			.run();
		const rules = {
			match: 'all' as const,
			rules: [
				{ field: 'topic', op: 'in', value: String(news) },
				{ field: 'created', op: 'within', value: '30' },
				{ field: 'source', op: 'is', value: 'manual' }
			]
		};
		expect(await setEntryRules(db, aid, { rules }, actor)).toMatchObject({ ok: true });
		const row = await one<{ entry_rules: string }>('SELECT entry_rules FROM automations WHERE id = ?', aid);
		expect(JSON.parse(row.entry_rules)).toEqual(rules);
		const spec = await readSpec(db, aid);
		expect(spec.ok && spec.data.entry_rules).toEqual(rules);

		await setEntryRules(db, aid, { rules: { match: 'all', rules: [{ field: 'topic', op: 'out', value: String(news) }] } }, actor);
		expect(await contactsMatchingRules(db, { match: 'all', rules: [{ field: 'topic', op: 'out', value: String(news) }] }, [out, ok])).toEqual([out]);
		const blocked = await enroll(db, aid, [ok]);
		expect(blocked).toMatchObject({ enrolled: 0, entryBlocked: 1 });
		const forced = await enroll(db, aid, [ok], { ignoreEntryRules: true });
		expect(forced.enrolled).toBe(1);
	});

	it('the Contacts filter takes topic_out and created_days, and maps them back to rules', async () => {
		const news = await topic('Newsletter');
		const out = await contact('out@x.test', { createdDaysAgo: 50 });
		const fresh = await contact('fresh@x.test', { createdDaysAgo: 1 });
		await db.prepare('INSERT INTO topic_optouts (contact_id, list_id) VALUES (?, ?)').bind(out, news).run();
		const ids = async (q: string) => {
			const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams(q)));
			return (await db.prepare(`SELECT id FROM contacts ${where} ORDER BY id`).bind(...params).all<{ id: number }>()).results.map((r) => r.id);
		};
		expect(await ids(`topic_out=${news}`)).toEqual([out]);
		expect(await ids('created_days=7')).toEqual([fresh]);
		expect(filterToRules(parseContactsFilter(new URLSearchParams(`topic_out=${news}&created_days=7`))).rules).toEqual([
			{ field: 'topic', op: 'out', value: String(news) },
			{ field: 'created', op: 'within', value: '7' }
		]);
	});

	it('report specs accept the topic and field-text rules', () => {
		const spec = parseReportSpec({
			entity: 'contacts',
			columns: ['email'],
			filters: { match: 'all', rules: [{ field: 'topic', op: 'out', value: '3' }, { field: 'field_contains', op: 'contains', value: 'x', value2: 'role' }] }
		});
		expect(spec.filters.rules.map((r) => r.field)).toEqual(['topic', 'field_contains']);
	});
});
