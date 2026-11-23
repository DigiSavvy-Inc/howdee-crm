// #457: campaign counts for the Email built-ins, recomputed from `recipients` + `events`
// instead of the engine's per-recipient-row subqueries, so a built-in can
//  - count **per contact** (a contact who got the original and the resend is one
//    recipient; an opener on either pass is one opener),
//  - limit a campaign to the recipients sent in a range (recipients have no timestamp: a
//    row's send time is its first delivery / bounce event, else the campaign's send time —
//    the same stand-in the deliverability checks use), and
//  - split a step's sends by A/B variant (`recipients.ab_variant`).
// Openers follow the engine's rule (#453): a click, or an open `classifyProxyOpen` doesn't
// flag — checked against the delivery of the same recipient row (the same pass).

import { classifyProxyOpen } from '$lib/server/engagement';
import { reportPct } from '$lib/report-metrics';

export type CampaignCounts = {
	recipients: number;
	rejected: number;
	delivered: number;
	opens: number;
	clicks: number;
	unsubs: number;
	bounces: number;
	spam: number;
	replies: number;
};

export type CountOpts = {
	/** One identity per contact (default: per recipient row). */
	perContact?: boolean;
	/** SQLite datetime: only recipient rows sent at or after it. */
	since?: string | null;
	/** SQLite datetime: only recipient rows sent at or before it (a custom range's end). */
	until?: string | null;
	/** Also count each A/B variant on its own (key `<campaign>:<variant>`). */
	byVariant?: boolean;
};

export type CountsResult = {
	/** Key = campaign id, or `<campaign id>:<variant>` for a variant split. */
	counts: Map<string, CampaignCounts>;
	/** Campaigns with at least one recipient row on the resend pass. */
	resent: Set<number>;
	/** Variants seen per campaign, sorted. */
	variants: Map<number, string[]>;
};

type RecipientRow = {
	id: number;
	campaign_id: number;
	contact_id: number | null;
	status: string;
	send_pass: string | null;
	ab_variant: string | null;
};

type EventRow = {
	campaign_id: number;
	recipient_id: number | null;
	contact_id: number | null;
	type: string;
	detail: string | null;
	recorded_at: string;
};

const SEND_TIME = `COALESCE(
	(SELECT MIN(se.recorded_at) FROM events se WHERE se.recipient_id = r.id AND se.type IN ('delivery', 'bounce')),
	cp.sent_at, cp.created_at)`;

type Sets = {
	accepted: Set<string>;
	errored: Set<string>;
	delivered: Set<string>;
	opens: Set<string>;
	clicks: Set<string>;
	unsubs: Set<string>;
	bounces: Set<string>;
	spam: Set<string>;
	contacts: Set<number>;
};

function emptySets(): Sets {
	return {
		accepted: new Set(),
		errored: new Set(),
		delivered: new Set(),
		opens: new Set(),
		clicks: new Set(),
		unsubs: new Set(),
		bounces: new Set(),
		spam: new Set(),
		contacts: new Set()
	};
}

