// #238: Compose drafts created through the Data API. DRAFT ONLY by construction: this
// module imports nothing that can send or schedule (no postmark, send, or scheduler
// modules), writes status='draft' with no list, no recipients and no scheduled_at, and
// only ever deletes rows that are still drafts with zero recipients.
// #252: PATCH edits drafts only (UPDATE … WHERE status = 'draft'); a scheduled_at written
// here is the intended time only — the row stays a draft, and the scheduler fires
// status='scheduled' rows alone.
// #313: reopenAsDraft / duplicateAsDraft only ever produce drafts too.
import { renderEmailHtml, renderEmailText } from '$lib/server/email';
import { storedBlocks, renderBody } from '$lib/server/compose-body';
import { getSignature } from '$lib/server/email-signature';
import { getSettings, fromAllowed } from '$lib/server/settings';
import { isEmail } from '$lib/csv';
import { existingGroups, normalizeAudience, readAudience, writeAudience, MAX_AUDIENCE_GROUPS, type Audience } from '$lib/server/campaign-audience';

export const MAX_SUBJECT = 300;
export const MAX_BODY = 200_000;

export type DraftInput = { subject: string; body: string };

export function parseDraftInput(raw: unknown): DraftInput | { error: string } {
	if (!raw || typeof raw !== 'object') return { error: 'Body must be a JSON object with subject and body.' };
	const r = raw as Record<string, unknown>;
	for (const k of ['recipients', 'list_id', 'to', 'scheduled_at', 'send', 'schedule']) {
		if (k in r) return { error: `"${k}" is not accepted: this endpoint creates drafts only.` };
	}
	const subject = typeof r.subject === 'string' ? r.subject.trim() : '';
	const body = typeof r.body === 'string' ? r.body : '';
	if (!subject) return { error: 'subject is required.' };
	if (!body.trim()) return { error: 'body (markdown) is required.' };
	if (subject.length > MAX_SUBJECT) return { error: `subject must be at most ${MAX_SUBJECT} characters.` };
	if (body.length > MAX_BODY) return { error: `body must be at most ${MAX_BODY} characters.` };
	return { subject, body };
}

