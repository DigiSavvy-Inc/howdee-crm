import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { pct } from '../src/lib/server/dashboard';
import { compileSegment } from '../src/lib/server/segment-query';
import { compileReportQuery, reportContactIds, runReport, specToSegmentRules } from '../src/lib/server/reports/engine';
import { utcWeekStart } from '../src/lib/report-spec';
import { adminOnlyKeys, isAdminOnlyField, parseReportSpec, ReportError } from '../src/lib/report-spec';
import { zohoReportsEnabled } from '../src/lib/report-metrics';
import {
	createReport,
	deleteReport,
	duplicateReport,
	getReport,
	listReports,
	updateReport
} from '../src/lib/server/reports/store';

const db = (env as { DB: D1Database }).DB;
const admin = { role: 'admin' as const };
const member = { role: 'member' as const };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM reports'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM companies'),
		db.prepare('DELETE FROM lists')
	]);
});

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await db.prepare(sql).bind(...binds).first<{ id: number }>();
	if (!row) throw new Error(sql);
	return row.id;
}

function contactsSpec(extra: Record<string, unknown> = {}) {
	return parseReportSpec({
		entity: 'contacts',
		filters: { match: 'all', rules: [] },
		columns: ['email'],
		...extra
	});
}

describe('report spec', () => {
	it('rejects an unknown entity, column, operator and key', () => {
		expect(() => parseReportSpec({ entity: 'widgets', filters: { match: 'all', rules: [] }, columns: ['email'] })).toThrow(
			/unknown entity/i
		);
		expect(() => contactsSpec({ columns: ['not_a_column'] })).toThrow(/unknown column/i);
		expect(() =>
			contactsSpec({
				filters: { match: 'all', rules: [{ field: 'tag', op: 'DROP', value: 'vip' }] }
			})
		).toThrow(/unknown operator/i);
		expect(() =>
			contactsSpec({
				filters: { match: 'all', rules: [{ field: 'nope', op: 'is', value: 'x' }] }
			})
		).toThrow(/unknown field/i);
		expect(() => contactsSpec({ injected: '1' })).toThrow(/unknown key/i);
		expect(() => contactsSpec({ thresholds: { minSent: 1, dropTable: 1 } })).toThrow(/unknown threshold/i);
	});

	it('caps limit at 5000 and defaults to 100', () => {
		expect(contactsSpec({ limit: 90000 }).limit).toBe(5000);
		expect(contactsSpec({ limit: 5000 }).limit).toBe(5000);
		expect(contactsSpec().limit).toBe(100);
		expect(() => contactsSpec({ limit: 0 })).toThrow(ReportError);
		expect(() => contactsSpec({ limit: 1.5 })).toThrow(ReportError);
	});

	it('parses preset and from/to time ranges', () => {
		expect(contactsSpec({ timeRange: { preset: '30d' } }).timeRange).toEqual({ preset: '30d' });
		expect(contactsSpec({ timeRange: { preset: 'all' } }).timeRange).toEqual({ preset: 'all' });
		expect(contactsSpec({ timeRange: { from: '2026-01-01', to: '2026-03-31' } }).timeRange).toEqual({
			from: '2026-01-01 00:00:00',
			to: '2026-03-31 23:59:59'
		});
		const again = parseReportSpec(contactsSpec({ timeRange: { from: '2026-01-01', to: '2026-03-31' } }));
		expect(again.timeRange).toEqual({ from: '2026-01-01 00:00:00', to: '2026-03-31 23:59:59' });
		expect(() => contactsSpec({ timeRange: { preset: 'yesterday' } })).toThrow(/unknown time range/i);
		expect(() => contactsSpec({ timeRange: { from: '2026-13-01', to: '2026-13-02' } })).toThrow(ReportError);
		expect(() => contactsSpec({ timeRange: { from: '2026-03-02', to: '2026-03-01' } })).toThrow(/after/i);
	});

	it('keeps Zoho metrics off', () => {
		expect(zohoReportsEnabled()).toBe(false);
		expect(() =>
			parseReportSpec({
				entity: 'companies',
				filters: { match: 'all', rules: [] },
				columns: ['zoho_ar']
			})
		).toThrow(/zoho/i);
	});
});

