// Contact management tools (#322, a #71 hard-rule change on the owner's instruction, 2026-10-17):
// create a contact, unsubscribe / resubscribe, archive / restore and delete. Every write goes
// through the code the contacts bulk bar runs (contact-bulk.ts → contact-archive.ts,
// contacts.ts' delete, the #279 unsubscribe write, the #285 resubscribe guard), so the
// assistant can't do anything a person couldn't do there. Never sends, schedules or enrolls:
// tags here pass `enroll: false`, and `create_contact` doesn't use the hygiene helper that
// would enroll on `hygiene:invalid`.
//
// Approval: unsubscribe, resubscribe and delete always wait for Approve (even for one
// contact); archive / restore only above APPROVE_OVER. Delete has no Undo and is refused
// above DELETE_MAX; an unsubscribe Undo only resubscribes the contacts it unsubscribed, within
// UNSUB_UNDO_HOURS, and never once Postmark suppressed them.

import { hygieneInvalid, hygieneMeta, hygieneNotes } from '$lib/email-hygiene';
import {
	bulkAddTag,
	bulkAddToGroup,
	bulkArchive,
	bulkDelete,
	bulkRestore,
	bulkResubscribe,
	bulkUnsubscribe,
	findGroup,
	resolveSelection,
	type Selection
} from '../../contact-bulk';
import { applyContactMeta, validateFieldsBag } from '../../contact-write';
import { syncCompanyMembership } from '../../companies';
import { HYGIENE_INVALID_TAG, checkAddress } from '../../hygiene';
import { snapshot as seoSnapshot } from '../../snapshot';
import { contactIdsArg, displayName, emailArg, emailOwner } from './write-contacts';
import { contactWriteTriggerNotes, newContactTriggerNotes, restoreTriggerNotes } from './trigger-guard';
import { ToolInputError, UndoRefused, strArg, type ToolContext, type WriteTool } from './types';
import { DELETE_OFF_MESSAGE, getAssistantConfig } from '../config';
import { setTierOverride, tierOverrideStates } from '../../tier-override';
import { computeEngagement } from '../../engagement';
import { TIERS } from '$lib/engagement-view';
import { TIER_OVERRIDE_DAYS_MAX, normalizeTierOverride, tierActionTitle, tierLabel } from '$lib/tier-override';

/** Most contacts one delete_contacts call may remove. */
export const DELETE_MAX = 50;
/** An unsubscribe can be undone this long after it was applied. */
export const UNSUB_UNDO_HOURS = 24;

const IDS = '(SELECT value FROM json_each(?))';

