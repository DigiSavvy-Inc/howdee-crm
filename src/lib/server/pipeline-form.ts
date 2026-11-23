// Pipeline (#206) form actions shared by /pipeline and the contact page. Members and admins
// alike can add / move / edit / remove cards; only stage editing is admin-only.
import { fail } from '@sveltejs/kit';
import {
	addToPipeline,
	moveCard,
	parseValue,
	removeFromPipeline,
	stageOfKind,
	updateCard,
	type Actor,
	type CardOpts
} from './pipeline';

export function userActor(locals: App.Locals): Actor {
	return { kind: 'user', id: locals.user?.id ?? null };
}

function intOrNull(v: FormDataEntryValue | null): number | null {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/** Owner field: '' → null (unassigned), a user id → that id. */
function parseOwner(v: FormDataEntryValue | null): number | null | undefined {
	if (v === null) return undefined;
	if (String(v) === '') return null;
	const n = intOrNull(v);
	return n ?? undefined;
}

function cardOpts(data: FormData): CardOpts | string {
	const opts: CardOpts = {};
	if (data.has('value')) {
		const v = parseValue(data.get('value'));
		if (v === undefined) return 'Value must be a whole amount, e.g. 1200.';
		opts.value = v;
	}
	if (data.has('note')) opts.note = String(data.get('note') ?? '').trim() || null;
	if (data.has('owner')) {
		const o = parseOwner(data.get('owner'));
		if (o === undefined) return 'Unknown owner.';
		opts.owner = o;
	}
	return opts;
}

/** Runs one pipeline form action. `contactId` comes from the route (contact page) or the form. */
export async function runPipelineAction(
	db: D1Database,
	locals: App.Locals,
	action: 'add' | 'move' | 'mark' | 'edit' | 'remove',
	data: FormData,
	contactId: number | null = intOrNull(data.get('contact_id'))
) {
	if (!contactId) return fail(400, { pipelineError: 'Pick a contact.' });
	const actor = userActor(locals);

	if (action === 'add') {
		const stageId = intOrNull(data.get('stage_id'));
		if (!stageId) return fail(400, { pipelineError: 'Pick a stage.' });
		const opts = cardOpts(data);
		if (typeof opts === 'string') return fail(400, { pipelineError: opts });
		const r = await addToPipeline(db, contactId, stageId, actor, opts);
		return r.ok ? { pipelineOk: r.created ? 'Added to the pipeline.' : 'Already in the pipeline — moved.' } : fail(400, { pipelineError: r.error });
	}
	if (action === 'move' || action === 'mark') {
		let stageId: number | null;
		if (action === 'mark') {
			const kind = String(data.get('kind') ?? '');
			if (kind !== 'won' && kind !== 'lost') return fail(400, { pipelineError: 'Mark won or lost.' });
			const s = await stageOfKind(db, kind);
			if (!s) return fail(400, { pipelineError: `There's no ${kind} stage — add one under Stages.` });
			stageId = s.id;
		} else {
			stageId = intOrNull(data.get('stage_id'));
		}
		if (!stageId) return fail(400, { pipelineError: 'Pick a stage.' });
		const posRaw = data.get('position');
		const position = posRaw === null || posRaw === '' ? undefined : Number(posRaw);
		const r = await moveCard(db, contactId, stageId, actor, { position });
		return r.ok ? { pipelineOk: 'Moved.' } : fail(400, { pipelineError: r.error });
	}
	if (action === 'edit') {
		const opts = cardOpts(data);
		if (typeof opts === 'string') return fail(400, { pipelineError: opts });
		const r = await updateCard(db, contactId, opts);
		return r.ok ? { pipelineOk: 'Saved.' } : fail(400, { pipelineError: r.error });
	}
	const r = await removeFromPipeline(db, contactId, actor);
	return r.ok ? { pipelineOk: 'Removed from the pipeline.' } : fail(400, { pipelineError: r.error });
}
