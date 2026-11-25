import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB, env, FINISH_SETUP_SENDING, mailToken, sendingUnconfigured } from '$lib/server/db';
import { mailSetup } from '$lib/server/mail';
import { MERGE_TAGS } from '$lib/server/email';
import { enrollContactsInAutomation, restartEnrollment } from '$lib/server/automations';
import { enrollSkipText } from '$lib/server/contact-bulk';
import { enrollSkipReason, enrollSkipRows } from '$lib/server/enroll-reason';
import { enrollFromList, listEnrollPreview } from '$lib/server/automation-enroll';
import { ensureSegmentBaseline, segmentBaselineExists, segmentEligibleCount, segmentTriggerOf } from '$lib/server/segment-trigger';
import { fromAllowed, getSettings } from '$lib/server/settings';
import { allLabelsWithCounts, listLabels } from '$lib/server/automation-labels';
import { activationProblems, deleteAutomations, noteStatusChange, overdueEnrollments, statusChangedAt } from '$lib/server/automation-bulk';
import { listStages } from '$lib/server/pipeline';
import {
	INSPECTOR_PAGE_SIZE,
	automationStepRows,
	automationStepStats,
	enrollPreviewCount,
	enrollmentCounts,
	enrollmentPage
} from '$lib/server/automation-read';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { bodyIsEmpty, readComposeBody } from '$lib/server/compose-body';
import { sendTestEmail } from '$lib/server/test-send';
import { saveStepUndo, takeStepUndo } from '$lib/server/step-undo';
import { isEmail } from '$lib/csv';
import { parseApprovedSenders } from '$lib/approved-senders';
import { normalizeRuleSet, parseGateRules, type ConditionRule, type ConditionRuleSet } from '$lib/condition-rules';
import { triggerEmailNames, triggerEmailOptions, triggerLinkOptions } from '$lib/server/engagement-trigger-read';
import { storedBlocks } from '$lib/server/compose-body';
import {
	cleanDay,
	clearPendingTriggers,
	funnelStats,
	logStatusChanges,
	pendingTriggerCount,
	pendingTriggerIds,
	predecessors,
	statusHistory,
	timelineFor
} from '$lib/server/automation-flow';
import { parseExitRules, parseWait, type WaitSpec } from '$lib/automation-flow';
import { topicRows } from '$lib/server/topics';
import { topicDisplay } from '$lib/topics';
import { automationPresendChecks } from '$lib/server/automation-checks';
import { abTestsFor } from '$lib/server/automation-ab';
import { canSeeBilling } from '$lib/server/integrations/zoho';
import { scorePicker } from '$lib/server/scoring/query';
import { fieldPicker } from '$lib/server/custom-fields';
import { formPicker } from '$lib/server/form-reads';
import { forPicker, ruleListIds } from '$lib/server/group-archive';
// #345: every builder edit goes through the shared write layer (also used by the assistant,
// the API and MCP); this file only parses the drawer's form fields into its input.
import {
	addLabel,
	addStep,
	deleteStep,
	duplicateAutomation,
	duplicateStep,
	moveStep,
	pickVariantWinner,
	removeLabel,
	renameAutomation,
	reorderSteps,
	restoreStepSnapshot,
	setExitRules,
	setReentry,
	setStepVariant,
	setStepWait,
	setEntryRules,
	entryRulesProblem,
	setTrigger,
	stepSnapshot,
	updateStep,
	type Actor
} from '$lib/server/automation-write';
import {
	GATE_KINDS,
	toSeconds,
	type ActionSpec,
	type BranchCondition,
	type StepFields,
	type StepType,
	type TriggerSpec
} from '$lib/automation-spec';

type Automation = {
	id: number;
	name: string;
	status: string;
	trigger_type: string;
	trigger_list_id: number | null;
	trigger_metric: string | null; // #170: company_metric trigger
	trigger_direction: string | null;
	trigger_threshold: number | null;
	trigger_site_id: number | null; // #154: site_visit trigger (NULL = any site)
	trigger_path_op: string | null;
	trigger_path: string | null;
	trigger_cooldown_hours: number | null;
	trigger_stage_id: number | null; // #207: pipeline_stage_entered trigger
	reentry: string; // 'once' | 'multiple'
	topic_list_id: number | null; // #414: the topic every email step belongs to (NULL = none)
	created_at: string;
	exit_rules: string | null; // #397: exit goals (JSON)
	trigger_config: string | null; // #412: email_opened / email_clicked config (JSON)
	entry_rules: string | null; // #412: entry conditions (ConditionRuleSet JSON)
};

/** #472: every group id this automation points at — trigger (column or config), topic, entry
 *  and exit rules, Condition steps — so an archived one stays in the pickers as "(archived)". */
function automationListRefs(
	a: Automation,
	steps: { gate_ref_id: number | null; gate_rules: string | null; wait_config?: string | null }[]
): number[] {
	const out: (number | null)[] = [a.trigger_list_id, a.topic_list_id, ...ruleListIds(a.entry_rules)];
	try {
		const cfg = a.trigger_config ? JSON.parse(a.trigger_config) : null;
		if (cfg && typeof cfg === 'object') out.push(Number(cfg.list_id) || null, Number(cfg.topic_list_id) || null);
	} catch {
		// unreadable config — nothing to keep
	}
	for (const r of parseExitRules(a.exit_rules)) if (r.kind === 'segment') out.push(r.list_id);
	for (const s of steps) {
		out.push(s.gate_ref_id, ...ruleListIds(s.gate_rules));
		// #626: a rules wait's list / topic rules.
		const w = parseWait(s.wait_config ?? null);
		if (w?.mode === 'rules' && w.rules) out.push(...ruleListIds(JSON.stringify(w.rules)));
	}
	return out.filter((n): n is number => typeof n === 'number');
}

