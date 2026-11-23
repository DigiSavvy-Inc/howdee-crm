// Pipeline write tools (#301): add a card, move it to a stage, edit value / note / owner.
// Writes go through pipeline.ts as the signed-in user (actor kind 'user', so the history
// reads "by @login") with `triggers: false` — a move by the assistant never fires an
// "Enters a pipeline stage" automation. Removing a card is not a tool; Undo of an add takes
// the card it made back off the board (the history row stays).

import { addToPipeline, moveCard, ownerOptions, parseValue, removeFromPipeline, updateCard, type Actor, type CardOpts } from '../../pipeline';
import { resolveStage } from '../../pipeline-api';
import { contactWriteTriggerNotes } from './trigger-guard';
import { displayName } from './write-contacts';
import { ToolInputError, UndoRefused, intArg, strArg, type ToolContext, type WriteTool } from './types';

type CardState = { contact_id: number; stage_id: number; value: number | null; note: string | null; owner_user_id: number | null };

const actorOf = (ctx: ToolContext): Actor => ({ kind: 'user', id: ctx.user.id });

async function cardState(db: D1Database, contactId: number): Promise<CardState | null> {
	return db
		.prepare('SELECT contact_id, stage_id, value, note, owner_user_id FROM pipeline_cards WHERE contact_id = ?')
		.bind(contactId)
		.first<CardState>();
}

async function contactOf(ctx: ToolContext, input: Record<string, unknown>) {
	const id = intArg(input, 'contact_id', { required: true, min: 1 })!;
	const c = await ctx.db
		.prepare('SELECT id, email, name, first_name, last_name FROM contacts WHERE id = ?')
		.bind(id)
		.first<{ id: number; email: string; name: string | null; first_name: string | null; last_name: string | null }>();
	if (!c) throw new ToolInputError(`No contact with id ${id}.`);
	return { id, who: displayName(c) };
}

async function stageOf(ctx: ToolContext, input: Record<string, unknown>) {
	const ref = strArg(input, 'stage', 100);
	if (!ref) throw new ToolInputError('"stage" (id or name) is required.');
	const stage = await resolveStage(ctx.db, /^\d+$/.test(ref) ? { id: ref } : { name: ref });
	if (!stage) throw new ToolInputError(`No pipeline stage "${ref}". get_pipeline_board lists them.`);
	return stage;
}

async function stageName(db: D1Database, id: number | null): Promise<string | null> {
	if (!id) return null;
	return (await db.prepare('SELECT name FROM pipeline_stages WHERE id = ?').bind(id).first<{ name: string }>())?.name ?? `stage #${id}`;
}

/** value / note / owner from the input, key-present (null clears). */
async function cardOpts(ctx: ToolContext, input: Record<string, unknown>): Promise<CardOpts> {
	const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
	const opts: CardOpts = {};
	if (has('value')) {
		const v = parseValue(input.value);
		if (v === undefined) throw new ToolInputError('"value" must be a whole amount, e.g. 1200.');
		opts.value = v;
	}
	if (has('note')) opts.note = input.note === null ? null : String(input.note).trim().slice(0, 1000) || null;
	if (has('owner')) {
		if (input.owner === null || input.owner === '' || input.owner === 'none') opts.owner = null;
		else {
			const ref = String(input.owner).trim().replace(/^@/, '').toLowerCase();
			const owner = (await ownerOptions(ctx.db)).find((u) => String(u.id) === ref || u.github_login.toLowerCase() === ref);
			if (!owner) throw new ToolInputError(`No active user "${input.owner}" to own the card.`);
			opts.owner = owner.id;
		}
	}
	return opts;
}

function same(a: CardState | null, b: CardState | null): boolean {
	if (!a || !b) return a === b;
	return a.stage_id === b.stage_id && (a.value ?? null) === (b.value ?? null) && (a.note ?? null) === (b.note ?? null) && (a.owner_user_id ?? null) === (b.owner_user_id ?? null);
}

