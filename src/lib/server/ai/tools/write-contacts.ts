// Contact write tools (#301): edit fields, add/remove a tag, add to/remove from a list.
// Writes go through contact-write.ts and contact-bulk.ts (the bulk bar's code) with
// `enroll: false` — the assistant never enrolls anyone, so adding a tag or a list here does
// not fire "added to list/tag" automations. More than APPROVE_OVER contacts → Approve first.
// #322: `update_contact` (was update_contact_fields) also changes the email — validated,
// unique, hygiene-checked. Create / unsubscribe / resubscribe / archive / restore / delete
// live in ./write-contact-manage.ts.

import { isEmail } from '$lib/csv';
import { hygieneMeta, hygieneNotes } from '$lib/email-hygiene';
import { bulkAddTag, bulkAddToGroup, bulkRemoveFromGroup, findGroup, resolveSelection } from '../../contact-bulk';
import { applyContactFields, applyContactMeta, validateFieldsBag } from '../../contact-write';
import { checkAddress } from '../../hygiene';
import { snapshot as seoSnapshot } from '../../snapshot';
import { contactWriteTriggerNotes } from './trigger-guard';
import { ToolInputError, UndoRefused, intArg, strArg, type ToolContext, type WriteTool } from './types';

/** Most contacts one write call may touch (a page selection is ≤ 500 too). */
export const WRITE_IDS_MAX = 500;
const IDS = '(SELECT value FROM json_each(?))';

