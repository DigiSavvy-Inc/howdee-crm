// Form drafting tools (#517, Forms 5/7): create_form_draft and update_form, both tier
// 'approve' — the card shows the form in words (questions, mappings, show rules, page jumps,
// outcomes, settings) before anything is stored, and links to the builder (Open in builder).
//
// Hard rules, structural rather than gated (tests/ai-forms-tools-517.test.ts): the assistant
// never publishes, unpublishes, archives, restores, duplicates or deletes a form — nothing here
// imports those helpers from forms.ts and no statement here sets a status; the only form it
// creates is createForm's draft. It edits drafts only (published / archived → refused: the user
// unpublishes or duplicates it in the app), and it never sets allowed origins or the notify
// webhook (./form-input.ts keeps the form's own, none for a new form).
//
// Undo of a create deletes the draft only while it is still a draft as the assistant left it,
// with no submissions and no automation trigger or score rule pointing at it. Undo of an update
// puts the previous name + spec back (stored in ai_actions.before) while the draft is unchanged.

import type { FieldChange } from '$lib/assistant-actions';
import type { FormSpec } from '$lib/forms';
import { createForm, getForm, saveForm, type FormRow } from '../../forms';
import { FORM_SPEC_DOC, formCounts, formOutline, prepareFormSpec, problemLines } from './form-input';
import { requireForm } from './forms';
import { ToolInputError, UndoRefused, intArg, strArg, type Tool, type ToolContext, type WriteOutcome } from './types';

const REVIEW_NOTE = 'Saved as a draft: review and publish it yourself in Forms (Open in builder).';
const NEXT = 'Tell the user to review the draft and publish it in the builder (Open in builder). You cannot publish it.';

const url = (ctx: ToolContext, id: number) => `${ctx.baseUrl}/forms/${id}`;

type CreatedAfter = { form_id: number; name: string; snapshot: string };
type UpdateBefore = { form_id: number; name: string; spec: FormSpec };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Resolve + validate; a problem list goes back to the model and nothing is stored. */
async function preparedOrThrow(ctx: ToolContext, raw: unknown, opts: { name: string; current?: FormSpec }, tool: string) {
	const p = await prepareFormSpec(ctx.db, raw, { ...opts, userId: ctx.user.id });
	if (!p.ok) {
		const n = p.problems.length;
		throw new ToolInputError(`Nothing was saved — the form has ${n} problem${n === 1 ? '' : 's'}. Fix them and call ${tool} again:\n${problemLines(p.problems)}`);
	}
	return p;
}

/** The new form's name: `name`, else the spec's title. */
function nameArg(input: Record<string, unknown>): string {
	const name = strArg(input, 'name', 300);
	if (name) return name;
	const spec = input.spec;
	return isObj(spec) && typeof spec.title === 'string' ? spec.title.trim().slice(0, 300) : '';
}

/** A draft form, or why the assistant can't edit it. */
async function requireDraft(ctx: ToolContext, input: Record<string, unknown>): Promise<FormRow> {
	const f = await requireForm(ctx, input);
	if (f.status === 'published') {
		throw new ToolInputError(`“${f.name}” is published, and the assistant only edits draft forms. Unpublish it first, or duplicate it (both in the form's builder).`);
	}
	if (f.status !== 'draft') {
		throw new ToolInputError(`“${f.name}” is ${f.status}, and the assistant only edits draft forms. Restore it first, or duplicate it (in Forms).`);
	}
	return f;
}