export async function createDraft(db: D1Database, input: DraftInput, fallbackFrom: string): Promise<number> {
	const settings = await getSettings(db);
	const from = settings.default_from || fallbackFrom || '';
	const signature = await getSignature(db);
	const row = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, recipient_count, scheduled_at, sent_at)
			 VALUES (?, ?, ?, ?, NULL, ?, 'draft', 0, NULL, NULL)
			 RETURNING id`
		)
		.bind(input.subject, input.body, renderEmailHtml(input.body, { signature }), renderEmailText(input.body, { signature }), from)
		.first<{ id: number }>();
	return row!.id;
}

/** Delete a draft. Returns false if the row is not a zero-recipient draft. */
export async function deleteDraft(db: D1Database, id: number): Promise<boolean> {
	const res = await db
		.prepare(
			`DELETE FROM campaigns WHERE id = ? AND status = 'draft' AND recipient_count = 0
			 AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.campaign_id = campaigns.id)`
		)
		.bind(id)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

// #313: reopen a scheduled or canceled campaign as a draft — only one that never sent
// (no sent_at, no recipients rows at all: recipients are only written at send time).
// Content and scheduled_at are kept (compose shows the old time); resend_status and the
// recipient_count estimate are cleared as #240 does. Status-guarded, so a scheduled row
// the tick claims mid-request isn't reopened.
export const PARTLY_SENT = 'This campaign already went out to some recipients, so it can’t be reopened. Duplicate it as a new draft instead.';

export type ReopenResult = { ok: true } | { ok: false; reason: 'not_found' | 'status' | 'sent'; error: string };

export async function reopenAsDraft(db: D1Database, id: number): Promise<ReopenResult> {
	const cur = await db
		.prepare(
			`SELECT status, sent_at,
			        EXISTS (SELECT 1 FROM recipients r WHERE r.campaign_id = campaigns.id) AS has_recipients
			 FROM campaigns WHERE id = ?`
		)
		.bind(id)
		.first<{ status: string; sent_at: string | null; has_recipients: number }>();
	if (!cur) return { ok: false, reason: 'not_found', error: 'No campaign with that id.' };
	if (cur.status !== 'scheduled' && cur.status !== 'canceled') {
		return { ok: false, reason: 'status', error: 'Only a scheduled or canceled campaign can be reopened.' };
	}
	if (cur.sent_at || cur.has_recipients) return { ok: false, reason: 'sent', error: PARTLY_SENT };
	// #479: Edit on a send held by its pre-send checks clears that hold (the schedule is kept);
	// scheduling it again runs the checks again. A deliverability hold stays.
	const res = await db
		.prepare(
			`UPDATE campaigns SET status = 'draft', resend_status = NULL, recipient_count = 0,
			        held_at = CASE WHEN held_reason = 'preflight' THEN NULL ELSE held_at END,
			        held_reason = CASE WHEN held_reason = 'preflight' THEN NULL ELSE held_reason END,
			        preflight_retry_until = NULL, preflight_override_by = NULL, preflight_override_user_id = NULL
			 WHERE id = ? AND status IN ('scheduled', 'canceled') AND sent_at IS NULL
			   AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.campaign_id = campaigns.id)`
		)
		.bind(id)
		.run();
	if (!res.meta?.changes) return { ok: false, reason: 'status', error: 'This campaign is no longer scheduled or canceled.' };
	return { ok: true };
}

/** #313: copy a campaign's content into a new draft (no schedule, no resend state, no recipients). */
export async function duplicateAsDraft(db: D1Database, id: number): Promise<number | null> {
	const row = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, body_text, list_id, from_email, preheader,
			        template_id, resend_delay, resend_subject, tag_on_open, tag_on_click, weekday_only, best_time,
			        status, recipient_count, scheduled_at, sent_at)
			 SELECT subject, body_md, body_blocks, body_html, body_text, list_id, from_email, preheader,
			        template_id, CASE WHEN resend_delay IN ('24h', '3d') THEN resend_delay END, resend_subject,
			        tag_on_open, tag_on_click, weekday_only, best_time,
			        'draft', 0, NULL, NULL
			 FROM campaigns WHERE id = ? AND automation_step_id IS NULL
			 RETURNING id`
		)
		.bind(id)
		.first<{ id: number }>();
	if (!row) return null;
	// #332: the copy keeps every included / excluded group.
	await db
		.prepare(
			`INSERT INTO campaign_audiences (campaign_id, list_id, mode, position)
			 SELECT ?, list_id, mode, position FROM campaign_audiences WHERE campaign_id = ?`
		)
		.bind(row.id, id)
		.run();
	return row.id;
}

export function composeUrl(baseUrl: string, id: number): string {
	return `${baseUrl.replace(/\/$/, '')}/compose?draft=${id}`;
}

// #252: PATCH /api/v1/campaigns/:id

export type DraftPatch = {
	subject?: string;
	preheader?: string | null;
	body?: string;
	list_id?: number | null;
	/** #332: the whole audience (included + excluded groups). */
	audience?: Audience;
	template_id?: number | null;
	from_email?: string;
	scheduled_at?: string | null; // UTC 'YYYY-MM-DD HH:MM:SS'
	resend_delay?: '24h' | '3d' | null;
};

const PATCH_FIELDS = ['subject', 'preheader', 'body', 'list_id', 'audience', 'template_id', 'from_email', 'scheduled_at', 'resend_delay'];
const FORBIDDEN_PATCH = ['status', 'send', 'schedule', 'recipients', 'to'];
export const MAX_PREHEADER = 500;
export const NOT_A_DRAFT = 'Only drafts can be edited via the API.';

function idOrNull(v: unknown): number | null | undefined {
	if (v === null) return null;
	if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
	return undefined;
}