const changedRefusal = (who: string) => new UndoRefused(`${who}'s pipeline card changed since — nothing was undone.`);

const CARD_PROPS = {
	value: { type: ['integer', 'null'], description: 'Deal value in whole units (null clears).' },
	note: { type: ['string', 'null'] },
	owner: { type: ['string', 'integer', 'null'], description: 'Owner: user id or GitHub login (null clears).' }
};

export const pipelineWriteTools: WriteTool[] = [
	{
		name: 'add_pipeline_card',
		tier: 'write',
		description: 'Put a contact on the pipeline board in a stage, optionally with value, note and owner. Fails if they are already on it (use move_pipeline_card). Does not start any automation.',
		input_schema: {
			type: 'object',
			properties: { contact_id: { type: 'integer' }, stage: { type: 'string', description: 'Stage id or name.' }, ...CARD_PROPS },
			required: ['contact_id', 'stage']
		},
		summarize: (input) => `contact #${input.contact_id} → ${input.stage}`,
		plan: async (ctx, input) => {
			const { id, who } = await contactOf(ctx, input);
			const stage = await stageOf(ctx, input);
			await cardOpts(ctx, input);
			if (await cardState(ctx.db, id)) throw new ToolInputError(`${who} is already on the board — use move_pipeline_card.`);
			// #535: a trigger segment with a pipeline_stage rule.
			const notes = await contactWriteTriggerNotes(ctx.db, [id], { pipeline: true });
			return { count: 1, sample: [who], summary: `Add ${who} to the pipeline in ${stage.name}`, ...(notes.length ? { approve: true, notes } : {}) };
		},
		apply: async (ctx, input) => {
			const { id, who } = await contactOf(ctx, input);
			const stage = await stageOf(ctx, input);
			const opts = await cardOpts(ctx, input);
			if (await cardState(ctx.db, id)) throw new ToolInputError(`${who} is already on the board — use move_pipeline_card.`);
			const r = await addToPipeline(ctx.db, id, stage.id, actorOf(ctx), opts, { triggers: false });
			if (!r.ok) throw new ToolInputError(r.error);
			return {
				summary: `Added ${who} to the pipeline in ${stage.name}`,
				before: null,
				after: await cardState(ctx.db, id),
				url: `${ctx.baseUrl}/contacts/${id}`,
				result: { contact_id: id, stage: stage.name }
			};
		},
		undo: async (ctx, _before, after) => {
			const a = after as CardState;
			const now = await cardState(ctx.db, a.contact_id);
			if (!now) return; // already off the board
			if (!same(now, a)) throw changedRefusal(`Contact #${a.contact_id}`);
			await removeFromPipeline(ctx.db, a.contact_id, actorOf(ctx), 'Undone in the assistant');
		}
	},
	{
		name: 'move_pipeline_card',
		tier: 'write',
		description: "Move a contact's pipeline card to another stage (id or name). Does not start any automation.",
		input_schema: { type: 'object', properties: { contact_id: { type: 'integer' }, stage: { type: 'string' } }, required: ['contact_id', 'stage'] },
		summarize: (input) => `contact #${input.contact_id} → ${input.stage}`,
		plan: async (ctx, input) => {
			const { id, who } = await contactOf(ctx, input);
			const stage = await stageOf(ctx, input);
			const card = await cardState(ctx.db, id);
			if (!card) throw new ToolInputError(`${who} is not on the board — use add_pipeline_card.`);
			// #535: a stage change can push the contact into a pipeline_stage trigger segment.
			const notes = card.stage_id === stage.id ? [] : await contactWriteTriggerNotes(ctx.db, [id], { pipeline: true });
			return { count: 1, sample: [who], summary: `Move ${who} to ${stage.name}`, ...(notes.length ? { approve: true, notes } : {}) };
		},
		apply: async (ctx, input) => {
			const { id, who } = await contactOf(ctx, input);
			const stage = await stageOf(ctx, input);
			const before = await cardState(ctx.db, id);
			if (!before) throw new ToolInputError(`${who} is not on the board — use add_pipeline_card.`);
			const r = await moveCard(ctx.db, id, stage.id, actorOf(ctx), { triggers: false });
			if (!r.ok) throw new ToolInputError(r.error);
			const from = await stageName(ctx.db, before.stage_id);
			return {
				summary: r.changed ? `Moved ${who} to ${stage.name}` : `${who} is already in ${stage.name}`,
				before,
				after: await cardState(ctx.db, id),
				changes: r.changed ? [{ field: 'stage', from, to: stage.name }] : [],
				url: `${ctx.baseUrl}/contacts/${id}`,
				result: { contact_id: id, from, to: stage.name }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as CardState;
			const a = after as CardState;
			const now = await cardState(ctx.db, a.contact_id);
			if (!now || now.stage_id !== a.stage_id) throw changedRefusal(`Contact #${a.contact_id}`);
			if (b.stage_id === a.stage_id) return;
			const r = await moveCard(ctx.db, a.contact_id, b.stage_id, actorOf(ctx), { triggers: false, note: 'Undone in the assistant' });
			if (!r.ok) throw new UndoRefused(r.error);
		}
	},
	{
		name: 'update_pipeline_card',
		tier: 'write',
		description: "Edit a contact's pipeline card: value, note and/or owner. Only the keys you pass change; null clears.",
		input_schema: { type: 'object', properties: { contact_id: { type: 'integer' }, ...CARD_PROPS }, required: ['contact_id'] },
		summarize: (input) => `contact #${input.contact_id}`,
		plan: async (ctx, input) => {
			const { id, who } = await contactOf(ctx, input);
			const opts = await cardOpts(ctx, input);
			if (!Object.keys(opts).length) throw new ToolInputError('Nothing to change: give value, note or owner.');
			if (!(await cardState(ctx.db, id))) throw new ToolInputError(`${who} is not on the board.`);
			return { count: 1, sample: [who], summary: `Update ${who}'s pipeline card` };
		},
		apply: async (ctx, input) => {
			const { id, who } = await contactOf(ctx, input);
			const opts = await cardOpts(ctx, input);
			if (!Object.keys(opts).length) throw new ToolInputError('Nothing to change: give value, note or owner.');
			const before = await cardState(ctx.db, id);
			if (!before) throw new ToolInputError(`${who} is not on the board.`);
			const r = await updateCard(ctx.db, id, opts);
			if (!r.ok) throw new ToolInputError(r.error);
			const after = (await cardState(ctx.db, id))!;
			const owners = await ownerOptions(ctx.db);
			const login = (uid: number | null) => (uid ? `@${owners.find((u) => u.id === uid)?.github_login ?? `user #${uid}`}` : null);
			const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
			const changes = [
				{ field: 'value', from: str(before.value), to: str(after.value) },
				{ field: 'note', from: str(before.note), to: str(after.note) },
				{ field: 'owner', from: login(before.owner_user_id), to: login(after.owner_user_id) }
			].filter((ch) => ch.from !== ch.to);
			return {
				summary: changes.length ? `Updated ${who}'s card: ${changes.map((ch) => ch.field).join(', ')}` : `No change to ${who}'s card`,
				before,
				after,
				changes,
				url: `${ctx.baseUrl}/contacts/${id}`,
				result: { contact_id: id }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as CardState;
			const a = after as CardState;
			const now = await cardState(ctx.db, a.contact_id);
			if (!same(now, a)) throw changedRefusal(`Contact #${a.contact_id}`);
			const r = await updateCard(ctx.db, a.contact_id, { value: b.value ?? null, note: b.note ?? null, owner: b.owner_user_id ?? null });
			if (!r.ok) throw new UndoRefused(r.error);
		}
	}
];