type Sel = Selection & { ok: true };
type NameRow = { id: number; email: string; name: string | null; first_name: string | null; last_name: string | null };

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function plural(n: number, word: string): string {
	return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** `unsubscribes.reason` for the assistant's unsubscribe: who asked for it. */
export function assistantReason(ctx: ToolContext): string {
	return `assistant (@${ctx.user.github_login})`;
}

async function selection(ctx: ToolContext, input: Record<string, unknown>, max?: number): Promise<Sel> {
	const sel = await resolveSelection(ctx.db, { ids: contactIdsArg(input, max) });
	if (!sel.ok) throw new ToolInputError(sel.error);
	return sel;
}

function asSel(ids: number[]): Sel {
	return { ok: true, ids, all: false, missing: 0 };
}

/** "Ann Lee <ann@example.com>" for the first few contacts — the approval card's sample. */
async function sampleWithEmails(ctx: ToolContext, ids: number[], n = 5): Promise<string[]> {
	const rows = await ctx.db
		.prepare(`SELECT id, email, name, first_name, last_name FROM contacts WHERE id IN ${IDS} ORDER BY id LIMIT ?`)
		.bind(JSON.stringify(ids.slice(0, 200)), n)
		.all<NameRow>();
	return rows.results.map((c) => {
		const name = displayName(c);
		return name === c.email ? c.email : `${name} <${c.email}>`;
	});
}

/** The ids of `ids` matching a contacts-column condition (e.g. `subscribed = 1`). */
async function idsWhere(db: D1Database, ids: number[], cond: string): Promise<number[]> {
	const out: number[] = [];
	for (let i = 0; i < ids.length; i += 500) {
		const rows = await db
			.prepare(`SELECT id FROM contacts WHERE ${cond} AND id IN ${IDS} ORDER BY id`)
			.bind(JSON.stringify(ids.slice(i, i + 500)))
			.all<{ id: number }>();
		out.push(...rows.results.map((r) => r.id));
	}
	return out;
}

async function withActivePasses(db: D1Database, ids: number[]): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(DISTINCT contact_id) AS n FROM automation_enrollments WHERE status = 'active' AND contact_id IN ${IDS}`)
		.bind(JSON.stringify(ids))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

function contactsUrl(ctx: ToolContext, ids: number[], archived = false): string {
	return ids.length === 1 ? `${ctx.baseUrl}/contacts/${ids[0]}` : `${ctx.baseUrl}/contacts${archived ? '?archived=1' : ''}`;
}

const IDS_PROPS = {
	contact_ids: { type: 'array', items: { type: 'integer' }, description: 'Contact ids. Use the selected ids from the page context for "these".' },
	contact_id: { type: 'integer', description: 'One contact id (instead of contact_ids).' }
};

// ---- create_contact ----

type CreateState = { contact_id: number; email: string; groups: number[] };

const REFERENCES: { table: string; label: string }[] = [
	{ table: 'recipients', label: 'has been sent email' },
	{ table: 'events', label: 'has tracking events' },
	{ table: 'replies', label: 'has replies' },
	{ table: 'unsubscribes', label: 'has an unsubscribe record' },
	{ table: 'automation_enrollments', label: 'is in an automation' },
	{ table: 'pipeline_cards', label: 'is on the pipeline' },
	{ table: 'site_events', label: 'has site activity' },
	{ table: 'mail_message_contacts', label: 'has Gmail messages' },
	// Tables owned by an optional feature module (#608).
	...seoSnapshot.contactReferences
];

function stringList(input: Record<string, unknown>, key: string, max: number): string[] {
	const raw = input[key];
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new ToolInputError(`"${key}" must be an array.`);
	const out = [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))];
	if (out.length > max) throw new ToolInputError(`At most ${max} ${key} per contact.`);
	return out;
}

type CreateInput = {
	email: string;
	scalars: Record<'name' | 'first_name' | 'last_name' | 'company', string | null>;
	fields: Record<string, string | number | boolean | null>;
	tags: string[];
	lists: { id: number; name: string; kind: string; rules: string | null }[];
};

async function createInput(ctx: ToolContext, input: Record<string, unknown>): Promise<CreateInput> {
	if (has(input, 'subscribed')) throw new ToolInputError('New contacts are created subscribed; use unsubscribe_contacts afterwards if needed.');
	const email = emailArg(input.email);
	const s = (k: string) => strArg(input, k, 200) || null;
	const fields: Record<string, string | number | boolean | null> = {};
	if (has(input, 'phone') && input.phone !== null) fields.phone = String(input.phone).trim().slice(0, 50);
	if (has(input, 'custom_fields')) {
		const problem = validateFieldsBag({ fields: input.custom_fields });
		if (problem) throw new ToolInputError(`custom_fields: ${problem}`);
		const entries = Object.entries(input.custom_fields as Record<string, string | number | boolean | null>);
		if (entries.length > 20) throw new ToolInputError('At most 20 custom fields per call.');
		for (const [k, v] of entries) {
			const key = k.trim().slice(0, 50);
			if (key && key !== 'hygiene') fields[key] = v;
		}
	}
	const tags = stringList(input, 'tags', 10);
	for (const t of tags) {
		if (t.length > 60) throw new ToolInputError(`Tag “${t.slice(0, 60)}…” is too long (60 chars max).`);
		if (seoSnapshot.protectedTag && t.toLowerCase() === seoSnapshot.protectedTag) throw new ToolInputError(`“${seoSnapshot.protectedTag}” releases a report to the lead, so the assistant can't add it.`);
	}
	const lists: CreateInput['lists'] = [];
	for (const ref of stringList(input, 'lists', 10)) {
		const g = await findGroup(ctx.db, ref, ['list', 'segment']);
		if (!g) throw new ToolInputError(`No list or segment “${ref}”. Use list_groups to find it, or create_list first.`);
		if (g.kind === 'segment' && (g.rules ?? '').trim()) throw new ToolInputError(`“${g.name}” is a dynamic segment — its members come from its rules.`);
		lists.push(g);
	}
	return { email, scalars: { name: s('name'), first_name: s('first_name'), last_name: s('last_name'), company: s('company') }, fields, tags, lists };
}