describe('SQL safety', () => {
	it('binds injected filter values and rejects unknown keys', async () => {
		const payload = "x' OR 1=1 --";
		const spec = contactsSpec({
			filters: { match: 'all', rules: [{ field: 'source', op: 'is', value: payload }] },
			columns: ['email', 'source']
		});
		const built = compileReportQuery(spec, admin);
		// source `is` binds the lowercased value, the same way compileSegment does.
		const bound = payload.toLowerCase();
		expect(built.sql).not.toContain(payload);
		expect(built.sql).not.toContain(bound);
		expect(built.sql).toContain('?');
		expect(built.binds).toContain(bound);
		expect(built.binds).not.toContain(payload);

		await id(`INSERT INTO contacts (email, source) VALUES ('kept@x.example.net', ?) RETURNING id`, payload);
		await id(`INSERT INTO contacts (email, source) VALUES ('other@x.example.net', 'ok') RETURNING id`);
		const result = await runReport(db, spec, admin);
		expect(result.rows.map((row) => row.email)).toEqual(['kept@x.example.net']);
	});
});

describe('campaign open rate', () => {
	async function campaign(subject: string, recipientCount: number): Promise<number> {
		return id(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, recipient_count, sent_at)
			 VALUES (?, 'm', 'h', 'f@x.example.net', 'sent', ?, '2026-06-01 12:00:00') RETURNING id`,
			subject,
			recipientCount
		);
	}

	async function recipient(campaignId: number, email: string, status: string): Promise<number> {
		return id(`INSERT INTO recipients (campaign_id, email, status) VALUES (?, ?, ?) RETURNING id`, campaignId, email, status);
	}

	async function event(
		campaignId: number,
		recipientId: number,
		type: string,
		detail?: string | null,
		at?: string | null
	) {
		await db
			.prepare(
				`INSERT INTO events (campaign_id, recipient_id, type, detail, recorded_at)
				 VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`
			)
			.bind(campaignId, recipientId, type, detail ?? null, at ?? null)
			.run();
	}

	function campaignSpec(columns: string[]) {
		return parseReportSpec({
			entity: 'campaigns',
			filters: { match: 'all', rules: [] },
			columns
		});
	}

	it('divides human opens and clicks by accepted recipients', async () => {
		const camp = await campaign('Hello', 10);
		const a = await recipient(camp, 'a@x.example.net', 'accepted');
		const b = await recipient(camp, 'b@x.example.net', 'accepted');
		await recipient(camp, 'c@x.example.net', 'accepted');
		await recipient(camp, 'd@x.example.net', 'accepted');
		await recipient(camp, 'e@x.example.net', 'error');
		await recipient(camp, 'f@x.example.net', 'error');
		await event(camp, a, 'open');
		await event(camp, a, 'open');
		await event(camp, b, 'open');
		await event(camp, a, 'click');

		const result = await runReport(
			db,
			campaignSpec(['subject', 'recipients', 'opens', 'open_rate', 'clicks', 'click_rate']),
			admin
		);
		expect(result.rows).toEqual([
			{
				subject: 'Hello',
				recipients: 4,
				opens: 2,
				open_rate: pct(2, 4),
				clicks: 1,
				click_rate: pct(1, 4)
			}
		]);
		expect(result.rows[0].open_rate).toBe(50);
		expect(result.rows[0].click_rate).toBe(25);
	});

	it('is null when nothing was accepted', async () => {
		const camp = await campaign('Empty', 5);
		const bad = await recipient(camp, 'bad@x.example.net', 'error');
		await event(camp, bad, 'open');
		const result = await runReport(db, campaignSpec(['subject', 'recipients', 'open_rate', 'click_rate']), admin);
		expect(result.rows[0]).toMatchObject({ subject: 'Empty', recipients: 0, open_rate: null, click_rate: null });
	});

	it('excludes Apple MPP proxy opens', async () => {
		const camp = await campaign('Proxy', 2);
		const apple = await recipient(camp, 'apple@x.example.net', 'accepted');
		const human = await recipient(camp, 'human@x.example.net', 'accepted');
		await event(camp, apple, 'delivery', null, '2026-06-01 12:00:00');
		await event(
			camp,
			apple,
			'open',
			JSON.stringify({ Client: { Name: 'Apple Mail', Family: 'Apple Mail' }, UserAgent: 'Mozilla/5.0 Apple Mail' }),
			'2026-06-01 12:00:05'
		);
		await event(camp, human, 'open', JSON.stringify({ Client: { Name: 'Gmail' }, UserAgent: 'Mozilla/5.0' }), '2026-06-01 13:00:00');

		const fast = await campaign('Fast open', 1);
		const who = await recipient(fast, 'fast@x.example.net', 'accepted');
		await event(fast, who, 'delivery', null, '2026-06-01 12:00:00');
		await event(fast, who, 'open', JSON.stringify({ FirstOpen: true }), '2026-06-01 12:00:30');

		const result = await runReport(db, campaignSpec(['subject', 'recipients', 'opens', 'open_rate']), admin);
		const proxy = result.rows.find((row) => row.subject === 'Proxy');
		const rushed = result.rows.find((row) => row.subject === 'Fast open');
		expect(proxy).toMatchObject({ recipients: 2, opens: 1, open_rate: 50 });
		expect(rushed).toMatchObject({ recipients: 1, opens: 0, open_rate: 0 });
	});
});

describe('contact reports', () => {
	async function contact(email: string, opts: { source?: string; meta?: string; created_at?: string } = {}): Promise<number> {
		return id(
			`INSERT INTO contacts (email, source, meta, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now'))) RETURNING id`,
			email,
			opts.source ?? null,
			opts.meta ?? null,
			opts.created_at ?? null
		);
	}

	async function engagement(contactId: number, sent: number, opens: number, proxy: number, uniqueOpens: number, clicks = 0) {
		await db
			.prepare(
				`INSERT INTO contact_engagement (
				   contact_id, sent_count, open_count, proxy_open_count, unique_open_campaigns,
				   click_count, unique_click_campaigns, open_rate, click_rate, tier
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'warm')`
			)
			.bind(
				contactId,
				sent,
				opens,
				proxy,
				uniqueOpens,
				clicks,
				clicks > 0 ? 1 : 0,
				sent > 0 ? uniqueOpens / sent : null,
				sent > 0 && clicks > 0 ? 1 / sent : null
			)
			.run();
	}

	async function tag(name: string, contactId: number) {
		const existing = await db.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND name = ?`).bind(name).first<{ id: number }>();
		const listId = existing?.id ?? (await id(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`, name));
		await db.prepare(`INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)`).bind(listId, contactId).run();
	}

	it('drops proxy opens from the contact open count', async () => {
		const who = await contact('mpp@x.example.net');
		await engagement(who, 4, 4, 3, 2);
		const result = await runReport(db, contactsSpec({ columns: ['email', 'opens', 'open_rate', 'sent'] }), admin);
		expect(result.rows).toEqual([{ email: 'mpp@x.example.net', opens: 1, open_rate: pct(2, 4), sent: 4 }]);
	});

	it('applies minSent before the row is rated', async () => {
		const low = await contact('low@x.example.net');
		const high = await contact('high@x.example.net');
		await engagement(low, 1, 1, 0, 1);
		await engagement(high, 5, 2, 0, 2);
		const spec = contactsSpec({ columns: ['email', 'sent', 'open_rate'], thresholds: { minSent: 3 } });
		expect(specToSegmentRules(spec, admin)).toBeNull();
		const result = await runReport(db, spec, admin);
		expect(result.rows.map((row) => row.email)).toEqual(['high@x.example.net']);
		expect(result.rows[0].open_rate).toBe(pct(2, 5));
		const ids = await reportContactIds(db, spec, admin);
		expect(ids).toEqual([high]);
	});

	it('groups by tag, source and custom field', async () => {
		const a = await contact('a@x.example.net', { source: 'newsletter', meta: '{"plan":"pro"}' });
		const b = await contact('b@x.example.net', { source: 'newsletter', meta: '{"plan":"pro"}' });
		const c = await contact('c@x.example.net', { source: 'import', meta: '{"plan":"free"}' });
		await engagement(a, 2, 0, 0, 0);
		await engagement(b, 3, 0, 0, 0);
		await engagement(c, 1, 0, 0, 0);
		await tag('vip', a);
		await tag('vip', b);
		await tag('other', c);

		const byTag = await runReport(db, contactsSpec({ columns: ['contacts', 'sent'], groupBy: 'tag' }), admin);
		expect(byTag.rows).toEqual([
			{ tag: 'other', contacts: 1, sent: 1 },
			{ tag: 'vip', contacts: 2, sent: 5 }
		]);

		const bySource = await runReport(db, contactsSpec({ columns: ['contacts', 'sent'], groupBy: 'source' }), admin);
		expect(bySource.rows).toEqual([
			{ source: 'import', contacts: 1, sent: 1 },
			{ source: 'newsletter', contacts: 2, sent: 5 }
		]);

		const byField = await runReport(
			db,
			contactsSpec({ columns: ['contacts'], groupBy: 'field:plan' }),
			admin
		);
		expect(byField.rows).toEqual([
			{ 'field:plan': 'free', contacts: 1 },
			{ 'field:plan': 'pro', contacts: 2 }
		]);
	});

	it('buckets weeks and months in UTC', async () => {
		await contact('jan@x.example.net', { created_at: '2026-01-15 00:00:00' });
		await contact('sun@x.example.net', { created_at: '2026-03-01 00:30:00' });
		await contact('wed@x.example.net', { created_at: '2026-03-04 15:00:00' });

		const weeks = await runReport(db, contactsSpec({ columns: ['contacts'], groupBy: 'week' }), admin);
		expect(weeks.rows).toEqual([
			{ week: '2026-01-12', contacts: 1 },
			{ week: utcWeekStart('2026-03-01 00:30:00'), contacts: 1 },
			{ week: '2026-03-02', contacts: 1 }
		]);
		expect(weeks.rows[1].week).toBe('2026-02-23');
		expect(compileReportQuery(contactsSpec({ columns: ['contacts'], groupBy: 'week' }), admin).sql).not.toContain('localtime');

		const months = await runReport(db, contactsSpec({ columns: ['contacts'], groupBy: 'month' }), admin);
		expect(months.rows).toEqual([
			{ month: '2026-01', contacts: 1 },
			{ month: '2026-03', contacts: 2 }
		]);
		expect(compileReportQuery(contactsSpec({ columns: ['contacts'], groupBy: 'month' }), admin).sql).not.toContain('localtime');
	});

	it('buckets campaign weeks with the same UTC Monday', async () => {
		await id(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at)
			 VALUES ('Later', 'm', 'h', 'f@x.example.net', 'sent', '2026-03-04 23:30:00') RETURNING id`
		);
		const result = await runReport(
			db,
			parseReportSpec({
				entity: 'campaigns',
				filters: { match: 'all', rules: [] },
				columns: ['recipients'],
				groupBy: 'week'
			}),
			admin
		);
		expect(result.rows).toEqual([{ week: '2026-03-02', recipients: 0 }]);
		expect(result.rows[0].week).toBe(utcWeekStart('2026-03-04 23:30:00'));
	});
});

describe('specToSegmentRules', () => {
	it('returns the same contact ids as compileSegment', async () => {
		const match = await id(`INSERT INTO contacts (email, source) VALUES ('in@x.example.net', 'csv') RETURNING id`);
		await id(`INSERT INTO contacts (email, source) VALUES ('out@x.example.net', 'other') RETURNING id`);
		await id(
			`INSERT INTO contacts (email, source, archived_at) VALUES ('gone@x.example.net', 'csv', '2026-01-01 00:00:00') RETURNING id`
		);
		const filters = { match: 'all' as const, rules: [{ field: 'source', op: 'is', value: 'csv' }] };
		const spec = contactsSpec({ filters, columns: ['email'] });
		const rules = specToSegmentRules(spec, admin);
		expect(rules).toEqual(filters);
		const compiled = compileSegment(rules);
		const seg = await db.prepare(compiled.sql).bind(...compiled.binds).all<{ id: number }>();
		const ids = await reportContactIds(db, spec, admin);
		expect(ids).toEqual([match]);
		expect([...ids].sort((a, b) => a - b)).toEqual(seg.results.map((row) => row.id).sort((a, b) => a - b));

		expect(specToSegmentRules(contactsSpec({ entity: 'companies' as never, columns: ['name'] }), admin)).toBeNull();
		expect(
			specToSegmentRules(
				parseReportSpec({
					entity: 'companies',
					filters,
					columns: ['name']
				}),
				admin
			)
		).toBeNull();
		expect(specToSegmentRules(contactsSpec({ entityFilters: [{ field: 'bounced', op: 'any' }] }), admin)).toBeNull();
		expect(specToSegmentRules(contactsSpec({ timeRange: { preset: '30d' } }), admin)).toBeNull();
	});
});

describe('permissions', () => {
	it('refuses hours and pipeline value for a member', async () => {
		const company = await id(`INSERT INTO companies (name) VALUES ('Acme') RETURNING id`);
		await db.prepare(`INSERT INTO company_metrics (company_id, hours_30d) VALUES (?, 12.5)`).bind(company).run();
		const hours = parseReportSpec({
			entity: 'companies',
			filters: { match: 'all', rules: [] },
			columns: ['name', 'hours_30d']
		});
		await expect(runReport(db, hours, member)).rejects.toThrow(/admins only/i);
		await expect(runReport(db, hours, member)).rejects.toThrow(/hours_30d/);
		const allowed = await runReport(db, hours, admin);
		expect(allowed.columns.map((column) => column.key)).toContain('hours_30d');
		expect(allowed.rows).toEqual([{ name: 'Acme', hours_30d: 12.5 }]);

		const who = await id(`INSERT INTO contacts (email) VALUES ('deal@x.example.net') RETURNING id`);
		const stage = await db.prepare(`SELECT id FROM pipeline_stages WHERE name = 'Lead'`).first<{ id: number }>();
		await db
			.prepare(
				`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 5000, '2026-01-01 00:00:00')`
			)
			.bind(who, stage!.id)
			.run();
		const value = contactsSpec({ columns: ['email', 'pipeline_value'] });
		await expect(runReport(db, value, member)).rejects.toThrow(/pipeline_value/);
		const seen = await runReport(db, value, admin);
		expect(seen.rows).toEqual([{ email: 'deal@x.example.net', pipeline_value: 5000 }]);

		const safe = await runReport(db, contactsSpec({ columns: ['email'] }), member);
		expect(safe.columns.map((column) => column.key)).not.toContain('pipeline_value');
		expect(safe.columns.map((column) => column.key)).not.toContain('hours_30d');
	});

	it('refuses last_tracked_at for a member as a filter, sort or column, and allows an admin', async () => {
		const company = await id(`INSERT INTO companies (name) VALUES ('Tracked Co') RETURNING id`);
		await db
			.prepare(`INSERT INTO company_metrics (company_id, last_tracked_at) VALUES (?, '2026-10-01 10:00:00')`)
			.bind(company)
			.run();
		const who = await id(`INSERT INTO contacts (email, company_id) VALUES ('tracked@x.example.net', ?) RETURNING id`, company);
		expect(who).toBeGreaterThan(0);
		const filter = contactsSpec({
			filters: {
				match: 'all',
				rules: [{ field: 'company_metric', op: 'within', value: '3650', value2: 'last_tracked_at' }]
			}
		});
		await expect(runReport(db, filter, member)).rejects.toThrow(/Admins only/);
		await expect(runReport(db, filter, member)).rejects.toThrow(/last_tracked_at/);
		await expect(runReport(db, filter, admin)).resolves.toBeTruthy();

		// Sort and column keys go through the same gate.
		expect(isAdminOnlyField('companies', 'last_tracked_at')).toBe(true);
		expect(isAdminOnlyField('contacts', 'last_tracked_at')).toBe(true);
		const raw = { ...filter, columns: ['email', 'last_tracked_at'], sort: { key: 'last_tracked_at', dir: 'desc' } };
		expect(adminOnlyKeys(raw as typeof filter)).toEqual(['last_tracked_at']);
	});

	it('refuses a member sort by pipeline value, hours or Zoho money', async () => {
		const low = await id(`INSERT INTO contacts (email) VALUES ('sort-low@x.example.net') RETURNING id`);
		const high = await id(`INSERT INTO contacts (email) VALUES ('sort-high@x.example.net') RETURNING id`);
		const stages = await db
			.prepare(`SELECT id, name FROM pipeline_stages WHERE kind = 'open' ORDER BY position LIMIT 2`)
			.all<{ id: number; name: string }>();
		expect(stages.results?.length).toBe(2);
		const [first, second] = stages.results ?? [];
		await db
			.prepare(
				`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 100, '2026-01-01 00:00:00')`
			)
			.bind(low, first.id)
			.run();
		await db
			.prepare(
				`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 9000, '2026-01-02 00:00:00')`
			)
			.bind(high, second.id)
			.run();

		const sorted = parseReportSpec({
			entity: 'pipeline',
			filters: { match: 'all', rules: [] },
			columns: ['cards', 'pipeline_value'],
			groupBy: 'pipeline_stage',
			sort: { key: 'pipeline_value', dir: 'desc' }
		});
		await expect(runReport(db, sorted, member)).rejects.toThrow(/Admins only/);
		await expect(runReport(db, sorted, member)).rejects.toThrow(/pipeline_value/);
		expect(() => compileReportQuery(sorted, member)).toThrow(/pipeline_value/);

		// Sort key alone, column omitted — this is the ORDER BY pipeline_value path.
		const hiddenSort = parseReportSpec({
			entity: 'pipeline',
			filters: { match: 'all', rules: [] },
			columns: ['cards'],
			groupBy: 'pipeline_stage',
			sort: { key: 'pipeline_value', dir: 'desc' }
		});
		await expect(runReport(db, hiddenSort, member)).rejects.toThrow(/pipeline_value/);
		expect(compileReportQuery(sorted, admin).sql).toContain('ORDER BY pipeline_value DESC');
		expect(compileReportQuery(hiddenSort, admin).sql).not.toContain('pipeline_value');

		const adminRows = await runReport(db, sorted, admin);
		expect(adminRows.rows.map((row) => row.pipeline_value)).toEqual([9000, 100]);

		const hoursSort = parseReportSpec({
			entity: 'companies',
			filters: { match: 'all', rules: [] },
			columns: ['name'],
			sort: { key: 'hours_30d', dir: 'desc' }
		});
		await expect(runReport(db, hoursSort, member)).rejects.toThrow(/hours_30d/);
		const zohoSort = parseReportSpec({
			entity: 'companies',
			filters: { match: 'all', rules: [] },
			columns: ['name'],
			sort: { key: 'zoho_paid', dir: 'desc' }
		});
		await expect(runReport(db, zohoSort, member)).rejects.toThrow(/zoho_paid/);

		const stageOnly = await runReport(
			db,
			parseReportSpec({
				entity: 'pipeline',
				filters: { match: 'all', rules: [] },
				columns: ['cards'],
				groupBy: 'pipeline_stage',
				sort: { key: 'cards', dir: 'desc' }
			}),
			member
		);
		expect(stageOnly.rows.map((row) => row.pipeline_stage).sort()).toEqual([first.name, second.name].sort());
		expect(JSON.stringify(stageOnly)).not.toContain('9000');
	});

	it('refuses member filters that would reveal hours, billing or pipeline value', async () => {
		const richCo = await id(`INSERT INTO companies (name) VALUES ('Rich Co') RETURNING id`);
		const quietCo = await id(`INSERT INTO companies (name) VALUES ('Quiet Co') RETURNING id`);
		await db.prepare(`INSERT INTO company_metrics (company_id, hours_30d, issues_open) VALUES (?, 40, 3)`).bind(richCo).run();
		await db.prepare(`INSERT INTO company_metrics (company_id, hours_30d, issues_open) VALUES (?, 1, 0)`).bind(quietCo).run();
		const rich = await id(`INSERT INTO contacts (email, company_id) VALUES ('rich@x.example.net', ?) RETURNING id`, richCo);
		await id(`INSERT INTO contacts (email, company_id) VALUES ('quiet@x.example.net', ?) RETURNING id`, quietCo);

		const byHours = contactsSpec({
			filters: {
				match: 'all',
				rules: [{ field: 'company_metric', op: 'gt', value: '10', value2: 'hours_30d' }]
			}
		});
		await expect(runReport(db, byHours, member)).rejects.toThrow(/Admins only/);
		await expect(runReport(db, byHours, member)).rejects.toThrow(/hours_30d/);
		await expect(reportContactIds(db, byHours, member)).rejects.toThrow(/hours_30d/);
		expect(() => specToSegmentRules(byHours, member)).toThrow(/hours_30d/);

		const allowed = await runReport(db, byHours, admin);
		expect(allowed.rows).toEqual([{ email: 'rich@x.example.net' }]);
		expect(allowed.recordIds).toEqual([rich]);
		expect(JSON.stringify(allowed)).not.toContain('quiet@x.example.net');
		expect(specToSegmentRules(byHours, admin)?.rules).toEqual(byHours.filters.rules);
		// #362: viewer is required; a caller that leaves it out fails closed.
		// @ts-expect-error viewer is a required argument
		expect(() => specToSegmentRules(byHours)).toThrow(/hours_30d/);

		const entityHours = parseReportSpec({
			entity: 'companies',
			filters: { match: 'all', rules: [] },
			entityFilters: [{ field: 'hours_30d', op: 'gt', value: '10' }],
			columns: ['name']
		});
		await expect(runReport(db, entityHours, member)).rejects.toThrow(/hours_30d/);
		expect((await runReport(db, entityHours, admin)).rows).toEqual([{ name: 'Rich Co' }]);

		const contactMetric = contactsSpec({
			entityFilters: [{ field: 'company_metric', op: 'gt', value: '10', value2: 'hours_7d' }]
		});
		await expect(runReport(db, contactMetric, member)).rejects.toThrow(/hours_7d/);

		const issues = parseReportSpec({
			entity: 'companies',
			filters: { match: 'all', rules: [] },
			entityFilters: [{ field: 'issues_open', op: 'gt', value: '0' }],
			columns: ['name']
		});
		expect((await runReport(db, issues, member)).rows).toEqual([{ name: 'Rich Co' }]);
	});

	it('refuses member group totals of pipeline value, hours and money', async () => {
		const low = await id(`INSERT INTO contacts (email) VALUES ('agg-low@x.example.net') RETURNING id`);
		const high = await id(`INSERT INTO contacts (email) VALUES ('agg-high@x.example.net') RETURNING id`);
		const stage = await db.prepare(`SELECT id, name FROM pipeline_stages WHERE name = 'Lead'`).first<{ id: number; name: string }>();
		await db
			.prepare(
				`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 100, '2026-01-01 00:00:00')`
			)
			.bind(low, stage!.id)
			.run();
		await db
			.prepare(
				`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 9000, '2026-01-02 00:00:00')`
			)
			.bind(high, stage!.id)
			.run();

		const grouped = parseReportSpec({
			entity: 'pipeline',
			filters: { match: 'all', rules: [] },
			columns: ['cards', 'pipeline_value'],
			groupBy: 'pipeline_stage'
		});
		await expect(runReport(db, grouped, member)).rejects.toThrow(/Admins only/);
		await expect(runReport(db, grouped, member)).rejects.toThrow(/pipeline_value/);
		expect(compileReportQuery(grouped, admin).sql).toContain('SUM(pc.value)');
		const adminGrouped = await runReport(db, grouped, admin);
		expect(adminGrouped.rows).toEqual([expect.objectContaining({ pipeline_stage: 'Lead', cards: 2, pipeline_value: 9100 })]);

		const counts = parseReportSpec({
			entity: 'pipeline',
			filters: { match: 'all', rules: [] },
			columns: ['cards', 'won', 'lost'],
			groupBy: 'pipeline_stage'
		});
		const memberCounts = await runReport(db, counts, member);
		expect(memberCounts.columns.map((column) => column.key)).toEqual(['pipeline_stage', 'cards', 'won', 'lost']);
		expect(memberCounts.rows).toEqual([expect.objectContaining({ pipeline_stage: 'Lead', cards: 2 })]);
		expect(JSON.stringify(memberCounts)).not.toContain('9100');
		expect(JSON.stringify(memberCounts)).not.toContain('9000');

		await expect(
			runReport(
				db,
				parseReportSpec({
					entity: 'companies',
					filters: { match: 'all', rules: [] },
					columns: ['name', 'hours_total']
				}),
				member
			)
		).rejects.toThrow(/hours_total/);
		expect(() =>
			compileReportQuery(
				parseReportSpec({
					entity: 'companies',
					filters: { match: 'all', rules: [] },
					columns: ['name'],
					sort: { key: 'zoho_invoiced', dir: 'desc' }
				}),
				member
			)
		).toThrow(/zoho_invoiced/);
	});

	it('refuses a member save of a spec that mentions an admin-only field', async () => {
		const spec = contactsSpec({ columns: ['email', 'pipeline_value'], sort: { key: 'pipeline_value', dir: 'desc' } });
		await expect(createReport(db, { name: 'Member secret', spec }, member)).rejects.toThrow(/Admins only/);
		expect(await listReports(db)).toEqual([]);
		const saved = await createReport(db, { name: 'Admin secret', spec }, admin);
		await expect(updateReport(db, saved.id, { pinned: true }, member)).rejects.toThrow(/pipeline_value/);
		await expect(duplicateReport(db, saved.id, null, member)).rejects.toThrow(/pipeline_value/);
		// #362: viewer is required; a caller that leaves it out gets the member check.
		// @ts-expect-error viewer is a required argument
		await expect(createReport(db, { name: 'No viewer', spec })).rejects.toThrow(/pipeline_value/);
		// @ts-expect-error viewer is a required argument
		await expect(updateReport(db, saved.id, { pinned: true })).rejects.toThrow(/pipeline_value/);
		// @ts-expect-error viewer is a required argument
		await expect(duplicateReport(db, saved.id, null)).rejects.toThrow(/pipeline_value/);
		expect((await getReport(db, saved.id))?.pinned).toBe(0);
		const renamed = await updateReport(db, saved.id, { name: 'Admin secret renamed' }, admin);
		expect(renamed?.name).toBe('Admin secret renamed');
		expect(renamed?.spec.columns).toContain('pipeline_value');
	});
});

describe('saved reports', () => {
	it('creates, lists, updates, duplicates and deletes', async () => {
		const user = await db.prepare(`SELECT id FROM users WHERE github_login = 'ourco-admin'`).first<{ id: number }>();
		const spec = contactsSpec({ columns: ['email', 'source'] });
		const created = await createReport(db, {
			name: 'Quiet clients',
			description: 'No opens',
			spec,
			createdBy: user!.id,
			pinned: true,
			folder: 'Weekly',
			builtInKey: 'quiet-clients'
		}, admin);
		expect(created.spec).toEqual(spec);
		expect(created.pinned).toBe(1);
		expect(created.built_in_key).toBe('quiet-clients');

		const copy = await duplicateReport(db, created.id, user!.id, admin);
		expect(copy.name).toBe('Copy of Quiet clients');
		expect(copy.built_in_key).toBeNull();
		expect(copy.pinned).toBe(0);
		expect(copy.spec).toEqual(spec);

		const updated = await updateReport(db, created.id, { name: 'Quiet clients renamed', pinned: false }, admin);
		expect(updated?.name).toBe('Quiet clients renamed');
		expect(updated?.pinned).toBe(0);

		const listed = await listReports(db, { folder: 'Weekly' });
		expect(listed.map((row) => row.id).sort()).toEqual([created.id, copy.id].sort());

		expect(await getReport(db, created.id)).toMatchObject({ name: 'Quiet clients renamed' });
		expect(await deleteReport(db, copy.id)).toBe(true);
		expect(await getReport(db, copy.id)).toBeNull();
		expect(await deleteReport(db, copy.id)).toBe(false);
	});
});

describe('migration 0092', () => {
	it('adds the reports table and site_events(occurred_at) without a second events contact index', async () => {
		const reports = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reports'`).first();
		expect(reports).toBeTruthy();
		const site = await db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_site_events_occurred'`)
			.first();
		expect(site).toBeTruthy();
		const indexes = await db
			.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL`)
			.all<{ name: string; sql: string }>();
		const contactTypeTime = indexes.results.filter(
			(index) => /contact_id/i.test(index.sql) && /\btype\b/i.test(index.sql) && /recorded_at/i.test(index.sql)
		);
		expect(contactTypeTime.map((index) => index.name)).toEqual(['idx_events_contact_type_time']);
	});
});
