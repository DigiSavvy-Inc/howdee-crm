import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// #518: security-scanner clicks — the classifier, the webhook (incl. reclassifying earlier rows
// and keeping the "clicked" trigger quiet), the 0116 backfill on a campaign-64-shaped fixture,
// the Link clicks grouping, and a click reader that now excludes them by construction.

import { POST as webhook } from '../src/routes/api/webhook/+server';
import {
	classifyScannerClicks,
	clickTypeFor,
	computeEngagement,
	isUnsubscribeLink,
	ENGAGEMENT_DEFAULTS,
	validateEngagementConfig,
	type ClickRow
} from '../src/lib/server/engagement';
import { campaignLinks, campaignScannerFetches } from '../src/lib/server/campaign-read';
import { engagementBreakdown } from '../src/lib/server/campaign-engagement';
import { campaignCounts } from '../src/lib/server/reports/campaign-counts';
import { load as campaignPageLoad } from '../src/routes/campaign/[id]/+page.server';

const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM engagement_trigger_fires'),
		db.prepare('DELETE FROM automation_pending_triggers'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts')
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;
const UNSUB = (n: number | string) => `https://crm.myapp.example/unsubscribe?t=tok${n}`;
const LINKS = ['https://ourco.example/a', 'https://ourco.example/b', 'https://ourco.example/c', 'https://ourco.example/d', 'https://ourco.example/e'];

async function contact(email: string): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', email)).id;
}
async function campaign(): Promise<number> {
	return (
		await one<{ id: number }>(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at, recipient_count)
			 VALUES ('News', 'b', '<p>b</p>', 'alan@ourco.example', 'sent', '2026-11-03 19:24:00', 1) RETURNING id`
		)
	).id;
}
let msg = 0;
async function recipient(campaignId: number, cid: number): Promise<{ id: number; messageId: string }> {
	const messageId = `m-${++msg}`;
	const r = await one<{ id: number }>(
		"INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, (SELECT email FROM contacts WHERE id = ?), ?, 'accepted') RETURNING id",
		campaignId,
		cid,
		cid,
		messageId
	);
	return { id: r.id, messageId };
}
async function addEvent(campaignId: number, rid: number, cid: number, type: string, link: string | null, at: string) {
	await db
		.prepare('INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(campaignId, rid, cid, type, link ? JSON.stringify({ RecordType: 'Click', OriginalLink: link }) : null, at)
		.run();
}
const types = async (rid: number) =>
	(await db.prepare('SELECT type FROM events WHERE recipient_id = ? ORDER BY id').bind(rid).all<{ type: string }>()).results.map((r) => r.type);

function hook(payload: object) {
	return webhook({
		platform: { env: { ...env, WEBHOOK_KEY: 'test-key' } },
		url: new URL('https://app.test/api/webhook?key=test-key'),
		request: new Request('https://app.test/api/webhook', { method: 'POST', body: JSON.stringify(payload) })
	} as any);
}
const click = (messageId: string, link: string) =>
	hook({ RecordType: 'Click', MessageID: messageId, OriginalLink: link, UserAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' });

describe('isUnsubscribeLink / clickTypeFor', () => {
	it('matches our token link and one-click, not other unsubscribe-ish URLs', () => {
		expect(isUnsubscribeLink(UNSUB(1))).toBe(true);
		expect(isUnsubscribeLink('https://crm-app.my-account.workers.dev/unsubscribe?t=x&c=1')).toBe(true);
		expect(isUnsubscribeLink('https://crm.myapp.example/unsubscribe/one-click?t=x')).toBe(true);
		expect(isUnsubscribeLink('https://crm.myapp.example/unsubscribe')).toBe(false);
		expect(isUnsubscribeLink('https://ourco.example/blog/unsubscribe-tips')).toBe(false);
		expect(isUnsubscribeLink(null)).toBe(false);
		expect(clickTypeFor(UNSUB(1))).toBe('unsubscribe_click');
		expect(clickTypeFor(LINKS[0])).toBe('click');
	});
});

describe('classifyScannerClicks', () => {
	const at = (s: number) => `2026-11-03 19:25:${String(s).padStart(2, '0')}`;
	const rows = (...r: [number, string | null, string][]): ClickRow[] => r.map(([id, link, t]) => ({ id, link, at: t }));

	it('burst: 3 distinct links within 10 s → all of them', () => {
		const s = classifyScannerClicks(rows([1, LINKS[0], at(1)], [2, LINKS[1], at(2)], [3, LINKS[2], at(3)]));
		expect([...s].sort()).toEqual([1, 2, 3]);
	});

	it('2 links, or 3 links spread over more than 10 s, stay real', () => {
		expect(classifyScannerClicks(rows([1, LINKS[0], at(1)], [2, LINKS[1], at(2)])).size).toBe(0);
		expect(classifyScannerClicks(rows([1, LINKS[0], at(0)], [2, LINKS[1], at(6)], [3, LINKS[2], at(12)])).size).toBe(0);
		// The same link three times is a person double-clicking, not a scan.
		expect(classifyScannerClicks(rows([1, LINKS[0], at(1)], [2, LINKS[0], at(2)], [3, LINKS[0], at(3)])).size).toBe(0);
	});

	it('unsubscribe pair: the unsubscribe link and one other link within 10 s', () => {
		expect([...classifyScannerClicks(rows([1, LINKS[0], at(1)], [2, UNSUB(1), at(3)]))].sort()).toEqual([1, 2]);
		expect(classifyScannerClicks(rows([1, UNSUB(1), at(1)], [2, UNSUB(1), at(2)])).size).toBe(0);
	});

	it('a later single click stays real', () => {
		const s = classifyScannerClicks(
			rows([1, LINKS[0], at(1)], [2, LINKS[1], at(1)], [3, LINKS[2], at(2)], [4, LINKS[0], '2026-11-03 21:00:00'])
		);
		expect([...s].sort()).toEqual([1, 2, 3]);
	});

	it('the constants are tunable engagement config', () => {
		expect(ENGAGEMENT_DEFAULTS.scannerWindowSeconds).toBe(10);
		expect(ENGAGEMENT_DEFAULTS.scannerMinLinks).toBe(3);
		const v = validateEngagementConfig({ scannerMinLinks: 4, scannerWindowSeconds: 5 });
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(classifyScannerClicks(rows([1, LINKS[0], at(1)], [2, LINKS[1], at(2)], [3, LINKS[2], at(3)]), v.cfg).size).toBe(0);
		expect(classifyScannerClicks(rows([1, LINKS[0], at(1)], [2, LINKS[1], at(9)], [3, UNSUB(1), at(9)]), v.cfg).size).toBe(2);
	});
});

describe('webhook', () => {
	it('a burst reclassifies the earlier rows, keeps them out of the score; a later click stays real', async () => {
		const cid = await contact('scan@corp.test');
		const camp = await campaign();
		const r = await recipient(camp, cid);
		await click(r.messageId, LINKS[0]);
		await click(r.messageId, LINKS[1]);
		expect(await types(r.id)).toEqual(['click', 'click']);
		await click(r.messageId, LINKS[2]);
		expect(await types(r.id)).toEqual(['scanner_click', 'scanner_click', 'scanner_click']);

		// A real click an hour later.
		await db.prepare("UPDATE events SET recorded_at = datetime('now', '-1 hour') WHERE recipient_id = ?").bind(r.id).run();
		await click(r.messageId, LINKS[0]);
		expect(await types(r.id)).toEqual(['scanner_click', 'scanner_click', 'scanner_click', 'click']);

		await computeEngagement(db, { contactIds: [cid] });
		const eng = await one<{ click_count: number }>('SELECT click_count FROM contact_engagement WHERE contact_id = ?', cid);
		expect(eng.click_count).toBe(1);
		expect(await campaignScannerFetches(db, camp)).toBe(3);
	});

	it('a content link + the unsubscribe link → both scanner; a lone unsubscribe visit is unsubscribe_click', async () => {
		const cid = await contact('pair@corp.test');
		const camp = await campaign();
		const r = await recipient(camp, cid);
		await click(r.messageId, LINKS[0]);
		await click(r.messageId, UNSUB(cid));
		expect(await types(r.id)).toEqual(['scanner_click', 'scanner_click']);

		const cid2 = await contact('human@corp.test');
		const r2 = await recipient(camp, cid2);
		await click(r2.messageId, UNSUB(cid2));
		expect(await types(r2.id)).toEqual(['unsubscribe_click']);
		await computeEngagement(db, { contactIds: [cid2] });
		const eng = await one<{ click_count: number; score: number }>('SELECT click_count, score FROM contact_engagement WHERE contact_id = ?', cid2);
		expect(eng).toMatchObject({ click_count: 0, score: 0 });
	});

	it('the "clicked" trigger never fires on an unsubscribe-link click or a scanner pair', async () => {
		const auto = (
			await one<{ id: number }>(
				`INSERT INTO automations (name, status, trigger_type, trigger_config, reentry)
				 VALUES ('Clicked', 'active', 'email_clicked', '{}', 'multiple') RETURNING id`
			)
		).id;
		await db
			.prepare(
				"INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, delay_before_seconds, subject, body_md, from_email) VALUES (?, 0, 'tag', 'add', 'x', 3600, '', '', '')"
			)
			.bind(auto)
			.run();
		const camp = await campaign();
		const cid = await contact('unsub@corp.test');
		const r = await recipient(camp, cid);
		await click(r.messageId, UNSUB(cid));
		const cid2 = await contact('pair2@corp.test');
		const r2 = await recipient(camp, cid2);
		await click(r2.messageId, UNSUB(cid2));
		await click(r2.messageId, LINKS[0]);
		const n = await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?', auto);
		expect(n.n).toBe(0);

		// A plain click still fires it.
		const cid3 = await contact('real@corp.test');
		const r3 = await recipient(camp, cid3);
		await click(r3.messageId, LINKS[0]);
		const m = await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', auto, cid3);
		expect(m.n).toBe(1);
	});
});

describe('0116 backfill (campaign 64 shape)', () => {
	async function runMigration() {
		const mig = ((env as any).TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((m) => m.name.startsWith('0116_'))!;
		for (const q of mig.queries) await db.prepare(q).run();
	}

	it('reclassifies 6-link bursts and unsubscribe pairs, keeps real clicks, marks rollups dirty', async () => {
		const camp = await campaign();
		const scanned: { cid: number; rid: number }[] = [];
		// 5 scanned recipients: all 6 links (5 content + their own unsubscribe link) within 1–3 s.
		for (let i = 0; i < 5; i++) {
			const cid = await contact(`s${i}@corp.test`);
			const r = await recipient(camp, cid);
			const links = [...LINKS, UNSUB(cid)];
			for (let k = 0; k < links.length; k++) await addEvent(camp, r.id, cid, 'click', links[k], `2026-11-03 19:24:${String(30 + Math.floor(k / 2)).padStart(2, '0')}`);
			scanned.push({ cid, rid: r.id });
		}
		// A scanner that only fetched one content link + unsubscribe (pair rule).
		const pc = await contact('pair@corp.test');
		const pr = await recipient(camp, pc);
		await addEvent(camp, pr.id, pc, 'click', LINKS[0], '2026-11-03 19:24:40');
		await addEvent(camp, pr.id, pc, 'click', UNSUB(pc), '2026-11-03 19:24:41');
		// A human: one click, then one more an hour later, and a lone unsubscribe-page visit.
		const hc = await contact('human@corp.test');
		const hr = await recipient(camp, hc);
		await addEvent(camp, hr.id, hc, 'click', LINKS[1], '2026-11-03 20:00:00');
		await addEvent(camp, hr.id, hc, 'click', LINKS[2], '2026-11-03 21:00:00');
		await addEvent(camp, hr.id, hc, 'click', UNSUB(hc), '2026-11-03 22:00:00');
		// A truncated (invalid JSON) old row doesn't break the migration (on another campaign, as
		// the link table reads every row of its own).
		const old = await campaign();
		await db
			.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail, recorded_at) VALUES (?, ?, ?, 'click', '{\"OriginalLink\": \"https://x', '2026-11-03 19:00:00')")
			.bind(old, hr.id, hc)
			.run();
		await db.prepare('INSERT INTO contact_engagement (contact_id, dirty) SELECT id, 0 FROM contacts').run();

		await runMigration();
		await runMigration(); // idempotent

		for (const s of scanned) expect(new Set(await types(s.rid))).toEqual(new Set(['scanner_click']));
		expect(await types(pr.id)).toEqual(['scanner_click', 'scanner_click']);
		expect(await types(hr.id)).toEqual(['click', 'click', 'unsubscribe_click', 'click']);

		const dirty = (await db.prepare('SELECT contact_id FROM contact_engagement WHERE dirty = 1 ORDER BY contact_id').all<{ contact_id: number }>()).results.map((r) => r.contact_id);
		expect(dirty).toEqual([...scanned.map((s) => s.cid), pc, hc].sort((a, b) => a - b));

		// Report surfaces: link table groups the unsubscribe page, scanner fetches counted apart,
		// the Engagement bar's clicked segment only has the human.
		const links = await campaignLinks(db, camp);
		expect(links).toHaveLength(3);
		expect(new Set(links.slice(0, 2).map((l) => l.url))).toEqual(new Set([LINKS[1], LINKS[2]]));
		expect(links[2]).toEqual({ url: 'Unsubscribe page', unique_clicks: 1, total_clicks: 1, unsubscribe: true });
		expect(await campaignScannerFetches(db, camp)).toBe(5 * 6 + 2);
		const b = await engagementBreakdown(db, camp);
		expect(b.clicked).toBe(1);
		// Reports (#457 campaignCounts) count only the human's click, by construction.
		const { counts } = await campaignCounts(db, [camp]);
		expect(counts.get(String(camp))?.clicks).toBe(1);
	});

	it('Link clicks collapses every per-recipient unsubscribe link into one row at the bottom', async () => {
		const camp = await campaign();
		for (let i = 0; i < 3; i++) {
			const cid = await contact(`u${i}@x.test`);
			const r = await recipient(camp, cid);
			await addEvent(camp, r.id, cid, 'unsubscribe_click', UNSUB(cid), '2026-11-03 20:00:00');
			if (i === 0) await addEvent(camp, r.id, cid, 'unsubscribe_click', UNSUB(cid), '2026-11-03 20:05:00');
			await addEvent(camp, r.id, cid, 'click', LINKS[0], '2026-11-03 21:00:00');
		}
		const links = await campaignLinks(db, camp);
		expect(links).toEqual([
			{ url: LINKS[0], unique_clicks: 3, total_clicks: 3 },
			{ url: 'Unsubscribe page', unique_clicks: 3, total_clicks: 4, unsubscribe: true }
		]);
	});
});

describe('campaign page Activity panel', () => {
	it('leaves out scanner fetches and labels an unsubscribe-page visit "unsubscribe page"', async () => {
		const camp = await campaign();
		const sc = await contact('scanned@corp.test');
		const sr = await recipient(camp, sc);
		for (let k = 0; k < 3; k++) await addEvent(camp, sr.id, sc, 'scanner_click', LINKS[k], '2026-11-03 19:24:30');
		const hc = await contact('human@corp.test');
		const hr = await recipient(camp, hc);
		await addEvent(camp, hr.id, hc, 'open', null, '2026-11-03 20:00:00');
		await addEvent(camp, hr.id, hc, 'click', LINKS[0], '2026-11-03 20:01:00');
		await addEvent(camp, hr.id, hc, 'unsubscribe_click', UNSUB(hc), '2026-11-03 20:02:00');

		const url = new URL(`https://app.test/campaign/${camp}`);
		const data: any = await campaignPageLoad({
			platform: { env: { ...(env as any), SESSION_SECRET: 'test-secret' } },
			params: { id: String(camp) },
			url,
			request: new Request(url),
			locals: {}
		} as any);
		const rows = data.activity.rows as { type: string; label: string; who: string }[];
		expect(rows.some((r) => r.type === 'scanner_click')).toBe(false);
		expect(rows.map((r) => [r.type, r.label])).toEqual([
			['unsubscribe_click', 'unsubscribe page'],
			['click', 'click'],
			['open', 'open']
		]);
		expect(rows.every((r) => r.who === 'human@corp.test')).toBe(true);
	});
});