async function getAutomation(db: D1Database, id: number): Promise<Automation> {
	const a = await db
		.prepare('SELECT id, name, status, trigger_type, trigger_list_id, trigger_metric, trigger_direction, trigger_threshold, trigger_site_id, trigger_path_op, trigger_path, trigger_cooldown_hours, trigger_stage_id, reentry, topic_list_id, created_at, exit_rules, trigger_config, entry_rules FROM automations WHERE id = ?')
		.bind(id)
		.first<Automation>();
	if (!a) throw error(404, 'Automation not found');
	return a;
}

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const id = Number(event.params.id);
	if (!id) throw error(404, 'Automation not found');

	const automation = await getAutomation(db, id);

	const steps = await automationStepRows(db, id);

	const counts = await enrollmentCounts(db, id);

	const listRows = await db
		.prepare(`SELECT id, name, kind, archived_at, (kind = 'segment' AND rules IS NOT NULL) AS dynamic FROM lists ORDER BY kind, name`)
		.all<{ id: number; name: string; kind: string; archived_at: string | null; dynamic: number }>();
	// #472: archived groups only where this automation already uses them (labelled "(archived)").
	const lists = { results: forPicker(listRows.results, automationListRefs(automation, steps)) };

	// Per-step funnel (#14) + branch yes/no counts.
	const stepStats = await automationStepStats(db, id);

	// #396: the inspector filters + pages in SQL (?insp_q, ?insp_status, ?insp_step, ?insp_page).
	const sp = event.url.searchParams;
	const inspFilter = {
		q: (sp.get('insp_q') ?? '').slice(0, 200),
		status: sp.get('insp_status') ?? '',
		step: Number(sp.get('insp_step')) || null,
		page: Math.max(1, Math.floor(Number(sp.get('insp_page')) || 1))
	};
	const inspector = await enrollmentPage(db, id, {
		q: inspFilter.q,
		status: inspFilter.status,
		stepId: inspFilter.step,
		limit: INSPECTOR_PAGE_SIZE,
		offset: (inspFilter.page - 1) * INSPECTOR_PAGE_SIZE
	});

	// Branch decisions for the enrollments on this inspector page — grouped client-side.
	const branchHits = await db
		.prepare(
			`SELECT bh.step_id, bh.enrollment_id, bh.label, bh.decided_at
			 FROM automation_branch_hits bh
			 WHERE bh.enrollment_id IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(inspector.rows.map((e) => e.id)))
		.all<{ step_id: number; enrollment_id: number; label: string; decided_at: string }>();

	// #397: each inspector pass's full path (appended timeline) with timestamps.
	const timeline = await timelineFor(db, inspector.rows.map((e) => e.id));

	// #397: Performance funnel (reached / exited by goal per step) in the picked date range.
	const perfRange = { from: cleanDay(sp.get('perf_from')), to: cleanDay(sp.get('perf_to')) };
	const funnel = await funnelStats(db, id, perfRange);

	// #396 status strip: the next due step of a live flow.
	const nextRun = await db
		.prepare(`SELECT MIN(next_run_at) AS at FROM automation_enrollments WHERE automation_id = ? AND status = 'active'`)
		.bind(id)
		.first<{ at: string | null }>();
	const settings = await getSettings(db);
	const defaultFrom = settings.default_from || (event.platform?.env?.POSTMARK_FROM ?? '');

	const labels = await listLabels(db, id);
	const allLabels = (await allLabelsWithCounts(db)).map((x) => x.label);

	// #128: action-step target picker — every OTHER automation (self is never a valid
	// target), active ones first so the common case (target something live) sorts to the
	// top, then alphabetical within each group.
	const targetAutomations = await db
		.prepare(
			`SELECT id, name, status FROM automations
			 WHERE id != ?
			 ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, name COLLATE NOCASE`
		)
		.bind(id)
		.all<{ id: number; name: string; status: string }>();

	// #154: "Visits a page" trigger site picker (disabled sites listed too, so a saved
	// choice still shows; the trigger only fires for an enabled site's beacons anyway).
	const trackingSites = await db
		.prepare('SELECT id, name, domain, enabled FROM tracking_sites ORDER BY name COLLATE NOCASE')
		.all<{ id: number; name: string; domain: string; enabled: number }>();

	return {
		automation,
		// #254: blocks parsed + sanitised for the editor (NULL = a markdown step).
		steps: steps.map((s) => ({ ...s, body_blocks: storedBlocks(s.body_blocks) })),
		counts,
		stepStats,
		lists: lists.results,
		// #414: the optional topic picker (public label; a hidden one says so).
		topics: (await topicRows(db)).map((t) => ({ id: t.id, label: topicDisplay(t)?.label ?? `${t.name} (hidden: no label)` })),
		// #467: the score pickers (Condition / entry rules, the score_changed trigger, Adjust score).
		scores: await scorePicker(db, { all: true }),
		customFields: await fieldPicker(db),
		// #516: the form_submitted trigger + the Forms rule kinds (questions for "Answer to a form question").
		forms: await formPicker(db),
		activeEnrollments: counts.active,
		defaultFrom,
		// #396: the step drawer's From picker (the setting Compose's sends are checked against).
		approvedSenders: parseApprovedSenders(settings.approved_senders),
		// #396: where an email step's "Send test" goes — never chosen in the browser.
		testTo: await testRecipient(db, event.locals?.user?.id ?? null, defaultFrom),
		statusSince: automation.status === 'draft' ? automation.created_at : await statusChangedAt(db, id),
		nextRunAt: nextRun?.at ?? null,
		now: new Date().toISOString(),
		mergeTags: MERGE_TAGS,
		enrollments: inspector.rows,
		inspector: { total: inspector.total, pageSize: INSPECTOR_PAGE_SIZE, ...inspFilter },
		branchHits: branchHits.results,
		// #397
		timeline: Object.fromEntries(timeline),
		funnel: { ...funnel, predecessors: Object.fromEntries(predecessors(steps)), range: perfRange },
		exitRules: parseExitRules(automation.exit_rules),
		// #412: titles of the emails the trigger names; the entry conditions.
		triggerEmails: await triggerEmailNames(db, [automation]),
		entryRules: parseGateRules(automation.entry_rules),
		statusHistory: await statusHistory(db, id),
		pendingTriggers: await pendingTriggerCount(db, id),
		// #398: A/B tests on email steps (variant B + per-variant stats), keyed by step id.
		abTests: await abTestsFor(db, id),
		labels,
		allLabels,
		targetAutomations: targetAutomations.results,
		trackingSites: trackingSites.results,
		// #207: stage pickers (trigger, pipeline action step, pipeline-stage condition).
		pipelineStages: (await listStages(db)).map((st) => ({ id: st.id, name: st.name, color: st.color, kind: st.kind })),
		// #221: the Condition rule builder's "Company is …" picker (same cap as /lists/[id]).
		companies: (await db.prepare('SELECT id, name FROM companies ORDER BY name COLLATE NOCASE LIMIT 500').all<{ id: number; name: string }>())
			.results,
		// #445: the Billing company-metric group (trigger, Condition rules) only with billing access.
		billing: await canSeeBilling(db, event.locals?.user ?? null)
	};
};

export const actions: Actions = {
	rename: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const name = String((await event.request.formData()).get('name') ?? '');
		const r = await renameAutomation(db, id, { name }, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		return { ok: true };
	},

	setTrigger: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		// #412: the drawer also posts the entry conditions (Advanced); checked before anything is saved.
		const entry = data.has('entry_rules') ? entryRulesFromForm(data) : undefined;
		if (entry && !entry.ok) return fail(400, { error: entry.error });
		if (entry?.ok) {
			const p = await entryRulesProblem(db, id, entry.set);
			if (p) return fail(400, { error: p });
		}
		const r = await setTrigger(db, id, triggerFromForm(data), actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		if (entry?.ok) {
			const e = await setEntryRules(db, id, { rules: entry.set }, actorOf(event));
			if (!e.ok) return fail(e.status ?? 400, { error: e.error });
		}
		return { ok: true };
	},

	// #412: the engagement trigger's "Select email" options (`q` narrows, ≤ 50) and, for one
	// email, its "Select link" options. Read-only, called by the trigger drawer.
	triggerEmails: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const q = String((await event.request.formData()).get('q') ?? '').slice(0, 200);
		return { triggerEmailOptions: await triggerEmailOptions(db, id, q) };
	},

	triggerLinks: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const campaignId = Number(data.get('campaign_id')) || 0;
		const stepId = Number(data.get('step_id')) || 0;
		const links = campaignId || stepId ? await triggerLinkOptions(db, campaignId ? { campaign_id: campaignId } : { step_id: stepId }) : [];
		return { triggerLinkOptions: links };
	},

	// Re-entry policy: 'once' (any prior pass blocks re-enrollment — the default) or
	// 'multiple' (a contact can re-enter after a pass ends; one active pass at a time).
	setReentry: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const reentry = String((await event.request.formData()).get('reentry') ?? '');
		const r = await setReentry(db, id, { reentry }, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		return { ok: true };
	},

	// #414: the topic every email step belongs to ('' = none). Contacts who opted out of it on
	// the preference page skip the emails; the flow continues.
	setTopic: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const raw = Number((await event.request.formData()).get('topic_list_id') ?? '') || 0;
		const topic = raw
			? await db.prepare("SELECT id FROM lists WHERE id = ? AND kind = 'list' AND public_topic = 1").bind(raw).first<{ id: number }>()
			: null;
		if (raw && !topic) return fail(400, { error: 'That list is not a subscription topic.' });
		const res = await db.prepare('UPDATE automations SET topic_list_id = ? WHERE id = ?').bind(topic?.id ?? null, id).run();
		if (!res.meta.changes) return fail(404, { error: 'Automation not found.' });
		return { ok: true };
	},

	// #395: the full activation check (every step finished and complete, the trigger and every
	// reference still there). Problems come back with step ids so the editor can link to each.
	// Contacts already due (a paused flow) send within minutes of activation, so that needs
	// `confirm=1` — the first post returns the count for the editor's confirm.
	activate: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const automation = await getAutomation(db, id);
		const data = await event.request.formData();
		const confirmed = String(data.get('confirm') ?? '') === '1';
		// #398: "Activate anyway" past blocking pre-send checks (Compose's "Send anyway").
		const checksOk = String(data.get('checks_ok') ?? '') === '1';

		const problems = await activationProblems(db, id);
		if (problems.length) {
			const error = problems.length === 1 ? 'Fix this before activating:' : `Fix these ${problems.length} things before activating:`;
			return fail(400, { error, activationProblems: problems });
		}
		// #398: Compose's pre-send checks on every email step (and variant B of a running A/B
		// test). A block stops activation until the operator confirms; warnings never do.
		if (automation.status !== 'active') {
			const checks = await automationPresendChecks(db, id, { media: event.platform?.env?.MEDIA });
			if (checks.blocks > 0 && !checksOk) {
				const steps = checks.steps
					.filter((st) => st.report.blocks + st.report.warns > 0)
					.map((st) => ({ ...st, report: { ...st.report, checks: st.report.checks.filter((c) => c.level !== 'pass') } }));
				return fail(400, { activateChecks: { steps, blocks: checks.blocks, warns: checks.warns } });
			}
		}
		// #413: a rule-based segment trigger only fires for contacts who enter after activation;
		// the first activation offers to enroll the ones already in it.
		const seg = automation.status !== 'active' ? await segmentTriggerOf(db, id) : null;
		const firstSegment = seg && !(await segmentBaselineExists(db, id, seg.list_id)) ? seg : null;
		if (automation.status !== 'active' && !confirmed) {
			const overdue = await overdueEnrollments(db, id);
			const members = firstSegment ? await segmentEligibleCount(db, firstSegment.rules) : 0;
			if (overdue > 0 || members > 0) {
				// `segment` is only present when there's an offer to make, so the plain overdue
				// confirm keeps its #395 shape.
				const segment: { name: string; members: number } | undefined =
					members > 0 ? { name: firstSegment!.name, members } : undefined;
				const activateConfirm = segment ? { overdue, segment } : { overdue };
				// checksOk rides along so the confirm post keeps "Activate anyway" past the checks.
				return checksOk ? { activateConfirm, checksOk } : { activateConfirm };
			}
		}
		await db.prepare(`UPDATE automations SET status = 'active' WHERE id = ?`).bind(id).run();
		if (automation.status !== 'active') {
			await noteStatusChange(db, [id]);
			await logStatusChanges(db, [{ id, from: automation.status, to: 'active' }], null, event.locals?.user?.id ?? null);
		}
		if (seg) {
			await ensureSegmentBaseline(db, id, seg.list_id, seg.rules);
			if (firstSegment && String(data.get('enroll_existing') ?? '') === '1') {
				const r = await enrollFromList(db, id, seg.list_id);
				if (r.ok) return { ok: true, enrolled: r.enrolled, skipped: r.skipped, queued: r.queued, enrollDone: true };
			}
		}
		return { ok: true };
	},

	// #398: start / edit an A/B test on an email step (variant B), or stop it without a winner.
	setVariant: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const stepId = Number(data.get('step_id'));
		const stop = String(data.get('stop') ?? '') === '1';
		const variant = stop
			? null
			: { subject: String(data.get('ab_subject') ?? ''), preheader: String(data.get('ab_preheader') ?? ''), body_md: String(data.get('ab_body_md') ?? '') };
		const r = await setStepVariant(db, id, { step_id: stepId, variant }, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { abError: r.error, abStep: stepId });
		return { ok: true, abSaved: stepId };
	},

	// #398: end an A/B test with the operator's pick (B winning becomes the step's email).
	pickWinner: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const stepId = Number(data.get('step_id'));
		// pickVariantWinner refuses anything but 'a' / 'b'.
		const winner = String(data.get('winner') ?? '') as 'a' | 'b';
		const r = await pickVariantWinner(db, id, { step_id: stepId, winner }, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { abError: r.error, abStep: stepId });
		return { ok: true, abSaved: stepId };
	},

	// #397: exit conditions (goals) — the editor posts the whole list as JSON.
	setExitRules: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		let rules: unknown = [];
		try {
			rules = JSON.parse(String((await event.request.formData()).get('exit_rules') ?? '[]') || '[]');
		} catch {
			return fail(400, { exitError: 'Those exit rules could not be read.' });
		}
		const r = await setExitRules(db, id, { rules }, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { exitError: r.error });
		return { exitSaved: r.data.count };
	},

	// #397: contacts that triggered while the automation was paused — offered on resume, never
	// automatic. Only while active; without `confirm=1` it returns the count for the confirm.
	enrollPending: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const automation = await getAutomation(db, id);
		if (automation.status !== 'active') return fail(403, { error: 'Resume the automation before enrolling these contacts.' });
		const ids = await pendingTriggerIds(db, id);
		if (String((await event.request.formData()).get('confirm') ?? '') !== '1') {
			const { total, eligible } = await enrollPreviewCount(db, id, ids);
			return { pendingPreview: { total, eligible } };
		}
		// #444: "Subscription changes" contacts are often unsubscribed — let them in like the trigger does.
		const r = await enrollContactsInAutomation(db, id, ids, { allowUnsubscribed: automation.trigger_type === 'subscription_changed' });
		if (!r.ok) return fail(400, { error: r.error });
		await clearPendingTriggers(db, id);
		return { enrolled: r.enrolled, skipped: r.skipped, enrollDone: true, pendingDone: true };
	},

	discardPending: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const n = await clearPendingTriggers(db, id);
		return { pendingDiscarded: n };
	},

	// Free-form labels (#74) — lightweight organisation, not a `lists(kind=...)` grouping.
	addLabel: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const raw = String((await event.request.formData()).get('label') ?? '');
		const result = await addLabel(db, id, { label: raw }, actorOf(event));
		if (!result.ok) return fail(400, { labelError: result.error });
		return { labelOk: true };
	},

	removeLabel: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const label = String((await event.request.formData()).get('label') ?? '');
		await removeLabel(db, id, { label }, actorOf(event));
		return { labelOk: true };
	},

	// #397: an optional reason goes into the status history.
	pause: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const reason = String((await event.request.formData()).get('reason') ?? '').trim();
		const before = await db.prepare('SELECT status FROM automations WHERE id = ?').bind(id).first<{ status: string }>();
		const r = await db.prepare(`UPDATE automations SET status = 'paused' WHERE id = ? AND status != 'paused'`).bind(id).run();
		if (r.meta.changes) {
			await noteStatusChange(db, [id]);
			await logStatusChanges(db, [{ id, from: before?.status ?? null, to: 'paused' }], reason || null, event.locals?.user?.id ?? null);
		}
		return { ok: true };
	},

	delete: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);

		// Shared with the list page's bulkDelete (#164): refuses once anything has gone out
		// (campaign rows reference the automation, no cascade) — pause instead.
		const { skipped } = await deleteAutomations(db, [id]);
		if (skipped.length > 0) {
			return fail(400, {
				error: 'This automation has already sent emails — pause it instead of deleting.'
			});
		}
		throw redirect(303, '/automations');
	},

	// Manually enroll a list/segment's subscribed contacts (#10). #395: refused unless the
	// automation is active (403); without `confirm=1` it only returns the preview. One request
	// enrolls ≤ 2,000 contacts; the rest are queued for the heartbeat (automation-enroll.ts).
	enrollList: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const listId = Number(data.get('list_id'));
		if (!listId) return fail(400, { error: 'Choose a list or segment to enroll.' });

		if (String(data.get('confirm') ?? '') !== '1') {
			const p = await listEnrollPreview(db, id, listId);
			if (!p.ok) return fail(p.status, { error: p.error });
			return { enrollPreview: p };
		}
		const r = await enrollFromList(db, id, listId, { ignoreEntryRules: ignoreEntry(data) });
		if (!r.ok) return fail(r.status, { error: r.error });
		return { enrolled: r.enrolled, skipped: r.skipped, queued: r.queued, enrollDone: true };
	},

	// Enroll hand-picked contacts (#98) — the typeahead picker alongside the
	// list/segment form above. Shares enrollContactsInAutomation with the bulk bars
	// (#97) and the contact detail page, so the active/step-count validation and
	// skip accounting (unsubscribed / already mid-flow) are identical everywhere.
	enrollContacts: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const ids = data
			.getAll('contact_ids')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n) && n > 0);

		// #678: per-contact overrides, same rules as the contact page (#673). `again_ids` = "Enroll
		// again" (once only), `restart_ids` = "Restart from the first step" (a running pass). Each
		// is re-checked here: a flag that doesn't match the contact's real reason is ignored and the
		// contact is enrolled like any other. Never allowUnsubscribed — unsubscribed or archived
		// contacts stay blocked whatever the form says.
		const picked = new Set(ids);
		const flagged = (name: string) =>
			new Set(
				data
					.getAll(name)
					.map((v) => Number(v))
					.filter((n) => picked.has(n))
			);
		const againIds = flagged('again_ids');
		const restartIds = flagged('restart_ids');

		let canRestart = false;
		if (restartIds.size > 0) {
			const auto = await db
				.prepare(
					`SELECT a.status, (SELECT COUNT(*) FROM automation_steps s WHERE s.automation_id = a.id AND s.parent_step_id IS NULL) AS trunk
					 FROM automations a WHERE a.id = ?`
				)
				.bind(id)
				.first<{ status: string; trunk: number }>();
			canRestart = auto?.status === 'active' && (auto.trunk ?? 0) > 0;
		}

		const plain: number[] = [];
		const forcedAgain: number[] = [];
		const forcedRestart: number[] = [];
		for (const cid of picked) {
			if (restartIds.has(cid) && canRestart) {
				const reason = await enrollSkipReason(db, id, cid, { ignoreEntryRules: true, ignoreReentry: true });
				if (reason === 'active') {
					forcedRestart.push(cid);
					continue;
				}
			}
			if (againIds.has(cid)) {
				const reason = await enrollSkipReason(db, id, cid, { ignoreEntryRules: true, ignoreReentry: false });
				if (reason === 'once') {
					forcedAgain.push(cid);
					continue;
				}
			}
			plain.push(cid);
		}

		let enrolled = 0;
		let skipped = 0;
		// #705: each skip reason counted on its own for the result line.
		const skips = { unsubscribed: 0, pending: 0, archived: 0, already: 0, entry: 0 };
		const addSkips = (s: typeof skips) => {
			for (const k of Object.keys(skips) as (keyof typeof skips)[]) skips[k] += s[k];
		};
		if (plain.length > 0 || forcedAgain.length + forcedRestart.length === 0) {
			const result = await enrollContactsInAutomation(db, id, plain, { ignoreEntryRules: ignoreEntry(data) });
			if (!result.ok) return fail(400, { error: result.error });
			enrolled += result.enrolled;
			skipped += result.skipped;
			addSkips(result.skips);
		}
		let restarted = 0;
		if (forcedAgain.length + forcedRestart.length > 0) {
			for (const cid of forcedRestart) if ((await restartEnrollment(db, id, cid)) > 0) restarted++;
			const result = await enrollContactsInAutomation(db, id, [...forcedAgain, ...forcedRestart], {
				ignoreEntryRules: true,
				ignoreReentry: true
			});
			if (!result.ok) return fail(400, { error: result.error });
			enrolled += result.enrolled;
			skipped += result.skipped;
			addSkips(result.skips);
		}
		return { enrolled, restarted, skipped, skipText: enrollSkipText(skips).replace(/^ · /, ''), enrollDone: true };
	},

	// --- Step builder (#9, unlocked by #74) ---------------------------------------
	// The engine pointer is a step ID, so add / duplicate / move / reorder are safe
	// while enrollments are active: an in-flight contact keeps pointing at its step,
	// and "next" resolves from the new order at advance time. Deleting a step is the
	// one structural edit that touches in-flight state — deleteStep re-points its
	// enrollments to the following step (or completes them at the end of the flow).

	addStep: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const rawType = String(data.get('type') ?? 'email');
		const type = (['tag', 'branch', 'action', 'end', 'wait'].includes(rawType) ? rawType : 'email') as StepType;

		// Target sibling group (#76): trunk by default, or inside a branch path when
		// parent_step_id + branch_label are sent. Action steps (#128): the ＋ menu creates a
		// bare step the drawer then configures via ?/updateStep; a posted target is validated.
		const r = await addStep(
			db,
			id,
			{
				type,
				parent_step_id: data.get('parent_step_id') ? Number(data.get('parent_step_id')) : null,
				branch_label: String(data.get('branch_label')) === 'no' ? 'no' : 'yes',
				// #731: Settings default From first; POSTMARK_FROM is optional now.
				from_email: (await getSettings(db)).default_from || (event.platform?.env?.POSTMARK_FROM ?? ''),
				action: type === 'action' ? actionFromForm(data) : undefined
			},
			actorOf(event)
		);
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		// newStepId lets the ＋ menu jump straight into the drawer for a fresh action step
		// (#128) — harmless for the other types, which don't use it.
		return { ok: true, newStepId: r.data.step_id };
	},

	updateStep: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const stepId = Number(data.get('step_id'));

		const step = await db
			.prepare('SELECT id, type FROM automation_steps WHERE id = ? AND automation_id = ?')
			.bind(stepId, id)
			.first<{ id: number; type: string }>();
		if (!step) return fail(404, { error: 'Step not found.' });

		const r = await updateStep(db, id, { step_id: stepId, fields: stepFieldsFromForm(step.type, data) }, actorOf(event));
		if (!r.ok) return r.status === 404 ? fail(404, { error: r.error }) : fail(r.status ?? 400, { error: r.error, stepId });
		return { ok: true, savedStep: stepId };
	},

	// #396: the canvas's inline wait node — the wait only, the step's settings untouched.
	setWait: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const stepId = Number(data.get('step_id'));
		const r = await setStepWait(
			db,
			id,
			{ step_id: stepId, wait_seconds: toSeconds(Number(data.get('delay_value')), String(data.get('delay_unit') ?? 'days')), weekday_only: !!data.get('weekday_only') },
			actorOf(event)
		);
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		return { ok: true, savedWait: stepId };
	},

	duplicateStep: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const stepId = Number((await event.request.formData()).get('step_id'));
		const r = await duplicateStep(db, id, { step_id: stepId }, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		return { ok: true };
	},

	// Duplicate the whole automation as a draft copy (#77) — steps, tree structure, and
	// branch conditions included. Parent/ref ids are remapped to the copied steps.
	duplicate: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		await getAutomation(db, id); // 404 for a missing one
		// #347: shared with POST /api/v1/automations/:id/duplicate.
		const r = await duplicateAutomation(db, id, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		throw redirect(303, `/automations/${r.data.automation_id}`);
	},


	// Deleting a branch step removes its whole subtree (#75); waiting enrollments are
	// re-pointed to the following step (#74) — see deleteStep in automation-write.ts.
	deleteStep: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const stepId = Number((await event.request.formData()).get('step_id'));
		// #396: keep what's about to go so the toast's Undo can put it back.
		const snap = await stepSnapshot(db, id, stepId);
		const r = await deleteStep(db, id, { step_id: stepId }, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		const undoToken = snap ? await saveStepUndo(db, snap) : null;
		return { ok: true, deletedStep: stepId, deletedCount: r.data.deleted.length, undoToken };
	},

	// #396: the delete toast's Undo — re-creates the deleted step (and its lanes) in place.
	restoreStep: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const token = String((await event.request.formData()).get('token') ?? '');
		const snap = await takeStepUndo(db, id, token);
		if (!snap) return fail(400, { error: 'This delete can no longer be undone.' });
		const r = await restoreStepSnapshot(db, id, snap, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		return { ok: true, restoredStep: r.data.step_id };
	},

	// Move within the step's own sibling group (trunk, or one branch path) — position is
	// sibling order in the tree (#75), so cross-group moves are meaningless here.
	moveStep: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const stepId = Number(data.get('step_id'));
		const dir = String(data.get('dir')) === 'up' ? 'up' : 'down';
		const r = await moveStep(db, id, { step_id: stepId, dir }, actorOf(event));
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		return { ok: true };
	},

	// Drag-reorder within one lane: the trunk, or (#396) a branch path when parent_step_id +
	// branch_label are posted — steps never move between lanes (#75/#76).
	reorderSteps: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const raw = String(data.get('order') ?? '');
		const order = raw.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
		const parent = Number(data.get('parent_step_id')) || null;
		const r = await reorderSteps(
			db,
			id,
			{ order, parent_step_id: parent, branch_label: parent ? (String(data.get('branch_label')) === 'no' ? 'no' : 'yes') : null },
			actorOf(event)
		);
		if (!r.ok) return fail(r.status ?? 400, { error: r.error });
		return { ok: true };
	},

	// "This will enroll N contacts" — the Enroll modal's count before its confirm.
	// #395: a list / segment preview goes through listEnrollPreview (refused unless the automation
	// is active and has steps; members / subscribed / already-in / queued detail as `enrollPreview`).
	// #396: hand-picked contacts are counted by enrollPreviewCount (same rules as enroll()).
	// Both return `preview: { total, eligible }` for the modal's one-line count.
	enrollPreview: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const listId = Number(data.get('list_id')) || 0;
		if (listId) {
			const p = await listEnrollPreview(db, id, listId);
			if (!p.ok) return fail(p.status, { error: p.error });
			return { enrollPreview: p, preview: { total: p.members, eligible: p.will_enroll, entry_blocked: p.entry_blocked } };
		}
		const ids = data
			.getAll('contact_ids')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n) && n > 0);
		const { total, eligible, entry_blocked } = await enrollPreviewCount(db, id, ids);
		// #678: one row per skipped hand-picked contact with its reason (contact conditions
		// included, so the reason shows even before "Ignore contact conditions" is ticked).
		const { rows, more } = await enrollSkipRows(db, id, ids);
		return { preview: { total, eligible, entry_blocked, skipped: rows, skipped_more: more } };
	},

	// #396: the email step drawer's "Send test" — the drawer's current (unsaved) content, sent
	// through the same path as Compose's test (unsubscribe link + List-Unsubscribe headers,
	// #373), to the signed-in user only. Members may use it, as they may Compose's test.
	testStep: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const stepId = Number(data.get('step_id'));
		const step = await db
			.prepare("SELECT id FROM automation_steps WHERE id = ? AND automation_id = ? AND type = 'email'")
			.bind(stepId, id)
			.first<{ id: number }>();
		if (!step) return fail(404, { testError: 'Email step not found.', testStepId: stepId });

		const settings = await getSettings(db);
		const to = await testRecipient(db, event.locals?.user?.id ?? null, settings.default_from || (event.platform?.env?.POSTMARK_FROM ?? ''));
		const subject = String(data.get('subject') ?? '').trim();
		const from = String(data.get('from_email') ?? '').trim();
		const body = readComposeBody(data);
		const preheader = String(data.get('preheader') ?? '').trim();
		if (!subject || !from || bodyIsEmpty(body)) {
			return fail(400, { testError: 'Add a subject, from address, and body before testing.', testStepId: stepId });
		}
		if (!isEmail(to)) return fail(400, { testError: 'There is no address to send your test to.', testStepId: stepId });
		if (!fromAllowed(from, settings.approved_senders)) {
			return fail(400, { testError: `From “${from}” isn't an approved Postmark sender (Settings → Approved senders).`, testStepId: stepId });
		}
		const { provider: mail, creds: mailCreds } = await mailSetup(db, event.platform?.env);
		if (sendingUnconfigured(mail, mailCreds)) return fail(409, { testError: FINISH_SETUP_SENDING, testStepId: stepId });
		const sent = await sendTestEmail(
			db,
			{
				provider: mail,
				token: mailToken(event, mailCreds),
				stream: mailCreds.postmark.stream || env(event, 'POSTMARK_STREAM'),
				secret: env(event, 'SESSION_SECRET'),
				baseUrl: await publicBaseUrlFor(event)
			},
			{ from, to, subject, body, preheader }
		);
		if (!sent.ok) return fail(400, { testError: sent.error, testStepId: stepId });
		return { testSuccess: true, testTo: to, testStepId: stepId };
	},

	// --- Enrollment inspector actions (#80) ----------------------------------------

	// #396: every failed pass back to active — the newest per contact, and none for a contact
	// that already has an active pass (one active pass per contact per automation).
	retryAllFailed: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const failed = await db
			.prepare(
				`SELECT e.id, e.contact_id FROM automation_enrollments e
				 WHERE e.automation_id = ? AND e.status = 'failed' AND e.current_step_id IS NOT NULL
				   AND NOT EXISTS (SELECT 1 FROM automation_enrollments o WHERE o.automation_id = e.automation_id AND o.contact_id = e.contact_id AND o.status = 'active')
				 ORDER BY e.id DESC`
			)
			.bind(id)
			.all<{ id: number; contact_id: number }>();
		const seen = new Set<number>();
		const ids: number[] = [];
		for (const f of failed.results) {
			if (seen.has(f.contact_id)) continue;
			seen.add(f.contact_id);
			ids.push(f.id);
		}
		for (let i = 0; i < ids.length; i += 40) {
			const part = ids.slice(i, i + 40);
			await db
				.prepare(
					`UPDATE automation_enrollments SET status = 'active', attempts = 0, next_run_at = datetime('now'), ended_at = NULL
					 WHERE id IN (${part.map(() => '?').join(', ')}) AND status = 'failed'`
				)
				.bind(...part)
				.run();
		}
		const left = await db
			.prepare(`SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? AND status = 'failed'`)
			.bind(id)
			.first<{ n: number }>();
		return { retried: ids.length, stillFailed: left?.n ?? 0 };
	},

	retryEnrollment: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const enrollmentId = Number((await event.request.formData()).get('enrollment_id'));
		if (!enrollmentId) return fail(400, { error: 'Missing enrollment_id.' });

		const enr = await db
			.prepare(`SELECT status, current_step_id, contact_id FROM automation_enrollments WHERE id = ? AND automation_id = ?`)
			.bind(enrollmentId, id)
			.first<{ status: string; current_step_id: number | null; contact_id: number }>();
		if (!enr || enr.status !== 'failed' || enr.current_step_id === null) {
			return fail(400, { error: 'Cannot retry: enrollment must be failed with a step pointer.' });
		}
		// Re-entry ('multiple') can start a NEWER pass while this failed one sits in
		// history — reactivating would then violate ux_enrollments_active (one active
		// pass per contact per automation). Refuse instead of erroring on the index.
		const newer = await db
			.prepare(
				`SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? AND status = 'active' AND id != ?`
			)
			.bind(id, enr.contact_id, enrollmentId)
			.first<{ id: number }>();
		if (newer) {
			return fail(400, { error: 'Cannot retry: this contact already has an active pass through this automation.' });
		}
		await db
			.prepare(`UPDATE automation_enrollments SET status='active', attempts=0, next_run_at=datetime('now'), ended_at=NULL WHERE id=?`)
			.bind(enrollmentId)
			.run();
		return { ok: true };
	},

	cancelEnrollment: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const enrollmentId = Number((await event.request.formData()).get('enrollment_id'));
		if (!enrollmentId) return fail(400, { error: 'Missing enrollment_id.' });

		const enr = await db
			.prepare(`SELECT status FROM automation_enrollments WHERE id = ? AND automation_id = ?`)
			.bind(enrollmentId, id)
			.first<{ status: string }>();
		if (!enr || enr.status !== 'active') {
			return fail(400, { error: 'Cannot cancel: enrollment must be active.' });
		}
		await db
			.prepare(`UPDATE automation_enrollments SET status='cancelled', next_run_at=NULL, ended_at=datetime('now') WHERE id=?`)
			.bind(enrollmentId)
			.run();
		return { ok: true };
	}
};

