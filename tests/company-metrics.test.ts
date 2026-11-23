// #170: company metrics as contact conditions — filter SQL per operator, segment rules,
// {{company.*}} merge tags, the "Company metric crossed" trigger, the Condition step, and
// the Data API read.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey } from '../src/lib/server/api-keys';
import { contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { memberQuery, parseFilter } from '../src/lib/server/contact-filter';
import { compileSegment } from '../src/lib/server/segment-query';
import { personalize, renderEmailHtml } from '../src/lib/server/email';
import { companyMergeFields, goingQuietCount } from '../src/lib/server/company-metrics';
import { evaluateMetricCrossings } from '../src/lib/server/metric-trigger';
import { runProviderSync, type IntegrationProvider } from '../src/lib/server/integrations';
import { tick } from '../src/lib/server/automations';
import {
	conditionLabel,
	crossed,
	decodeCondition,
	parseMetricConditions,
	triggerLabel
} from '../src/lib/company-metrics';
import { GET as getMetricsApi } from '../src/routes/api/v1/companies/[id]/metrics/+server';
import { GET as getContactApi } from '../src/routes/api/v1/contacts/[id]/+server';

const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM integration_syncs'),
		db.prepare("DELETE FROM app_state WHERE key LIKE 'integration_%'"),
		db.prepare('DELETE FROM company_metrics_prev'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM companies')
	]);
});

async function company(name: string, metrics: Record<string, number | string | null> = {}): Promise<number> {
	const r = await db.prepare('INSERT INTO companies (name, domain) VALUES (?, ?) RETURNING id').bind(name, `${name.toLowerCase()}.test`).first<{ id: number }>();
	if (Object.keys(metrics).length) await setMetrics(r!.id, metrics);
	return r!.id;
}

async function setMetrics(companyId: number, metrics: Record<string, number | string | null>): Promise<void> {
	await db.prepare('INSERT OR IGNORE INTO company_metrics (company_id) VALUES (?)').bind(companyId).run();
	for (const [k, v] of Object.entries(metrics)) {
		await db.prepare(`UPDATE company_metrics SET ${k} = ? WHERE company_id = ?`).bind(v, companyId).run();
	}
}

async function contact(email: string, companyId: number | null, subscribed = 1): Promise<number> {
	const r = await db
		.prepare('INSERT INTO contacts (email, company_id, subscribed) VALUES (?, ?, ?) RETURNING id')
		.bind(email, companyId, subscribed)
		.first<{ id: number }>();
	return r!.id;
}

async function filterEmails(qs: string): Promise<string[]> {
	const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams(qs)));
	const rows = await db.prepare(`SELECT email FROM contacts ${where} ORDER BY email`).bind(...params).all<{ email: string }>();
	return rows.results.map((r) => r.email);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

describe('condition vocabulary', () => {
	it('decodes, normalizes and labels conditions', () => {
		expect(decodeCondition('issues_open:gt:10')).toEqual({ metric: 'issues_open', op: 'gt', value: 10 });
		expect(decodeCondition('last_tracked_at:older:30.7')).toEqual({ metric: 'last_tracked_at', op: 'older', value: 30 });
		expect(decodeCondition('bogus:gt:1')).toBeNull();
		expect(decodeCondition('hours_30d:older:1')).toBeNull(); // date op on a number metric
		expect(decodeCondition('hours_30d:gt:abc')).toBeNull();
		expect(decodeCondition('hours_30d:gt:')).toBeNull();
		expect(conditionLabel({ metric: 'issues_open', op: 'gte', value: 3 })).toBe('Open issues ≥ 3');
		expect(conditionLabel({ metric: 'last_issue_at', op: 'older', value: 30 })).toBe('Last issue activity more than 30 days ago');
		expect(triggerLabel('issues_open', 'above', 10)).toBe('Open issues crosses above 10');
	});

	it('parses cm, cm_keep and the new-row triple, deduped and capped', () => {
		const sp = new URLSearchParams('cm=hours_90d:gt:0,hours_30d:eq:0,junk&cm_keep=hours_90d:gt:0&cm_metric=issues_open&cm_op=lt&cm_value=2');
		expect(parseMetricConditions(sp).map((c) => `${c.metric}:${c.op}:${c.value}`)).toEqual([
			'hours_90d:gt:0',
			'hours_30d:eq:0',
			'issues_open:lt:2'
		]);
		const many = new URLSearchParams(`cm=${Array.from({ length: 9 }, (_, i) => `hours_7d:gt:${i}`).join(',')}`);
		expect(parseMetricConditions(many)).toHaveLength(5);
	});

	it('crossed(): once across the threshold, never from/to a missing value', () => {
		expect(crossed(5, 12, 'above', 10)).toBe(true);
		expect(crossed(10, 11, 'above', 10)).toBe(true);
		expect(crossed(12, 13, 'above', 10)).toBe(false);
		expect(crossed(null, 12, 'above', 10)).toBe(false);
		expect(crossed(5, null, 'above', 10)).toBe(false);
		expect(crossed(3, 0, 'below', 1)).toBe(true);
		expect(crossed(0, 0, 'below', 1)).toBe(false);
	});
});

