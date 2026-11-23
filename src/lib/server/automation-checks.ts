// #398: pre-activation pre-send checks — Compose's checks (#311: links, placeholders, UTM,
// images, merge tags, the #373 unsubscribe path …) run on every email step of an automation,
// and on variant B of a running A/B test. A step has no list of its own (the trigger decides
// who reaches it), so the audience checks are left out, as in the step drawer (#396). The
// `activate` action refuses while any step has a blocking problem unless the operator ticks
// "Activate anyway" — the same rule as Compose's "Send anyway". Imports nothing that sends.

import { summarize, type ChecksReport } from '$lib/presend-checks';
import { numberedStepTitle, stepNumbers, stepShortTitle } from '$lib/automation-action-labels';
import { runPresendChecks, type PresendDeps } from './presend-checks';
import { storedBlocks, type ComposeBody } from './compose-body';
import { STEP_COLS, type StepRow } from './automation-tree';

export type StepChecks = {
	step_id: number;
	/** "2. Email: Welcome" */
	title: string;
	/** 'b' = variant B of the step's A/B test; null = the step's own email. */
	variant: 'b' | null;
	report: ChecksReport;
};

export type AutomationChecks = { steps: StepChecks[]; blocks: number; warns: number };

async function checkOne(db: D1Database, subject: string, preheader: string, body: ComposeBody, deps: PresendDeps): Promise<ChecksReport> {
	const report = await runPresendChecks(db, { subject, preheader, body, templateId: null, audience: { include: [], exclude: [] } }, deps);
	return summarize(
		report.checks.filter((c) => c.category !== 'audience'),
		report.linksChecked
	);
}

/** Every email step's checks, in canvas order. `deps.checkLinks` adds the live link probe. */
export async function automationPresendChecks(db: D1Database, automationId: number, deps: PresendDeps = {}): Promise<AutomationChecks> {
	const steps = (
		await db.prepare(`SELECT ${STEP_COLS} FROM automation_steps WHERE automation_id = ?`).bind(automationId).all<StepRow>()
	).results;
	const numbers = stepNumbers(steps);
	const emails = steps.filter((s) => s.type === 'email').sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0));
	const out: StepChecks[] = [];
	for (const s of emails) {
		const title = numberedStepTitle(numbers.get(s.id), stepShortTitle(s));
		const body: ComposeBody = { blocks: storedBlocks(s.body_blocks), md: s.body_md ?? '' };
		out.push({ step_id: s.id, title, variant: null, report: await checkOne(db, s.subject ?? '', s.preheader ?? '', body, deps) });
		if (s.ab_enabled && s.ab_subject) {
			const own = (s.ab_body_md ?? '').trim();
			out.push({
				step_id: s.id,
				title,
				variant: 'b',
				report: await checkOne(db, s.ab_subject, (s.ab_preheader ?? '').trim() || (s.preheader ?? ''), own ? { blocks: null, md: own } : body, deps)
			});
		}
	}
	return {
		steps: out,
		blocks: out.reduce((n, s) => n + s.report.blocks, 0),
		warns: out.reduce((n, s) => n + s.report.warns, 0)
	};
}