// --- Form → automation-write input (#345) -------------------------------------------------
// The builder's drawer posts flat form fields; these turn them into the shared write
// layer's typed input. Validation happens there, not here.

function actorOf(event: RequestEvent): Actor {
	return { kind: 'user', id: event.locals?.user?.id ?? null };
}

/** #396: an email step's test goes to the signed-in user's own address (users.email), else to
 *  the operator's default From — the mailbox Compose's test defaults to. Never a posted address. */
async function testRecipient(db: D1Database, userId: number | null, fallback: string): Promise<string> {
	if (userId) {
		const u = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string | null }>();
		if (u?.email) return u.email;
	}
	return fallback;
}

const num = (v: FormDataEntryValue | null) => Number(v) || null;

/** #412: the manual Enroll modal's "Ignore entry conditions" box. */
function ignoreEntry(data: FormData): boolean {
	return String(data.get('ignore_entry') ?? '') === '1';
}

/** #412: the trigger drawer's Advanced → entry conditions (hidden JSON; '' / no rules = none). */
function entryRulesFromForm(data: FormData): { ok: true; set: ConditionRuleSet | null } | { ok: false; error: string } {
	const raw = String(data.get('entry_rules') ?? '').trim();
	if (!raw) return { ok: true, set: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Entry conditions: invalid rules.' };
	}
	const rules = (parsed as { rules?: unknown[] } | null)?.rules;
	if (!Array.isArray(rules) || rules.length === 0) return { ok: true, set: null };
	const set = normalizeRuleSet(parsed);
	return set ? { ok: true, set } : { ok: false, error: 'Entry conditions: invalid rules.' };
}

