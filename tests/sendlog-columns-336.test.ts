import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	SENDLOG_COLUMNS,
	DEFAULT_SENDLOG_COLUMNS,
	cleanSendLogColumns,
	ratePct,
	rateText,
	sendLogRates
} from '../src/lib/sendlog-columns';
import { SENDLOG_SORTS, sendLogOrderBy, sendLogRows, type SendLogFilter } from '../src/lib/server/sendlog-query';

// #336: Send log column picker, rate columns and their sort keys.
const db = (env as any).DB as D1Database;
const EMPTY: SendLogFilter = { status: 'any', type: 'any', q: '', from: '', to: '' };

describe('rate math', () => {
	it('is null (shown —) when nothing was accepted', () => {
		expect(ratePct(0, 0)).toBeNull();
		expect(ratePct(5, 0)).toBeNull();
		expect(rateText(null)).toBe('—');
		expect(sendLogRates({ accepted: 0, opens: 0, clicks: 0, unsubs: 0, bounces: 0 })).toEqual({
			open_rate: null,
			click_rate: null,
			ctor: null,
			unsub_rate: null,
			bounce_rate: null
		});
	});

	it('rounds to one decimal, like the 30-day tile', () => {
		expect(ratePct(337, 1166)).toBe(28.9);
		expect(ratePct(1, 3)).toBe(33.3);
		expect(rateText(28.9)).toBe('28.9%');
		expect(rateText(50)).toBe('50.0%');
	});

	it('click-to-open divides by openers; no openers → null', () => {
		const r = sendLogRates({ accepted: 100, opens: 40, clicks: 10, unsubs: 1, bounces: 2 });
		expect(r).toEqual({ open_rate: 40, click_rate: 10, ctor: 25, unsub_rate: 1, bounce_rate: 2 });
		expect(sendLogRates({ accepted: 100, opens: 0, clicks: 0, unsubs: 0, bounces: 0 }).ctor).toBeNull();
	});
});

describe('column picker', () => {
	it('defaults to Status · Sent · Open rate · Opens · Clicks · Unsubs · Date', () => {
		expect(DEFAULT_SENDLOG_COLUMNS).toEqual(['status', 'sent', 'open_rate', 'opens', 'clicks', 'unsubs', 'date']);
	});

	it('cleans a saved choice: known keys only, table order; junk → default', () => {
		expect(cleanSendLogColumns(['date', 'bogus', 'open_rate'])).toEqual(['open_rate', 'date']);
		expect(cleanSendLogColumns([])).toEqual([]);
		expect(cleanSendLogColumns(null)).toBe(DEFAULT_SENDLOG_COLUMNS);
		expect(cleanSendLogColumns('status')).toBe(DEFAULT_SENDLOG_COLUMNS);
	});

	it('every column (and subject) has a sort key', () => {
		for (const c of SENDLOG_COLUMNS) expect(SENDLOG_SORTS[c.key], c.key).toBeTruthy();
		expect(SENDLOG_SORTS.subject).toBeTruthy();
	});
});

describe('sendLogOrderBy', () => {
	it('puts NULLs last and tiebreaks newest first', () => {
		expect(sendLogOrderBy('open_rate', 'asc')).toMatch(/^\(CASE .* END\) IS NULL, CASE .* END ASC, s\.created_at DESC/);
		expect(sendLogOrderBy('opens', 'desc')).toBe('(s.opens) IS NULL, s.opens DESC, s.created_at DESC, s.id DESC');
	});

	it('falls back to date for an unknown key (never user SQL)', () => {
		expect(sendLogOrderBy('1; DROP TABLE campaigns', 'desc')).toBe('s.created_at DESC, s.id DESC');
	});
});

