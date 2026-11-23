// #412: how a Postmark webhook payload is stored in `events.detail`. It used to be the JSON
// cut at 4,000 characters, which left long payloads (big Geo / Client blocks, long links,
// bounce dumps) as invalid JSON — json_extract then failed and the readers fell back to
// guessing. Now the payload is stored whole when it is small, else as a smaller object that
// is still valid JSON and keeps every field a reader uses.

/** Payloads up to this size are stored whole. */
export const DETAIL_MAX = 4000;

/** The `events.detail` link expression; idx_events_link (migration 0101) indexes exactly this. */
export const CLICK_LINK_SQL = (alias = 'ev') =>
	`CASE WHEN json_valid(${alias}.detail) THEN json_extract(${alias}.detail, '$.OriginalLink') END`;

// Fields the app reads back (engagement, proxy-open rule, bounce filters, deliverability,
// reports, triggers) with a cap on each string.
const KEEP: Record<string, number> = {
	RecordType: 40,
	MessageID: 100,
	MessageStream: 60,
	Recipient: 320,
	Email: 320,
	Tag: 200,
	ServerID: 20,
	ID: 40,
	Name: 200,
	Type: 60,
	TypeCode: 20,
	Inactive: 10,
	CanActivate: 10,
	Description: 500,
	Details: 1000,
	Origin: 60,
	SuppressSending: 10,
	SuppressionReason: 100,
	ChangedAt: 40,
	BouncedAt: 40,
	DeliveredAt: 40,
	ReceivedAt: 40,
	FirstOpen: 10,
	ReadSeconds: 20,
	OriginalLink: 2000,
	ClickLocation: 40,
	UserAgent: 500,
	Platform: 60
};
// Small objects kept with their string fields capped.
const KEEP_OBJECTS = ['Client', 'OS', 'Geo'];
const OBJECT_FIELD_MAX = 120;

function trimValue(v: unknown, max: number): unknown {
	if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
	if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
	return undefined;
}

/** A webhook payload → the `events.detail` string: whole when ≤ DETAIL_MAX, else the kept
 *  fields (always valid JSON). */
export function compactEventDetail(payload: Record<string, unknown>): string {
	const whole = JSON.stringify(payload);
	if (whole.length <= DETAIL_MAX) return whole;
	const out: Record<string, unknown> = {};
	for (const [key, max] of Object.entries(KEEP)) {
		if (!(key in payload)) continue;
		const v = trimValue(payload[key], max);
		if (v !== undefined) out[key] = v;
	}
	for (const key of KEEP_OBJECTS) {
		const o = payload[key];
		if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
		const small: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(o as Record<string, unknown>).slice(0, 12)) {
			const t = trimValue(v, OBJECT_FIELD_MAX);
			if (t !== undefined) small[k.slice(0, 40)] = t;
		}
		out[key] = small;
	}
	out.Truncated = true;
	return JSON.stringify(out);
}