function triggerFromForm(data: FormData): TriggerSpec {
	const type = String(data.get('trigger_type') ?? 'manual') as TriggerSpec['type'];
	// #412: the engagement kinds post their whole config as JSON (EngagementTriggerFields);
	// #434: so does site_activity (SiteActivityTriggerFields), #444 subscription_changed, #467 score_changed,
	// #516 form_submitted (FormTriggerFields).
	if (
		type === 'email_opened' ||
		type === 'email_clicked' ||
		type === 'site_activity' ||
		type === 'subscription_changed' ||
		type === 'score_changed' ||
		type === 'form_submitted'
	) {
		let cfg: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(String(data.get('trigger_config') ?? '{}'));
			if (parsed && typeof parsed === 'object') cfg = parsed;
		} catch {
			/* falls back to the defaults (any email) */
		}
		return { ...(cfg as Partial<TriggerSpec>), type };
	}
	const rawThreshold = String(data.get('trigger_threshold') ?? '').trim();
	const rawSite = String(data.get('trigger_site_id') ?? '').trim();
	const rawCd = String(data.get('trigger_cooldown_hours') ?? '').trim();
	return {
		type,
		list_id: num(data.get('trigger_list_id')),
		metric: String(data.get('trigger_metric') ?? ''),
		direction: String(data.get('trigger_direction') ?? '') === 'below' ? 'below' : 'above',
		threshold: rawThreshold === '' ? null : Number(rawThreshold),
		site_id: rawSite ? Number(rawSite) : null,
		path_op: String(data.get('trigger_path_op') ?? 'contains'),
		path: String(data.get('trigger_path') ?? ''),
		cooldown_hours: rawCd === '' ? null : Number(rawCd),
		stage_id: num(data.get('trigger_stage_id'))
	};
}

