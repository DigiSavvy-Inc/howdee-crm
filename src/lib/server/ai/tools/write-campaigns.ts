// Campaign drafting tools (#309, Phase 3 of #71): the assistant prepares a draft, a person
// opens it in Compose and sends or schedules it. DRAFT ONLY by construction, like the Data
// API's drafts (campaign-drafts.ts): every write is `UPDATE … WHERE status = 'draft'` or an
// INSERT of a zero-recipient draft; a proposed send time is stored in `scheduled_at` on the
// draft only — the scheduler fires `status = 'scheduled'` rows alone. Nothing here imports a
// send, test-send or scheduling module (tests/ai-no-send.test.ts).
//
// Bodies are the visual editor's blocks (draft-body.ts) rendered by compose-body's renderBody,
// the same renderer compose's Save draft uses. Replacing a whole body asks for approval;
// rewriting one section (rewrite_draft_section) does not. Undo replays the earlier fields
// while the draft is still exactly as the assistant left it.

import { composeUrl, MAX_PREHEADER, MAX_SUBJECT } from '../../campaign-drafts';
import { audienceView, existingGroups, normalizeAudience, readAudiences, writeAudience, MAX_AUDIENCE_GROUPS, type Audience } from '../../campaign-audience';
import { audienceLabel } from '$lib/campaign-audience';
import { renderBody, storedBlocks } from '../../compose-body';
import { getSignature } from '../../email-signature';
import { fromAllowed, getSettings } from '../../settings';
import { isEmail } from '$lib/csv';
import type { FieldChange } from '$lib/assistant-actions';
import { BODY_PROPS, blocksArg, bodyOf, sectionList, storedOrConverted } from './draft-body';
import { ToolInputError, UndoRefused, intArg, type Tool, type ToolContext, type WriteOutcome, type WriteTool } from './types';

export type DraftState = {
	campaign_id: number;
	subject: string;
	preheader: string | null;
	body_md: string;
	body_blocks: string | null;
	list_id: number | null; // the first included group (#332)
	from_email: string;
	scheduled_at: string | null; // the proposed send time — the row stays a draft
	template_id: number | null;
	// #332: every included / excluded list or segment. Absent on actions stored before #332.
	include_ids?: number[];
	exclude_ids?: number[];
};

const STATE_KEYS = ['subject', 'preheader', 'body_md', 'body_blocks', 'list_id', 'from_email', 'scheduled_at', 'template_id', 'include_ids', 'exclude_ids'] as const;

type Row = DraftState & { status: string; recipient_count: number };

async function campaignRow(db: D1Database, id: number): Promise<Row | null> {
	const r = await db
		.prepare(
			`SELECT id AS campaign_id, subject, preheader, body_md, body_blocks, list_id, from_email, scheduled_at, template_id, status, recipient_count
			 FROM campaigns WHERE id = ?`
		)
		.bind(id)
		.first<Row>();
	if (!r) return null;
	const a = (await readAudiences(db, [{ id: r.campaign_id, list_id: r.list_id }])).get(r.campaign_id)!;
	return { ...r, include_ids: a.include, exclude_ids: a.exclude };
}

function stateOf(r: Row): DraftState {
	const out = { campaign_id: r.campaign_id } as DraftState;
	for (const k of STATE_KEYS) (out as Record<string, unknown>)[k] = r[k] ?? null;
	out.subject = r.subject;
	out.body_md = r.body_md ?? '';
	out.from_email = r.from_email ?? '';
	out.include_ids = r.include_ids ?? [];
	out.exclude_ids = r.exclude_ids ?? [];
	return out;
}

const eq = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/** `cur` (from the DB) matches `stored`; keys a pre-#332 stored state lacks are skipped. */
function sameState(cur: DraftState, stored: DraftState): boolean {
	return STATE_KEYS.every((k) => !(k in stored) || eq(cur[k], stored[k]));
}

function audienceOf(s: DraftState): Audience {
	return s.include_ids ? { include: s.include_ids, exclude: s.exclude_ids ?? [] } : { include: s.list_id ? [s.list_id] : [], exclude: [] };
}