describe('Contacts filter SQL', () => {
	beforeEach(async () => {
		const a = await company('Acme', { hours_30d: 10, issues_open: 4, last_tracked_at: daysAgo(40) });
		const b = await company('Beta', { hours_30d: 0, issues_open: 12, last_tracked_at: daysAgo(2) });
		await company('Gamma'); // no metrics row at all
		await contact('a@x.test', a);
		await contact('b@x.test', b);
		await contact('g@x.test', (await db.prepare("SELECT id FROM companies WHERE name='Gamma'").first<{ id: number }>())!.id);
		await contact('none@x.test', null);
	});

	it('each numeric operator', async () => {
		expect(await filterEmails('cm=hours_30d:gt:5')).toEqual(['a@x.test']);
		expect(await filterEmails('cm=hours_30d:gte:10')).toEqual(['a@x.test']);
		expect(await filterEmails('cm=hours_30d:lt:10')).toEqual(['b@x.test']);
		expect(await filterEmails('cm=hours_30d:lte:10')).toEqual(['a@x.test', 'b@x.test']);
		expect(await filterEmails('cm=hours_30d:eq:0')).toEqual(['b@x.test']);
		expect(await filterEmails('cm=issues_open:ne:4')).toEqual(['b@x.test']);
	});

	it('date operators', async () => {
		expect(await filterEmails('cm=last_tracked_at:older:30')).toEqual(['a@x.test']);
		expect(await filterEmails('cm=last_tracked_at:within:7')).toEqual(['b@x.test']);
	});

	it('contacts without a company (or without a value) never match a metric rule', async () => {
		const all = await filterEmails('cm=hours_30d:lte:1000000');
		expect(all).not.toContain('none@x.test');
		expect(all).not.toContain('g@x.test');
		expect(await filterEmails('cm=issues_open:ne:999')).toEqual(['a@x.test', 'b@x.test']);
	});

	it('has_company + conditions combine with AND', async () => {
		expect(await filterEmails('has_company=no')).toEqual(['none@x.test']);
		expect(await filterEmails('has_company=yes')).toEqual(['a@x.test', 'b@x.test', 'g@x.test']);
		expect(await filterEmails('cm=issues_open:gt:1,hours_30d:gt:1')).toEqual(['a@x.test']);
	});

	it('the list member table takes the same params', async () => {
		const l = await db.prepare("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id").first<{ id: number }>();
		await db.prepare('INSERT INTO list_members (list_id, contact_id) SELECT ?, id FROM contacts').bind(l!.id).run();
		const q = memberQuery(l!.id, parseFilter(new URLSearchParams('cm=issues_open:gt:10&has_company=yes')));
		const rows = await db
			.prepare(`SELECT c.email FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${q.where}`)
			.bind(...q.params)
			.all<{ email: string }>();
		expect(rows.results.map((r) => r.email)).toEqual(['b@x.test']);
	});
});