// #128: the drawer's `action_kind` radio + `target_automation_id` <select>. The End radio's
// select carries a sentinel first option, `__all__` ("All other automations") — choosing it
// saves `end_all_automations` (no target). A direct `action_kind=end_all_automations` post
// keeps whatever target came with it, so the write layer rejects it rather than silently
// dropping it. #146: goto_step carries `target_step_id`; #207: pipeline kinds carry stages.
function actionFromForm(data: FormData): ActionSpec {
	const rawKind = String(data.get('action_kind') ?? 'enroll_automation');
	if (rawKind === 'pipeline_move' || rawKind === 'pipeline_remove') {
		return { kind: rawKind, stage_id: num(data.get('target_stage_id')), only_from_stage_id: num(data.get('only_from_stage_id')) };
	}
	if (rawKind === 'goto_step') return { kind: 'goto_step', step_id: num(data.get('target_step_id')) };
	// #460: set_tier carries `target_tier` (a tier or 'clear'); `tier_until=days` + `tier_days`
	// = an override for N days, otherwise until cleared.
	if (rawKind === 'set_tier') {
		const rawDays = String(data.get('tier_days') ?? '').trim();
		const forDays = String(data.get('tier_until') ?? '') === 'days';
		return { kind: 'set_tier', tier: String(data.get('target_tier') ?? ''), days: forDays ? Number(rawDays || 0) : null };
	}
	// #467: adjust_score carries `target_score_id`, `score_delta` and `score_expires_days` (blank = never).
	if (rawKind === 'adjust_score') {
		const rawExp = String(data.get('score_expires_days') ?? '').trim();
		return {
			kind: 'adjust_score',
			score_id: num(data.get('target_score_id')),
			points: Number(String(data.get('score_delta') ?? '').trim().replace('−', '-')) || null,
			expires_days: rawExp === '' ? null : Number(rawExp)
		};
	}
	const rawTarget = String(data.get('target_automation_id') ?? '');
	if (rawKind === 'end_automation' && rawTarget === '__all__') return { kind: 'end_all_automations', automation_id: null };
	const kind: ActionSpec['kind'] =
		rawKind === 'end_all_automations' ? 'end_all_automations' : rawKind === 'end_automation' ? 'end_automation' : 'enroll_automation';
	return { kind, automation_id: Number(rawTarget) || null };
}

