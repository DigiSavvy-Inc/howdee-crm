// #456: built-in report pages — CSV + Pin, faithful Duplicate (?spec=, nothing saved),
// custom date range params, raised API / CSV limits, timezone cells, CSV numbers, readback.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { readback } from '../src/lib/report-nl';
import { parseReportSpec } from '../src/lib/report-spec';
import { CSV_BOM, csvCell, decodeSpec, formatCell, formatDateTime, reportCsv } from '../src/lib/report-view';
import { generateApiKey } from '../src/lib/server/api-keys';
import {
	BUILT_IN_REPORTS,
	MAX_CUSTOM_RANGE_DAYS,
	builtInByKey,
	builtInInfo,
	customRange,
	resolveParams,
	runBuiltIn
} from '../src/lib/server/reports/builtins';
import { CAMPAIGN_FETCH_CAP } from '../src/lib/server/reports/engine';
import { listBuiltInPins } from '../src/lib/server/reports/store';
import { load as loadHome } from '../src/routes/reports/+page.server';
import { actions as builtInActions, load as loadBuiltIn } from '../src/routes/reports/b/[key]/+page.server';
import { GET as builtInCsvGET } from '../src/routes/reports/b/[key].csv/+server';
import { GET as savedCsvGET } from '../src/routes/reports/[id].csv/+server';
import { GET as runRefGET } from '../src/routes/api/v1/reports/[ref]/run/+server';

const db = (env as { DB: D1Database }).DB;
const admin = { id: 1, role: 'admin' as const };
const TZ = 'America/Los_Angeles';
let listId: number;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM reports'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare(`DELETE FROM lists WHERE name = 'r456 list'`),
		db.prepare(`DELETE FROM app_state WHERE key IN ('reports_pinned_builtins', 'timezone')`),
		db.prepare(`INSERT INTO app_state (key, value) VALUES ('timezone', ?)`).bind(TZ)
	]);
	const row = await db.prepare(`INSERT INTO lists (name, kind) VALUES ('r456 list', 'list') RETURNING id`).first<{ id: number }>();
	listId = row!.id;
});

async function campaign(subject: string, sentAt: string, sent: number, opens: number): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, sent_at)
			 VALUES (?, 'm', 'h', 'f@x.example.net', 'sent', ?, ?) RETURNING id`
		)
		.bind(subject, listId, sentAt)
		.first<{ id: number }>();
	const id = row!.id;
	for (let i = 0; i < sent; i++) {
		const r = await db
			.prepare(`INSERT INTO recipients (campaign_id, email, status) VALUES (?, ?, 'accepted') RETURNING id`)
			.bind(id, `r456-${id}-${i}@x.example.net`)
			.first<{ id: number }>();
		if (i < opens) {
			await db
				.prepare(`INSERT INTO events (campaign_id, recipient_id, type, detail) VALUES (?, ?, 'open', ?)`)
				.bind(id, r!.id, JSON.stringify({ Client: { Name: 'Gmail' }, UserAgent: 'Mozilla/5.0' }))
				.run();
		}
	}
	return id;
}

function getEvent(path: string, params: Record<string, string> = {}, user = admin) {
	const url = new URL(`https://crm.test${path}`);
	return { request: new Request(url), url, params, locals: { user }, platform: { env } } as any;
}

function postEvent(path: string, params: Record<string, string>, fields: Record<string, string>, user = admin) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const url = new URL(`https://crm.test${path}`);
	return { request: new Request(url, { method: 'POST', body }), url, params, locals: { user }, platform: { env } } as any;
}

async function redirectLocation(pending: unknown): Promise<string> {
	try {
		await pending;
	} catch (err) {
		if (isRedirect(err)) return err.location;
		throw err;
	}
	throw new Error('expected a redirect');
}

function csvLines(text: string): string[] {
	return text.replace(CSV_BOM, '').trimEnd().split('\r\n');
}

