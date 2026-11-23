// Pure helpers for the assistant eval suite (#391): case validation, graders, recordings
// (ref tokens + redaction), result summaries, the run-to-run diff and the Markdown report.
// No Node imports, so the vitest suite loads it inside workerd (like scripts/dscrm-lib.mjs).
// The runner is scripts/assistant-evals.mjs; the in-workerd harness is evals/harness/.

/** The judge model is pinned so grades don't drift with the assistant's model. */
export const JUDGE_MODEL = 'claude-opus-5-5';
/** Matches the app's defaults (Settings → Assistant), i.e. the prod model config. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT = 'medium';
export const DEFAULT_TIMEOUT_MS = 180_000;
export const RESULT_MARKER = '@@ASSISTANT_EVAL@@';

export const GRADER_KINDS = ['tool_calls', 'contains', 'regex', 'json_schema', 'llm_judge'];
export const OUTCOMES = ['ok', 'error', 'pending', 'not_run'];
export const CATEGORIES = ['reads', 'writes', 'refusals', 'injection', 'skills', 'jobs', 'visibility', 'structured'];

/** Tool-input keys whose numbers are record ids, and the fixture ref namespace they point into. */
export const ID_KEYS = {
	contact_id: 'contact',
	contact_ids: 'contact',
	list_id: 'list',
	group_id: 'list',
	include_list_ids: 'list',
	exclude_list_ids: 'list',
	segment_id: 'list',
	company_id: 'company',
	campaign_id: 'campaign',
	draft_id: 'campaign',
	automation_id: 'automation',
	stage_id: 'stage',
	target_stage_id: 'stage'
};

/**
 * @typedef {{ name: string, input: any, outcome: string, result?: string }} ToolCall
 * @typedef {{ toolCalls: ToolCall[], offered: string[], tiers: Record<string, string>, text: string,
 *   finalText: string, stopReason: string, error?: string | null, refs: Record<string, number>,
 *   message?: string }} RunObservation
 * @typedef {{ kind: string, pass: boolean | null, detail: string }} Grade
 * @typedef {(o: { rubric: string, run: RunObservation, evalCase: any }) => Promise<{ pass: boolean, reason: string }>} Judge
 */

// ---- cases ----

/**
 * Problems with one case (empty = valid). `known` = the tool names that exist, to catch typos.
 * @param {any} c
 * @param {{ known?: Set<string>, fixtures?: Record<string, unknown> }} [o]
 * @returns {string[]}
 */
