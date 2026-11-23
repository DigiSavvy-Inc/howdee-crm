// Company write tool (#301): edit a company's name, domain, website or notes through
// companies.ts `updateCompany` (a rename rewrites the linked contacts' company text) with
// `enroll: false`, so re-syncing company groups never enrolls anyone. No create or delete.

import { updateCompany, type CompanyInput } from '../../companies';
import { contactWriteTriggerNotes } from './trigger-guard';
import { ToolInputError, UndoRefused, intArg, type ToolContext, type WriteTool } from './types';

const KEYS = ['name', 'domain', 'website', 'notes'] as const;
type CompanyState = { company_id: number; name: string; domain: string | null; website: string | null; notes: string | null };

async function companyState(db: D1Database, id: number): Promise<CompanyState | null> {
	return db
		.prepare('SELECT id AS company_id, name, domain, website, notes FROM companies WHERE id = ?')
		.bind(id)
		.first<CompanyState>();
}

function edits(input: Record<string, unknown>): CompanyInput {
	const out: CompanyInput = {};
	for (const k of KEYS) if (Object.prototype.hasOwnProperty.call(input, k)) out[k] = input[k] ?? '';
	if (!Object.keys(out).length) throw new ToolInputError('Nothing to change: give name, domain, website or notes.');
	return out;
}

async function apply(ctx: ToolContext, id: number, input: CompanyInput): Promise<void> {
	const r = await updateCompany(ctx.db, id, input, { enroll: false });
	if (r.ok) return;
	throw new ToolInputError(
		r.error === 'not_found' ? `No company with id ${id}.` : r.error === 'name_required' ? 'A company needs a name.' : 'Another company already has that name.'
	);
}

export const companyWriteTools: WriteTool[] = [
	{
		name: 'update_company_fields',
		tier: 'write',
		description:
			"Edit a company's name, domain, website or notes. Only the keys you pass change (\"\" clears; name can't be cleared). A rename also updates the company name on its contacts.",
		input_schema: {
			type: 'object',
			properties: {
				company_id: { type: 'integer' },
				name: { type: 'string' },
				domain: { type: ['string', 'null'] },
				website: { type: ['string', 'null'] },
				notes: { type: ['string', 'null'] }
			},
			required: ['company_id']
		},
		summarize: (input) => `company #${input.company_id}`,
		plan: async (ctx, input) => {
			const id = intArg(input, 'company_id', { required: true, min: 1 })!;
			const change = edits(input);
			const c = await companyState(ctx.db, id);
			if (!c) throw new ToolInputError(`No company with id ${id}.`);
			// #535: only a rename reaches contacts (their company text + company group, like
			// updateCompany); the link, metrics, domain, website and notes are read by no segment rule.
			const newName = change.name === undefined ? '' : String(change.name ?? '').trim().slice(0, 200);
			let notes: string[] = [];
			if (newName && newName !== c.name) {
				const linked = await ctx.db.prepare('SELECT id FROM contacts WHERE company_id = ?').bind(id).all<{ id: number }>();
				notes = await contactWriteTriggerNotes(ctx.db, linked.results.map((r) => r.id), { companyName: true });
			}
			return { count: 1, sample: [c.name], summary: `Update company ${c.name}`, ...(notes.length ? { approve: true, notes } : {}) };
		},
		apply: async (ctx, input) => {
			const id = intArg(input, 'company_id', { required: true, min: 1 })!;
			const change = edits(input);
			const before = await companyState(ctx.db, id);
			if (!before) throw new ToolInputError(`No company with id ${id}.`);
			await apply(ctx, id, change);
			const after = (await companyState(ctx.db, id))!;
			const changes = KEYS.map((k) => ({ field: k, from: before[k] ?? null, to: after[k] ?? null })).filter((ch) => ch.from !== ch.to);
			return {
				summary: changes.length ? `Updated company ${after.name}: ${changes.map((ch) => ch.field).join(', ')}` : `No change to ${after.name}`,
				before,
				after,
				changes,
				url: `${ctx.baseUrl}/companies/${id}`,
				result: { company_id: id }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as CompanyState;
			const a = after as CompanyState;
			const now = await companyState(ctx.db, a.company_id);
			if (!now) throw new UndoRefused('That company no longer exists.');
			const changed = KEYS.find((k) => (now[k] ?? null) !== (a[k] ?? null));
			if (changed) throw new UndoRefused(`${now.name}'s ${changed} changed since — nothing was undone.`);
			try {
				await apply(ctx, a.company_id, { name: b.name, domain: b.domain ?? '', website: b.website ?? '', notes: b.notes ?? '' });
			} catch (e) {
				throw new UndoRefused(e instanceof Error ? e.message : 'Undo failed.');
			}
		}
	}
];