describe('built-in CSV', () => {
	it('/reports/b/<key>.csv: BOM, numeric rates, the unit in the header, times in Settings → Timezone, params honoured', async () => {
		await campaign('January send', '2026-01-15 20:30:00', 4, 1);
		await campaign('March send', '2026-03-10 10:00:00', 2, 2);
		const query = 'p_range=custom&p_from=2026-01-01&p_to=2026-01-31';
		const res = await builtInCsvGET(getEvent(`/reports/b/campaign-performance.csv?${query}`, { key: 'campaign-performance' }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/csv');
		expect(res.headers.get('content-disposition')).toBe('attachment; filename="report-campaign-performance.csv"');
		const text = await res.text();
		expect(text.startsWith(CSV_BOM)).toBe(true);
		const [header, ...rows] = csvLines(text);
		expect(header).toContain('Open rate (%)');
		expect(header).toContain('Click rate (%)');
		expect(rows).toHaveLength(1); // March is outside the custom range
		expect(rows[0]).toMatch(/^January send,4,0,/);
		expect(rows[0]).toContain(',25,'); // open rate as a number, no "%"
		expect(rows[0]).not.toContain('%');
		expect(rows[0]).not.toContain('—');
		expect(rows[0]).toContain('2026-01-15 12:30'); // 20:30 UTC in Los Angeles
	});

	it('/reports/builtin:<key>.csv is the same export; ?limit= raises the row limit', async () => {
		for (let i = 0; i < 12; i++) await campaign(`Send ${i}`, `2026-10-${String(10 + i).padStart(2, '0')} 09:00:00`, 1, 0);
		const viaRef = await savedCsvGET(getEvent('/reports/builtin:campaign-comparison.csv', { id: 'builtin:campaign-comparison' }));
		expect(viaRef.status).toBe(200);
		expect(csvLines(await viaRef.text())).toHaveLength(1 + 10); // the built-in's own limit
		const raised = await builtInCsvGET(getEvent('/reports/b/campaign-comparison.csv?limit=50', { key: 'campaign-comparison' }));
		expect(csvLines(await raised.text())).toHaveLength(1 + 12);
	});

	it('unknown built-ins 404; an admin-only one is refused for members', async () => {
		await expect(builtInCsvGET(getEvent('/reports/b/nope.csv', { key: 'nope' }))).rejects.toMatchObject({ status: 404 });
		await expect(
			builtInCsvGET(getEvent('/reports/b/client-hours-trend.csv', { key: 'client-hours-trend' }, { id: 2, role: 'member' } as any))
		).rejects.toMatchObject({ status: 404 });
	});

	it('empty cells stay empty, numbers stay numbers, a leading formula is still guarded', () => {
		const csv = reportCsv(
			[
				{ key: 'name', label: 'Name', format: 'text' },
				{ key: 'rate', label: 'Open rate', format: 'pct' },
				{ key: 'value', label: 'Value', format: 'currency' },
				{ key: 'delta', label: 'Delta', format: 'count' }
			],
			[
				{ name: '=cmd', rate: 24.4, value: 12345, delta: -3 },
				{ name: 'x', rate: null, value: null, delta: null }
			]
		);
		expect(csvLines(csv)).toEqual(['Name,Open rate (%),Value,Delta', "'=cmd,24.4,12345,-3", 'x,,,']);
		expect(csvCell('-2+3')).toBe("'-2+3");
	});
});

describe('pin a built-in', () => {
	it('pins with the current params, renders as a card on Reports home, and unpins', async () => {
		await campaign('Pinned send', '2026-10-20 09:00:00', 2, 1);
		const location = await redirectLocation(
			builtInActions.pin(postEvent('/reports/b/campaign-comparison?/pin', { key: 'campaign-comparison' }, { pinned: '1' }))
		);
		expect(location).toBe('/reports/b/campaign-comparison');
		expect(await listBuiltInPins(db)).toEqual([{ key: 'campaign-comparison', params: {} }]);

		const home = await loadHome(getEvent('/reports'));
		const card = home.pinned.find((item) => item.id === 'b:campaign-comparison');
		expect(card).toMatchObject({ name: 'Campaign comparison', href: '/reports/b/campaign-comparison', chart: 'bar', error: null });
		expect(card?.result?.rows.map((row) => row.subject)).toEqual(['Pinned send']);
		expect(home.tz).toBe(TZ);

		const page = await loadBuiltIn(getEvent('/reports/b/campaign-comparison', { key: 'campaign-comparison' }));
		expect(page.builtIn).toMatchObject({ pinned: true, pinnedHere: true });

		await redirectLocation(
			builtInActions.pin(postEvent('/reports/b/campaign-comparison?/pin', { key: 'campaign-comparison' }, { pinned: '0' }))
		);
		expect((await loadHome(getEvent('/reports'))).pinned.some((item) => item.id === 'b:campaign-comparison')).toBe(false);
	});

	it('keeps the params; best send times (not duplicable) is pinnable too', async () => {
		const location = await redirectLocation(
			builtInActions.pin(
				postEvent('/reports/b/campaign-performance?/pin', { key: 'campaign-performance' }, { pinned: '1', p_range: '30d' })
			)
		);
		expect(location).toBe('/reports/b/campaign-performance?p_range=30d');
		await redirectLocation(builtInActions.pin(postEvent('/reports/b/best-send-times?/pin', { key: 'best-send-times' }, { pinned: '1' })));
		const home = await loadHome(getEvent('/reports'));
		expect(home.pinned.find((item) => item.id === 'b:campaign-performance')?.href).toBe('/reports/b/campaign-performance?p_range=30d');
		expect(home.pinned.find((item) => item.id === 'b:best-send-times')).toMatchObject({ chart: 'heatmap', error: null });
		const page = await loadBuiltIn(getEvent('/reports/b/campaign-performance?p_range=90d', { key: 'campaign-performance' }));
		expect(page.builtIn).toMatchObject({ pinned: true, pinnedHere: false, query: 'p_range=90d' });
	});
});

describe('Duplicate and flags', () => {
	it('a duplicable built-in opens /reports/new?spec= and saves nothing', async () => {
		const location = await redirectLocation(
			builtInActions.duplicate(postEvent('/reports/b/new-contacts-by-source?/duplicate', { key: 'new-contacts-by-source' }, { p_range: '30d' }))
		);
		const url = new URL(location, 'https://crm.test');
		expect(url.pathname).toBe('/reports/new');
		expect(decodeSpec(url.searchParams.get('spec') ?? '').timeRange).toEqual({ preset: '30d' });
		expect(url.searchParams.get('name')).toBe('Copy of New contacts by source');
		expect((await db.prepare(`SELECT COUNT(*) AS n FROM reports`).first<{ n: number }>())?.n).toBe(0);
	});

	it('the trend, automation email and per-contact campaign reports are not duplicable and show as custom', async () => {
		// #457: campaign performance / comparison recount per contact in their run.
		for (const key of ['rate-trend', 'automation-email-performance', 'best-send-times', 'campaign-performance', 'campaign-comparison']) {
			const def = builtInByKey(key)!;
			expect(builtInInfo(def, resolveParams(def))).toMatchObject({ duplicable: false, custom: true });
			const res = (await builtInActions.duplicate(postEvent(`/reports/b/${key}?/duplicate`, { key }, {}))) as { status: number };
			expect(res.status).toBe(400);
		}
		// Every report with a run step is either custom or a faithful copy, never both or neither.
		for (const def of BUILT_IN_REPORTS) {
			const info = builtInInfo(def, resolveParams(def));
			if (def.run) expect(info.custom).toBe(!info.duplicable);
			else expect(info).toMatchObject({ custom: false, duplicable: true });
		}
	});

	it('the automation email spec has no sort the results would not follow', () => {
		const def = builtInByKey('automation-email-performance')!;
		expect(def.spec(resolveParams(def), admin).sort).toBeUndefined();
	});
});

describe('custom date range', () => {
	const now = new Date('2026-10-24T12:00:00Z');

	it('validates, swaps and clamps to 2 years', () => {
		expect(customRange('', '', now)).toEqual({ from: '2026-09-24', to: '2026-10-24' });
		expect(customRange('2026-02-30', 'nope', now)).toEqual({ from: '2026-09-24', to: '2026-10-24' });
		expect(customRange('2026-10-10', '2026-01-01', now)).toEqual({ from: '2026-01-01', to: '2026-10-10' });
		expect(customRange('2020-01-01', '2026-10-01', now)).toEqual({ from: '2024-10-01', to: '2026-10-01' });
		expect(MAX_CUSTOM_RANGE_DAYS).toBe(730);
	});

	it('p_from / p_to feed the spec only when Custom is picked', () => {
		const def = builtInByKey('campaign-performance')!;
		const custom = resolveParams(def, new URLSearchParams('p_range=custom&p_from=2026-01-01&p_to=2026-03-31'), now);
		expect(def.spec(custom, admin).timeRange).toEqual({ from: '2026-01-01 00:00:00', to: '2026-03-31 23:59:59' });
		const preset = resolveParams(def, new URLSearchParams('p_range=30d&p_from=2026-01-01'), now);
		expect(def.spec(preset, admin).timeRange).toEqual({ preset: '30d' });
		expect(builtInInfo(def, preset).query).toBe('p_range=30d');
		expect(builtInInfo(def, custom).query).toBe('p_range=custom&p_from=2026-01-01&p_to=2026-03-31');
	});

	it('pipeline movement honours a custom range', async () => {
		const def = builtInByKey('pipeline-movement')!;
		const params = resolveParams(def, new URLSearchParams('p_range=custom&p_from=2026-01-01&p_to=2026-01-31'), now);
		const result = await runBuiltIn(db, def, params, admin, now);
		expect(result.columns.map((column) => column.key)).toContain('moves');
	});
});

describe('API limit', () => {
	it('?limit= raises a built-in limit, capped at the engine cap', async () => {
		for (let i = 0; i < 12; i++) await campaign(`API ${i}`, `2026-10-${String(10 + i).padStart(2, '0')} 09:00:00`, 1, 0);
		const k = await generateApiKey();
		await db
			.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('r456', ?, ?, ?, 'read')`)
			.bind(k.tokenHash, k.prefix, k.last4)
			.run();
		const call = async (query: string) => {
			const url = new URL(`https://app.test/api/v1/reports/builtin:campaign-comparison/run${query}`);
			const event = {
				request: new Request(url, { headers: { authorization: `Bearer ${k.token}` } }),
				url,
				params: { ref: 'builtin:campaign-comparison' },
				platform: { env }
			} as any;
			return (await (await runRefGET(event)).json<any>()).data;
		};
		expect((await call('')).rows).toHaveLength(10);
		expect((await call('?limit=50')).rows).toHaveLength(12);
		expect((await call('?limit=3')).rows).toHaveLength(3);
		const def = builtInByKey('campaign-comparison')!;
		const capped = await runBuiltIn(db, def, resolveParams(def), admin, new Date(), { limit: 10_000_000 });
		expect(capped.rows).toHaveLength(12);
		expect(CAMPAIGN_FETCH_CAP).toBe(5000);
	});
});

describe('timezone cells', () => {
	it('formatCell reads date-times in the zone; dates, other formats and no zone are unchanged', () => {
		expect(formatCell('2026-10-20 16:05:00', 'date', TZ)).toBe('2026-10-20 09:05');
		expect(formatCell('2026-01-05T03:00:00.000Z', 'date', 'America/New_York')).toBe('2026-01-04 22:00');
		expect(formatCell('2026-10-20', 'date', TZ)).toBe('2026-10-20');
		expect(formatCell('2026-10-20 16:05:00', 'date')).toBe('2026-10-20 16:05:00');
		expect(formatCell(null, 'date', TZ)).toBe('—');
		expect(formatCell(24.4, 'pct', TZ)).toBe('24.4%');
		expect(formatDateTime('not a date', TZ)).toBe('not a date');
		expect(formatDateTime('2026-10-20 16:05:00', 'Not/AZone')).toBe('2026-10-20 16:05:00');
	});

	it('the built-in page loads the zone for the results table', async () => {
		const page = await loadBuiltIn(getEvent('/reports/b/campaign-performance', { key: 'campaign-performance' }));
		expect(page.tz).toBe(TZ);
	});
});

describe('readback', () => {
	const base = { filters: { match: 'all', rules: [] }, columns: ['subject'] };

	it('mentions the row limit', () => {
		expect(readback(parseReportSpec({ entity: 'campaigns', ...base, limit: 25 }))).toBe('Campaigns, showing Subject, up to 25 rows.');
		expect(readback(parseReportSpec({ entity: 'campaigns', ...base, limit: 1 }))).toBe('Campaigns, showing Subject, first row only.');
	});

	it('names automation emails and broadcasts instead of "kind is …"', () => {
		const automation = builtInByKey('automation-email-performance')!;
		const line = readback(automation.spec(resolveParams(automation), admin));
		expect(line).toMatch(/^Automation emails, all time, showing Subject,/);
		expect(line).not.toMatch(/sorted by recipients/);
		const trend = builtInByKey('rate-trend')!;
		expect(readback(trend.spec(resolveParams(trend), admin))).toMatch(
			/^Broadcast campaigns \(automation emails left out\) where status is sent, last 12 months, showing Open rate, Click rate, grouped by week, up to 60 rows\.$/
		);
	});
});