function branchFromForm(data: FormData): BranchCondition {
	// #221: the editor posts a rule set (gate_mode=rules); malformed JSON is rejected there.
	if (String(data.get('gate_mode') ?? '') === 'rules') {
		let raw: { match?: 'all' | 'any'; rules?: ConditionRule[] } | null = null;
		try {
			raw = JSON.parse(String(data.get('gate_rules') ?? ''));
		} catch {
			/* malformed → rejected by the write layer */
		}
		return { kind: 'rules', match: raw?.match, rules: raw?.rules };
	}
	const posted = String(data.get('gate_kind') ?? 'tag');
	const kind = ((GATE_KINDS as readonly string[]).includes(posted) ? posted : 'tag') as BranchCondition['kind'];
	if (kind === 'company-metric') {
		return { kind, metric: String(data.get('metric') ?? ''), op: String(data.get('metric_op') ?? ''), value: String(data.get('metric_value') ?? '') };
	}
	if (kind === 'visited') {
		return { kind, mode: String(data.get('visited_mode') ?? ''), name: String(data.get('visited_match') ?? ''), days: String(data.get('visited_days') ?? '') };
	}
	return {
		kind,
		name: String(data.get('gate_name') ?? ''),
		value: String(data.get('gate_value') ?? ''),
		list_id: num(data.get('gate_ref_id')),
		step_id: num(data.get('gate_ref_id')),
		stage_id: num(data.get('gate_ref_id')),
		mode: String(data.get('pipeline_mode') ?? 'in'),
		pct: Number(data.get('split_pct'))
	};
}