describe('segment rules', () => {
	async function members(rules: Parameters<typeof compileSegment>[0]): Promise<string[]> {
		const c = compileSegment(rules);
		const rows = await db
			.prepare(`SELECT email FROM contacts WHERE id IN (${c.sql}) ORDER BY email`)
			.bind(...c.binds)
			.all<{ email: string }>();
		return rows.results.map((r) => r.email);
	}

	it('"0 hours in 30d but hours in 90d" lists the right contacts and recomputes on metric change', async () => {
		const quiet = await company('Quiet', { hours_90d: 12, hours_30d: 0 });
		const busy = await company('Busy', { hours_90d: 40, hours_30d: 8 });
		const gone = await company('Gone', { hours_90d: 0, hours_30d: 0 });
		await contact('q1@x.test', quiet);
		await contact('q2@x.test', quiet);
		await contact('b@x.test', busy);
		await contact('g@x.test', gone);
		await contact('n@x.test', null);
		const rules = {
			match: 'all' as const,
			rules: [
				{ field: 'company_metric', value2: 'hours_90d', op: 'gt', value: '0' },
				{ field: 'company_metric', value2: 'hours_30d', op: 'eq', value: '0' }
			]
		};
		expect(await members(rules)).toEqual(['q1@x.test', 'q2@x.test']);
		await setMetrics(busy, { hours_30d: 0 });
		expect(await members(rules)).toEqual(['b@x.test', 'q1@x.test', 'q2@x.test']);
		expect(await goingQuietCount(db)).toBe(2);
	});

	it('company_id rules: linked / not linked / is', async () => {
		const a = await company('A1');
		await contact('a@x.test', a);
		await contact('n@x.test', null);
		expect(await members({ match: 'all', rules: [{ field: 'company_id', op: 'exists' }] })).toEqual(['a@x.test']);
		expect(await members({ match: 'all', rules: [{ field: 'company_id', op: 'missing' }] })).toEqual(['n@x.test']);
		expect(await members({ match: 'all', rules: [{ field: 'company_id', op: 'is', value: String(a) }] })).toEqual(['a@x.test']);
		// Malformed rules are skipped (match everything), like every other rule kind.
		expect(compileSegment({ match: 'all', rules: [{ field: 'company_metric', value2: 'nope', op: 'gt', value: '1' }] }).binds).toEqual([]);
	});
});

describe('{{company.*}} merge tags', () => {
	it('fills values, applies fallbacks, leaves unknown keys verbatim', () => {
		const fields = { name: 'Acme & Co', hours_30d: '12.5', issues_open: '', last_tracked_title: 'Fix nav' };
		const t = 'Hi {{company.name}} — {{company.hours_30d}}h, {{company.issues_open|no}} open, {{company.domain|n/a}} {{company.bogus}}';
		expect(personalize(t, '#', { email: 'a@x.test', companyFields: fields })).toBe(
			'Hi Acme & Co — 12.5h, no open, n/a {{company.bogus}}'
		);
		expect(personalize('{{company.name|your team}}', '#', { email: 'a@x.test' })).toBe('your team');
		expect(personalize('[{{company.name}}]', '#', { email: 'a@x.test' })).toBe('[]');
		expect(personalize('<p>{{company.name}}</p>', '#', { email: 'a@x.test', companyFields: fields }, { mode: 'html' })).toBe(
			'<p>Acme &amp; Co</p>'
		);
	});

	it('survives markdown rendering (text and link hrefs)', () => {
		const html = renderEmailHtml('Hello **{{company.name|friend}}** [site]({{company.website}})');
		expect(html).toContain('{{company.name|friend}}');
		const out = personalize(html, '#', { email: 'a@x.test', companyFields: { name: 'Acme', website: 'https://acme.test' } }, { mode: 'html' });
		expect(out).toContain('<strong>Acme</strong>');
		expect(out).toContain('href="https://acme.test"');
	});

	it('companyMergeFields formats values per contact', async () => {
		const a = await company('Acme', { hours_30d: 12.3456, last_tracked_at: '2026-10-01T09:00:00Z', issues_open: 3 });
		const c = await contact('a@x.test', a);
		const n = await contact('n@x.test', null);
		const m = await companyMergeFields(db, [c, n, null]);
		expect(m.get(c)).toMatchObject({ name: 'Acme', domain: 'acme.test', hours_30d: '12.3', last_tracked_at: '2026-10-01', issues_open: '3', hours_7d: '' });
		expect(m.has(n)).toBe(false);
	});
});

