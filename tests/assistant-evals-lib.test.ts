import { describe, it, expect } from 'vitest';

// #391: the assistant eval runner's pure parts — graders, refs in recordings, summaries,
// the run-to-run diff, the Markdown report and the CLI flags.
import {
	caseProblems,
	diffRuns,
	extractJson,
	filterCases,
	gradeContains,
	gradeJsonSchema,
	gradeRegex,
	gradeRun,
	gradeToolCalls,
	makeRecording,
	markdownReport,
	matchArgs,
	parseDevVars,
	parseJudgeReply,
	parseResultLines,
	parseRunnerArgs,
	resolveFixture,
	resolveRefs,
	RESULT_MARKER,
	shard,
	summarize,
	tokenizeRefs,
	validateSchema
} from '../scripts/assistant-evals-lib.mjs';

const refs = { 'contact.dana': 7, 'list.newsletter': 7, 'campaign.spring': 3 };
const tiers = { search_contacts: 'read', unsubscribe_contacts: 'approve', add_tag: 'write', list_automation_enrollments: 'read' };

function run(over: Record<string, unknown> = {}) {
	return {
		toolCalls: [],
		offered: ['search_contacts', 'unsubscribe_contacts', 'add_tag', 'list_automation_enrollments'],
		tiers,
		text: 'Dana works at Acme Widgets.',
		finalText: 'Dana works at Acme Widgets.',
		stopReason: 'end_turn',
		error: null,
		refs,
		...over
	} as any;
}

const unsubscribe = { name: 'unsubscribe_contacts', input: { contact_ids: [7] }, outcome: 'pending' };

describe('matchArgs', () => {
	it('strings are case-insensitive substrings, numbers exact, arrays contain', () => {
		expect(matchArgs({ filter: { q: 'dana' } }, { filter: { q: 'Dana Reyes' }, limit: 5 })).toBe(true);
		expect(matchArgs({ filter: { q: 'sam' } }, { filter: { q: 'Dana' } })).toBe(false);
		expect(matchArgs({ limit: 5 }, { limit: '5' })).toBe(true);
		expect(matchArgs({ contact_ids: [7] }, { contact_ids: [3, 7] })).toBe(true);
		expect(matchArgs({ contact_ids: [7, 9] }, { contact_ids: [7] })).toBe(false);
	});

	it('refs, $regex, $absent, $falsy, $any', () => {
		expect(matchArgs({ contact_ids: ['$ref:contact.dana'] }, { contact_ids: [7] }, refs)).toBe(true);
		expect(matchArgs('$ref:contact.dana', 8, refs)).toBe(false);
		expect(matchArgs('$ref:contact.nobody', 7, refs)).toBe(false);
		expect(matchArgs({ subject: { $regex: '^spring' } }, { subject: 'Spring is here' })).toBe(true);
		expect(matchArgs({ also: { $absent: true } }, {})).toBe(true);
		expect(matchArgs({ also: { $absent: true } }, { also: true })).toBe(false);
		expect(matchArgs({ also: { $falsy: true } }, { also: false })).toBe(true);
		expect(matchArgs({ also: { $falsy: true } }, { also: true })).toBe(false);
		expect(matchArgs({ x: { $any: true } }, { x: 0 })).toBe(true);
	});
});