const NOT_DRAFT = (id: number, status: string) =>
	`Campaign #${id} is ${status}, not a draft. The assistant only edits drafts — it never changes a scheduled or sent campaign.`;

/** The draft named by `campaign_id`; refuses anything that isn't a draft. */
async function requireDraft(ctx: ToolContext, input: Record<string, unknown>): Promise<Row> {
	const id = intArg(input, 'campaign_id', { required: true, min: 1 })!;
	const r = await campaignRow(ctx.db, id);
	if (!r) throw new ToolInputError(`No campaign with id ${id}.`);
	if (r.status !== 'draft') throw new ToolInputError(NOT_DRAFT(id, r.status));
	return r;
}

/** Write every draft field (and re-render the stored preview HTML/text). Draft rows only. */
async function writeState(db: D1Database, s: DraftState): Promise<boolean> {
	const { html, text } = renderBody({ blocks: storedBlocks(s.body_blocks), md: s.body_md }, { preheader: s.preheader || undefined, signature: await getSignature(db) });
	const row = await db
		.prepare(
			`UPDATE campaigns SET subject = ?, preheader = ?, body_md = ?, body_blocks = ?, body_html = ?, body_text = ?,
			        list_id = ?, from_email = ?, scheduled_at = ?, template_id = ?
			 WHERE id = ? AND status = 'draft' RETURNING id`
		)
		.bind(s.subject, s.preheader, s.body_md, s.body_blocks, html, text, s.list_id, s.from_email, s.scheduled_at, s.template_id, s.campaign_id)
		.first<{ id: number }>();
	if (row) await writeAudience(db, s.campaign_id, audienceOf(s));
	return !!row;
}

// ── Field arguments (key-present: a key in the call is written, null clears) ─────────────