async function duplicateError(ctx: ToolContext, email: string): Promise<never> {
	const c = await emailOwner(ctx.db, email);
	if (!c) throw new ToolInputError(`${email} already exists.`);
	throw new ToolInputError(
		JSON.stringify({
			error: 'A contact with this email already exists — nothing was created.',
			existing_contact: { id: c.id, email: c.email, name: displayName(c), url: `${ctx.baseUrl}/contacts/${c.id}` },
			hint: 'Use update_contact to change it.'
		})
	);
}

const createContact: WriteTool = {
	name: 'create_contact',
	tier: 'write',
	description:
		'Create one contact (subscribed, source "assistant"): email (required), name / first_name / last_name, company, phone, custom_fields, and optionally tags (created if missing) and lists (existing lists or hand-picked segments, by id or name). Address-hygiene warnings (typo, role address, disposable, no mail server) come back in the result. If the email already exists nothing is created and the existing contact is returned. Never starts an automation.',
	input_schema: {
		type: 'object',
		properties: {
			email: { type: 'string' },
			name: { type: 'string' },
			first_name: { type: 'string' },
			last_name: { type: 'string' },
			company: { type: 'string', description: 'Company name (links or creates the company).' },
			phone: { type: 'string' },
			custom_fields: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
			tags: { type: 'array', items: { type: 'string' }, description: 'Tag names (max 10).' },
			lists: { type: 'array', items: { type: ['string', 'integer'] }, description: 'List / hand-picked segment ids or names (max 10).' }
		},
		required: ['email']
	},
	summarize: (input) => String(input.email ?? ''),
	plan: async (ctx, input) => {
		const c = await createInput(ctx, input);
		if (await emailOwner(ctx.db, c.email)) await duplicateError(ctx, c.email);
		// #535: a new contact may match a trigger segment's rules (subscribed, source, "not
		// tagged", …); apply may also tag it hygiene:invalid.
		const notes = await newContactTriggerNotes(ctx.db, {
			tags: [...c.tags, HYGIENE_INVALID_TAG],
			listIds: c.lists.map((g) => g.id),
			company: !!c.scalars.company
		});
		return { count: 1, sample: [c.email], summary: `Create ${c.email}`, ...(notes.length ? { approve: true, notes } : {}) };
	},
	apply: async (ctx, input) => {
		const c = await createInput(ctx, input);
		if (await emailOwner(ctx.db, c.email)) await duplicateError(ctx, c.email);
		let id: number;
		try {
			const row = await ctx.db
				.prepare(
					`INSERT INTO contacts (email, name, first_name, last_name, company, source, subscribed)
					 VALUES (?, ?, ?, ?, ?, 'assistant', 1) RETURNING id`
				)
				.bind(c.email, c.scalars.name, c.scalars.first_name, c.scalars.last_name, c.scalars.company)
				.first<{ id: number }>();
			id = row!.id;
		} catch (e) {
			if (String(e).includes('UNIQUE')) await duplicateError(ctx, c.email);
			throw e;
		}
		await syncCompanyMembership(ctx.db, id, c.scalars.company, { enroll: false });

		// #306 hygiene, like the machine entry paths (tag, never reject) — but tagged with
		// enroll: false, so `hygiene:invalid` can't start an automation from here.
		const h = await checkAddress(c.email, { lookup: ctx.mxLookup });
		await applyContactMeta(ctx.db, id, { ...c.fields, hygiene: hygieneMeta(h) });
		const sel = asSel([id]);
		const tags = [...c.tags];
		if (hygieneInvalid(h) && !tags.some((t) => t.toLowerCase() === HYGIENE_INVALID_TAG)) tags.push(HYGIENE_INVALID_TAG);
		for (const t of tags) {
			const out = await bulkAddTag(ctx.db, sel, t, { enroll: false });
			if (!out.ok) throw new ToolInputError(out.error);
		}
		for (const g of c.lists) {
			const out = await bulkAddToGroup(ctx.db, sel, g, { enroll: false });
			if (!out.ok) throw new ToolInputError(out.error);
		}
		const groups = await ctx.db
			.prepare(`SELECT lm.list_id AS id FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = ? AND l.kind != 'company'`)
			.bind(id)
			.all<{ id: number }>();
		const notes = hygieneNotes(h);
		const who = c.scalars.name || [c.scalars.first_name, c.scalars.last_name].filter(Boolean).join(' ') || c.email;
		return {
			summary: `Created ${who === c.email ? c.email : `${who} (${c.email})`}`,
			before: null,
			after: { contact_id: id, email: c.email, groups: groups.results.map((g) => g.id) } satisfies CreateState,
			notes,
			url: `${ctx.baseUrl}/contacts/${id}`,
			result: { contact_id: id, hygiene: hygieneMeta(h) }
		};
	},
	undo: async (ctx, _before, after) => {
		const a = after as CreateState | null;
		if (!a?.contact_id) return;
		const c = await ctx.db.prepare('SELECT id, email FROM contacts WHERE id = ?').bind(a.contact_id).first<{ id: number; email: string }>();
		if (!c) return; // already gone
		if (c.email !== a.email) throw new UndoRefused(`The contact's email changed since — it was kept.`);
		const used = await ctx.db
			.batch(REFERENCES.map((r) => ctx.db.prepare(`SELECT 1 AS x FROM ${r.table} WHERE contact_id = ? LIMIT 1`).bind(c.id)))
			.then((res) => REFERENCES.filter((_, i) => res[i].results.length));
		if (used.length) throw new UndoRefused(`${c.email} ${used[0].label} now, so it was kept. Archive it instead if it shouldn't be here.`);
		const groups = await ctx.db
			.prepare(`SELECT lm.list_id AS id FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = ? AND l.kind != 'company'`)
			.bind(c.id)
			.all<{ id: number }>();
		const ours = new Set(a.groups);
		if (groups.results.some((g) => !ours.has(g.id))) throw new UndoRefused(`${c.email} was added to another list or tag since, so it was kept.`);
		await syncCompanyMembership(ctx.db, c.id, null, { enroll: false }); // drop the derived company group first
		await bulkDelete(ctx.db, asSel([c.id]));
	}
};