describe('"Company metric crossed" trigger', () => {
	async function metricAutomation(direction = 'above', threshold = 10): Promise<number> {
		const a = await db
			.prepare(
				`INSERT INTO automations (name, status, trigger_type, trigger_metric, trigger_direction, trigger_threshold)
				 VALUES ('Issues spike', 'active', 'company_metric', 'issues_open', ?, ?) RETURNING id`
			)
			.bind(direction, threshold)
			.first<{ id: number }>();
		await db
			.prepare(`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email)
			          VALUES (?, 0, 'tag', 'add', 'spike', '', '', '')`)
			.bind(a!.id)
			.run();
		return a!.id;
	}
	const enrolledCount = async (aid: number) =>
		(await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?').bind(aid).first<{ n: number }>())!.n;

	it('fires once per crossing (not every sync), only for the crossing company, via the sync runner', async () => {
		const aid = await metricAutomation();
		const acme = await company('Acme', { issues_open: 5 });
		const other = await company('Other', { issues_open: 2 });
		await contact('a1@x.test', acme);
		await contact('a2@x.test', acme);
		await contact('unsub@x.test', acme, 0);
		await contact('o@x.test', other);

		// The provider's "sync" just moves the metric; the runner evaluates crossings after it.
		let next: Record<number, number> = {};
		const provider: IntegrationProvider = {
			provider: 'github',
			label: 'GitHub',
			secretName: 'GITHUB_TOKEN',
			tokenHelp: '',
			isConfigured: () => true,
			probe: async () => ({ state: 'connected', detail: '', checkedAt: '' }),
			sync: async (d) => {
				for (const [id, v] of Object.entries(next)) await d.prepare('UPDATE company_metrics SET issues_open = ? WHERE company_id = ?').bind(v, Number(id)).run();
				return { counts: {}, errors: [] };
			}
		};
		const env1 = { GITHUB_TOKEN: 't' };

		await runProviderSync(db, env1, provider, 'cron'); // first sync = baseline only
		expect(await enrolledCount(aid)).toBe(0);

		next = { [acme]: 12 };
		await runProviderSync(db, env1, provider, 'cron'); // 5 → 12 crosses above 10
		expect(await enrolledCount(aid)).toBe(2); // the unsubscribed contact is skipped

		next = { [acme]: 15, [other]: 9 };
		await runProviderSync(db, env1, provider, 'cron'); // still above — no new crossing
		expect(await enrolledCount(aid)).toBe(2);

		// Drop below and cross again: 'once' re-entry keeps it at one pass per contact.
		next = { [acme]: 3 };
		await runProviderSync(db, env1, provider, 'cron');
		next = { [acme]: 11 };
		await runProviderSync(db, env1, provider, 'cron');
		expect(await enrolledCount(aid)).toBe(2);
		const emails = await db
			.prepare('SELECT c.email FROM automation_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.automation_id = ? ORDER BY c.email')
			.bind(aid)
			.all<{ email: string }>();
		expect(emails.results.map((r) => r.email)).toEqual(['a1@x.test', 'a2@x.test']);
	});

	it('below-direction and inactive automations', async () => {
		const below = await metricAutomation('below', 1);
		const paused = await metricAutomation('above', 0);
		await db.prepare("UPDATE automations SET status = 'paused' WHERE id = ?").bind(paused).run();
		const co = await company('Co', { issues_open: 4 });
		await contact('c@x.test', co);
		await evaluateMetricCrossings(db); // baseline
		await setMetrics(co, { issues_open: 0 });
		const res = await evaluateMetricCrossings(db);
		expect(res).toEqual({ crossings: 1, enrolled: 1 });
		expect(await enrolledCount(below)).toBe(1);
		expect(await enrolledCount(paused)).toBe(0);
	});

	it('a failed sync does not move the snapshot', async () => {
		await metricAutomation();
		const co = await company('Co', { issues_open: 5 });
		await evaluateMetricCrossings(db);
		const failing: IntegrationProvider = {
			provider: 'timing',
			label: 'Timing',
			secretName: 'TIMING_API_TOKEN',
			tokenHelp: '',
			isConfigured: () => true,
			probe: async () => ({ state: 'connected', detail: '', checkedAt: '' }),
			sync: async (d) => {
				await d.prepare('UPDATE company_metrics SET issues_open = 20 WHERE company_id = ?').bind(co).run();
				throw new Error('boom');
			}
		};
		await runProviderSync(db, { TIMING_API_TOKEN: 't' }, failing, 'manual');
		const prev = await db.prepare('SELECT metrics FROM company_metrics_prev WHERE company_id = ?').bind(co).first<{ metrics: string }>();
		expect(JSON.parse(prev!.metrics).issues_open).toBe(5);
	});
});

describe('Condition step: company metric', () => {
	it('routes YES/NO by the contact company metric (no company → NO)', async () => {
		const a = await db.prepare("INSERT INTO automations (name, status) VALUES ('C', 'active') RETURNING id").first<{ id: number }>();
		const aid = a!.id;
		const ins = (pos: number, type: string, o: Record<string, unknown> = {}) =>
			db
				.prepare(
					`INSERT INTO automation_steps (automation_id, position, type, subject, body_md, from_email, tag_action, tag_name,
					   gate_kind, gate_name, gate_value, parent_step_id, branch_label)
					 VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, ?, ?, ?) RETURNING id`
				)
				.bind(aid, pos, type, o.tag ? 'add' : null, o.tag ?? null, o.kind ?? null, o.name ?? null, o.value ?? null, o.parent ?? null, o.label ?? null)
				.first<{ id: number }>()
				.then((r) => r!.id);
		const br = await ins(0, 'branch', { kind: 'company-metric', name: 'hours_30d', value: 'gte:5' });
		await ins(0, 'tag', { tag: 'busy', parent: br, label: 'yes' });
		await ins(0, 'tag', { tag: 'quiet', parent: br, label: 'no' });

		const busyCo = await company('Busy', { hours_30d: 9 });
		const quietCo = await company('Quiet', { hours_30d: 1 });
		const c1 = await contact('busy@x.test', busyCo);
		const c2 = await contact('quiet@x.test', quietCo);
		const c3 = await contact('none@x.test', null);
		for (const c of [c1, c2, c3]) {
			await db
				.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, next_run_at, status) VALUES (?, ?, ?, datetime('now', '-1 minute'), 'active')")
				.bind(aid, c, br)
				.run();
		}
		const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };
		for (let i = 0; i < 3; i++) await tick(db, cfg);

		const tags = await db
			.prepare(
				`SELECT c.email, l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id JOIN contacts c ON c.id = lm.contact_id
				 WHERE l.kind = 'tag' ORDER BY c.email`
			)
			.all<{ email: string; name: string }>();
		expect(tags.results).toEqual([
			{ email: 'busy@x.test', name: 'busy' },
			{ email: 'none@x.test', name: 'quiet' },
			{ email: 'quiet@x.test', name: 'quiet' }
		]);
	});
});