const fieldId = (f: FormSpec['fields'][number]) => f.key || f.id;
const fieldName = (f: FormSpec['fields'][number]) => `“${(f.label || f.key || f.type).replace(/\s+/g, ' ').slice(0, 50)}”`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What an update changes, in words, for the card. */
function changeLines(before: FormSpec, after: FormSpec): string[] {
	const old = new Map(before.fields.map((f) => [fieldId(f), f]));
	const now = new Map(after.fields.map((f) => [fieldId(f), f]));
	const added = after.fields.filter((f) => !old.has(fieldId(f)));
	const removed = before.fields.filter((f) => !now.has(fieldId(f)));
	const changed = after.fields.filter((f) => {
		const o = old.get(fieldId(f));
		return o && !same({ ...o, id: '' }, { ...f, id: '' });
	});
	const lines: string[] = [];
	if (added.length) lines.push(`Added: ${added.map(fieldName).join(', ')}`);
	if (removed.length) lines.push(`Removed: ${removed.map(fieldName).join(', ')}`);
	if (changed.length) lines.push(`Changed: ${changed.map(fieldName).join(', ')}`);
	const moved = !added.length && !removed.length && !same(before.fields.map(fieldId), after.fields.map(fieldId));
	if (moved) lines.push('Questions reordered');
	const also: string[] = [];
	if (before.title !== after.title || before.intro_md !== after.intro_md) also.push('title / intro');
	if (!same(before.pages, after.pages)) also.push('page jumps');
	if (!same(before.outcomes, after.outcomes)) also.push('outcomes');
	if (!same(before.settings, after.settings)) also.push('settings');
	if (!same(before.style, after.style)) also.push('style');
	if (also.length) lines.push(`Also changed: ${also.join(', ')}`);
	return lines.length ? lines : ['No changes to the form.'];
}

const SPEC_PROP = { type: 'object', description: 'The form spec (see the format in create_form_draft).' };