describe('tool_calls grader', () => {
	it('required call with args and outcome (Approve)', () => {
		const g = { required: [{ name: 'unsubscribe_contacts', args: { contact_ids: ['$ref:contact.dana'] }, outcome: 'pending' }] };
		expect(gradeToolCalls(g, run({ toolCalls: [unsubscribe] })).pass).toBe(true);
		expect(gradeToolCalls(g, run({ toolCalls: [{ ...unsubscribe, outcome: 'ok' }] })).pass).toBe(false);
		expect(gradeToolCalls(g, run({ toolCalls: [] })).detail).toContain('missing unsubscribe_contacts');
	});

	it('forbidden names / patterns / calls, writes, call counts', () => {
		const calls = [{ name: 'add_tag', input: { tag: 'x' }, outcome: 'ok' }];
		expect(gradeToolCalls({ forbidden: ['add_tag'] }, run({ toolCalls: calls })).pass).toBe(false);
		expect(gradeToolCalls({ forbidden_patterns: ['^send'] }, run({ toolCalls: calls })).pass).toBe(true);
		expect(gradeToolCalls({ forbidden_patterns: ['^add'] }, run({ toolCalls: calls })).pass).toBe(false);
		expect(gradeToolCalls({ forbidden_calls: [{ name: 'add_tag', args: { tag: 'y' } }] }, run({ toolCalls: calls })).pass).toBe(true);
		expect(gradeToolCalls({ forbidden_calls: [{ name: 'add_tag', args: { tag: 'x' } }] }, run({ toolCalls: calls })).pass).toBe(false);
		expect(gradeToolCalls({ no_writes: true }, run({ toolCalls: calls })).pass).toBe(false);
		expect(gradeToolCalls({ no_applied_writes: true }, run({ toolCalls: [unsubscribe] })).pass).toBe(true);
		expect(gradeToolCalls({ no_applied_writes: true }, run({ toolCalls: calls })).pass).toBe(false);
		expect(gradeToolCalls({ no_calls: true }, run({ toolCalls: calls })).pass).toBe(false);
		expect(gradeToolCalls({ max_calls: 1 }, run({ toolCalls: calls })).pass).toBe(true);
		expect(gradeToolCalls({ any_of: [['get_contact', 'add_tag']] }, run({ toolCalls: calls })).pass).toBe(true);
		expect(gradeToolCalls({ any_of: [['get_contact']] }, run({ toolCalls: calls })).pass).toBe(false);
	});

	it('what was offered: includes / excludes / patterns / reads only', () => {
		expect(gradeToolCalls({ offered_includes: ['add_tag'] }, run()).pass).toBe(true);
		expect(gradeToolCalls({ offered_excludes: ['delete_contacts'] }, run()).pass).toBe(true);
		expect(gradeToolCalls({ offered_excludes: ['add_tag'] }, run()).pass).toBe(false);
		// Anchored, so list_automation_enrollments doesn't count as an "enroll" tool.
		expect(gradeToolCalls({ offered_excludes_patterns: ['^enroll', '^send'] }, run()).pass).toBe(true);
		expect(gradeToolCalls({ offered_reads_only: true }, run()).pass).toBe(false);
		expect(gradeToolCalls({ offered_reads_only: true }, run({ offered: ['search_contacts'] })).pass).toBe(true);
	});
});

describe('text graders', () => {
	it('contains all / any / none, case-insensitive by default', () => {
		expect(gradeContains({ all: ['acme widgets'] }, run()).pass).toBe(true);
		expect(gradeContains({ all: ['acme widgets'], case_sensitive: true }, run()).pass).toBe(false);
		expect(gradeContains({ any: ['Globex', 'Acme'] }, run()).pass).toBe(true);
		expect(gradeContains({ none: ['Acme'] }, run()).pass).toBe(false);
	});

	it('regex and negate', () => {
		expect(gradeRegex({ pattern: 'acme\\s+widgets' }, run()).pass).toBe(true);
		expect(gradeRegex({ pattern: 'sk-ant-', negate: true }, run()).pass).toBe(true);
		expect(gradeRegex({ pattern: 'Acme', negate: true }, run()).pass).toBe(false);
	});

	it('json_schema finds JSON in a fence, bare, or inside prose', () => {
		expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ ok: true, value: { a: 1 } });
		expect(extractJson('[1, 2]')).toEqual({ ok: true, value: [1, 2] });
		expect(extractJson('Here you go: {"count": 3} — done')).toEqual({ ok: true, value: { count: 3 } });
		expect(extractJson('no json here').ok).toBe(false);
		const schema = { type: 'object', required: ['count', 'emails'], properties: { count: { type: 'integer', const: 3 }, emails: { type: 'array', minItems: 1, items: { type: 'string', pattern: '@' } } } };
		expect(gradeJsonSchema({ schema }, run({ finalText: '{"count": 3, "emails": ["a@example.com"]}' })).pass).toBe(true);
		const bad = gradeJsonSchema({ schema }, run({ finalText: '{"count": 2, "emails": ["nope"]}' }));
		expect(bad.pass).toBe(false);
		expect(bad.detail).toContain('$.count');
		expect(bad.detail).toContain('$.emails[0]');
		expect(gradeJsonSchema({ schema }, run({ finalText: 'nothing' })).detail).toBe('no JSON found in the answer');
	});

	it('validateSchema: types, enum, bounds, additionalProperties', () => {
		expect(validateSchema({ type: 'number' }, 3)).toEqual([]);
		expect(validateSchema({ type: 'integer' }, 3.5)).toHaveLength(1);
		expect(validateSchema({ enum: ['Lead', 'Proposal'] }, 'Won')).toHaveLength(1);
		expect(validateSchema({ type: 'integer', minimum: 1, maximum: 2 }, 3)).toHaveLength(1);
		expect(validateSchema({ type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2 })).toEqual(['$.b: not allowed']);
		expect(validateSchema({ type: 'string', minLength: 2 }, 'x')).toHaveLength(1);
	});
});

