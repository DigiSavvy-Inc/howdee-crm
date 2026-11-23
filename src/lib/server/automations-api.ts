// #347: shared pieces of the automation write endpoints under /api/v1/automations — body
// parsing, the "no status changes" rule, the record every endpoint returns, and the spec
// vocabulary shown by discovery. Every write goes through automation-write.ts with
// `draftOnly`; nothing here (or in the handlers) imports the engine, enroll or send —
// tests/api-v1-automations-write.test.ts walks the import graph to keep it so.

import type { RequestEvent } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { apiError } from '$lib/server/api-v1';
import type { ApiKeyRow } from '$lib/server/api-keys';
import { getSettings } from '$lib/server/settings';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { listLabels } from '$lib/server/automation-labels';
import { automationStepStats, enrollmentCounts } from '$lib/server/automation-read';
import { readSpec, type Actor, type WriteFailure, type WriteOpts } from '$lib/server/automation-write';
import { ACTION_KINDS, GATE_KINDS, STEP_TYPES, TRIGGER_TYPES, type AutomationSpec } from '$lib/automation-spec';
import { AUTOMATION_RULE_FIELDS } from '$lib/condition-rules';

/** Every API edit is draft-only: draft or paused, and a paused flow with contacts mid-flow is
 *  refused (409 `needs_approval`) — that edit is made in the app. */
export const API_WRITE_OPTS: WriteOpts = { draftOnly: true };

export const actorFor = (key: ApiKeyRow): Actor => ({ kind: 'api', id: key.id });

export function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/** Keys that would change a status or enroll anyone. Never accepted in a write body. */
const FORBIDDEN_KEYS = ['status', 'activate', 'enroll'];