/** Validate a PATCH body (key-present semantics). Shape only; references are checked in updateDraft. */
export function parseDraftPatch(raw: unknown): DraftPatch | { error: string } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Body must be a JSON object.' };
	const r = raw as Record<string, unknown>;
	for (const k of FORBIDDEN_PATCH) {
		if (k in r) return { error: `"${k}" is not accepted: drafts are scheduled and sent in the app only.` };
	}
	for (const k of Object.keys(r)) {
		if (!PATCH_FIELDS.includes(k)) return { error: `Unknown field "${k}".` };
	}
	const out: DraftPatch = {};
	if ('subject' in r) {
		const subject = typeof r.subject === 'string' ? r.subject.trim() : '';
		if (!subject) return { error: 'subject must be a non-empty string.' };
		if (subject.length > MAX_SUBJECT) return { error: `subject must be at most ${MAX_SUBJECT} characters.` };
		out.subject = subject;
	}
	if ('preheader' in r) {
		if (r.preheader !== null && typeof r.preheader !== 'string') return { error: 'preheader must be a string or null.' };
		const p = (r.preheader ?? '').trim();
		if (p.length > MAX_PREHEADER) return { error: `preheader must be at most ${MAX_PREHEADER} characters.` };
		out.preheader = p || null;
	}
	if ('body' in r) {
		if (typeof r.body !== 'string') return { error: 'body (markdown) must be a string.' };
		if (r.body.length > MAX_BODY) return { error: `body must be at most ${MAX_BODY} characters.` };
		out.body = r.body;
	}
	if ('list_id' in r) {
		const v = idOrNull(r.list_id);
		if (v === undefined) return { error: 'list_id must be a positive integer or null.' };
		out.list_id = v;
	}
	if ('audience' in r) {
		if ('list_id' in r) return { error: 'Send either list_id or audience, not both.' };
		const a = r.audience as Record<string, unknown> | null;
		if (a === null) out.audience = { include: [], exclude: [] };
		else {
			const okIds = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= MAX_AUDIENCE_GROUPS && v.every((x) => idOrNull(x)));
			if (typeof a !== 'object' || Array.isArray(a) || !okIds(a.include) || !okIds(a.exclude)) {
				return { error: `audience must be { include: [ids], exclude: [ids] } (at most ${MAX_AUDIENCE_GROUPS} each) or null.` };
			}
			out.audience = normalizeAudience({ include: (a.include as unknown[]) ?? [], exclude: (a.exclude as unknown[]) ?? [] });
		}
	}
	if ('template_id' in r) {
		const v = idOrNull(r.template_id);
		if (v === undefined) return { error: 'template_id must be a positive integer or null.' };
		out.template_id = v;
	}
	if ('from_email' in r) {
		const f = typeof r.from_email === 'string' ? r.from_email.trim() : '';
		if (!isEmail(f)) return { error: 'from_email must be an email address.' };
		out.from_email = f;
	}
	if ('scheduled_at' in r) {
		if (r.scheduled_at === null || r.scheduled_at === '') out.scheduled_at = null;
		else {
			const t = typeof r.scheduled_at === 'string' ? new Date(r.scheduled_at) : new Date(NaN);
			if (Number.isNaN(t.getTime())) return { error: 'scheduled_at must be an ISO 8601 date-time or null.' };
			out.scheduled_at = t.toISOString().slice(0, 19).replace('T', ' ');
		}
	}
	if ('resend_delay' in r) {
		const d = r.resend_delay;
		if (d === null || d === '') out.resend_delay = null;
		else if (d === '24h' || d === '3d') out.resend_delay = d;
		else return { error: 'resend_delay must be "24h", "3d" or null.' };
	}
	return out;
}

export type UpdateDraftResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