// #397: the wait drawer's fields. Validation is the write layer's (normalizeWait).
function waitFromForm(data: FormData): WaitSpec {
	const mode = String(data.get('wait_mode') ?? 'delay') as WaitSpec['mode'];
	// #625: a set period of time (minutes / hours / days / weeks).
	if (mode === 'delay') {
		return {
			mode,
			seconds: toSeconds(Number(data.get('wait_delay_value')), String(data.get('wait_delay_unit') ?? 'days')),
			weekdays_only: !!data.get('wait_weekdays_only')
		};
	}
	if (mode === 'event') {
		return {
			mode,
			event: String(data.get('wait_event') ?? '') as WaitSpec['event'],
			path: String(data.get('wait_path') ?? ''),
			timeout_seconds: toSeconds(Number(data.get('wait_timeout_value')), String(data.get('wait_timeout_unit') ?? 'days'))
		};
	}
	// #626: until the contact matches a rule set; the time limit only when its box is ticked.
	if (mode === 'rules') {
		let rules: unknown = null;
		try {
			rules = JSON.parse(String(data.get('wait_rules') ?? ''));
		} catch {
			rules = null;
		}
		const wait: WaitSpec = { mode, rules: rules as WaitSpec['rules'] };
		if (data.get('wait_limit')) {
			// A ticked limit of 0 is refused by the write layer (0 alone would read as "no limit").
			wait.timeout_seconds = toSeconds(Number(data.get('wait_timeout_value')), String(data.get('wait_timeout_unit') ?? 'days')) || 1;
		}
		return wait;
	}
	if (mode === 'date') {
		return String(data.get('wait_date_kind') ?? 'at') === 'at'
			? { mode, at: String(data.get('wait_at') ?? '') }
			: { mode, day: String(data.get('wait_day') ?? 'weekday') as WaitSpec['day'], time: String(data.get('wait_time') ?? '') };
	}
	if (mode === 'field_date') {
		return {
			mode,
			field: String(data.get('wait_field') ?? ''),
			relation: String(data.get('wait_relation') ?? 'on') as WaitSpec['relation'],
			offset: Number(data.get('wait_offset')),
			unit: String(data.get('wait_offset_unit') ?? 'days') as WaitSpec['unit'],
			time: String(data.get('wait_field_time') ?? ''),
			if_passed: String(data.get('wait_if_passed') ?? 'continue') as WaitSpec['if_passed']
		};
	}
	return {
		mode: 'window',
		start: String(data.get('wait_start') ?? ''),
		end: String(data.get('wait_end') ?? ''),
		days: String(data.get('wait_days') ?? '') === 'every' ? 'every' : 'weekdays'
	};
}