type Group = { id: number; name: string; kind: string; rules: string | null };
type Member = { contact_id: number; added_at: string };

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function contactIdsArg(input: Record<string, unknown>, max = WRITE_IDS_MAX): number[] {
	const raw = Array.isArray(input.contact_ids) ? input.contact_ids : input.contact_id !== undefined && input.contact_id !== null ? [input.contact_id] : [];
	const ids = [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
	if (!ids.length) throw new ToolInputError('Give contact_ids (or contact_id).');
	if (ids.length > max) throw new ToolInputError(`At most ${max} contacts per call.`);
	return ids;
}

async function selection(ctx: ToolContext, input: Record<string, unknown>) {
	const sel = await resolveSelection(ctx.db, { ids: contactIdsArg(input) });
	if (!sel.ok) throw new ToolInputError(sel.error);
	return sel;
}

type NameRow = { id: number; email: string; name: string | null; first_name: string | null; last_name: string | null };

export function displayName(c: NameRow): string {
	return c.name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email;
}

/** A few contacts' names for an approval card. */
export async function sampleNames(ctx: ToolContext, ids: number[], n = 5): Promise<string[]> {
	const rows = await ctx.db
		.prepare(`SELECT id, email, name, first_name, last_name FROM contacts WHERE id IN ${IDS} ORDER BY id LIMIT ?`)
		.bind(JSON.stringify(ids.slice(0, 200)), n)
		.all<NameRow>();
	return rows.results.map(displayName);
}

function plural(n: number, word: string): string {
	return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

async function membersOf(db: D1Database, listId: number, ids: number[]): Promise<Member[]> {
	if (!ids.length) return [];
	const rows = await db
		.prepare(`SELECT contact_id, added_at FROM list_members WHERE list_id = ? AND contact_id IN ${IDS}`)
		.bind(listId, JSON.stringify(ids))
		.all<Member>();
	return rows.results;
}

async function groupById(db: D1Database, id: number): Promise<Group | null> {
	return db.prepare('SELECT id, name, kind, rules FROM lists WHERE id = ?').bind(id).first<Group>();
}

/** By name only (a tag called "2024" is a name, not an id). */
async function groupByName(db: D1Database, name: string, kinds: string[]): Promise<Group | null> {
	if (!name) return null;
	return db
		.prepare(`SELECT id, name, kind, rules FROM lists WHERE name = ? COLLATE NOCASE AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id LIMIT 1`)
		.bind(name, ...kinds)
		.first<Group>();
}

function tagNameArg(input: Record<string, unknown>): string {
	const name = strArg(input, 'tag', 100);
	if (!name) throw new ToolInputError('"tag" (the tag name) is required.');
	if (name.length > 60) throw new ToolInputError('Tag is too long (60 chars max).');
	return name;
}

/** A list or hand-picked segment by `list_id` or `list` (name); dynamic/company refused. */
async function listArg(ctx: ToolContext, input: Record<string, unknown>): Promise<Group> {
	const id = intArg(input, 'list_id', { min: 1 });
	const name = strArg(input, 'list', 100);
	if (!id && !name) throw new ToolInputError('Give list_id or list (the list name).');
	const g = id ? await findGroup(ctx.db, id, ['list', 'segment']) : await groupByName(ctx.db, name, ['list', 'segment']);
	if (!g) throw new ToolInputError(`No list or segment ${id ? `with id ${id}` : `named “${name}”`}. Use list_groups to find it, or create_list.`);
	if (g.kind === 'segment' && (g.rules ?? '').trim()) throw new ToolInputError(`“${g.name}” is a dynamic segment — its members come from its rules, not by hand.`);
	return g;
}

function recordUrl(ctx: ToolContext, ids: number[], groupId: number): string {
	return ids.length === 1 ? `${ctx.baseUrl}/contacts/${ids[0]}` : `${ctx.baseUrl}/lists/${groupId}`;
}

const IDS_PROPS = {
	contact_ids: { type: 'array', items: { type: 'integer' }, description: `Contact ids (max ${WRITE_IDS_MAX}). Use the selected ids from the page context for "these".` },
	contact_id: { type: 'integer', description: 'One contact id (instead of contact_ids).' }
};

// ---- membership undo (shared by tag and list tools) ----

type AddedState = { group_id: number; added: number[] };
type RemovedState = { group_id: number; removed: number[] };
type RemovedBefore = { group_id: number; members: Member[] };

async function undoAdd(ctx: ToolContext, after: unknown, noun: string): Promise<void> {
	const a = after as AddedState | null;
	if (!a?.added?.length) return;
	const group = await groupById(ctx.db, a.group_id);
	if (!group) throw new UndoRefused(`The ${noun} no longer exists, so there is nothing to undo.`);
	const still = await membersOf(ctx.db, group.id, a.added);
	if (still.length !== a.added.length) {
		throw new UndoRefused(`${plural(a.added.length - still.length, 'contact')} left “${group.name}” since — it changed, so nothing was undone.`);
	}
	const out = await bulkRemoveFromGroup(ctx.db, { ok: true, ids: a.added, all: false, missing: 0 }, group);
	if (!out.ok) throw new UndoRefused(out.error);
}

async function undoRemove(ctx: ToolContext, before: unknown, after: unknown): Promise<void> {
	const b = before as RemovedBefore | null;
	const a = after as RemovedState | null;
	if (!b?.members?.length || !a) return;
	const group = await groupById(ctx.db, a.group_id);
	if (!group) throw new UndoRefused('That group no longer exists, so the members can’t be put back.');
	const back = await membersOf(ctx.db, group.id, a.removed);
	if (back.length) throw new UndoRefused(`${plural(back.length, 'contact')} are back in “${group.name}” since — it changed, so nothing was undone.`);
	// Put the rows back as they were (same added_at). No autoEnroll: they were members
	// before, and the assistant never enrolls. Contacts deleted since are skipped.
	await ctx.db
		.prepare(
			`INSERT OR IGNORE INTO list_members (list_id, contact_id, added_at)
			 SELECT ?, json_extract(value, '$.contact_id'), json_extract(value, '$.added_at') FROM json_each(?)
			 WHERE json_extract(value, '$.contact_id') IN (SELECT id FROM contacts)`
		)
		.bind(group.id, JSON.stringify(b.members))
		.run();
}

async function removeMembersOutcome(ctx: ToolContext, input: Record<string, unknown>, group: Group) {
	const sel = await selection(ctx, input);
	const had = await membersOf(ctx.db, group.id, sel.ids);
	const out = await bulkRemoveFromGroup(ctx.db, sel, group);
	if (!out.ok) throw new ToolInputError(out.error);
	return {
		summary: out.message,
		before: { group_id: group.id, members: had } satisfies RemovedBefore,
		after: { group_id: group.id, removed: had.map((m) => m.contact_id) } satisfies RemovedState,
		url: recordUrl(ctx, sel.ids, group.id),
		result: { removed: had.length, not_in_it: sel.ids.length - had.length }
	};
}

// ---- update_contact (#301 update_contact_fields; email since #322) ----

const SCALARS = ['name', 'first_name', 'last_name', 'company'] as const;
type Snapshot = { scalars: Record<string, string | null>; fields: Record<string, unknown> };
type FieldState = Snapshot & { contact_id: number };
type ContactRow = NameRow & { company: string | null; meta: string | null };

/** A trimmed, lowercased email, or a ToolInputError. */
export function emailArg(raw: unknown): string {
	const email = String(raw ?? '').trim().toLowerCase();
	if (!email) throw new ToolInputError('"email" is required.');
	if (email.length > 254 || !isEmail(email)) throw new ToolInputError(`“${email.slice(0, 80)}” is not a valid email address.`);
	return email;
}

/** The contact that already uses this email (other than `exceptId`), or null. */
export async function emailOwner(db: D1Database, email: string, exceptId = 0): Promise<NameRow | null> {
	return db
		.prepare('SELECT id, email, name, first_name, last_name FROM contacts WHERE email = ? AND id != ?')
		.bind(email, exceptId)
		.first<NameRow>();
}

async function assertEmailFree(ctx: ToolContext, email: string, exceptId: number): Promise<void> {
	const owner = await emailOwner(ctx.db, email, exceptId);
	if (owner) throw new ToolInputError(`${email} is already used by ${displayName(owner)} (contact #${owner.id}, ${ctx.baseUrl}/contacts/${owner.id}).`);
}

function fieldEdits(input: Record<string, unknown>): { body: Record<string, string | null>; fields: Record<string, string | number | boolean | null> } {
	if (has(input, 'subscribed')) throw new ToolInputError('Subscription status is not a field: use unsubscribe_contacts or resubscribe_contacts.');
	const body: Record<string, string | null> = {};
	if (has(input, 'email')) body.email = emailArg(input.email);
	for (const k of SCALARS) if (has(input, k)) body[k] = input[k] === null ? null : String(input[k]).trim().slice(0, 200);
	const fields: Record<string, string | number | boolean | null> = {};
	if (has(input, 'phone')) fields.phone = input.phone === null ? null : String(input.phone).trim().slice(0, 50);
	if (has(input, 'custom_fields')) {
		const problem = validateFieldsBag({ fields: input.custom_fields });
		if (problem) throw new ToolInputError(`custom_fields: ${problem}`);
		const entries = Object.entries(input.custom_fields as Record<string, string | number | boolean | null>);
		if (entries.length > 20) throw new ToolInputError('At most 20 custom fields per call.');
		for (const [k, v] of entries) {
			const key = k.trim().slice(0, 50);
			if (key) fields[key] = v;
		}
	}
	if (!Object.keys(body).length && !Object.keys(fields).length) throw new ToolInputError('Nothing to change: give email, name, first_name, last_name, company, phone or custom_fields.');
	return { body, fields };
}

async function contactRow(db: D1Database, id: number): Promise<ContactRow | null> {
	return db.prepare('SELECT id, email, name, first_name, last_name, company, meta FROM contacts WHERE id = ?').bind(id).first<ContactRow>();
}

function snapshotOf(c: ContactRow, scalarKeys: string[], fieldKeys: string[]): Snapshot {
	let meta: Record<string, unknown> = {};
	try {
		meta = c.meta ? JSON.parse(c.meta) : {};
	} catch {
		meta = {};
	}
	const scalars: Record<string, string | null> = {};
	for (const k of scalarKeys) scalars[k] = (c as unknown as Record<string, string | null>)[k] ?? null;
	const fields: Record<string, unknown> = {};
	for (const k of fieldKeys) fields[k] = meta[k] ?? null;
	return { scalars, fields };
}

function shown(v: unknown): string | null {
	return v === null || v === undefined || v === '' ? null : String(v);
}

function sameSnapshot(a: Snapshot, b: Snapshot): string | null {
	for (const k of Object.keys(b.scalars)) if (shown(a.scalars[k]) !== shown(b.scalars[k])) return k;
	for (const k of Object.keys(b.fields)) if (shown(a.fields[k]) !== shown(b.fields[k])) return k;
	return null;
}

async function writeSnapshot(db: D1Database, c: ContactRow, s: Snapshot): Promise<void> {
	if (Object.keys(s.scalars).length) {
		try {
			await applyContactFields(db, c.id, s.scalars, { currentEmail: c.email, enroll: false });
		} catch (e) {
			// The uniqueness pre-check lost a race with another write.
			if (String(e).includes('UNIQUE')) throw new ToolInputError(`${s.scalars.email} is already used by another contact.`);
			throw e;
		}
	}
	if (Object.keys(s.fields).length) await applyContactMeta(db, c.id, s.fields);
}

// ---- the tools ----

function addTool(o: { name: string; kinds: 'tag' | 'list'; description: string }): WriteTool {
	return {
		name: o.name,
		tier: 'write',
		description: o.description,
		input_schema:
			o.kinds === 'tag'
				? { type: 'object', properties: { ...IDS_PROPS, tag: { type: 'string', description: 'Tag name (created if it does not exist).' } }, required: ['tag'] }
				: {
						type: 'object',
						properties: { ...IDS_PROPS, list_id: { type: 'integer', description: 'List or hand-picked segment id.' }, list: { type: 'string', description: 'Or its name.' } }
					},
		summarize: (input) => `${o.kinds === 'tag' ? `tag ${input.tag}` : `list ${input.list_id ?? input.list}`}`,
		plan: async (ctx, input) => {
			const sel = await selection(ctx, input);
			if (o.kinds === 'tag' && seoSnapshot.protectedTag && tagNameArg(input).toLowerCase() === seoSnapshot.protectedTag) {
				throw new ToolInputError(`“${seoSnapshot.protectedTag}” releases a report to the lead, so the assistant can't add it. Approve from the contact page or the review email.`);
			}
			const list = o.kinds === 'list' ? await listArg(ctx, input) : null;
			const target = list ? `“${list.name}”` : `“${tagNameArg(input)}”`;
			const n = plural(sel.ids.length, 'contact');
			const notes = await contactWriteTriggerNotes(ctx.db, sel.ids, list ? { listIds: [list.id] } : { tags: [tagNameArg(input)] });
			return {
				count: sel.ids.length,
				sample: await sampleNames(ctx, sel.ids),
				summary: o.kinds === 'tag' ? `Tag ${n} ${target}` : `Add ${n} to ${target}`,
				...(notes.length ? { approve: true, notes } : {})
			};
		},
		apply: async (ctx, input) => {
			const sel = await selection(ctx, input);
			let group: Group | null;
			let had: number[] = [];
			let created = false;
			let message: string;
			if (o.kinds === 'tag') {
				const name = tagNameArg(input);
				const existing = await groupByName(ctx.db, name, ['tag']);
				if (existing) had = (await membersOf(ctx.db, existing.id, sel.ids)).map((m) => m.contact_id);
				const out = await bulkAddTag(ctx.db, sel, name, { enroll: false });
				if (!out.ok) throw new ToolInputError(out.error);
				message = out.message;
				group = existing ?? (await groupByName(ctx.db, name, ['tag']));
				created = !existing;
			} else {
				group = await listArg(ctx, input);
				had = (await membersOf(ctx.db, group.id, sel.ids)).map((m) => m.contact_id);
				const out = await bulkAddToGroup(ctx.db, sel, group, { enroll: false });
				if (!out.ok) throw new ToolInputError(out.error);
				message = out.message;
			}
			if (!group) throw new ToolInputError('The group could not be created.');
			const hadSet = new Set(had);
			const added = sel.ids.filter((id) => !hadSet.has(id));
			return {
				summary: message,
				before: { group_id: group.id, had, created },
				after: { group_id: group.id, added } satisfies AddedState,
				url: recordUrl(ctx, sel.ids, group.id),
				result: { group_id: group.id, added: added.length, already: had.length, ...(sel.missing ? { not_found: sel.missing } : {}) }
			};
		},
		undo: (ctx, _before, after) => undoAdd(ctx, after, o.kinds)
	};
}

function removeTool(o: { name: string; kinds: 'tag' | 'list'; description: string }): WriteTool {
	const target = async (ctx: ToolContext, input: Record<string, unknown>): Promise<Group> => {
		if (o.kinds === 'list') return listArg(ctx, input);
		const name = tagNameArg(input);
		const g = await groupByName(ctx.db, name, ['tag']);
		if (!g) throw new ToolInputError(`No tag named “${name}”.`);
		return g;
	};
	return {
		name: o.name,
		tier: 'write',
		description: o.description,
		input_schema:
			o.kinds === 'tag'
				? { type: 'object', properties: { ...IDS_PROPS, tag: { type: 'string', description: 'Tag name.' } }, required: ['tag'] }
				: {
						type: 'object',
						properties: { ...IDS_PROPS, list_id: { type: 'integer', description: 'List or hand-picked segment id.' }, list: { type: 'string', description: 'Or its name.' } }
					},
		summarize: (input) => `${o.kinds === 'tag' ? `tag ${input.tag}` : `list ${input.list_id ?? input.list}`}`,
		plan: async (ctx, input) => {
			const sel = await selection(ctx, input);
			const g = await target(ctx, input);
			const n = plural(sel.ids.length, 'contact');
			// #535: removing can push contacts into a "not tagged / not in" trigger segment too.
			const notes = await contactWriteTriggerNotes(ctx.db, sel.ids, { ...(o.kinds === 'tag' ? { tags: [g.name] } : { listIds: [g.id] }), removed: true });
			return {
				count: sel.ids.length,
				sample: await sampleNames(ctx, sel.ids),
				summary: o.kinds === 'tag' ? `Remove tag “${g.name}” from ${n}` : `Remove ${n} from “${g.name}”`,
				...(notes.length ? { approve: true, notes } : {})
			};
		},
		apply: async (ctx, input) => removeMembersOutcome(ctx, input, await target(ctx, input)),
		undo: (ctx, before, after) => undoRemove(ctx, before, after)
	};
}

export const contactWriteTools: WriteTool[] = [
	{
		name: 'update_contact',
		tier: 'write',
		description:
			"Edit one contact's email, name, first_name, last_name, company, phone (stored as the custom field \"phone\") or custom fields. Only the keys you pass change; null or \"\" clears (not email). A new email must be valid and not used by another contact; address-hygiene warnings come back in the result. Subscription status is not a field here: use unsubscribe_contacts / resubscribe_contacts.",
		input_schema: {
			type: 'object',
			properties: {
				contact_id: { type: 'integer' },
				email: { type: 'string', description: 'New email address.' },
				name: { type: ['string', 'null'] },
				first_name: { type: ['string', 'null'] },
				last_name: { type: ['string', 'null'] },
				company: { type: ['string', 'null'], description: 'Company name (links or creates the company).' },
				phone: { type: ['string', 'null'] },
				custom_fields: { type: 'object', description: 'Custom fields to set (null clears one).', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } }
			},
			required: ['contact_id']
		},
		summarize: (input) => `contact #${input.contact_id}`,
		plan: async (ctx, input) => {
			const id = intArg(input, 'contact_id', { required: true, min: 1 })!;
			const { body, fields } = fieldEdits(input);
			const c = await contactRow(ctx.db, id);
			if (!c) throw new ToolInputError(`No contact with id ${id}.`);
			const emailChanges = !!body.email && body.email !== c.email;
			if (emailChanges) await assertEmailFree(ctx, body.email!, id);
			// #535: a field / company a trigger segment reads (a new email also rewrites meta.hygiene,
			// and `spam_complaint` matches unsubscribes by address). Names and phone: no rule reads them.
			const notes = await contactWriteTriggerNotes(ctx.db, [id], {
				fields: [...Object.keys(fields), ...(emailChanges ? ['hygiene'] : [])],
				company: has(body, 'company'),
				email: emailChanges
			});
			return { count: 1, sample: [displayName(c)], summary: `Update ${displayName(c)}`, ...(notes.length ? { approve: true, notes } : {}) };
		},
		apply: async (ctx, input) => {
			const id = intArg(input, 'contact_id', { required: true, min: 1 })!;
			const { body, fields } = fieldEdits(input);
			const c = await contactRow(ctx.db, id);
			if (!c) throw new ToolInputError(`No contact with id ${id}.`);
			let notes: string[] = [];
			if (body.email === c.email) delete body.email;
			else if (body.email) {
				await assertEmailFree(ctx, body.email, id);
				// #306 hygiene on the new address: stored in meta.hygiene (part of the snapshot, so
				// Undo puts the old value back), shown as warnings. Never rejects.
				const h = await checkAddress(body.email, { lookup: ctx.mxLookup });
				fields.hygiene = hygieneMeta(h);
				notes = hygieneNotes(h);
			}
			const scalarKeys = Object.keys(body);
			const fieldKeys = Object.keys(fields);
			const before: FieldState = { contact_id: id, ...snapshotOf(c, scalarKeys, fieldKeys) };
			await writeSnapshot(ctx.db, c, { scalars: body, fields });
			const now = await contactRow(ctx.db, id);
			const after: FieldState = { contact_id: id, ...snapshotOf(now!, scalarKeys, fieldKeys) };
			const changes = [
				...scalarKeys.map((k) => ({ field: k, from: shown(before.scalars[k]), to: shown(after.scalars[k]) })),
				...fieldKeys.map((k) => ({ field: k, from: shown(before.fields[k]), to: shown(after.fields[k]) }))
			].filter((ch) => ch.from !== ch.to && ch.field !== 'hygiene');
			const who = displayName(now!);
			return {
				summary: changes.length ? `Updated ${who}: ${changes.map((ch) => ch.field.replace(/_/g, ' ')).join(', ')}` : `No change to ${who}`,
				before,
				after,
				changes,
				notes,
				url: `${ctx.baseUrl}/contacts/${id}`,
				result: { contact_id: id }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as FieldState;
			const a = after as FieldState;
			const c = await contactRow(ctx.db, a.contact_id);
			if (!c) throw new UndoRefused('That contact no longer exists.');
			const changed = sameSnapshot(snapshotOf(c, Object.keys(a.scalars), Object.keys(a.fields)), a);
			if (changed) throw new UndoRefused(`${displayName(c)}'s ${changed.replace(/_/g, ' ')} changed since — nothing was undone.`);
			const oldEmail = b.scalars.email;
			if (oldEmail && oldEmail !== c.email && (await emailOwner(ctx.db, oldEmail, c.id))) {
				throw new UndoRefused(`${oldEmail} is now used by another contact — nothing was undone.`);
			}
			await writeSnapshot(ctx.db, c, b);
		}
	},
	addTool({
		name: 'add_tag',
		kinds: 'tag',
		description: `Tag one or more contacts (the tag is created if missing). Does not start any automation. Over 25 contacts waits for the user's approval.`
	}),
	removeTool({ name: 'remove_tag', kinds: 'tag', description: 'Remove a tag from one or more contacts. Over 25 contacts waits for approval.' }),
	addTool({
		name: 'add_to_list',
		kinds: 'list',
		description: 'Add contacts to a list or hand-picked segment (not a dynamic segment). Does not start any automation. Over 25 contacts waits for approval.'
	}),
	removeTool({ name: 'remove_from_list', kinds: 'list', description: 'Remove contacts from a list or hand-picked segment. Membership only — contacts stay. Over 25 contacts waits for approval.' })
];
