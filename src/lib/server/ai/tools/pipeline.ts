// Pipeline read tools (#287): the board (stages + cards), one contact's card + history.
// Reads go through pipeline-api.ts (the Data API's read side) — never pipeline.ts writes.

import { apiCards, apiStages, contactPipeline, resolveStage } from '../../pipeline-api';
import { LIMIT_PROP, ToolInputError, intArg, limitArg, strArg, type Tool } from './types';

export const pipelineTools: Tool[] = [
	{
		name: 'get_pipeline_board',
		tier: 'read',
		description:
			'The pipeline: every stage (open/won/lost) with card count and total value, plus one page of cards (contact, value, owner, days in stage), optionally one stage only.',
		input_schema: {
			type: 'object',
			properties: {
				stage: { type: 'string', description: 'Stage id or name (optional).' },
				limit: LIMIT_PROP,
				offset: { type: 'integer', minimum: 0 }
			}
		},
		summarize: (input) => (input.stage ? `stage ${input.stage}` : 'whole board'),
		handler: async (ctx, input) => {
			const ref = strArg(input, 'stage', 100);
			let stageId: number | undefined;
			if (ref) {
				const stage = await resolveStage(ctx.db, /^\d+$/.test(ref) ? { id: ref } : { name: ref });
				if (!stage) throw new ToolInputError(`No pipeline stage "${ref}".`);
				stageId = stage.id;
			}
			const limit = limitArg(input, 50);
			const offset = intArg(input, 'offset', { min: 0 }) ?? 0;
			const [stages, cards] = await Promise.all([apiStages(ctx.db), apiCards(ctx.db, { stageId }, limit, offset)]);
			return { stages, cards_total: cards.total, offset, cards: cards.rows, url: `${ctx.baseUrl}/pipeline` };
		}
	},
	{
		name: 'get_pipeline_card',
		tier: 'read',
		description: "One contact's pipeline card (stage, value, note, owner) and its stage history, newest first. card is null when the contact isn't on the board.",
		input_schema: { type: 'object', properties: { contact_id: { type: 'integer' } }, required: ['contact_id'] },
		summarize: (input) => `contact #${input.contact_id}`,
		handler: async (ctx, input) => {
			const id = intArg(input, 'contact_id', { required: true, min: 1 })!;
			const exists = await ctx.db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first();
			if (!exists) throw new ToolInputError(`No contact with id ${id}.`);
			const { card, history } = await contactPipeline(ctx.db, id);
			return { contact_id: id, card, history: history.slice(0, 50) };
		}
	}
];