// ---- unsubscribe / resubscribe ----

type UnsubState = { ids: number[]; at: string; suppressed: boolean };
type ResubState = { ids: number[] };

const unsubscribeContacts: WriteTool = {
	name: 'unsubscribe_contacts',
	tier: 'approve',
	description:
		'Unsubscribe contacts (like the contacts bulk bar): they get no more campaigns or automation emails, an unsubscribe record is written with the reason "assistant (@you)", and their active automation passes are cancelled. Always waits for the user to Approve, even for one contact. also_suppress_in_postmark (default false) also adds them to the Postmark suppression list — then there is no Undo. Otherwise Undo within 24 hours resubscribes exactly the contacts this unsubscribed.',
	input_schema: {
		type: 'object',
		properties: {
			...IDS_PROPS,
			also_suppress_in_postmark: { type: 'boolean', description: 'Also suppress them in Postmark (default false; makes it permanent from here).' }
		}
	},
	summarize: (input) => `${Array.isArray(input.contact_ids) ? input.contact_ids.length : 1} contact(s)`,
	plan: async (ctx, input) => {
		const sel = await selection(ctx, input);
		const subscribed = await idsWhere(ctx.db, sel.ids, 'subscribed = 1');
		const passes = await withActivePasses(ctx.db, subscribed.length ? subscribed : [0]);
		const suppress = input.also_suppress_in_postmark === true;
		const already = sel.ids.length - subscribed.length;
		const notes = [
			`Effect: ${plural(subscribed.length, 'contact')} unsubscribed — no more campaigns or automation emails. Reason recorded: “${assistantReason(ctx)}”.`,
			passes ? `${plural(passes, 'contact')} ${passes === 1 ? 'has' : 'have'} active automation passes that will be cancelled (not restored by Undo).` : 'None of them are in an active automation.',
			...(already ? [`${plural(already, 'contact')} already unsubscribed — left as is.`] : []),
			suppress
				? 'Also suppresses them in Postmark: Postmark will refuse to send to these addresses. This can’t be undone from here.'
				: `Not suppressed in Postmark. Undo is available for ${UNSUB_UNDO_HOURS} hours.`,
			// #551: unsubscribing can move them into a trigger segment on `subscribed` or the tier (cold, #444).
			...(await contactWriteTriggerNotes(ctx.db, subscribed, { subscribed: true, tier: true }))
		];
		return { count: sel.ids.length, sample: await sampleWithEmails(ctx, sel.ids), summary: `Unsubscribe ${plural(sel.ids.length, 'contact')}`, notes };
	},
	apply: async (ctx, input) => {
		const sel = await selection(ctx, input);
		const wasSubscribed = await idsWhere(ctx.db, sel.ids, 'subscribed = 1');
		const wantSuppress = input.also_suppress_in_postmark === true;
		const out = await bulkUnsubscribe(ctx.db, sel, { suppress: wantSuppress, postmark: ctx.postmark, reason: assistantReason(ctx), triggers: false });
		if (!out.ok) throw new ToolInputError(out.error);
		const now = wasSubscribed.length ? await idsWhere(ctx.db, wasSubscribed, 'subscribed = 0') : [];
		const suppressed = wantSuppress && !!ctx.postmark?.token && !!ctx.postmark?.stream;
		return {
			summary: out.message,
			before: { subscribed: wasSubscribed },
			after: { ids: now, at: ctx.now.toISOString(), suppressed } satisfies UnsubState,
			undoable: !suppressed,
			url: contactsUrl(ctx, sel.ids),
			result: { unsubscribed: out.affected, skipped: out.skipped, suppressed_in_postmark: suppressed }
		};
	},
	undo: async (ctx, _before, after) => {
		const a = after as UnsubState | null;
		if (!a?.ids?.length) return;
		if (a.suppressed) throw new UndoRefused('These contacts were also suppressed in Postmark, so this can’t be undone here.');
		if (ctx.now.getTime() - Date.parse(a.at) > UNSUB_UNDO_HOURS * 3600_000) {
			throw new UndoRefused(`An unsubscribe can only be undone within ${UNSUB_UNDO_HOURS} hours. Resubscribe them (with their consent) instead.`);
		}
		// Only those this action unsubscribed, still unsubscribed, and not unsubscribed again
		// since by anything else (their own link, a bounce, a Postmark sync).
		const since = a.at.replace('T', ' ').slice(0, 19);
		const rows = await ctx.db
			.prepare(
				`SELECT id FROM contacts WHERE subscribed = 0 AND id IN ${IDS}
				   AND id NOT IN (SELECT contact_id FROM unsubscribes WHERE contact_id IS NOT NULL AND created_at >= ? AND reason != ?)`
			)
			.bind(JSON.stringify(a.ids), since, assistantReason(ctx))
			.all<{ id: number }>();
		const ids = rows.results.map((r) => r.id);
		if (!ids.length) throw new UndoRefused('None of these contacts can be resubscribed by Undo any more — nothing was changed.');
		const out = await bulkResubscribe(ctx.db, asSel(ids), { postmark: ctx.postmark, triggers: false });
		if (!out.ok) throw new UndoRefused(out.error);
	}
};