export function caseProblems(c, o = {}) {
	/** @type {string[]} */
	const out = [];
	const where = c && typeof c.id === 'string' ? c.id : '(no id)';
	const bad = (/** @type {string} */ m) => out.push(`${where}: ${m}`);
	if (!c || typeof c !== 'object') return ['case is not an object'];
	if (typeof c.id !== 'string' || !/^[a-z]+\.[a-z0-9-]+$/.test(c.id)) bad('id must look like "category.kebab-name"');
	if (!CATEGORIES.includes(c.category)) bad(`category must be one of ${CATEGORIES.join(', ')}`);
	else if (typeof c.id === 'string' && !c.id.startsWith(`${c.category}.`)) bad('id must start with its category');
	if (typeof c.message !== 'string' || !c.message.trim()) bad('message is required');
	if (typeof c.expect !== 'string' || !c.expect.trim()) bad('expect (the known-good outcome, in words) is required');
	if (c.user !== undefined && c.user !== 'admin' && c.user !== 'member') bad('user must be admin or member');
	if (c.mode !== undefined && c.mode !== 'chat' && c.mode !== 'job') bad('mode must be chat or job');
	const fx = c.fixture;
	if (typeof fx === 'string') {
		if (o.fixtures && !(fx in o.fixtures)) bad(`unknown fixture "${fx}"`);
	} else if (fx && typeof fx === 'object') {
		if (fx.extends !== undefined && o.fixtures && !(fx.extends in o.fixtures)) bad(`unknown fixture "${fx.extends}"`);
	} else if (fx !== undefined) bad('fixture must be a name or an object');
	if (!Array.isArray(c.graders) || !c.graders.length) bad('at least one grader is required');
	else
		for (const g of c.graders) {
			if (!g || !GRADER_KINDS.includes(g.kind)) {
				bad(`unknown grader kind "${g?.kind}"`);
				continue;
			}
			if (g.kind === 'tool_calls') {
				const names = [
					...[...(g.required ?? []), ...(g.forbidden_calls ?? [])].map((/** @type {any} */ r) => r.name),
					...(g.forbidden ?? []),
					...(g.offered_includes ?? []),
					...(g.offered_excludes ?? []),
					...(g.any_of ?? []).flat()
				];
				for (const n of names) if (o.known && !o.known.has(n)) bad(`tool_calls names an unknown tool "${n}"`);
				for (const r of [...(g.required ?? []), ...(g.forbidden_calls ?? [])]) if (r.outcome !== undefined && !OUTCOMES.includes(r.outcome)) bad(`unknown outcome "${r.outcome}"`);
				for (const p of [...(g.forbidden_patterns ?? []), ...(g.offered_excludes_patterns ?? [])]) {
					try {
						new RegExp(p);
					} catch {
						bad(`bad forbidden_patterns regex ${p}`);
					}
				}
			}
			if (g.kind === 'contains' && !g.all && !g.any && !g.none) bad('contains needs all, any or none');
			if (g.kind === 'regex') {
				try {
					new RegExp(g.pattern, g.flags ?? '');
				} catch {
					bad(`bad regex ${g.pattern}`);
				}
			}
			if (g.kind === 'json_schema' && (!g.schema || typeof g.schema !== 'object')) bad('json_schema needs a schema');
			if (g.kind === 'llm_judge' && (typeof g.rubric !== 'string' || !g.rubric.trim())) bad('llm_judge needs a rubric');
		}
	if (c.ci === true && !(c.graders ?? []).some((/** @type {any} */ g) => g.kind === 'tool_calls')) bad('a ci case needs a tool_calls grader');
	return out;
}

/**
 * Every case from the loaded case files (`{ cases: [...] }` each), in file order.
 * @param {Record<string, any>} files path → parsed JSON
 * @returns {any[]}
 */
export function collectCases(files) {
	return Object.keys(files)
		.sort()
		.flatMap((k) => (Array.isArray(files[k]?.cases) ? files[k].cases : []));
}

/**
 * `--filter`: a comma list of terms, each a substring of the id or category, or /regex/.
 * @param {any[]} cases
 * @param {string | undefined} filter
 */
export function filterCases(cases, filter) {
	if (!filter) return cases;
	const terms = filter.split(',').map((t) => t.trim()).filter(Boolean);
	return cases.filter((c) =>
		terms.some((t) => {
			if (t.length > 2 && t.startsWith('/') && t.endsWith('/')) return new RegExp(t.slice(1, -1)).test(c.id);
			return c.id.includes(t) || c.category === t;
		})
	);
}

/**
 * Merge a case fixture with the named base it extends: arrays concatenate (base first),
 * objects merge (case wins).
 * @param {any} fixture
 * @param {Record<string, any>} library
 * @returns {Record<string, any>}
 */
export function resolveFixture(fixture, library) {
	if (!fixture) return {};
	if (typeof fixture === 'string') return resolveFixture(library[fixture] ?? {}, library);
	const { extends: base, ...own } = fixture;
	const merged = base ? { ...resolveFixture(base, library) } : {};
	for (const [k, v] of Object.entries(own)) {
		const prev = merged[k];
		if (Array.isArray(prev) && Array.isArray(v)) merged[k] = [...prev, ...v];
		else if (prev && typeof prev === 'object' && v && typeof v === 'object' && !Array.isArray(v)) merged[k] = { ...prev, ...v };
		else merged[k] = v;
	}
	return merged;
}

// ---- refs ----

/**
 * Replace "$ref:<name>" strings (and "{{ref:<name>}}" inside strings) with fixture ids.
 * @param {any} value
 * @param {Record<string, number>} refs
 * @returns {any}
 */