describe('gradeRun', () => {
	const evalCase = {
		id: 'writes.unsub',
		graders: [
			{ kind: 'tool_calls', required: [{ name: 'unsubscribe_contacts', outcome: 'pending' }] },
			{ kind: 'contains', any: ['approve'] },
			{ kind: 'llm_judge', rubric: 'clear' }
		]
	};

	it('all graders, llm_judge skipped without a judge', async () => {
		const g = await gradeRun(run({ toolCalls: [unsubscribe], text: 'Press Approve.' }), evalCase);
		expect(g.pass).toBe(true);
		expect(g.grades.map((x) => x.pass)).toEqual([true, true, null]);
	});

	it('`only` limits the kinds (the CI subset), a judge is called, a run error fails', async () => {
		const only = await gradeRun(run({ toolCalls: [unsubscribe], text: 'nothing' }), evalCase, { only: ['tool_calls'] });
		expect(only.pass).toBe(true);
		expect(only.grades).toHaveLength(1);
		const judged = await gradeRun(run({ toolCalls: [unsubscribe], text: 'approve' }), evalCase, { judge: async () => ({ pass: false, reason: 'vague' }) });
		expect(judged.pass).toBe(false);
		expect(judged.grades[2]).toEqual({ kind: 'llm_judge', pass: false, detail: 'vague' });
		const errored = await gradeRun(run({ toolCalls: [unsubscribe], text: 'approve', error: 'timed out' }), evalCase, { only: ['tool_calls'] });
		expect(errored.pass).toBe(false);
	});

	it('parseJudgeReply', () => {
		expect(parseJudgeReply('{"pass": true, "reason": "fine"}')).toEqual({ pass: true, reason: 'fine' });
		expect(parseJudgeReply('I think yes').pass).toBe(false);
	});
});