const has = (input: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(input, k);

function subjectArg(input: Record<string, unknown>): string {
	const s = typeof input.subject === 'string' ? input.subject.trim() : '';
	if (!s) throw new ToolInputError('"subject" must be a non-empty string.');
	if (s.length > MAX_SUBJECT) throw new ToolInputError(`The subject can be at most ${MAX_SUBJECT} characters.`);
	return s;
}

function preheaderArg(input: Record<string, unknown>): string | null {
	const p = typeof input.preheader === 'string' ? input.preheader.trim() : '';
	if (p.length > MAX_PREHEADER) throw new ToolInputError(`The preheader can be at most ${MAX_PREHEADER} characters.`);
	return p || null;
}

/** ISO 8601 → UTC 'YYYY-MM-DD HH:MM:SS' (null / '' clears). Stored on the draft only. */
function sendAtArg(input: Record<string, unknown>, now: Date): string | null {
	const raw = input.proposed_send_at;
	if (raw === null || raw === '' || raw === undefined) return null;
	const t = typeof raw === 'string' ? new Date(raw) : new Date(NaN);
	if (Number.isNaN(t.getTime())) throw new ToolInputError('"proposed_send_at" must be an ISO 8601 date-time with an offset, or null.');
	if (t.getTime() < now.getTime()) throw new ToolInputError('"proposed_send_at" is in the past.');
	return t.toISOString().slice(0, 19).replace('T', ' ');
}

async function listArg(db: D1Database, input: Record<string, unknown>): Promise<number | null> {
	if (input.list_id === null || input.list_id === '') return null;
	const id = intArg(input, 'list_id', { min: 1 });
	if (id === null) return null;
	// The audience compose offers: a list or a segment (hand-picked or dynamic).
	const l = await db.prepare("SELECT id FROM lists WHERE id = ? AND kind IN ('list', 'segment')").bind(id).first();
	if (!l) throw new ToolInputError(`list_id ${id} is not a list or segment.`);
	return id;
}

async function groupIdsArg(db: D1Database, input: Record<string, unknown>, key: string): Promise<number[]> {
	const raw = input[key];
	if (raw === null || raw === undefined || raw === '') return [];
	if (!Array.isArray(raw) || raw.length > MAX_AUDIENCE_GROUPS || !raw.every((v) => Number.isInteger(v) && (v as number) > 0)) {
		throw new ToolInputError(`"${key}" must be an array of list / segment ids (at most ${MAX_AUDIENCE_GROUPS}), or null.`);
	}
	const { missing } = await existingGroups(db, { include: raw as number[], exclude: [] });
	if (missing.length) throw new ToolInputError(`${missing.join(', ')} ${missing.length === 1 ? 'is not a list or segment' : 'are not lists or segments'}.`);
	return raw as number[];
}

async function templateArg(db: D1Database, input: Record<string, unknown>): Promise<number | null> {
	if (input.template_id === null || input.template_id === '') return null;
	const id = intArg(input, 'template_id', { min: 1 });
	if (id === null) return null;
	if (!(await db.prepare("SELECT id FROM templates WHERE id = ? AND kind != 'web'").bind(id).first())) throw new ToolInputError(`No template with id ${id}.`);
	return id;
}

async function fromArg(db: D1Database, input: Record<string, unknown>): Promise<string> {
	const f = typeof input.from_email === 'string' ? input.from_email.trim() : '';
	if (!isEmail(f)) throw new ToolInputError('"from_email" must be an email address.');
	const settings = await getSettings(db);
	if (!fromAllowed(f, settings.approved_senders)) throw new ToolInputError(`“${f}” isn't an approved sender (Settings → Approved senders).`);
	return f;
}

/** Apply the key-present fields of a call to a state (validated). */
async function patched(ctx: ToolContext, cur: DraftState, input: Record<string, unknown>): Promise<DraftState> {
	const next = { ...cur };
	if (has(input, 'subject')) next.subject = subjectArg(input);
	if (has(input, 'preheader')) next.preheader = preheaderArg(input);
	// #332: list_id = one included group (exclusions kept); include/exclude_list_ids set the lists.
	let audience = audienceOf(cur);
	if (has(input, 'list_id') && has(input, 'include_list_ids')) throw new ToolInputError('Pass either list_id or include_list_ids, not both.');
	if (has(input, 'list_id')) {
		const id = await listArg(ctx.db, input);
		audience = { ...audience, include: id ? [id] : [] };
	}
	if (has(input, 'include_list_ids')) audience = { ...audience, include: await groupIdsArg(ctx.db, input, 'include_list_ids') };
	if (has(input, 'exclude_list_ids')) audience = { ...audience, exclude: await groupIdsArg(ctx.db, input, 'exclude_list_ids') };
	audience = normalizeAudience(audience);
	next.include_ids = audience.include;
	next.exclude_ids = audience.exclude;
	next.list_id = audience.include[0] ?? null;
	if (has(input, 'template_id')) next.template_id = await templateArg(ctx.db, input);
	if (has(input, 'from_email')) next.from_email = await fromArg(ctx.db, input);
	if (has(input, 'proposed_send_at')) next.scheduled_at = sendAtArg(input, ctx.now);
	const blocks = blocksArg(input);
	if (blocks) {
		const body = bodyOf(blocks);
		next.body_blocks = JSON.stringify(body.blocks);
		next.body_md = body.md;
	}
	return next;
}

const show = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

const audienceChanged = (a: DraftState, b: DraftState) => !eq(audienceOf(a), audienceOf(b));

function fieldChanges(a: DraftState, b: DraftState): FieldChange[] {
	const label: Record<string, string> = { from_email: 'from', scheduled_at: 'proposed send time', template_id: 'template' };
	const out: FieldChange[] = [];
	for (const k of ['subject', 'preheader', 'from_email', 'scheduled_at', 'template_id'] as const) {
		if ((a[k] ?? null) !== (b[k] ?? null)) out.push({ field: label[k] ?? k, from: show(a[k]), to: show(b[k]) });
	}
	return out;
}

/** The field changes incl. the audience by name ("Customers + Newsletter, excluding VIP"). */
async function allChanges(db: D1Database, a: DraftState, b: DraftState): Promise<FieldChange[]> {
	const out = fieldChanges(a, b);
	if (audienceChanged(a, b)) {
		const text = async (s: DraftState) => show(audienceLabel(await audienceView(db, audienceOf(s))));
		const at = out.findIndex((c) => c.field !== 'subject' && c.field !== 'preheader');
		out.splice(at === -1 ? out.length : at, 0, { field: 'audience', from: await text(a), to: await text(b) });
	}
	return out;
}

async function audienceJson(db: D1Database, s: DraftState) {
	const v = await audienceView(db, audienceOf(s));
	const g = (x: { id: number; name: string; kind: string }) => ({ list_id: x.id, name: x.name, kind: x.kind });
	return { include: v.include.map(g), exclude: v.exclude.map(g), label: audienceLabel(v) };
}

const bodyChanged = (a: DraftState, b: DraftState) => a.body_md !== b.body_md || (a.body_blocks ?? null) !== (b.body_blocks ?? null);

function outcome(ctx: ToolContext, summary: string, before: DraftState | null, after: DraftState, changes: FieldChange[] = []): WriteOutcome {
	const url = composeUrl(ctx.baseUrl, after.campaign_id);
	return { summary, before, after, changes, url, result: { campaign_id: after.campaign_id, compose_url: url, status: 'draft' } };
}

/** Undo an edit: the draft must still be a draft and exactly as the assistant left it. */
async function restore(ctx: ToolContext, before: unknown, after: unknown): Promise<void> {
	const b = before as DraftState;
	const a = after as DraftState;
	const r = await campaignRow(ctx.db, a.campaign_id);
	if (!r) throw new UndoRefused('That draft no longer exists.');
	if (r.status !== 'draft') throw new UndoRefused(`Campaign #${r.campaign_id} is ${r.status} now — nothing was undone.`);
	if (!sameState(stateOf(r), a)) throw new UndoRefused(`Draft #${r.campaign_id} was edited since — nothing was undone.`);
	if (!(await writeState(ctx.db, b))) throw new UndoRefused(`Campaign #${r.campaign_id} is no longer a draft — nothing was undone.`);
}

const CAMPAIGN_ID = {
	campaign_id: {
		type: 'integer',
		description: 'The draft campaign id. On /compose?draft=<id> the page context has params.draft_id; on /campaign/<id>, params.id.'
	}
};

const FIELD_PROPS = {
	subject: { type: 'string' },
	preheader: { type: ['string', 'null'], description: 'Inbox preview text (about 40–90 characters).' },
	list_id: { type: ['integer', 'null'], description: 'Audience shortcut: ONE list or segment id (list_groups shows them); replaces the included groups, keeps exclusions.' },
	include_list_ids: {
		type: ['array', 'null'],
		items: { type: 'integer' },
		maxItems: MAX_AUDIENCE_GROUPS,
		description: 'Audience: send to everyone in ANY of these lists / segments (each person once). Replaces the included groups.'
	},
	exclude_list_ids: {
		type: ['array', 'null'],
		items: { type: 'integer' },
		maxItems: MAX_AUDIENCE_GROUPS,
		description: "Don't send to anyone in these lists / segments (subtracted after the union). Replaces the exclusions; null or [] clears."
	},
	from_email: { type: 'string', description: 'An approved sender address. Omit to use the default From.' },
	template_id: { type: ['integer', 'null'], description: 'An email template id (optional).' },
	proposed_send_at: {
		type: ['string', 'null'],
		description:
			'Proposed send time, ISO 8601 with offset (e.g. 2026-10-20T09:00:00-07:00). Stored on the draft only — it is NOT scheduled; a person schedules it in Compose.'
	}
};

export const campaignDraftTools: Tool[] = [
	{
		name: 'get_draft_sections',
		tier: 'read',
		description:
			"A draft campaign's body as numbered blocks (index, type, text) — use it before rewrite_draft_section to find the intro, a paragraph, the call to action or the end. Also returns subject, preheader, audience and proposed send time.",
		input_schema: { type: 'object', properties: CAMPAIGN_ID, required: ['campaign_id'] },
		summarize: (input) => `draft #${input.campaign_id}`,
		handler: async (ctx, input) => {
			const id = intArg(input, 'campaign_id', { required: true, min: 1 })!;
			const r = await campaignRow(ctx.db, id);
			if (!r) throw new ToolInputError(`No campaign with id ${id}.`);
			const blocks = storedOrConverted(r.body_blocks, r.body_md, storedBlocks);
			return {
				campaign_id: id,
				status: r.status,
				editable: r.status === 'draft',
				subject: r.subject,
				preheader: r.preheader,
				list_id: r.list_id,
				audience: await audienceJson(ctx.db, stateOf(r)),
				from_email: r.from_email,
				proposed_send_at: r.scheduled_at,
				sections: sectionList(blocks),
				url: composeUrl(ctx.baseUrl, id)
			};
		}
	},
	{
		name: 'suggest_subject_lines',
		tier: 'read',
		description:
			'Check subject-line options before offering them: write 3–6 candidates yourself and pass them in. Returns each with its length, whether it fits a phone inbox (~40 chars), merge tags, and warnings, plus the draft’s current subject and recent sent subjects with their open rates. It never applies a subject — once the user picks one, call update_campaign_draft.',
		input_schema: {
			type: 'object',
			properties: { ...CAMPAIGN_ID, options: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
			required: ['options']
		},
		summarize: (input) => (input.campaign_id ? `draft #${input.campaign_id}` : 'subject lines'),
		handler: async (ctx, input) => {
			if (!Array.isArray(input.options) || !input.options.length) throw new ToolInputError('"options" must be a non-empty array of strings.');
			const options = input.options.slice(0, 8).map((o) => String(o ?? '').trim()).filter(Boolean);
			const id = intArg(input, 'campaign_id', { min: 1 });
			const current = id ? await campaignRow(ctx.db, id) : null;
			const tagsOf = (s: string) => [...s.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]);
			const currentTags = current ? tagsOf(current.subject) : [];
			const recent = await ctx.db
				.prepare(
					`SELECT c.id, c.subject,
					        (SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = c.id AND r.status = 'accepted') AS sent,
					        (SELECT COUNT(DISTINCT e.recipient_id) FROM events e WHERE e.campaign_id = c.id AND e.type = 'open') AS opens
					 FROM campaigns c
					 WHERE c.status = 'sent' AND c.list_id IS NOT NULL AND c.automation_step_id IS NULL
					 ORDER BY COALESCE(c.sent_at, c.created_at) DESC LIMIT 10`
				)
				.all<{ id: number; subject: string; sent: number; opens: number }>();
			return {
				current_subject: current?.subject ?? null,
				options: options.map((text) => {
					const warnings: string[] = [];
					if (text.length > MAX_SUBJECT) warnings.push(`longer than ${MAX_SUBJECT} characters (not allowed)`);
					else if (text.length > 70) warnings.push('long: most inboxes cut it off');
					if (/!{2,}/.test(text)) warnings.push('repeated exclamation marks');
					if (/\b[A-Z]{4,}\b/.test(text.replace(/\{\{[^}]+\}\}/g, ''))) warnings.push('a word in all caps');
					if (/\b(free|act now|guarantee[d]?|winner|cash|urgent|risk[- ]free|click here|buy now)\b|100%/i.test(text)) warnings.push('a word spam filters notice');
					const tags = tagsOf(text);
					const lost = currentTags.filter((t) => !tags.includes(t));
					if (lost.length) warnings.push(`drops ${lost.join(', ')} from the current subject`);
					return { text, length: text.length, fits_phone: text.length <= 40, merge_tags: tags, warnings };
				}),
				recent_subjects: recent.results.map((r) => ({
					subject: r.subject,
					sent: r.sent,
					open_rate: r.sent ? Math.round((r.opens / r.sent) * 1000) / 10 : null,
					url: `${ctx.baseUrl}/campaign/${r.id}`
				})),
				note: 'Nothing was changed.'
			};
		}
	},
	{
		name: 'create_campaign_draft',
		tier: 'write',
		description:
			'Create a campaign DRAFT (never sent or scheduled): subject, body, optional preheader, audience (one or more lists / segments, optional exclusions), from, template and a proposed send time stored on the draft. Returns compose_url — tell the user to open it in Compose to review, then send or schedule it themselves.',
		input_schema: { type: 'object', properties: { ...FIELD_PROPS, ...BODY_PROPS }, required: ['subject'] },
		summarize: (input) => String(input.subject ?? ''),
		plan: async (ctx, input) => {
			subjectArg(input);
			if (!blocksArg(input)) throw new ToolInputError('Give the body as body_markdown (or body_blocks).');
			return { count: 0, sample: [], summary: `Create draft “${String(input.subject).trim()}”` };
		},
		apply: async (ctx, input) => {
			const blocks = blocksArg(input);
			if (!blocks) throw new ToolInputError('Give the body as body_markdown (or body_blocks).');
			const settings = await getSettings(ctx.db);
			const base: DraftState = {
				campaign_id: 0,
				subject: subjectArg(input),
				preheader: null,
				body_md: '',
				body_blocks: null,
				list_id: null,
				from_email: settings.default_from ?? '',
				scheduled_at: null,
				template_id: null,
				include_ids: [],
				exclude_ids: []
			};
			const s = await patched(ctx, base, input);
			const { html, text } = renderBody({ blocks: storedBlocks(s.body_blocks), md: s.body_md }, { preheader: s.preheader || undefined, signature: await getSignature(ctx.db) });
			const row = await ctx.db
				.prepare(
					`INSERT INTO campaigns (subject, preheader, body_md, body_blocks, body_html, body_text, list_id, from_email, scheduled_at, template_id,
					                        status, recipient_count, sent_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, NULL) RETURNING id`
				)
				.bind(s.subject, s.preheader, s.body_md, s.body_blocks, html, text, s.list_id, s.from_email, s.scheduled_at, s.template_id)
				.first<{ id: number }>();
			const after = { ...s, campaign_id: row!.id };
			await writeAudience(ctx.db, after.campaign_id, audienceOf(after));
			return outcome(ctx, `Created draft #${after.campaign_id} “${after.subject}”`, null, after);
		},
		undo: async (ctx, _before, after) => {
			const a = after as DraftState;
			const r = await campaignRow(ctx.db, a.campaign_id);
			if (!r) return; // already gone
			if (r.status !== 'draft') throw new UndoRefused(`Campaign #${r.campaign_id} was kept: it is ${r.status} now.`);
			if (!sameState(stateOf(r), a)) throw new UndoRefused(`Draft #${r.campaign_id} was kept: it was edited since.`);
			const del = await ctx.db
				.prepare(
					`DELETE FROM campaigns WHERE id = ? AND status = 'draft' AND recipient_count = 0
					 AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.campaign_id = campaigns.id)`
				)
				.bind(a.campaign_id)
				.run();
			if (!del.meta.changes) throw new UndoRefused(`Draft #${a.campaign_id} was kept.`);
		}
	} satisfies WriteTool,
	{
		name: 'update_campaign_draft',
		tier: 'write',
		description:
			'Edit a draft campaign: subject, preheader, audience (include_list_ids / exclude_list_ids, or list_id for one group), from, template or proposed send time — only the keys you pass change (null clears). Passing body_markdown / body_blocks replaces the WHOLE body and waits for the user to Approve; to change one part ("shorten the intro", "add a P.S.") use rewrite_draft_section instead. Drafts only — never a scheduled or sent campaign.',
		input_schema: { type: 'object', properties: { ...CAMPAIGN_ID, ...FIELD_PROPS, ...BODY_PROPS }, required: ['campaign_id'] },
		summarize: (input) => `draft #${input.campaign_id}`,
		plan: async (ctx, input) => {
			const r = await requireDraft(ctx, input);
			const next = await patched(ctx, stateOf(r), input);
			const body = bodyChanged(stateOf(r), next);
			if (!body && !fieldChanges(stateOf(r), next).length && !audienceChanged(stateOf(r), next)) throw new ToolInputError('Nothing to change.');
			return { count: 0, sample: [], summary: body ? `Replace the whole body of draft “${r.subject}”` : `Update draft “${r.subject}”`, approve: body };
		},
		apply: async (ctx, input) => {
			const r = await requireDraft(ctx, input);
			const before = stateOf(r);
			const after = await patched(ctx, before, input);
			if (!(await writeState(ctx.db, after))) throw new ToolInputError(NOT_DRAFT(r.campaign_id, 'no longer a draft'));
			const changes = await allChanges(ctx.db, before, after);
			const parts = [...changes.map((c) => c.field), ...(bodyChanged(before, after) ? ['body'] : [])];
			return outcome(ctx, parts.length ? `Updated draft “${after.subject}”: ${parts.join(', ')}` : `No change to draft “${after.subject}”`, before, after, changes);
		},
		undo: restore
	} satisfies WriteTool,
	{
		name: 'rewrite_draft_section',
		tier: 'write',
		description:
			'Rewrite one part of a draft\'s body: replace blocks start..end-1 (indexes from get_draft_sections) with new content. Insert without replacing by passing end = start (e.g. a P.S. at the end: start = end = number of sections). Can\'t replace every block at once — that is update_campaign_draft with a body (needs approval).',
		input_schema: {
			type: 'object',
			properties: {
				...CAMPAIGN_ID,
				start: { type: 'integer', minimum: 0, description: 'First block index to replace.' },
				end: { type: 'integer', minimum: 0, description: 'One past the last block to replace (default start + 1).' },
				...BODY_PROPS
			},
			required: ['campaign_id', 'start']
		},
		summarize: (input) => `draft #${input.campaign_id}`,
		plan: async (ctx, input) => {
			const r = await requireDraft(ctx, input);
			sectionEdit(r, input);
			return { count: 0, sample: [], summary: `Rewrite part of draft “${r.subject}”` };
		},
		apply: async (ctx, input) => {
			const r = await requireDraft(ctx, input);
			const { blocks, start, end, inserted } = sectionEdit(r, input);
			const before = stateOf(r);
			const body = bodyOf(blocks);
			const after = { ...before, body_blocks: JSON.stringify(body.blocks), body_md: body.md };
			if (!(await writeState(ctx.db, after))) throw new ToolInputError(NOT_DRAFT(r.campaign_id, 'no longer a draft'));
			const what = end === start ? `added ${inserted} block${inserted === 1 ? '' : 's'} at ${start}` : `rewrote blocks ${start}–${end - 1}`;
			return outcome(ctx, `Draft “${after.subject}”: ${what}`, before, after);
		},
		undo: restore
	} satisfies WriteTool
];

/** The new block list for a section rewrite (validated). */
function sectionEdit(r: Row, input: Record<string, unknown>) {
	const current = storedOrConverted(r.body_blocks, r.body_md, storedBlocks);
	const start = intArg(input, 'start', { required: true, min: 0 })!;
	const end = intArg(input, 'end', { min: 0 }) ?? start + 1;
	if (start > current.length) throw new ToolInputError(`The draft has ${current.length} sections (0–${current.length - 1}).`);
	if (end < start || end > current.length) throw new ToolInputError(`"end" must be between ${start} and ${current.length}.`);
	if (current.length && start === 0 && end === current.length) {
		throw new ToolInputError('That replaces the whole body — use update_campaign_draft with the new body (the user approves it).');
	}
	const replacement = blocksArg(input, { part: true });
	if (!replacement) throw new ToolInputError('Give the new content as body_markdown (or body_blocks).');
	return { blocks: [...current.slice(0, start), ...replacement, ...current.slice(end)], start, end, inserted: replacement.length };
}