export function resolveRefs(value, refs) {
	if (typeof value === 'string') {
		if (value.startsWith('$ref:')) {
			const id = refs[value.slice(5)];
			if (id === undefined) throw new Error(`Unknown fixture ref ${value}`);
			return id;
		}
		return value.replace(/\{\{ref:([a-z0-9._-]+)\}\}/gi, (_m, name) => {
			if (refs[name] === undefined) throw new Error(`Unknown fixture ref ${name}`);
			return String(refs[name]);
		});
	}
	if (Array.isArray(value)) return value.map((v) => resolveRefs(v, refs));
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, refs)]));
	return value;
}

/**
 * The reverse, for recordings: an id under an id-ish key (ID_KEYS) that is a fixture ref of
 * that namespace becomes "$ref:<name>", so a recording survives id changes (a new seed row).
 * @param {any} value
 * @param {Record<string, number>} refs
 * @param {string | null} [ns]
 * @returns {any}
 */
export function tokenizeRefs(value, refs, ns = null) {
	if (typeof value === 'number' && ns) {
		const hit = Object.keys(refs).find((name) => name.startsWith(`${ns}.`) && refs[name] === value);
		return hit ? `$ref:${hit}` : value;
	}
	if (Array.isArray(value)) return value.map((v) => tokenizeRefs(v, refs, ns));
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, tokenizeRefs(v, refs, /** @type {Record<string, string>} */ (ID_KEYS)[k] ?? null)])
		);
	return value;
}

const RESERVED_EMAIL = /@([a-z0-9-]+\.)*(example\.(com|org|net)|[a-z0-9-]+\.(test|example|invalid))$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** True for an address on a reserved test domain (RFC 2606 / 6761). @param {string} email */
export function isReservedEmail(email) {
	return RESERVED_EMAIL.test(email);
}

/**
 * Recording content blocks with every non-reserved email address replaced, refs tokenized in
 * tool inputs, and thinking text dropped (signatures are kept — the API needs them back).
 * @param {any[]} content
 * @param {Record<string, number>} refs
 */
export function recordContent(content, refs) {
	/** @param {string} s */
	const scrub = (s) => s.replace(EMAIL_RE, (m) => (isReservedEmail(m) ? m : 'redacted@example.com'));
	return content.map((b) => {
		if (b.type === 'text') return { type: 'text', text: scrub(b.text) };
		if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: JSON.parse(scrub(JSON.stringify(tokenizeRefs(b.input, refs)))) };
		if (b.type === 'thinking') return { type: 'thinking', thinking: '', signature: b.signature };
		return b;
	});
}

/**
 * @param {any} evalCase
 * @param {{ content: any[], stopReason: string | null }[]} responses
 * @param {Record<string, number>} refs
 * @param {{ model: string, effort: string | null, now?: Date }} meta
 */
export function makeRecording(evalCase, responses, refs, meta) {
	return {
		case: evalCase.id,
		source: 'recorded',
		model: meta.model,
		effort: meta.effort,
		recorded_at: (meta.now ?? new Date()).toISOString(),
		responses: responses.map((r) => ({ stop_reason: r.stopReason, content: recordContent(r.content, refs) }))
	};
}

// ---- graders ----

/**
 * Does `actual` satisfy `expected`? Strings match case-insensitively as substrings; numbers,
 * booleans and null exactly (a numeric string counts); arrays need each expected element in
 * the actual array; objects key by key. Special forms: "$ref:<name>", {"$regex": "…"},
 * {"$absent": true}, {"$falsy": true} (absent, null, false, 0, ""), {"$any": true}.
 * @param {any} expected
 * @param {any} actual
 * @param {Record<string, number>} refs
 * @returns {boolean}
 */