describe('sendLogRows — D1 round-trip', () => {
	let hi: number; // 2 of 4 opened (50%), incl. one Apple Mail auto-open
	let lo: number; // 1 of 4 opened (25%)
	let draft: number; // nothing accepted → rate NULL

	async function campaign(subject: string, status: string, created: string): Promise<number> {
		const r = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, created_at, recipient_count)
				 VALUES (?, 'md', '<p>hi</p>', NULL, 'alan@ourco.example', ?, ?, 0) RETURNING id`
			)
			.bind(subject, status, created)
			.first<{ id: number }>();
		return r!.id;
	}
	async function recipients(campaignId: number, n: number): Promise<number[]> {
		const ids: number[] = [];
		for (let i = 0; i < n; i++) {
			const r = await db
				.prepare(`INSERT INTO recipients (campaign_id, email, status, message_id) VALUES (?, ?, 'accepted', ?) RETURNING id`)
				.bind(campaignId, `r${campaignId}-${i}@example.com`, `m-${campaignId}-${i}`)
				.first<{ id: number }>();
			ids.push(r!.id);
		}
		await db.prepare('UPDATE campaigns SET recipient_count = ? WHERE id = ?').bind(n, campaignId).run();
		return ids;
	}
	async function event(campaignId: number, recipientId: number, type: string, detail = '{}') {
		await db
			.prepare(`INSERT INTO events (campaign_id, recipient_id, type, detail, recorded_at) VALUES (?, ?, ?, ?, datetime('now'))`)
			.bind(campaignId, recipientId, type, detail)
			.run();
	}

	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM replies'),
			db.prepare('DELETE FROM events'),
			db.prepare('DELETE FROM recipients'),
			db.prepare('DELETE FROM campaigns')
		]);
		hi = await campaign('slc-hi', 'sent', '2026-01-01 10:00:00');
		lo = await campaign('slc-lo', 'sent', '2026-01-02 10:00:00');
		draft = await campaign('slc-draft', 'draft', '2026-01-03 10:00:00');

		const h = await recipients(hi, 4);
		await event(hi, h[0], 'open');
		await event(hi, h[0], 'open'); // same opener twice → unique once
		await event(hi, h[1], 'open', JSON.stringify({ UserAgent: 'Apple Mail', Client: { Name: 'Apple Mail' } }));
		await event(hi, h[0], 'click');
		await event(hi, h[2], 'bounce');
		await db.prepare(`INSERT INTO replies (campaign_id, from_email) VALUES (?, 'x@example.com')`).bind(hi).run();

		const l = await recipients(lo, 4);
		await event(lo, l[0], 'open');
	});

	it('counts unique opens the same way as the 30-day tile (auto-opens included there, so here too)', async () => {
		const rows = await sendLogRows(db, EMPTY, { sort: 'date', dir: 'desc', limit: 25, offset: 0 });
		const row = rows.find((r) => r.id === hi)!;
		expect(row).toMatchObject({ accepted: 4, opens: 2, clicks: 1, bounces: 1, replies: 1 });
		expect(sendLogRates(row)).toMatchObject({ open_rate: 50, click_rate: 25, ctor: 50, bounce_rate: 25 });

		// The tile's own query over the same campaign gives the same number.
		const tile = await db
			.prepare(
				`SELECT
				   (SELECT COUNT(*) FROM recipients WHERE status = 'accepted' AND campaign_id = ?1) AS delivered,
				   (SELECT COUNT(DISTINCT recipient_id) FROM events
				      WHERE type = 'open' AND recipient_id IS NOT NULL AND campaign_id = ?1) AS opens`
			)
			.bind(hi)
			.first<{ delivered: number; opens: number }>();
		expect(ratePct(tile!.opens, tile!.delivered)).toBe(sendLogRates(row).open_rate);

		const d = rows.find((r) => r.id === draft)!;
		expect(sendLogRates(d).open_rate).toBeNull();
	});

	it('sorts by open rate both ways with the NULL (draft) last', async () => {
		const desc = await sendLogRows(db, EMPTY, { sort: 'open_rate', dir: 'desc', limit: 25, offset: 0 });
		expect(desc.map((r) => r.id)).toEqual([hi, lo, draft]);
		const asc = await sendLogRows(db, EMPTY, { sort: 'open_rate', dir: 'asc', limit: 25, offset: 0 });
		expect(asc.map((r) => r.id)).toEqual([lo, hi, draft]);
	});

	it('every sort key runs against D1', async () => {
		for (const key of Object.keys(SENDLOG_SORTS)) {
			for (const dir of ['asc', 'desc'] as const) {
				const rows = await sendLogRows(db, EMPTY, { sort: key, dir, limit: 25, offset: 0 });
				expect(rows.length, `${key} ${dir}`).toBe(3);
			}
		}
	});
});
