// #207: the "Enters a pipeline stage" automation trigger. Called by pipeline.ts whenever a
// card lands in a stage (added, or moved from another stage) — whoever moved it. Kept out of
// pipeline.ts so that module stays a plain data layer; this one only knows how to enroll.
import { enroll } from './automations';
import { recordPendingTriggers } from './automation-flow';
import type { Actor } from './pipeline';

/** Enroll the contact into every active `pipeline_stage_entered` automation watching
 *  `stageId`. Re-entry policy and "one active pass" apply as usual (enroll()). An
 *  automation never re-triggers itself: a move made by its own action step is skipped,
 *  so "enters Proposal → move to Proposal" can't loop. Returns passes created. #397: a
 *  paused one records the contact instead (offered on resume, never automatic). */
export async function firePipelineStageTriggers(
	db: D1Database,
	contactId: number,
	stageId: number,
	actor: Actor
): Promise<number> {
	const autos = await db
		.prepare(
			`SELECT id, status FROM automations
			 WHERE status IN ('active', 'paused') AND trigger_type = 'pipeline_stage_entered' AND trigger_stage_id = ?`
		)
		.bind(stageId)
		.all<{ id: number; status: string }>();
	let created = 0;
	for (const a of autos.results) {
		if (actor.kind === 'automation' && actor.id === a.id) continue;
		if (a.status === 'paused') {
			await recordPendingTriggers(db, a.id, [contactId], 'pipeline_stage_entered');
			continue;
		}
		created += (await enroll(db, a.id, [contactId])).enrolled;
	}
	return created;
}