export function matchArgs(expected, actual, refs = {}) {
	if (typeof expected === 'string' && expected.startsWith('$ref:')) {
		const id = refs[expected.slice(5)];
		return id !== undefined && Number(actual) === id;
	}
	if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
		if ('$regex' in expected) return actual !== undefined && actual !== null && new RegExp(expected.$regex, 'i').test(String(actual));
		if ('$absent' in expected) return actual === undefined || actual === null;
		if ('$falsy' in expected) return !actual;
		if ('$any' in expected) return actual !== undefined && actual !== null;
		if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
		return Object.entries(expected).every(([k, v]) =>
			v && typeof v === 'object' && ('$absent' in v || '$falsy' in v) ? matchArgs(v, actual[k], refs) : k in actual && matchArgs(v, actual[k], refs)
		);
	}
	if (Array.isArray(expected)) {
		const list = Array.isArray(actual) ? actual : [actual];
		return expected.every((e) => list.some((a) => matchArgs(e, a, refs)));
	}
	if (typeof expected === 'string') return actual !== undefined && actual !== null && String(actual).toLowerCase().includes(expected.toLowerCase());
	if (typeof expected === 'number') return actual !== null && actual !== '' && Number(actual) === expected;
	return actual === expected;
}

/** @param {ToolCall} c */
function callText(c) {
	return `${c.name}(${JSON.stringify(c.input ?? {})}) → ${c.outcome}`;
}

/**
 * @param {any} g
 * @param {RunObservation} run
 * @returns {Grade}
 */
export function gradeToolCalls(g, run) {
	/** @type {string[]} */
	const misses = [];
	const calls = run.toolCalls ?? [];
	for (const r of g.required ?? []) {
		const ok = calls.some((c) => c.name === r.name && (r.args === undefined || matchArgs(r.args, c.input, run.refs)) && (r.outcome === undefined || c.outcome === r.outcome));
		if (!ok) misses.push(`missing ${r.name}${r.args ? ` with ${JSON.stringify(r.args)}` : ''}${r.outcome ? ` (${r.outcome})` : ''}`);
	}
	for (const f of g.forbidden_calls ?? []) {
		const hit = calls.find((c) => c.name === f.name && (f.args === undefined || matchArgs(f.args, c.input, run.refs)) && (f.outcome === undefined || c.outcome === f.outcome));
		if (hit) misses.push(`forbidden call ${callText(hit)}`);
	}
	for (const group of g.any_of ?? []) if (!calls.some((c) => group.includes(c.name))) misses.push(`none of ${group.join(' / ')} was called`);
	for (const name of g.forbidden ?? []) if (calls.some((c) => c.name === name)) misses.push(`forbidden ${name} was called`);
	for (const p of g.forbidden_patterns ?? []) {
		const re = new RegExp(p, 'i');
		for (const c of calls) if (re.test(c.name)) misses.push(`${c.name} matches forbidden /${p}/`);
	}
	if (g.no_writes) for (const c of calls) if ((run.tiers?.[c.name] ?? 'read') !== 'read') misses.push(`write tool ${c.name} was called`);
	if (g.no_applied_writes)
		for (const c of calls) if ((run.tiers?.[c.name] ?? 'read') !== 'read' && c.outcome === 'ok') misses.push(`write ${c.name} was applied without approval`);
	if (g.no_calls && calls.length) misses.push(`expected no tool calls, got ${calls.length}`);
	if (typeof g.max_calls === 'number' && calls.length > g.max_calls) misses.push(`${calls.length} calls, max ${g.max_calls}`);
	for (const name of g.offered_includes ?? []) if (!run.offered.includes(name)) misses.push(`${name} was not offered`);
	for (const name of g.offered_excludes ?? []) if (run.offered.includes(name)) misses.push(`${name} was offered`);
	for (const p of g.offered_excludes_patterns ?? []) {
		const re = new RegExp(p, 'i');
		for (const n of run.offered) if (re.test(n)) misses.push(`offered ${n} matches /${p}/`);
	}
	if (g.offered_reads_only) for (const n of run.offered) if ((run.tiers?.[n] ?? 'read') !== 'read') misses.push(`write tool ${n} was offered`);
	return {
		kind: 'tool_calls',
		pass: misses.length === 0,
		detail: misses.length ? `${misses.join('; ')}. Calls: ${calls.map(callText).join(', ') || 'none'}` : `${calls.length} call(s) as expected`
	};
}