const resubscribeContacts: WriteTool = {
	name: 'resubscribe_contacts',
	tier: 'approve',
	description:
		"Resubscribe contacts (like the contacts bulk bar). Requires each contact's consent: only call it after the user has said they have it, and pass consent_confirmed: true. Contacts Postmark suppresses for a hard bounce or spam complaint are skipped. Always waits for the user to Approve. Undo unsubscribes again the contacts it resubscribed.",
	input_schema: {
		type: 'object',
		properties: {
			...IDS_PROPS,
			consent_confirmed: { type: 'boolean', description: 'True only when the user said these contacts consented to be resubscribed.' }
		},
		required: ['consent_confirmed']
	},
	summarize: (input) => `${Array.isArray(input.contact_ids) ? input.contact_ids.length : 1} contact(s)`,
	plan: async (ctx, input) => {
		if (input.consent_confirmed !== true) {
			throw new ToolInputError("Resubscribing needs the contacts' consent. Ask the user to confirm they have it, then call again with consent_confirmed: true.");
		}
		const sel = await selection(ctx, input);
		const unsubscribed = await idsWhere(ctx.db, sel.ids, 'subscribed = 0');
		const already = sel.ids.length - unsubscribed.length;
		const notes = [
			"Resubscribing requires each contact's consent. Approve only if you have it.",
			`Effect: ${plural(unsubscribed.length, 'contact')} resubscribed — they can receive campaigns again. Their unsubscribe records are kept.`,
			'Contacts Postmark suppresses for a hard bounce or spam complaint are skipped; other Postmark suppressions are not lifted.',
			...(already ? [`${plural(already, 'contact')} already subscribed — left as is.`] : []),
			// #535: a trigger segment on `subscribed` (or the tier, which resubscribing restores, #444).
			...(await contactWriteTriggerNotes(ctx.db, unsubscribed, { subscribed: true, tier: true }))
		];
		return { count: sel.ids.length, sample: await sampleWithEmails(ctx, sel.ids), summary: `Resubscribe ${plural(sel.ids.length, 'contact')}`, notes };
	},
	apply: async (ctx, input) => {
		if (input.consent_confirmed !== true) throw new ToolInputError('consent_confirmed must be true.');
		const sel = await selection(ctx, input);
		const wasUnsubscribed = await idsWhere(ctx.db, sel.ids, 'subscribed = 0');
		const out = await bulkResubscribe(ctx.db, sel, { postmark: ctx.postmark, triggers: false });
		if (!out.ok) throw new ToolInputError(out.error);
		const now = wasUnsubscribed.length ? await idsWhere(ctx.db, wasUnsubscribed, 'subscribed = 1') : [];
		return {
			summary: out.message,
			before: { unsubscribed: wasUnsubscribed },
			after: { ids: now } satisfies ResubState,
			url: contactsUrl(ctx, sel.ids),
			result: { resubscribed: out.affected, skipped: out.skipped }
		};
	},
	undo: async (ctx, _before, after) => {
		const a = after as ResubState | null;
		if (!a?.ids?.length) return;
		// Back to unsubscribed — a plain flag flip, no new unsubscribe record (they never asked).
		await ctx.db.prepare(`UPDATE contacts SET subscribed = 0 WHERE subscribed = 1 AND id IN ${IDS}`).bind(JSON.stringify(a.ids)).run();
	}
};

