import { describe, it, expect } from 'vitest';
import { triggerIcon, triggerSummary, type TriggerFields } from '../src/lib/automation-trigger';

const base: TriggerFields = {
	trigger_type: 'manual',
	trigger_list_id: null,
	trigger_metric: null,
	trigger_direction: null,
	trigger_threshold: null,
	trigger_site_id: null,
	trigger_path_op: null,
	trigger_path: null,
	trigger_cooldown_hours: null,
	trigger_stage_id: null,
	reentry: 'once'
};
const ctx = {
	lists: [
		{ id: 1, name: 'Newsletter', kind: 'list' },
		{ id: 2, name: 'opened-launch', kind: 'tag' }
	],
	sites: [{ id: 5, name: 'ourco.example' }],
	stages: [{ id: 9, name: 'Proposal' }]
};

describe('triggerSummary (#220)', () => {
	it('reads each of the five trigger types', () => {
		expect(triggerSummary(base, ctx)).toBe('Manual enrollment · once only');
		expect(triggerSummary({ ...base, trigger_type: 'list_added', trigger_list_id: 2, reentry: 'multiple' }, ctx)).toBe(
			'When added to tag “opened-launch” · multiple times'
		);
		expect(
			triggerSummary({ ...base, trigger_type: 'site_visit', trigger_path_op: 'contains', trigger_path: '/pricing' }, ctx)
		).toBe('Visits a page containing “/pricing” on any site · 24h cooldown · once only');
		expect(triggerSummary({ ...base, trigger_type: 'pipeline_stage_entered', trigger_stage_id: 9 }, ctx)).toBe(
			'Enters pipeline stage “Proposal” · once only'
		);
		expect(
			triggerSummary(
				{ ...base, trigger_type: 'company_metric', trigger_metric: 'hours_30d', trigger_direction: 'above', trigger_threshold: 10 },
				ctx
			)
		).toMatch(/^Company metric .* crosses above 10 · once only$/);
	});

	it('names deleted references instead of widening them', () => {
		expect(triggerSummary({ ...base, trigger_type: 'list_added', trigger_list_id: 77 }, ctx)).toContain('(deleted list)');
		expect(triggerSummary({ ...base, trigger_type: 'site_visit', trigger_site_id: 77, trigger_path: '/x' }, ctx)).toContain(
			'on (deleted site)'
		);
		expect(triggerSummary({ ...base, trigger_type: 'pipeline_stage_entered', trigger_stage_id: 77 }, ctx)).toContain(
			'(deleted stage)'
		);
	});

	it('maps types to #209 glyphs', () => {
		expect(triggerIcon('manual')).toBe('automations');
		expect(triggerIcon('list_added')).toBe('tag');
		expect(triggerIcon('company_metric')).toBe('companies');
		expect(triggerIcon('site_visit')).toBe('site-visit');
		expect(triggerIcon('pipeline_stage_entered')).toBe('pipeline');
	});
});
