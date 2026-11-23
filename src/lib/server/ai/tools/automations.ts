// Automations read tools (#287): list, steps, per-step performance, enrollments. Reads
// come from automation-read.ts; this module never imports the engine (automations.ts),
// so there is no enroll / tick / activate path here at all.

import {
	automationStepRows,
	automationStepStats,
	enrollmentCounts,
	listAutomations,
	recentEnrollments
} from '../../automation-read';
import { normalizeLabel } from '../../automation-labels';
import { LIMIT_PROP, ToolInputError, intArg, limitArg, strArg, type Tool, type ToolContext } from './types';

const STATUSES = ['active', 'paused', 'draft'];
const ENROLLMENT_STATUSES = ['active', 'completed', 'cancelled', 'failed'];

async function requireAutomation(ctx: ToolContext, input: Record<string, unknown>) {
	const id = intArg(input, 'automation_id', { required: true, min: 1 })!;
	const a = await ctx.db
		.prepare('SELECT id, name, status, trigger_type, trigger_list_id, reentry, created_at FROM automations WHERE id = ?')
		.bind(id)
		.first<{ id: number; name: string; status: string; trigger_type: string; trigger_list_id: number | null; reentry: string; created_at: string }>();
	if (!a) throw new ToolInputError(`No automation with id ${id}.`);
	return a;
}

const AUTOMATION_ID = { automation_id: { type: 'integer', description: 'Automation id.' } };

export const automationTools: Tool[] = [
	{
		name: 'list_automations',
		tier: 'read',
		description: 'Automations (drip flows) by name: status, trigger, re-entry, step count, active enrollments, labels.',
		input_schema: {
			type: 'object',
			properties: { status: { type: 'string', enum: STATUSES }, label: { type: 'string' } }
		},
		summarize: (input) => [input.status, input.label].filter(Boolean).join(' · ') || 'all automations',
		handler: async (ctx, input) => {
			const status = strArg(input, 'status', 10);
			if (status && !STATUSES.includes(status)) throw new ToolInputError('status must be active, paused or draft.');
			const rows = await listAutomations(ctx.db, { status: status || null, label: normalizeLabel(strArg(input, 'label', 60)) || null });
			return { count: rows.length, automations: rows.map((r) => ({ ...r, url: `${ctx.baseUrl}/automations/${r.id}` })) };
		}
	},
	{
		name: 'get_automation',
		tier: 'read',
		description:
			'One automation: trigger, status, enrollment counts and its steps in order (type, wait, email subject/preheader, tag action, condition, branch lane, action target). Email bodies are trimmed.',
		input_schema: { type: 'object', properties: AUTOMATION_ID, required: ['automation_id'] },
		summarize: (input) => `automation #${input.automation_id}`,
		handler: async (ctx, input) => {
			const a = await requireAutomation(ctx, input);
			const [steps, counts] = await Promise.all([automationStepRows(ctx.db, a.id), enrollmentCounts(ctx.db, a.id)]);
			return {
				...a,
				enrollments: counts,
				steps: steps.map((s) => ({
					id: s.id,
					position: s.position,
					type: s.type,
					wait_seconds: s.delay_before_seconds,
					weekday_only: !!s.weekday_only,
					parent_step_id: s.parent_step_id,
					branch_label: s.branch_label,
					subject: s.type === 'email' ? s.subject : undefined,
					preheader: s.type === 'email' ? s.preheader : undefined,
					from_email: s.type === 'email' ? s.from_email : undefined,
					body: s.type === 'email' ? (s.body_md ?? '').slice(0, 1500) : undefined,
					tag: s.type === 'tag' ? { action: s.tag_action, name: s.tag_name } : undefined,
					tag_on_open: s.tag_on_open,
					tag_on_click: s.tag_on_click,
					condition:
						s.type === 'gate' || s.type === 'branch'
							? { kind: s.gate_kind, name: s.gate_name, value: s.gate_value, ref_id: s.gate_ref_id, split_pct: s.split_pct, rules: s.gate_rules }
							: undefined,
					action:
						s.type === 'action'
							? { kind: s.action_kind, target_automation: s.target_name, target_step_id: s.target_step_id, target_stage_id: s.target_stage_id, tier: s.target_tier, tier_days: s.tier_days }
							: undefined
				})),
				url: `${ctx.baseUrl}/automations/${a.id}`
			};
		}
	},
	{
		name: 'get_automation_performance',
		tier: 'read',
		description: 'Per-step funnel of an automation: contacts waiting at each step, and for email steps sent / unique opens / unique clicks / unsubscribes; branch yes/no counts; action step outcomes.',
		input_schema: { type: 'object', properties: AUTOMATION_ID, required: ['automation_id'] },
		summarize: (input) => `automation #${input.automation_id}`,
		handler: async (ctx, input) => {
			const a = await requireAutomation(ctx, input);
			return { automation_id: a.id, name: a.name, steps: await automationStepStats(ctx.db, a.id) };
		}
	},
	{
		name: 'list_automation_enrollments',
		tier: 'read',
		description: 'Enrollment passes of an automation, active first then newest: contact, status, current step, next run, attempts, last error.',
		input_schema: {
			type: 'object',
			properties: { ...AUTOMATION_ID, status: { type: 'string', enum: ENROLLMENT_STATUSES }, limit: LIMIT_PROP },
			required: ['automation_id']
		},
		summarize: (input) => `automation #${input.automation_id}${input.status ? ` · ${input.status}` : ''}`,
		handler: async (ctx, input) => {
			const a = await requireAutomation(ctx, input);
			const status = strArg(input, 'status', 12);
			if (status && !ENROLLMENT_STATUSES.includes(status)) throw new ToolInputError('Unknown enrollment status.');
			const [counts, rows] = await Promise.all([
				enrollmentCounts(ctx.db, a.id),
				recentEnrollments(ctx.db, a.id, { limit: limitArg(input), status: status || null })
			]);
			return { automation_id: a.id, counts, enrollments: rows };
		}
	}
];