export async function campaignCounts(db: D1Database, ids: number[], opts: CountOpts = {}): Promise<CountsResult> {
	const recipients: RecipientRow[] = [];
	const events: EventRow[] = [];
	const replies: { campaign_id: number; contact_id: number | null }[] = [];
	for (const slice of chunks(ids, 80)) {
		const m = marks(slice.length);
		const since = (opts.since ? ` AND ${SEND_TIME} >= ?` : '') + (opts.until ? ` AND ${SEND_TIME} <= ?` : '');
		const binds: unknown[] = [...slice, ...(opts.since ? [opts.since] : []), ...(opts.until ? [opts.until] : [])];
		const [r, e, rp] = await db.batch([
			db
				.prepare(
					`SELECT r.id, r.campaign_id, r.contact_id, r.status, r.send_pass, r.ab_variant
					 FROM recipients r JOIN campaigns cp ON cp.id = r.campaign_id
					 WHERE r.campaign_id IN (${m}) AND r.status IN ('accepted', 'error')${since}`
				)
				.bind(...binds),
			db
				.prepare(
					`SELECT e.campaign_id, e.recipient_id, e.contact_id, e.type,
					        CASE WHEN e.type = 'open' THEN e.detail END AS detail, e.recorded_at
					 FROM events e
					 WHERE e.campaign_id IN (${m}) AND e.type IN ('delivery', 'open', 'click', 'unsubscribe', 'bounce', 'spam')`
				)
				.bind(...slice),
			db.prepare(`SELECT campaign_id, contact_id FROM replies WHERE campaign_id IN (${m})`).bind(...slice)
		]);
		recipients.push(...((r.results ?? []) as RecipientRow[]));
		events.push(...((e.results ?? []) as EventRow[]));
		replies.push(...((rp.results ?? []) as { campaign_id: number; contact_id: number | null }[]));
	}

	const byId = new Map<number, RecipientRow>();
	const byContact = new Map<string, RecipientRow>();
	const resent = new Set<number>();
	const variants = new Map<number, Set<string>>();
	for (const row of recipients) {
		byId.set(row.id, row);
		if (row.contact_id != null && !byContact.has(`${row.campaign_id}:${row.contact_id}`)) {
			byContact.set(`${row.campaign_id}:${row.contact_id}`, row);
		}
		if (row.send_pass === 'resend') resent.add(row.campaign_id);
		if (opts.byVariant && row.ab_variant) {
			const set = variants.get(row.campaign_id) ?? new Set<string>();
			set.add(row.ab_variant);
			variants.set(row.campaign_id, set);
		}
	}

	const sets = new Map<string, Sets>();
	const groupsOf = (row: RecipientRow): Sets[] => {
		const keys = [String(row.campaign_id)];
		if (opts.byVariant && row.ab_variant) keys.push(`${row.campaign_id}:${row.ab_variant}`);
		return keys.map((key) => {
			let s = sets.get(key);
			if (!s) sets.set(key, (s = emptySets()));
			return s;
		});
	};
	const who = (row: RecipientRow) => (opts.perContact && row.contact_id != null ? `c${row.contact_id}` : `r${row.id}`);

	for (const row of recipients) {
		for (const s of groupsOf(row)) {
			(row.status === 'accepted' ? s.accepted : s.errored).add(who(row));
			if (row.contact_id != null) s.contacts.add(row.contact_id);
		}
	}

	// First delivery per recipient row: the proxy check compares an open with the delivery of its own pass.
	const deliveredAt = new Map<number, string>();
	for (const ev of events) {
		if (ev.type !== 'delivery' || ev.recipient_id == null) continue;
		const prev = deliveredAt.get(ev.recipient_id);
		if (prev == null || ev.recorded_at < prev) deliveredAt.set(ev.recipient_id, ev.recorded_at);
	}

	for (const ev of events) {
		const row =
			(ev.recipient_id != null ? byId.get(ev.recipient_id) : undefined) ??
			(ev.recipient_id == null && ev.contact_id != null ? byContact.get(`${ev.campaign_id}:${ev.contact_id}`) : undefined);
		if (!row) continue; // not a recipient in scope (out of range, or no row)
		const id = who(row);
		for (const s of groupsOf(row)) {
			switch (ev.type) {
				case 'delivery':
					s.delivered.add(id);
					break;
				case 'click':
					s.clicks.add(id);
					s.opens.add(id);
					break;
				case 'open':
					if (!isProxy(ev, deliveredAt.get(row.id) ?? null)) s.opens.add(id);
					break;
				case 'unsubscribe':
					s.unsubs.add(id);
					break;
				case 'bounce':
					s.bounces.add(id);
					break;
				case 'spam':
					s.spam.add(id);
					break;
			}
		}
	}

	const counts = new Map<string, CampaignCounts>();
	for (const [key, s] of sets) {
		const campaignId = Number(key.split(':')[0]);
		const variant = key.includes(':') ? key.slice(key.indexOf(':') + 1) : null;
		let replyCount = 0;
		for (const reply of replies) {
			if (reply.campaign_id !== campaignId) continue;
			// Nothing narrows the campaign: every reply counts, like the engine's column. A variant
			// or a range keeps the replies of its own recipients.
			if ((!variant && !opts.since && !opts.until) || (reply.contact_id != null && s.contacts.has(reply.contact_id))) replyCount++;
		}
		counts.set(key, {
			recipients: s.accepted.size,
			rejected: [...s.errored].filter((id) => !s.accepted.has(id)).length,
			delivered: s.delivered.size,
			opens: s.opens.size,
			clicks: s.clicks.size,
			unsubs: s.unsubs.size,
			bounces: s.bounces.size,
			spam: s.spam.size,
			replies: replyCount
		});
	}
	return {
		counts,
		resent,
		variants: new Map([...variants].map(([id, set]) => [id, [...set].sort()]))
	};
}

/** Counts + every campaign rate onto a report row (only the keys the row already has are kept by the caller). */
export function applyCounts(row: Record<string, unknown>, c: CampaignCounts): void {
	Object.assign(row, c);
	row.open_rate = reportPct(c.opens, c.recipients);
	row.click_rate = reportPct(c.clicks, c.recipients);
	row.ctor = reportPct(c.clicks, c.opens);
	row.unsub_rate = reportPct(c.unsubs, c.recipients, true);
	row.bounce_rate = reportPct(c.bounces, c.recipients, true);
	row.complaint_rate = reportPct(c.spam, c.recipients, true);
}

function isProxy(ev: EventRow, deliveredAt: string | null): boolean {
	let detail: unknown = {};
	if (ev.detail) {
		try {
			detail = JSON.parse(ev.detail);
		} catch {
			detail = {};
		}
	}
	return classifyProxyOpen(detail, deliveredAt, ev.recorded_at);
}

function marks(n: number): string {
	return Array.from({ length: n }, () => '?').join(', ');
}

function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