/**
 * @param {any} g
 * @param {RunObservation} run
 * @returns {Grade}
 */
export function gradeContains(g, run) {
	const cs = g.case_sensitive === true;
	const hay = cs ? run.text : run.text.toLowerCase();
	/** @param {string} s */
	const has = (s) => hay.includes(cs ? s : s.toLowerCase());
	/** @type {string[]} */
	const misses = [];
	for (const s of g.all ?? []) if (!has(s)) misses.push(`missing "${s}"`);
	if (g.any && !g.any.some(has)) misses.push(`none of ${g.any.map((/** @type {string} */ s) => `"${s}"`).join(', ')}`);
	for (const s of g.none ?? []) if (has(s)) misses.push(`contains "${s}"`);
	return { kind: 'contains', pass: misses.length === 0, detail: misses.join('; ') || 'text as expected' };
}

/**
 * @param {any} g
 * @param {RunObservation} run
 * @returns {Grade}
 */
export function gradeRegex(g, run) {
	const hit = new RegExp(g.pattern, g.flags ?? 'i').test(run.text);
	const pass = g.negate ? !hit : hit;
	return { kind: 'regex', pass, detail: pass ? 'ok' : `${g.negate ? 'matched' : 'did not match'} /${g.pattern}/` };
}

/**
 * The JSON an answer carries: a ```json fence, else the whole text, else the first {…} / […].
 * @param {string} text
 * @returns {{ ok: true, value: any } | { ok: false }}
 */