describe('cases, fixtures, refs, recordings', () => {
	const good = {
		id: 'reads.x',
		category: 'reads',
		message: 'hi',
		expect: 'an answer',
		fixture: 'crm',
		ci: true,
		graders: [{ kind: 'tool_calls', required: [{ name: 'search_contacts' }] }]
	};

	it('caseProblems', () => {
		const known = new Set(['search_contacts']);
		expect(caseProblems(good, { known, fixtures: { crm: {} } })).toEqual([]);
		expect(caseProblems({ ...good, id: 'writes.x' }, { known })).toEqual(['writes.x: id must start with its category']);
		expect(caseProblems({ ...good, fixture: 'nope' }, { known, fixtures: { crm: {} } })[0]).toContain('unknown fixture');
		expect(caseProblems({ ...good, graders: [{ kind: 'tool_calls', required: [{ name: 'send_now' }] }] }, { known })[0]).toContain('unknown tool "send_now"');
		expect(caseProblems({ ...good, graders: [{ kind: 'contains', any: ['x'] }] }, { known })[0]).toContain('a ci case needs a tool_calls grader');
		expect(caseProblems({ ...good, graders: [{ kind: 'vibes' }] }, { known })[0]).toContain('unknown grader kind');
	});

	it('filterCases by id, category or /regex/', () => {
		const cs = [{ id: 'reads.a', category: 'reads' }, { id: 'writes.b', category: 'writes' }];
		expect(filterCases(cs, 'writes').map((c: any) => c.id)).toEqual(['writes.b']);
		expect(filterCases(cs, 'a,b')).toHaveLength(2);
		expect(filterCases(cs, '/^reads\\./').map((c: any) => c.id)).toEqual(['reads.a']);
		expect(filterCases(cs, undefined)).toHaveLength(2);
	});

	it('resolveFixture merges the base (arrays concatenate, objects merge)', () => {
		const lib = { crm: { contacts: [{ ref: 'a' }], settings: { allowDelete: false, x: 1 } } };
		const merged = resolveFixture({ extends: 'crm', contacts: [{ ref: 'b' }], settings: { allowDelete: true } }, lib);
		expect(merged.contacts.map((c: any) => c.ref)).toEqual(['a', 'b']);
		expect(merged.settings).toEqual({ allowDelete: true, x: 1 });
		expect(resolveFixture('crm', lib)).toEqual(lib.crm);
	});

	it('resolveRefs and tokenizeRefs round-trip per namespace', () => {
		expect(resolveRefs({ contact_ids: ['$ref:contact.dana'], sql: 'id = {{ref:campaign.spring}}' }, refs)).toEqual({ contact_ids: [7], sql: 'id = 3' });
		expect(() => resolveRefs('$ref:contact.nobody', refs)).toThrow('Unknown fixture ref');
		// contact 7 and list 7 share an id: the key decides the namespace.
		expect(tokenizeRefs({ contact_ids: [7], list_id: 7, limit: 7 }, refs)).toEqual({ contact_ids: ['$ref:contact.dana'], list_id: '$ref:list.newsletter', limit: 7 });
	});

	it('makeRecording tokenizes ids, scrubs real addresses, drops thinking text', () => {
		const rec = makeRecording(
			{ id: 'writes.x' },
			[
				{
					content: [
						{ type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
						{ type: 'text', text: 'Mail dana.reyes@acme-widgets.test or someone@gmail.com' },
						{ type: 'tool_use', id: 't1', name: 'add_tag', input: { contact_ids: [7], tag: 'x', note: 'cc jane.doe@gmail.com' } }
					],
					stopReason: 'tool_use'
				}
			],
			refs,
			{ model: 'm', effort: 'medium', now: new Date('2026-10-21T00:00:00Z') }
		);
		expect(rec.responses[0].content).toEqual([
			{ type: 'thinking', thinking: '', signature: 'sig' },
			{ type: 'text', text: 'Mail dana.reyes@acme-widgets.test or redacted@example.com' },
			{ type: 'tool_use', id: 't1', name: 'add_tag', input: { contact_ids: ['$ref:contact.dana'], tag: 'x', note: 'cc redacted@example.com' } }
		]);
		expect(rec).toMatchObject({ case: 'writes.x', source: 'recorded', recorded_at: '2026-10-21T00:00:00.000Z' });
	});
});

describe('results', () => {
	const e = (id: string, pass: boolean, attempt = 1, category = 'reads') => ({ id, category, attempt, pass, grades: pass ? [] : [{ kind: 'contains', pass: false, detail: 'missing "x"' }], costMicros: 1000, latencyMs: 2000, toolCalls: [], text: 'answer' });

	it('summarize: per case (all attempts must pass), flaky, per category, cost', () => {
		const s = summarize([e('reads.a', true), e('reads.a', false, 2), e('reads.b', true), e('writes.c', false, 1, 'writes')]);
		expect(s).toMatchObject({ cases: 3, passed: 1, flaky: 1, runs: 4, runsPassed: 2, costMicros: 4000 });
		expect(s.byCategory).toEqual({ reads: { total: 2, passed: 1 }, writes: { total: 1, passed: 0 } });
	});

	it('diffRuns: new failures, fixes, new cases', () => {
		const prev = [e('reads.a', true), e('reads.b', false)];
		const cur = [e('reads.a', false), e('reads.b', true), e('reads.c', true)];
		expect(diffRuns(prev, cur)).toEqual({ newFailures: ['reads.a'], fixed: ['reads.b'], added: ['reads.c'] });
		expect(diffRuns(null, cur)).toBeNull();
	});

	it('markdownReport: pass rate, category table, failures with transcript, diff', () => {
		const md = markdownReport({
			meta: { started_at: '2026-10-21T00:00:00Z', model: 'claude-sonnet-5-5', effort: 'medium', judge_model: 'claude-opus-5-5', repeat: 1 },
			entries: [e('reads.a', true), e('reads.b', false)],
			diff: { newFailures: ['reads.b'], fixed: [], added: [] },
			cases: [{ id: 'reads.b', message: 'Who?', expect: 'Dana' }]
		});
		expect(md).toContain('**Pass rate: 50.0%** (1/2 cases');
		expect(md).toContain('| reads | 1 | 2 | 50.0% |');
		expect(md).toContain('- New failures: `reads.b`');
		expect(md).toContain('### `reads.b` (attempt 1)');
		expect(md).toContain('> Who?');
		expect(md).toContain('- **contains**: missing "x"');
		expect(md).toContain('```text');
	});
});

describe('runner plumbing', () => {
	it('parseRunnerArgs', () => {
		expect(parseRunnerArgs(['--model', 'claude-haiku-5-5', '--repeat=3', '--record', '--filter', 'reads'])).toEqual({
			model: 'claude-haiku-5-5',
			repeat: '3',
			record: true,
			filter: 'reads'
		});
		expect(() => parseRunnerArgs(['--repeat', '0'])).toThrow('positive');
		expect(() => parseRunnerArgs(['--nope'])).toThrow('Unknown flag');
		expect(() => parseRunnerArgs(['--model'])).toThrow('needs a value');
		expect(() => parseRunnerArgs(['--record', '--replay'])).toThrow();
	});

	it('parseDevVars', () => {
		expect(parseDevVars('# c\nA=1\nB="two"\n\nC = \'3\'\nbad\n')).toEqual({ A: '1', B: 'two', C: '3' });
	});

	it('shard deals items round-robin', () => {
		expect(shard([1, 2, 3, 4, 5], 2)).toEqual([[1, 3, 5], [2, 4]]);
		expect(shard([1], 4)).toEqual([[1]]);
	});

	it('parseResultLines finds marker lines anywhere in the output', () => {
		const out = `stdout | x\n${RESULT_MARKER}{"id":"reads.a","attempt":1}\nnoise\n  ${RESULT_MARKER}{"id":"reads.b"}\n${RESULT_MARKER}{cut`;
		expect(parseResultLines(out)).toEqual([{ id: 'reads.a', attempt: 1 }, { id: 'reads.b' }]);
	});
});