/** Apply a validated patch to a draft. Never sends, schedules or writes recipients. */
export async function updateDraft(db: D1Database, id: number, patch: DraftPatch): Promise<UpdateDraftResult> {
	const cur = await db
		.prepare('SELECT status, body_md, body_blocks, preheader FROM campaigns WHERE id = ?')
		.bind(id)
		.first<{ status: string; body_md: string; body_blocks: string | null; preheader: string | null }>();
	if (!cur) return { ok: false, status: 404, error: 'No campaign with that id.' };
	if (cur.status !== 'draft') return { ok: false, status: 409, error: NOT_A_DRAFT };

	// The audience compose offers: a list or a segment (hand-picked or dynamic).
	if (patch.list_id != null) {
		const l = await db.prepare("SELECT id FROM lists WHERE id = ? AND kind IN ('list', 'segment')").bind(patch.list_id).first();
		if (!l) return { ok: false, status: 400, error: `list_id ${patch.list_id} is not a list or segment.` };
	}
	// #332: list_id replaces the included groups with that one (exclusions kept); audience
	// replaces both.
	let audience: Audience | null = null;
	if (patch.audience) {
		const { missing } = await existingGroups(db, patch.audience);
		if (missing.length) return { ok: false, status: 400, error: `audience: ${missing.join(', ')} ${missing.length === 1 ? 'is not a list or segment' : 'are not lists or segments'}.` };
		audience = patch.audience;
	} else if (patch.list_id !== undefined) {
		const cur = await readAudience(db, id);
		audience = normalizeAudience({ include: patch.list_id ? [patch.list_id] : [], exclude: cur.exclude });
	}
	if (patch.template_id != null) {
		const t = await db.prepare("SELECT id FROM templates WHERE id = ? AND kind != 'web'").bind(patch.template_id).first();
		if (!t) return { ok: false, status: 400, error: `template_id ${patch.template_id} does not exist.` };
	}
	if (patch.from_email !== undefined) {
		const settings = await getSettings(db);
		if (!fromAllowed(patch.from_email, settings.approved_senders)) {
			return { ok: false, status: 400, error: `from_email "${patch.from_email}" isn't an approved Postmark sender.` };
		}
	}

	const sets: string[] = [];
	const binds: unknown[] = [];
	const set = (col: string, v: unknown) => {
		sets.push(`${col} = ?`);
		binds.push(v);
	};
	if (patch.subject !== undefined) set('subject', patch.subject);
	if (patch.preheader !== undefined) set('preheader', patch.preheader);
	if (patch.body !== undefined || patch.preheader !== undefined) {
		// The stored HTML/text only feed the campaign page's preview (as in compose saveDraft).
		const preheader = patch.preheader !== undefined ? patch.preheader : cur.preheader;
		// #257: a body from the API is markdown and replaces any visual-editor blocks; a
		// preheader-only edit on a blocks draft re-renders from the blocks, not the lossy
		// markdown export in body_md.
		const blocks = patch.body === undefined ? storedBlocks(cur.body_blocks) : null;
		const signature = await getSignature(db);
		if (blocks) {
			const out = renderBody({ blocks, md: cur.body_md }, { preheader: preheader || undefined, signature });
			set('body_html', out.html);
			set('body_text', out.text);
		} else {
			const body = patch.body ?? cur.body_md;
			set('body_md', body);
			set('body_blocks', null);
			set('body_html', renderEmailHtml(body, { preheader: preheader || undefined, signature }));
			set('body_text', renderEmailText(body, { signature }));
		}
	}
	if (audience) set('list_id', audience.include[0] ?? null);
	if (patch.template_id !== undefined) set('template_id', patch.template_id);
	if (patch.from_email !== undefined) set('from_email', patch.from_email);
	if (patch.scheduled_at !== undefined) set('scheduled_at', patch.scheduled_at);
	if (patch.resend_delay !== undefined) set('resend_delay', patch.resend_delay);
	if (!sets.length) return { ok: true };

	const row = await db
		.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ? AND status = 'draft' RETURNING id`)
		.bind(...binds, id)
		.first<{ id: number }>();
	if (!row) return { ok: false, status: 409, error: NOT_A_DRAFT };
	if (audience) await writeAudience(db, id, audience);
	return { ok: true };
}
