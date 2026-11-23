// Reports (#389): the "Describe it" box on /reports/new — its load status and the
// `?/describe` action. The action returns the validated spec for the builder to pre-fill;
// it never saves and never runs the report (the user clicks Run).

import { fail, type RequestEvent } from '@sveltejs/kit';
import { EXAMPLE_PROMPTS } from '$lib/report-nl';
import { getDB } from '$lib/server/db';
import type { AiProvider } from '../ai/provider';
import { loadPickers, reportViewer } from './page';
import { buildReportFromText, postedSpec, reportNlGate, reportNlProvider, type NlOutcome } from './nl';

export type NlStatus = { available: boolean; message: string | null; examples: readonly string[] };

export type DescribeResult = { describe: NlOutcome & { description: string } };

export async function reportNlStatus(event: { locals: App.Locals; platform?: App.Platform }): Promise<NlStatus> {
	const user = event.locals.user;
	const db = event.platform?.env?.DB;
	if (!user || !db) return { available: false, message: 'Sign in required.', examples: EXAMPLE_PROMPTS };
	const gate = await reportNlGate(db, event.platform?.env, user);
	return { available: gate.ok, message: gate.ok ? null : gate.message, examples: EXAMPLE_PROMPTS };
}

export async function describeReportAction(event: RequestEvent, opts: { provider?: AiProvider } = {}) {
	const viewer = reportViewer(event);
	const user = event.locals.user!;
	const db = getDB(event);
	const data = await event.request.formData();
	const description = String(data.get('description') ?? '').trim();
	if (!description) return fail(400, { describeError: 'Describe the report you want.' });

	const gate = await reportNlGate(db, event.platform?.env, user);
	if (!gate.ok) return fail(gate.status, { describeError: gate.message });

	const provider = opts.provider ?? (await reportNlProvider(db, event.platform?.env, gate.model));
	const outcome = await buildReportFromText(db, {
		user: { id: user.id, role: viewer.role },
		description,
		current: postedSpec(data.get('current_spec')),
		threadId: Number(data.get('thread_id')) || null,
		records: await loadPickers(db),
		provider,
		model: gate.model,
		effort: gate.effort
	});
	return { describe: { ...outcome, description } } satisfies DescribeResult;
}