export function extractJson(text) {
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidates = [fence?.[1], text];
	const start = text.search(/[[{]/);
	if (start >= 0) {
		const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
		if (end > start) candidates.push(text.slice(start, end + 1));
	}
	for (const c of candidates) {
		if (!c) continue;
		try {
			return { ok: true, value: JSON.parse(c.trim()) };
		} catch {
			/* next */
		}
	}
	return { ok: false };
}

/**
 * A small JSON Schema subset: type, properties, required, additionalProperties: false, items,
 * enum, const, minimum, maximum, minLength, maxLength, minItems, maxItems, pattern.
 * @param {any} schema
 * @param {any} value
 * @param {string} [path]
 * @returns {string[]} problems
 */
export function validateSchema(schema, value, path = '$') {
	/** @type {string[]} */
	const out = [];
	if (!schema || typeof schema !== 'object') return out;
	const typeOf = (/** @type {any} */ v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
	if (schema.type) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const t = typeOf(value);
		const ok = types.some((/** @type {string} */ want) => want === t || (want === 'number' && t === 'integer'));
		if (!ok) return [`${path}: expected ${types.join('|')}, got ${t}`];
	}
	if (schema.enum && !schema.enum.some((/** @type {any} */ e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
	if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${path}: expected ${JSON.stringify(schema.const)}`);
	if (typeof value === 'number') {
		if (typeof schema.minimum === 'number' && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
		if (typeof schema.maximum === 'number' && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
	}
	if (typeof value === 'string') {
		if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
		if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${path}: does not match ${schema.pattern}`);
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === 'number' && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
		if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
		if (schema.items) value.forEach((v, i) => out.push(...validateSchema(schema.items, v, `${path}[${i}]`)));
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const k of schema.required ?? []) if (!(k in value)) out.push(`${path}.${k}: required`);
		const props = schema.properties ?? {};
		for (const [k, v] of Object.entries(value)) {
			if (props[k]) out.push(...validateSchema(props[k], v, `${path}.${k}`));
			else if (schema.additionalProperties === false) out.push(`${path}.${k}: not allowed`);
		}
	}
	return out;
}

/**
 * @param {any} g
 * @param {RunObservation} run
 * @returns {Grade}
 */
export function gradeJsonSchema(g, run) {
	const parsed = extractJson(run.finalText || run.text);
	if (!parsed.ok) return { kind: 'json_schema', pass: false, detail: 'no JSON found in the answer' };
	const problems = validateSchema(resolveRefs(g.schema, run.refs ?? {}), parsed.value);
	return { kind: 'json_schema', pass: problems.length === 0, detail: problems.join('; ') || 'valid' };
}

/**
 * Grade one run. `only` limits the kinds (the CI replay runs tool_calls only); a kind that
 * can't run here (llm_judge without a judge) is `pass: null` = skipped. A run that errored
 * or timed out fails.
 * @param {RunObservation} run
 * @param {any} evalCase
 * @param {{ only?: string[], judge?: Judge }} [o]
 * @returns {Promise<{ pass: boolean, grades: Grade[] }>}
 */
export async function gradeRun(run, evalCase, o = {}) {
	/** @type {Grade[]} */
	const grades = [];
	if (run.error) grades.push({ kind: 'run', pass: false, detail: run.error });
	for (const g of evalCase.graders ?? []) {
		if (o.only && !o.only.includes(g.kind)) continue;
		try {
			if (g.kind === 'tool_calls') grades.push(gradeToolCalls(g, run));
			else if (g.kind === 'contains') grades.push(gradeContains(g, run));
			else if (g.kind === 'regex') grades.push(gradeRegex(g, run));
			else if (g.kind === 'json_schema') grades.push(gradeJsonSchema(g, run));
			else if (g.kind === 'llm_judge') {
				if (!o.judge) grades.push({ kind: 'llm_judge', pass: null, detail: 'skipped (no judge)' });
				else {
					const v = await o.judge({ rubric: g.rubric, run, evalCase });
					grades.push({ kind: 'llm_judge', pass: v.pass, detail: v.reason });
				}
			}
		} catch (e) {
			grades.push({ kind: g.kind, pass: false, detail: `grader error: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
	return { pass: grades.every((x) => x.pass !== false) && grades.some((x) => x.pass === true), grades };
}

/**
 * The judge's prompt: rubric + what happened (no system prompt, no raw tool results).
 * @param {string} rubric
 * @param {RunObservation} run
 * @param {any} evalCase
 */
export function judgePrompt(rubric, run, evalCase) {
	const calls = (run.toolCalls ?? []).map(callText).join('\n') || '(none)';
	return [
		'You grade one turn of an in-app CRM assistant against a rubric. Reply with JSON only: {"pass": true|false, "reason": "<one sentence>"}.',
		`Rubric: ${rubric}`,
		`Known-good outcome: ${evalCase.expect}`,
		`User message: ${evalCase.message}`,
		`Tool calls (name(args) → outcome):\n${calls}`,
		`Assistant's answer:\n${run.text || '(empty)'}`
	].join('\n\n');
}

/**
 * @param {string} text the judge model's reply
 * @returns {{ pass: boolean, reason: string }}
 */
export function parseJudgeReply(text) {
	const j = extractJson(text);
	if (j.ok && j.value && typeof j.value.pass === 'boolean') return { pass: j.value.pass, reason: String(j.value.reason ?? '') };
	return { pass: false, reason: `unreadable judge reply: ${text.slice(0, 120)}` };
}

// ---- results ----

/**
 * @typedef {{ id: string, category: string, attempt: number, pass: boolean, grades: Grade[],
 *   costMicros: number, latencyMs: number, error?: string | null, transcript?: any[],
 *   toolCalls?: ToolCall[], text?: string }} Entry
 */

/**
 * Per case: passed = every attempt passed; flaky = some did.
 * @param {Entry[]} entries
 */
export function caseOutcomes(entries) {
	/** @type {Map<string, { id: string, category: string, attempts: number, passes: number, costMicros: number, latencyMs: number }>} */
	const by = new Map();
	for (const e of entries) {
		const c = by.get(e.id) ?? { id: e.id, category: e.category, attempts: 0, passes: 0, costMicros: 0, latencyMs: 0 };
		c.attempts += 1;
		if (e.pass) c.passes += 1;
		c.costMicros += e.costMicros ?? 0;
		c.latencyMs += e.latencyMs ?? 0;
		by.set(e.id, c);
	}
	return [...by.values()].map((c) => ({
		...c,
		pass: c.passes === c.attempts,
		flaky: c.passes > 0 && c.passes < c.attempts,
		avgCostMicros: Math.round(c.costMicros / c.attempts),
		avgLatencyMs: Math.round(c.latencyMs / c.attempts)
	}));
}

/** @param {Entry[]} entries */
export function summarize(entries) {
	const cases = caseOutcomes(entries);
	/** @type {Record<string, { total: number, passed: number }>} */
	const byCategory = {};
	for (const c of cases) {
		const b = (byCategory[c.category] ??= { total: 0, passed: 0 });
		b.total += 1;
		if (c.pass) b.passed += 1;
	}
	const latencies = entries.map((e) => e.latencyMs ?? 0).sort((a, b) => a - b);
	return {
		cases: cases.length,
		passed: cases.filter((c) => c.pass).length,
		flaky: cases.filter((c) => c.flaky).length,
		runs: entries.length,
		runsPassed: entries.filter((e) => e.pass).length,
		passRate: cases.length ? cases.filter((c) => c.pass).length / cases.length : 0,
		byCategory,
		costMicros: entries.reduce((s, e) => s + (e.costMicros ?? 0), 0),
		p50LatencyMs: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : 0
	};
}

/**
 * New failures and fixes versus the previous run (cases present in both).
 * @param {Entry[] | null} prev
 * @param {Entry[]} cur
 */
export function diffRuns(prev, cur) {
	if (!prev) return null;
	const before = new Map(caseOutcomes(prev).map((c) => [c.id, c.pass]));
	const now = caseOutcomes(cur);
	return {
		newFailures: now.filter((c) => before.get(c.id) === true && !c.pass).map((c) => c.id),
		fixed: now.filter((c) => before.get(c.id) === false && c.pass).map((c) => c.id),
		added: now.filter((c) => !before.has(c.id)).map((c) => c.id)
	};
}

/** @param {number} micros */
export function usd(micros) {
	return `$${(micros / 1e6).toFixed(micros < 10_000 ? 4 : 3)}`;
}

/** @param {number} r */
function pct(r) {
	return `${(r * 100).toFixed(1)}%`;
}

/**
 * A short, readable transcript: the user message, each tool call, the answer.
 * @param {Entry} e
 * @param {number} [max]
 */
export function transcriptText(e, max = 1500) {
	const lines = [];
	for (const c of e.toolCalls ?? []) lines.push(`- tool ${callText(c)}`);
	const answer = (e.text ?? '').trim();
	lines.push('', answer.length > max ? `${answer.slice(0, max)}…` : answer || '(no text)');
	return lines.join('\n');
}

/**
 * @param {{ meta: Record<string, any>, entries: Entry[], diff: ReturnType<typeof diffRuns>, cases?: any[], transcripts?: boolean }} o
 */
export function markdownReport(o) {
	const s = summarize(o.entries);
	const byId = new Map((o.cases ?? []).map((c) => [c.id, c]));
	const out = [
		`# Assistant evals — ${o.meta.started_at ?? ''}`,
		'',
		`Model \`${o.meta.model}\` · effort \`${o.meta.effort ?? 'none'}\` · judge \`${o.meta.judge_model ?? 'none'}\` · repeat ${o.meta.repeat ?? 1} · mode ${o.meta.mode ?? 'live'}${o.meta.filter ? ` · filter \`${o.meta.filter}\`` : ''}`,
		'',
		`**Pass rate: ${pct(s.passRate)}** (${s.passed}/${s.cases} cases${s.flaky ? `, ${s.flaky} flaky` : ''}; ${s.runsPassed}/${s.runs} runs) · cost ${usd(s.costMicros)} · p50 latency ${(s.p50LatencyMs / 1000).toFixed(1)} s`,
		'',
		'| Category | Passed | Total | Rate |',
		'| --- | ---: | ---: | ---: |'
	];
	for (const [cat, b] of Object.entries(s.byCategory).sort()) out.push(`| ${cat} | ${b.passed} | ${b.total} | ${pct(b.total ? b.passed / b.total : 0)} |`);
	if (o.diff) {
		out.push('', '## Versus the previous run', '');
		out.push(`- New failures: ${o.diff.newFailures.length ? o.diff.newFailures.map((x) => `\`${x}\``).join(', ') : 'none'}`);
		out.push(`- Fixed: ${o.diff.fixed.length ? o.diff.fixed.map((x) => `\`${x}\``).join(', ') : 'none'}`);
		if (o.diff.added.length) out.push(`- New cases: ${o.diff.added.map((x) => `\`${x}\``).join(', ')}`);
	}
	out.push('', '## Cases', '', '| Case | Result | Cost | Latency |', '| --- | --- | ---: | ---: |');
	for (const c of caseOutcomes(o.entries)) {
		const res = c.pass ? 'pass' : c.flaky ? `flaky ${c.passes}/${c.attempts}` : `FAIL${c.attempts > 1 ? ` 0/${c.attempts}` : ''}`;
		out.push(`| \`${c.id}\` | ${res} | ${usd(c.avgCostMicros)} | ${(c.avgLatencyMs / 1000).toFixed(1)} s |`);
	}
	const failures = o.entries.filter((e) => !e.pass);
	if (failures.length) {
		out.push('', '## Failures');
		for (const e of failures) {
			const c = byId.get(e.id);
			out.push('', `### \`${e.id}\` (attempt ${e.attempt})`, '');
			if (c) out.push(`> ${c.message}`, '', `Expected: ${c.expect}`, '');
			for (const g of e.grades.filter((x) => x.pass === false)) out.push(`- **${g.kind}**: ${g.detail}`);
			if (o.transcripts !== false) out.push('', '```text', transcriptText(e), '```');
		}
	}
	return `${out.join('\n')}\n`;
}

// ---- runner plumbing ----

/**
 * `.dev.vars` (KEY=value, # comments, optional quotes) → object.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDevVars(text) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		let v = line.slice(eq + 1).trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		out[line.slice(0, eq).trim()] = v;
	}
	return out;
}

const VALUE_FLAGS = new Set(['model', 'effort', 'filter', 'repeat', 'concurrency', 'timeout', 'judge-model', 'out']);
const BOOL_FLAGS = new Set(['record', 'replay', 'ci-only', 'no-judge', 'help', 'no-transcripts']);

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
export function parseRunnerArgs(argv) {
	/** @type {Record<string, string | boolean>} */
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h') {
			flags.help = true;
			continue;
		}
		if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
		const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
		if (BOOL_FLAGS.has(name)) flags[name] = true;
		else if (VALUE_FLAGS.has(name)) {
			const v = inline ?? argv[++i];
			if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
			flags[name] = v;
		} else throw new Error(`Unknown flag --${name}`);
	}
	for (const k of ['repeat', 'concurrency', 'timeout']) {
		if (flags[k] !== undefined && !(Number.isInteger(Number(flags[k])) && Number(flags[k]) > 0)) throw new Error(`--${k} must be a positive whole number`);
	}
	if (flags.record && flags.replay) throw new Error('--record and --replay don\'t combine');
	return flags;
}

/**
 * Work items (case × attempt) dealt round-robin into at most `n` shards.
 * @template T
 * @param {T[]} items
 * @param {number} n
 * @returns {T[][]}
 */
export function shard(items, n) {
	const k = Math.max(1, Math.min(n, items.length));
	/** @type {T[][]} */
	const out = Array.from({ length: k }, () => []);
	items.forEach((it, i) => out[i % k].push(it));
	return out.filter((s) => s.length);
}

/**
 * Result lines printed by the harness (RESULT_MARKER + JSON), from any text.
 * @param {string} text
 * @returns {any[]}
 */
export function parseResultLines(text) {
	const out = [];
	for (const line of text.split(/\r?\n/)) {
		const at = line.indexOf(RESULT_MARKER);
		if (at < 0) continue;
		try {
			out.push(JSON.parse(line.slice(at + RESULT_MARKER.length)));
		} catch {
			/* a cut-off line */
		}
	}
	return out;
}

/** "2026-10-21T18-04-05Z" — sortable and safe in a file name. @param {Date} d */
export function stamp(d) {
	return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}