describe('Data API', () => {
	async function key(): Promise<string> {
		const k = await generateApiKey();
		await db
			.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, ?, ?, 'read')`)
			.bind(k.tokenHash, k.prefix, k.last4)
			.run();
		return k.token;
	}
	function ev(path: string, token: string, params: Record<string, string>) {
		const url = new URL(`https://app.test${path}`);
		return {
			request: new Request(url, { headers: { authorization: `Bearer ${token}` } }),
			platform: { env: env as any },
			url,
			params
		} as any;
	}

	it('GET /api/v1/companies/:id/metrics', async () => {
		const t = await key();
		const co = await company('Acme', { hours_30d: 4, issues_open: 2 });
		const bare = await company('Bare');
		const res = await getMetricsApi(ev(`/api/v1/companies/${co}/metrics`, t, { id: String(co) }));
		expect(res.status).toBe(200);
		const body = JSON.parse(await res.text());
		expect(body.data).toMatchObject({ company_id: co, hours_30d: 4, issues_open: 2, hours_7d: null, github_synced_at: null });
		const empty = JSON.parse(await (await getMetricsApi(ev(`/api/v1/companies/${bare}/metrics`, t, { id: String(bare) }))).text());
		expect(empty.data.hours_30d).toBeNull();
		expect((await getMetricsApi(ev('/api/v1/companies/999999/metrics', t, { id: '999999' }))).status).toBe(404);
		expect((await getMetricsApi(ev('/api/v1/companies/x/metrics', t, { id: 'x' }))).status).toBe(400);
	});

	it('GET /api/v1/contacts/:id embeds company_detail', async () => {
		const t = await key();
		const co = await company('Acme', { issues_open: 7 });
		const c = await contact('a@x.test', co);
		await db.prepare("UPDATE contacts SET company = 'Acme' WHERE id = ?").bind(c).run();
		const n = await contact('n@x.test', null);
		const body = JSON.parse(await (await getContactApi(ev(`/api/v1/contacts/${c}`, t, { id: String(c) }))).text());
		expect(body.data.company).toBe('Acme');
		expect(body.data.company_detail).toMatchObject({ id: co, name: 'Acme', domain: 'acme.test', metrics: { issues_open: 7, hours_30d: null } });
		expect(body.data.company_detail.metrics.company_id).toBeUndefined();
		const none = JSON.parse(await (await getContactApi(ev(`/api/v1/contacts/${n}`, t, { id: String(n) }))).text());
		expect(none.data.company_detail).toBeNull();
	});
});