// ---- archive / restore ----

type ArchiveState = { ids: number[] };
type RestoreBefore = { archived: { id: number; at: string }[] };

const archiveContactsTool: WriteTool = {
	name: 'archive_contacts',
	tier: 'write',
	description:
		'Archive contacts: hidden from day-to-day views and never sent to, history and subscription kept (prefer this over delete). Over 25 contacts waits for approval. Undo restores them.',
	input_schema: { type: 'object', properties: { ...IDS_PROPS } },
	summarize: (input) => `${Array.isArray(input.contact_ids) ? input.contact_ids.length : 1} contact(s)`,
	plan: async (ctx, input) => {
		const sel = await selection(ctx, input);
		return {
			count: sel.ids.length,
			sample: await sampleWithEmails(ctx, sel.ids),
			summary: `Archive ${plural(sel.ids.length, 'contact')}`,
			notes: ['Effect: hidden from views and never sent to; history and subscription status are kept. Undo restores them.']
		};
	},
	apply: async (ctx, input) => {
		const sel = await selection(ctx, input);
		const active = await idsWhere(ctx.db, sel.ids, 'archived_at IS NULL');
		const out = await bulkArchive(ctx.db, sel);
		if (!out.ok) throw new ToolInputError(out.error);
		const now = active.length ? await idsWhere(ctx.db, active, 'archived_at IS NOT NULL') : [];
		return {
			summary: out.message,
			before: { active },
			after: { ids: now } satisfies ArchiveState,
			url: contactsUrl(ctx, sel.ids, true),
			result: { archived: out.affected, skipped: out.skipped }
		};
	},
	undo: async (ctx, _before, after) => {
		const a = after as ArchiveState | null;
		if (!a?.ids?.length) return;
		const still = await idsWhere(ctx.db, a.ids, 'archived_at IS NOT NULL');
		if (still.length) await bulkRestore(ctx.db, asSel(still));
	}
};