function stepFieldsFromForm(type: string, data: FormData): StepFields {
	const fields: StepFields = {
		wait_seconds: toSeconds(Number(data.get('delay_value')), String(data.get('delay_unit') ?? 'days')),
		weekday_only: !!data.get('weekday_only')
	};
	if (type === 'tag') {
		fields.tag_action = String(data.get('tag_action') ?? '') === 'remove' ? 'remove' : 'add';
		fields.tag_name = String(data.get('tag_name') ?? '');
	} else if (type === 'action') {
		fields.action = actionFromForm(data);
	} else if (type === 'branch') {
		fields.condition = branchFromForm(data);
	} else if (type === 'wait') {
		fields.wait = waitFromForm(data);
	} else {
		// #254: visual-editor blocks (sanitised) win; a plain `body_md` post stores markdown.
		fields.subject = String(data.get('subject') ?? '');
		fields.from_email = String(data.get('from_email') ?? '');
		fields.body_blocks = String(data.get('body_blocks') ?? '');
		fields.body_md = String(data.get('body_md') ?? '');
		fields.preheader = String(data.get('preheader') ?? '');
		// Engagement auto-tags (#42): a name only when its checkbox is on.
		fields.tag_on_open = data.get('tag_on_open_enabled') ? String(data.get('tag_on_open') ?? '') : null;
		fields.tag_on_click = data.get('tag_on_click_enabled') ? String(data.get('tag_on_click') ?? '') : null;
	}
	return fields;
}
