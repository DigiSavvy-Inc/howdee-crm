import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { parseFilter, validateRule, validateScore } from '$lib/scoring';
import { createRule, createScore, deleteRule, getRule, getScore, listRules, moveRule, updateRule, updateScore } from '$lib/server/scoring/store';
import { ingestBacklog, rebuildScore } from '$lib/server/scoring/engine';
import { stageOptions } from '$lib/server/pipeline-query';
import { topicPicker } from '$lib/server/topics';
import { forPicker, ruleListIds } from '$lib/server/group-archive';
import { formPickers } from '$lib/server/scoring/form-rules';

// Settings → Scoring → one score (#466): /new creates, /<id> edits the score and its rules.
// Admin-only (load AND every action).

function isAdmin(event: RequestEvent): boolean {
	return event.locals?.user?.role === 'admin';
}

function parseId(raw: string | undefined): number | 'new' | null {
	if (raw === 'new') return 'new';
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export const load: PageServerLoad = async (event) => {
	if (!isAdmin(event)) throw error(403, 'Admins only.');
	const id = parseId(event.params.id);
	if (id === null) throw error(404, 'Score not found.');
	const db = getDB(event);
	const score = id === 'new' ? null : await getScore(db, id);
	if (id !== 'new' && !score) throw error(404, 'Score not found.');

	const [rules, campaigns, automations, groupRows, stages, keys, companies, topics, backlog] = await Promise.all([
		score ? listRules(db, score.id) : Promise.resolve([]),
		db
			.prepare(
				`SELECT id, subject AS name FROM campaigns WHERE status IN ('sent', 'sending', 'scheduled') AND automation_step_id IS NULL
				 ORDER BY id DESC LIMIT 200`
			)
			.all<{ id: number; name: string }>(),
		db.prepare('SELECT id, name FROM automations ORDER BY name COLLATE NOCASE LIMIT 500').all<{ id: number; name: string }>(),
		db
			.prepare('SELECT id, name, kind, rules, archived_at FROM lists ORDER BY name COLLATE NOCASE LIMIT 2000')
			.all<{ id: number; name: string; kind: string; rules: string | null; archived_at: string | null }>(),
		stageOptions(db),
		db.prepare('SELECT id, label AS name FROM webhook_keys ORDER BY label COLLATE NOCASE').all<{ id: number; name: string }>(),
		db.prepare('SELECT id, name FROM companies ORDER BY name COLLATE NOCASE LIMIT 500').all<{ id: number; name: string }>(),
		topicPicker(db),
		score ? ingestBacklog(db) : Promise.resolve(null)
	]);
	// #472: archived lists / segments only where this score's rules already use them.
	const keep: number[] = [];
	for (const r of rules) {
		keep.push(...ruleListIds(r.rules));
		try {
			keep.push(Number(JSON.parse(r.filter ?? '{}')?.list_id) || 0);
		} catch {
			// unreadable filter — nothing to keep
		}
	}
	const groups = { results: forPicker(groupRows.results, keep) };
	// #621: CRM forms (with their questions) for "Submitted a CRM form"; archived ones only when used.
	const usedForms = rules.map((r) => Number(parseFilter(r.filter).form_id) || 0);
	// #632: and the forms a condition rule's "Submitted form" names.
	for (const r of rules) {
		try {
			for (const x of JSON.parse(r.rules ?? '{}')?.rules ?? []) if (x?.field === 'form_submitted') usedForms.push(Number(x.value) || 0);
		} catch {
			// unreadable rule set — nothing to keep
		}
	}
	const forms = await formPickers(db, usedForms);
	const addForm = Number(event.url.searchParams.get('add_form')) || 0;
	return {
		score,
		rules,
		pickers: {
			campaigns: campaigns.results,
			automations: automations.results,
			lists: groups.results.map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
			stages: stages.map((s) => ({ id: s.id, name: s.name })),
			keys: keys.results,
			companies: companies.results,
			topics,
			tags: groups.results.filter((g) => g.kind === 'tag').map((g) => g.name),
			// The segment builder's "List / group" picker: hand-picked groups only.
			groups: groups.results.filter((g) => g.kind !== 'tag' && !g.rules).map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
			forms
		},
		backlog,
		// #621: /settings/scoring/<id>?add_form=<form id> opens a new CRM form rule for that form.
		addForm: forms.some((f) => f.id === addForm) ? addForm : null
	};
};

function ruleValues(form: FormData) {
	return {
		kind: String(form.get('kind') ?? ''),
		label: String(form.get('label') ?? ''),
		event_type: String(form.get('event_type') ?? ''),
		filter: String(form.get('filter') ?? ''),
		rules: String(form.get('rules') ?? ''),
		points: String(form.get('points') ?? '').trim(),
		expires_days: String(form.get('expires_days') ?? '').trim(),
		max_per_day: String(form.get('max_per_day') ?? '').trim(),
		once: form.get('once') === 'on',
		active: form.get('active') === 'on'
	};
}

async function scoreFor(event: RequestEvent) {
	const id = parseId(event.params.id);
	if (typeof id !== 'number') return null;
	return getScore(getDB(event), id);
}

export const actions: Actions = {
	save: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const id = parseId(event.params.id);
		if (id === null) return fail(404, { error: 'Score not found.' });
		const form = await event.request.formData();
		const values = {
			name: String(form.get('name') ?? ''),
			description: String(form.get('description') ?? ''),
			status: String(form.get('status') ?? 'active'),
			decay_mode: String(form.get('decay_mode') ?? 'expire'),
			half_life_days: String(form.get('half_life_days') ?? '').trim(),
			bands: String(form.get('bands') ?? '[]')
		};
		const v = validateScore(values);
		if (!v.ok) return fail(400, { error: v.error, values });
		const db = getDB(event);
		if (id === 'new') {
			const r = await createScore(db, v.value);
			if (!r.ok) return fail(400, { error: r.error, values });
			throw redirect(303, `/settings/scoring/${r.id}`);
		}
		const r = await updateScore(db, id, v.value);
		if (!r.ok) return fail(404, { error: r.error, values });
		return { done: 'Saved.' };
	},

	saveRule: async (event) => {
		if (!isAdmin(event)) return fail(403, { ruleError: 'Admins only.' });
		const score = await scoreFor(event);
		if (!score) return fail(404, { ruleError: 'Score not found.' });
		const form = await event.request.formData();
		const ruleId = Number(form.get('rule_id')) || 0;
		const v = validateRule(ruleValues(form), score.decay_mode);
		if (!v.ok) return fail(400, { ruleError: v.error, ruleId });
		const db = getDB(event);
		const formId = v.value.filter?.form_id;
		if (formId && !(await db.prepare('SELECT id FROM forms WHERE id = ?').bind(formId).first()))
			return fail(400, { ruleError: 'That form no longer exists.', ruleId });
		if (ruleId) {
			const rule = await getRule(db, ruleId);
			if (!rule || rule.score_id !== score.id) return fail(404, { ruleError: 'That rule no longer exists.', ruleId });
			const r = await updateRule(db, ruleId, v.value);
			if (!r.ok) return fail(400, { ruleError: r.error, ruleId });
			return { ruleDone: v.value.kind === 'condition' ? 'Rule saved — matching contacts are being re-checked.' : 'Rule saved. New points use it; Rebuild applies it to past activity.', ruleId };
		}
		const r = await createRule(db, score.id, v.value);
		if (!r.ok) return fail(400, { ruleError: r.error, ruleId: 0 });
		return { ruleDone: v.value.kind === 'condition' ? 'Rule added — matching contacts are being checked.' : 'Rule added. It scores new activity; Rebuild applies it to the last 365 days.', ruleId: r.id };
	},

	deleteRule: async (event) => {
		if (!isAdmin(event)) return fail(403, { ruleError: 'Admins only.' });
		const score = await scoreFor(event);
		if (!score) return fail(404, { ruleError: 'Score not found.' });
		const form = await event.request.formData();
		const ruleId = Number(form.get('rule_id')) || 0;
		const db = getDB(event);
		const rule = await getRule(db, ruleId);
		if (!rule || rule.score_id !== score.id) return fail(404, { ruleError: 'That rule no longer exists.' });
		await deleteRule(db, ruleId);
		return { ruleDone: 'Rule deleted, with the points it gave.' };
	},

	moveRule: async (event) => {
		if (!isAdmin(event)) return fail(403, { ruleError: 'Admins only.' });
		const score = await scoreFor(event);
		if (!score) return fail(404, { ruleError: 'Score not found.' });
		const form = await event.request.formData();
		const ruleId = Number(form.get('rule_id')) || 0;
		const db = getDB(event);
		const rule = await getRule(db, ruleId);
		if (!rule || rule.score_id !== score.id) return fail(404, { ruleError: 'That rule no longer exists.' });
		await moveRule(db, ruleId, form.get('dir') === 'up' ? -1 : 1);
		return { moved: true };
	},

	rebuild: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const score = await scoreFor(event);
		if (!score) return fail(404, { error: 'Score not found.' });
		await rebuildScore(getDB(event), score.id);
		return { done: 'Rebuilding from the last 365 days — progress below.' };
	}
};