/** The JSON object body, or a ready 400 (bad JSON, not an object, a status / enroll key). */
export async function readBody(event: RequestEvent): Promise<{ body: Record<string, unknown> } | { response: Response }> {
	let raw: unknown;
	try {
		raw = await event.request.json();
	} catch {
		return { response: apiError(400, 'Body must be valid JSON.') };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { response: apiError(400, 'Body must be a JSON object.') };
	const body = raw as Record<string, unknown>;
	const bad = FORBIDDEN_KEYS.find((k) => k in body);
	if (bad) {
		return {
			response: apiError(400, `“${bad}” can't be set over the API: activating, pausing and enrolling happen in the app (open editor_url).`)
		};
	}
	return { body };
}

/** A write-layer failure → its JSON error (404 / 409 / 400, plus `problems` for a spec). */
export function failureResponse(f: WriteFailure): Response {
	if (f.needsApproval) {
		return json(
			{ error: `${f.error} Edit it in the app instead.`, needs_approval: true, active_enrollments: f.activeEnrollments ?? 0 },
			{ status: 409 }
		);
	}
	return json(f.problems ? { error: f.error, problems: f.problems } : { error: f.error }, { status: f.status ?? 400 });
}

/** The From an email step gets when it doesn't name one: Settings default From, else POSTMARK_FROM. */
export async function defaultFrom(event: RequestEvent, db: D1Database): Promise<string> {
	const env = event.platform?.env as Record<string, string> | undefined;
	return (await getSettings(db)).default_from || (env?.POSTMARK_FROM ?? '');
}

export const editorUrl = (base: string, id: number) => `${base}/automations/${id}`;

type AutomationRow = { id: number; name: string; status: string; trigger_type: string; reentry: string; created_at: string };
type StepListRow = { id: number; type: string; parent_step_id: number | null; branch_label: string | null; position: number };

/**
 * One automation as the API returns it: the row, labels, `editor_url`, the whole flow as a
 * spec (`readSpec`), a flat `steps` list with the real step ids (what the step endpoints take)
 * and stats (enrollment counts + per-step waiting / sent / opens / clicks / unsubs).
 */
export async function automationRecord(db: D1Database, id: number, base: string) {
	const a = await db
		.prepare('SELECT id, name, status, trigger_type, reentry, created_at FROM automations WHERE id = ?')
		.bind(id)
		.first<AutomationRow>();
	if (!a) return null;
	const spec = await readSpec(db, id);
	const steps = await db
		.prepare('SELECT id, type, parent_step_id, branch_label, position FROM automation_steps WHERE automation_id = ? ORDER BY parent_step_id, branch_label, position')
		.bind(id)
		.all<StepListRow>();
	const stepStats = await automationStepStats(db, id);
	return {
		id: a.id,
		name: a.name,
		status: a.status,
		trigger: a.trigger_type,
		reentry: a.reentry,
		labels: await listLabels(db, id),
		created_at: a.created_at,
		editor_url: editorUrl(base, a.id),
		spec: spec.ok ? spec.data : null,
		steps: steps.results,
		stats: {
			enrollments: await enrollmentCounts(db, id),
			steps: stepStats.map((s) => ({
				step_id: s.step_id,
				waiting: s.waiting,
				sent: s.sent,
				opens: s.opens,
				clicks: s.clicks,
				unsubs: s.unsubs
			}))
		}
	};
}

export const baseUrl = (event: RequestEvent) => publicBaseUrlFor(event);

/** The keys a step body may carry (StepFields). */
export const STEP_FIELD_KEYS = [
	'wait_seconds',
	'weekday_only',
	'subject',
	'from_email',
	'preheader',
	'body_md',
	'body_blocks',
	'tag_on_open',
	'tag_on_click',
	'tag_action',
	'tag_name',
	'condition',
	'action',
	'wait'
];

/** A full example spec: a trigger, a wait, an email, an "opened?" branch and a tag. */
export const EXAMPLE_SPEC: AutomationSpec = {
	name: 'Welcome series',
	trigger: { type: 'list_added', list_id: 12 },
	reentry: 'once',
	labels: ['onboarding'],
	steps: [
		{
			type: 'email',
			ref: 'welcome',
			wait_seconds: 3600,
			subject: 'Welcome, {{first_name}}',
			body_md: 'Thanks for signing up.\n\n[Book a call](https://example.com/book)',
			preheader: 'Here is what happens next'
		},
		{
			type: 'branch',
			wait_seconds: 172800,
			condition: { kind: 'opened', step_ref: 'welcome' },
			yes: [{ type: 'tag', tag_action: 'add', tag_name: 'engaged' }],
			no: [
				{
					type: 'email',
					subject: 'Did you see this?',
					body_md: 'A quick nudge in case the first email got buried.'
				}
			]
		}
	]
};

/** The spec format, for discovery (`GET /api/v1`) — enough for an agent to write a flow. */
export const AUTOMATION_VOCABULARY = {
	spec: 'POST /api/v1/automations and PUT /api/v1/automations/:id/spec take { name, trigger, reentry?, labels?, entry_rules?, steps }. GET /api/v1/automations/:id returns the same shape as `spec`.',
	trigger_types: TRIGGER_TYPES,
	trigger_fields: {
		manual: [],
		list_added: ['list_id'],
		company_metric: ['metric', 'direction (above|below)', 'threshold'],
		site_visit: ['site_id (null = any)', 'path_op (contains|equals|wildcard)', 'path', 'cooldown_hours (null = 24)'],
		pipeline_stage_entered: ['stage_id'],
		// #412: opens / clicks (stored in trigger_config).
		email_opened: [
			'email ("any" | { campaign_id } | { step_id } | in a spec { step_ref })',
			'list_id (null = any list; the contact must be in it)',
			'exclude ([{ campaign_id } | { step_id } | { step_ref }], max 10: "any email except …")',
			'ignore_proxy_opens (default true: Apple Mail / prefetch auto-opens don\'t fire)',
			'once_per_email (default true)'
		],
		email_clicked: [
			'email ("any" | { campaign_id } | { step_id } | in a spec { step_ref })',
			'list_id (null = any list)',
			'link ("any" | { op: contains|equals|starts_with, value })',
			'exclude (emails as above, or { link: { op, value } }; max 10)',
			'once_per_email (default true)'
		],
		// #434: "Visits the site often" (stored in trigger_config).
		site_activity: [
			'measure (pages | visits — a visit is a run of pageviews less than 30 minutes apart)',
			'threshold (1–1000)',
			'days (1–180; site events older than 180 days are deleted)',
			'site_id (null = any)',
			'path_op (contains|equals|wildcard) + path (blank = every page)',
			'cooldown_hours (0–8760, default 168)'
		],
		// #444: "Subscription changes" (stored in trigger_config).
		subscription_changed: [
			'events (non-empty list of unsubscribed | resubscribed | bounced | complained | topic_optout | topic_optin; default ["unsubscribed"])',
			'topic_list_id (topic events only; a list id, null = any topic)',
			'sources (unsubscribed only: list of link | preference_center | manual | api | postmark; [] = any)',
			'Runs for unsubscribed contacts, but an email step ends the pass instead of sending.'
		],
		// #467: "Score changes" (stored in trigger_config) — fires once on a real transition.
		score_changed: [
			'score_id (GET /api/v1/scores)',
			'mode (crosses_above | crosses_below | enters_band | any_change)',
			'threshold (crosses_above / crosses_below: a whole number)',
			'band (enters_band: one of the score’s band labels)'
		],
		// #516: "Form submitted" (stored in trigger_config) — only forms with “Enrol in automations” on.
		form_submitted: [
			'form_id (null = any form)',
			'filter (optional { match: all|any, rules: [{ field: <answer key>, op, value? }] }; op is one of eq | neq | in | contains | gt | gte | lt | lte | empty | not_empty | checked | unchecked)',
			'Anonymous submissions never enrol; a submission waiting on a double opt-in confirmation enrols when the person confirms (never, if they do not).'
		]
	},
	entry_rules: 'Optional on every trigger: { match: all|any, rules: [{ field, op, value?, value2? }] } (the segment / Condition rule shape, no email-step rules). Contacts that don\'t match are not enrolled; null = none.',
	reentry: ['once', 'multiple'],
	step_types: STEP_TYPES,
	step_fields: {
		common: ['wait_seconds (before the step)', 'weekday_only', 'ref (spec only: a local name other steps point at)'],
		email: ['subject', 'from_email (optional: default From)', 'body_md or body_blocks', 'preheader', 'tag_on_open', 'tag_on_click'],
		tag: ['tag_action (add|remove)', 'tag_name'],
		branch: ['condition', 'yes (steps)', 'no (steps)'],
		action: ['action'],
		end: [],
		wait: [
			'wait (use mode delay for a plain timed wait; leave wait_seconds 0 on a wait step)',
			'yes (steps, event mode: it happened; rules mode: they matched)',
			'no (steps, event / rules mode: timed out)'
		]
	},
	// #397: wait-until steps.
	wait_fields: {
		// #625: the default kind — a set period of time.
		delay: ['seconds (60–31536000)', 'weekdays_only? (a Saturday / Sunday result moves to Monday, same time)'],
		event: ['event (opened|clicked — the previous email: needs an email step before the wait|replied|visited)', 'path (visited)', 'timeout_seconds (3600–7776000)'],
		date: ['at (YYYY-MM-DDTHH:MM, operator time)', 'or day (weekday|mon…sun) + time (HH:MM)'],
		window: ['start (HH:MM)', 'end (HH:MM)', 'days (weekdays|every)'],
		// #627: a contact's date custom field.
		field_date: [
			'field (key of a defined custom field of type date)',
			'relation (on|before|after)',
			'offset (1–3650) + unit (hours|days|weeks), before / after only',
			'time (HH:MM, default 09:00, operator time)',
			'if_passed (continue|exit: the date is already past, or the field is empty, when the contact arrives)'
		],
		// #626: until the contact matches the rules (checked every few minutes).
		rules: [
			'rules ({ match: all|any, rules: [{ field, op, value?, value2? }] } — the Condition rule shape, no email-step rules)',
			'timeout_seconds? (3600–7776000; omit = no time limit: waits until they match)'
		]
	},
	condition_kinds: ['rules', ...GATE_KINDS],
	condition_fields: {
		rules: ['match (all|any)', 'rules [{ field, op, value?, value2? }] — segment rule fields plus the automation-only ones'],
		'tag | no-tag | field-exists | field-not-exists': ['name'],
		'field-eq | field-contains | field-not-contains': ['name', 'value'],
		'list-member': ['list_id'],
		'opened | clicked': ['step_ref (spec) or step_id (step endpoints) — an email step'],
		split: ['pct (0–100 to YES)'],
		'company-metric': ['metric', 'op', 'value'],
		visited: ['mode (page|event)', 'name', 'days (0 = ever)'],
		'pipeline-stage': ['mode (in|any|none)', 'stage_id']
	},
	automation_rule_fields: AUTOMATION_RULE_FIELDS.map((f) => f.field),
	action_kinds: ACTION_KINDS,
	action_fields: {
		'enroll_automation | end_automation': ['automation_id'],
		end_all_automations: [],
		goto_step: ['step_ref (spec) or step_id (step endpoints)'],
		pipeline_move: ['stage_id', 'only_from_stage_id?'],
		pipeline_remove: [],
		set_tier: ['tier (hot|warm|cool|cold|never|new, or clear = back to automatic)', 'days? (1–365; omitted = until cleared)'],
		adjust_score: ['score_id', 'points (± whole number, not 0)', 'expires_days? (1–3650; omitted = never)']
	},
	example: EXAMPLE_SPEC
};