export const formDraftTools: Tool[] = [
	{
		name: 'create_form_draft',
		tier: 'approve',
		description:
			'Draft a new form (a DRAFT: never published, nothing live) from a description, including show-when logic, page jumps and outcomes. Propose the questions to the user first. The spec is checked before anything is stored: problems come back as "path: message" lines, so fix the spec and call again. When valid, the user sees the form in words on a card and approves; it is created as a draft they review and publish in the builder. You cannot publish, archive or delete forms, or set allowed origins or the notify webhook. ' +
			FORM_SPEC_DOC,
		input_schema: {
			type: 'object',
			properties: { name: { type: 'string', description: 'The form name (internal; the address is made from it).' }, spec: SPEC_PROP },
			required: ['name', 'spec']
		},
		summarize: (input) => String(input.name ?? ''),
		plan: async (ctx, input) => {
			const name = nameArg(input);
			const p = await preparedOrThrow(ctx, input.spec, { name }, 'create_form_draft');
			return {
				count: 0,
				sample: [],
				summary: `Create draft form “${name}” · ${formCounts(p.spec)}`,
				notes: [...(await formOutline(ctx.db, p.spec)), ...p.notes, REVIEW_NOTE]
			};
		},
		apply: async (ctx, input): Promise<WriteOutcome> => {
			const name = nameArg(input);
			const p = await preparedOrThrow(ctx, input.spec, { name }, 'create_form_draft');
			const id = await createForm(ctx.db, name, ctx.user.id);
			const created = (await getForm(ctx.db, id))!;
			const saved = await saveForm(ctx.db, id, { name: created.name, slug: created.slug, spec: p.spec }, ctx.user.id);
			if (!saved.ok) {
				await ctx.db.prepare("DELETE FROM forms WHERE id = ? AND status = 'draft'").bind(id).run();
				throw new ToolInputError(`Nothing was saved:\n${problemLines(saved.problems)}`);
			}
			const form = saved.form;
			return {
				summary: `Created draft form “${form.name}” · ${formCounts(form.spec)}`,
				before: null,
				after: { form_id: id, name: form.name, snapshot: JSON.stringify(form.spec) } satisfies CreatedAfter,
				url: url(ctx, id),
				notes: [...(await formOutline(ctx.db, form.spec)), ...p.notes, REVIEW_NOTE],
				result: { form_id: id, status: 'draft', slug: form.slug, next: NEXT }
			};
		},
		undo: async (ctx, _before, after) => {
			const a = after as CreatedAfter | null;
			if (!a?.form_id) return;
			const f = await getForm(ctx.db, a.form_id);
			if (!f) return;
			if (f.status !== 'draft') throw new UndoRefused(`“${f.name}” was kept: it is ${f.status} now.`);
			if (f.name !== a.name || JSON.stringify(f.spec) !== a.snapshot) throw new UndoRefused(`“${f.name}” was kept: it was edited since.`);
			const used = await ctx.db
				.prepare(
					`SELECT (SELECT COUNT(*) FROM form_submissions WHERE form_id = ?1)
					      + (SELECT COUNT(*) FROM automations WHERE trigger_type = 'form_submitted'
					           AND json_valid(trigger_config) AND json_extract(trigger_config, '$.form_id') = ?1)
					      + (SELECT COUNT(*) FROM score_rules WHERE event_type = 'crm_form_submit'
					           AND json_valid(filter) AND json_extract(filter, '$.form_id') = ?1) AS n`
				)
				.bind(f.id)
				.first<{ n: number }>();
			if (used?.n) throw new UndoRefused(`“${f.name}” was kept: it has submissions, or an automation or score rule uses it.`);
			await ctx.db.prepare("DELETE FROM forms WHERE id = ? AND status = 'draft'").bind(f.id).run();
		}
	},
	{
		name: 'update_form',
		tier: 'approve',
		description:
			'Change a DRAFT form: pass its whole edited spec (read get_form first and keep the field ids). Top-level keys you leave out (fields, pages, outcomes, settings, style, title) stay as they are; settings and style merge key by key. Optional name renames it (the address stays). Published or archived forms are refused — the user unpublishes or duplicates them in the app. Waits for Approve; Undo puts the previous version back. Same spec format as create_form_draft; allowed origins and the notify webhook always stay as they are.',
		input_schema: {
			type: 'object',
			properties: {
				form_id: { type: 'integer', description: 'A draft form id.' },
				name: { type: 'string', description: 'A new name (optional).' },
				spec: SPEC_PROP
			},
			required: ['form_id', 'spec']
		},
		summarize: (input) => `form #${input.form_id}`,
		plan: async (ctx, input) => {
			intArg(input, 'form_id', { required: true, min: 1 });
			const f = await requireDraft(ctx, input);
			const name = strArg(input, 'name', 300) || f.name;
			const p = await preparedOrThrow(ctx, input.spec, { name, current: f.spec }, 'update_form');
			return {
				count: 0,
				sample: [],
				summary: `Update draft form “${f.name}” · ${formCounts(p.spec)}`,
				notes: [
					...(name !== f.name ? [`Renamed to “${name}”`] : []),
					...changeLines(f.spec, p.spec),
					...(await formOutline(ctx.db, p.spec)),
					...p.notes,
					'Undo puts the previous version back.'
				]
			};
		},
		apply: async (ctx, input): Promise<WriteOutcome> => {
			intArg(input, 'form_id', { required: true, min: 1 });
			const f = await requireDraft(ctx, input);
			const name = strArg(input, 'name', 300) || f.name;
			const p = await preparedOrThrow(ctx, input.spec, { name, current: f.spec }, 'update_form');
			const saved = await saveForm(ctx.db, f.id, { name, slug: f.slug, spec: p.spec }, ctx.user.id);
			if (!saved.ok) throw new ToolInputError(`Nothing was saved:\n${problemLines(saved.problems)}`);
			const form = saved.form;
			const changes: FieldChange[] = form.name !== f.name ? [{ field: 'name', from: f.name, to: form.name }] : [];
			return {
				summary: `Updated draft form “${form.name}” · ${formCounts(form.spec)}`,
				before: { form_id: f.id, name: f.name, spec: f.spec } satisfies UpdateBefore,
				after: { form_id: f.id, name: form.name, snapshot: JSON.stringify(form.spec) } satisfies CreatedAfter,
				changes,
				url: url(ctx, f.id),
				notes: [...changeLines(f.spec, form.spec), ...p.notes],
				result: { form_id: f.id, status: 'draft', next: NEXT }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as UpdateBefore | null;
			const a = after as CreatedAfter | null;
			if (!b?.form_id || !a) return;
			const f = await getForm(ctx.db, b.form_id);
			if (!f) throw new UndoRefused('That form no longer exists.');
			if (f.status !== 'draft') throw new UndoRefused(`“${f.name}” is ${f.status} now — nothing was undone.`);
			if (f.name !== a.name || JSON.stringify(f.spec) !== a.snapshot) throw new UndoRefused(`“${f.name}” was edited since — nothing was undone.`);
			const r = await saveForm(ctx.db, f.id, { name: b.name, slug: f.slug, spec: b.spec }, ctx.user.id);
			if (!r.ok) throw new UndoRefused(`The earlier version can’t be saved: ${r.error}`);
		}
	}
];