const restoreContactsTool: WriteTool = {
	name: 'restore_contacts',
	tier: 'write',
	description: 'Restore archived contacts: back in views and sends (subscription status unchanged). Over 25 contacts waits for approval. Undo archives them again.',
	input_schema: { type: 'object', properties: { ...IDS_PROPS } },
	summarize: (input) => `${Array.isArray(input.contact_ids) ? input.contact_ids.length : 1} contact(s)`,
	plan: async (ctx, input) => {
		const sel = await selection(ctx, input);
		// #535: archived contacts are in no dynamic segment, so a restored one can enter a trigger segment.
		const trigger = await restoreTriggerNotes(ctx.db, sel.ids);
		return {
			count: sel.ids.length,
			sample: await sampleWithEmails(ctx, sel.ids),
			summary: `Restore ${plural(sel.ids.length, 'contact')}`,
			notes: ['Effect: back in views, and subscribed ones receive campaigns again. Undo archives them again.', ...trigger],
			...(trigger.length ? { approve: true } : {})
		};
	},
	apply: async (ctx, input) => {
		const sel = await selection(ctx, input);
		const rows = await ctx.db
			.prepare(`SELECT id, archived_at AS at FROM contacts WHERE archived_at IS NOT NULL AND id IN ${IDS} ORDER BY id`)
			.bind(JSON.stringify(sel.ids))
			.all<{ id: number; at: string }>();
		const out = await bulkRestore(ctx.db, sel);
		if (!out.ok) throw new ToolInputError(out.error);
		const was = rows.results.map((r) => r.id);
		const now = was.length ? await idsWhere(ctx.db, was, 'archived_at IS NULL') : [];
		return {
			summary: out.message,
			before: { archived: rows.results } satisfies RestoreBefore,
			after: { ids: now } satisfies ArchiveState,
			url: contactsUrl(ctx, sel.ids),
			result: { restored: out.affected, skipped: out.skipped }
		};
	},
	undo: async (ctx, before, after) => {
		const b = before as RestoreBefore | null;
		const a = after as ArchiveState | null;
		if (!a?.ids?.length || !b?.archived?.length) return;
		const restored = new Set(a.ids);
		const back = b.archived.filter((r) => restored.has(r.id));
		// Archived again with their original archive date (only those still active).
		await ctx.db
			.prepare(
				`UPDATE contacts SET archived_at = (SELECT json_extract(value, '$.at') FROM json_each(?) WHERE json_extract(value, '$.id') = contacts.id)
				 WHERE archived_at IS NULL AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`
			)
			.bind(JSON.stringify(back), JSON.stringify(back))
			.run();
	}
};

// ---- delete ----

const deleteContactsTool: WriteTool = {
	name: 'delete_contacts',
	tier: 'approve',
	description: `Permanently delete contacts (at most ${DELETE_MAX} per call), only when the user explicitly asks to delete — otherwise use archive_contacts. Their unsubscribe records and Postmark suppressions are kept. Always waits for Approve. There is no Undo.`,
	input_schema: { type: 'object', properties: { ...IDS_PROPS } },
	summarize: (input) => `${Array.isArray(input.contact_ids) ? input.contact_ids.length : 1} contact(s)`,
	// #322 addendum: Settings → Assistant → Permissions, off by default. Read fresh on every
	// call and on Approve, so turning it off stops a card that is already waiting.
	gate: async (ctx) => ((await getAssistantConfig(ctx.db)).allowDelete ? null : DELETE_OFF_MESSAGE),
	plan: async (ctx, input) => {
		const sel = await selection(ctx, input, DELETE_MAX);
		return {
			count: sel.ids.length,
			sample: await sampleWithEmails(ctx, sel.ids),
			summary: `Delete ${plural(sel.ids.length, 'contact')} permanently`,
			notes: [
				"Permanent: can't be undone. Consider Archive instead.",
				'Deletes their send history, tracking events, list memberships, automation passes and pipeline cards.',
				'Their unsubscribe records and Postmark suppressions are kept.'
			]
		};
	},
	apply: async (ctx, input) => {
		const sel = await selection(ctx, input, DELETE_MAX);
		const emails = (await ctx.db.prepare(`SELECT email FROM contacts WHERE id IN ${IDS} ORDER BY id`).bind(JSON.stringify(sel.ids)).all<{ email: string }>()).results.map(
			(r) => r.email
		);
		const out = await bulkDelete(ctx.db, sel);
		if (!out.ok) throw new ToolInputError(out.error);
		return {
			summary: out.message,
			before: null,
			after: { deleted: out.affected, emails },
			undoable: false,
			notes: ["Permanent: can't be undone."],
			url: `${ctx.baseUrl}/contacts`,
			result: { deleted: out.affected, skipped: out.skipped }
		};
	},
	undo: async () => {
		throw new UndoRefused("Deleting contacts can't be undone.");
	}
};

// ---- update_contact_tier (#460) ----
// Through the same helper as the automation action, contact page and bulk bar. Over 25
// contacts waits for approval. Undo puts back each contact's previous override (or none) while
// their override is still the one this call wrote.

type TierSnap = { id: number; tier: string | null; until: string | null; source: string | null; at: string | null };
type TierAfter = { ids: number[]; tier: string | null; until: string | null };

function tierInput(input: Record<string, unknown>) {
	const n = normalizeTierOverride({ tier: input.tier, days: input.days });
	if (!n.ok) throw new ToolInputError(n.error);
	return n.value;
}

const updateContactTierTool: WriteTool = {
	name: 'update_contact_tier',
	tier: 'write',
	description:
		'Override contacts\' engagement tier (hot, warm, cool, cold, never, new) until cleared or for `days` (1–365), or `tier: "clear"` to put them back on the automatic tier. The automatic score keeps computing underneath. Over 25 contacts waits for approval. Undo restores the previous override.',
	input_schema: {
		type: 'object',
		properties: {
			...IDS_PROPS,
			tier: { type: 'string', enum: [...TIERS, 'clear'], description: 'The tier to set, or "clear" (back to automatic).' },
			days: { type: 'integer', minimum: 1, maximum: TIER_OVERRIDE_DAYS_MAX, description: 'How long the override lasts. Omit = until cleared.' }
		},
		required: ['tier']
	},
	summarize: (input) => `${String(input.tier ?? '')} · ${Array.isArray(input.contact_ids) ? input.contact_ids.length : 1} contact(s)`,
	plan: async (ctx, input) => {
		const t = tierInput(input);
		const sel = await selection(ctx, input);
		// #535: a trigger segment with an engagement_tier rule.
		const trigger = await contactWriteTriggerNotes(ctx.db, sel.ids, { tier: true });
		return {
			count: sel.ids.length,
			sample: await sampleWithEmails(ctx, sel.ids),
			summary: `${t.tier ? tierActionTitle(t.tier, t.days) : 'Clear the tier override'} for ${plural(sel.ids.length, 'contact')}`,
			notes: [
				'Effect: the engagement tier shown everywhere (filters, segments, Condition steps) changes; the automatic score keeps computing underneath. Undo restores the previous override.',
				...trigger
			],
			...(trigger.length ? { approve: true } : {})
		};
	},
	apply: async (ctx, input) => {
		const t = tierInput(input);
		const sel = await selection(ctx, input);
		const states = await tierOverrideStates(ctx.db, sel.ids);
		const before: TierSnap[] = sel.ids.map((id) => {
			const s = states.get(id);
			return { id, tier: s?.tier_override ?? null, until: s?.tier_override_until ?? null, source: s?.tier_override_source ?? null, at: s?.tier_override_at ?? null };
		});
		const res = await setTierOverride(ctx.db, sel.ids, { ...t, source: `assistant:${ctx.user.github_login}` });
		const changed = new Set(res.changed);
		const n = res.changed.length;
		const skipped = res.unchanged.length;
		const summary = t.tier
			? `Set tier to ${tierLabel(t.tier)}${res.until ? ` until ${res.until.slice(0, 10)}` : ''} for ${plural(n, 'contact')}${skipped ? ` · ${skipped} already set` : ''}`
			: `Back to automatic for ${plural(n, 'contact')}${skipped ? ` · ${skipped} had no override` : ''}`;
		return {
			summary,
			before: before.filter((b) => changed.has(b.id)),
			after: { ids: res.changed, tier: t.tier, until: res.until } satisfies TierAfter,
			url: contactsUrl(ctx, sel.ids),
			result: { changed: n, skipped }
		};
	},
	undo: async (ctx, before, after) => {
		const b = (before as TierSnap[] | null) ?? [];
		const a = after as TierAfter | null;
		if (!a?.ids?.length) return;
		const now = await tierOverrideStates(ctx.db, a.ids);
		const still = b.filter((x) => {
			const s = now.get(x.id);
			return (s?.tier_override ?? null) === a.tier && (s?.tier_override_until ?? null) === a.until;
		});
		if (!still.length) throw new UndoRefused('Those tiers changed since — nothing to undo.');
		for (const x of still) {
			await ctx.db
				.prepare(
					`UPDATE contact_engagement SET tier_override = ?, tier_override_until = ?, tier_override_source = ?, tier_override_at = ? WHERE contact_id = ?`
				)
				.bind(x.tier, x.until, x.source, x.at, x.id)
				.run();
		}
		await computeEngagement(ctx.db, { contactIds: still.map((x) => x.id) });
	}
};

export const contactManageTools: WriteTool[] = [
	createContact,
	unsubscribeContacts,
	resubscribeContacts,
	archiveContactsTool,
	restoreContactsTool,
	deleteContactsTool,
	updateContactTierTool
];
