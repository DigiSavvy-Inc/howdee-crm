// Account brief sources (#388): everything the CRM holds about one company, collected into a
// plain data object for the model, plus the list of citable sources (`[tag]` → link) and the
// open-item count. Read-only. Two variants: with Zoho billing (for a viewer who may see money,
// `canSeeBilling`) and without — the "without" variant never reads the Zoho tables at all, so
// a member's brief can't contain a figure it was never given.

import type { BriefSource } from '$lib/account-brief';
import { companyConversations } from './company-conversations';
import { getCompany } from './company-read';
import { snapshot } from './snapshot';

export const BRIEF_CONTACTS_MAX = 25;
export const BRIEF_CONVERSATION_DAYS = 90;
export const BRIEF_CONVERSATION_CONTACTS = 10;
export const BRIEF_CONVERSATIONS_MAX = 10;
export const STALE_DEAL_DAYS = 30;
const EXCERPT_MAX = 300;

export type BriefInput = {
	company: { id: number; name: string; domain: string | null; website: string | null; notes: string | null };
	contacts: {
		name: string;
		email: string;
		subscribed: boolean;
		tier: string | null;
		score: number | null;
		last_open_at: string | null;
		last_click_at: string | null;
		last_reply_at: string | null;
	}[];
	contacts_total: number;
	conversations: {
		source: string;
		subject: string;
		with: string;
		last_at: string;
		awaiting_our_reply: boolean;
		messages: number;
		their_replies: number;
		last_reply_excerpt: string | null;
	}[];
	pipeline: {
		source: string;
		cards: { contact: string; stage: string; stage_kind: string; value: number | null; entered_stage_at: string; stale: boolean; note: string | null }[];
		history: { contact: string; from: string | null; to: string | null; at: string }[];
	} | null;
	timing: {
		hours_7d: number | null;
		hours_30d: number | null;
		hours_90d: number | null;
		hours_total: number | null;
		last_tracked_at: string | null;
		last_tracked_title: string | null;
		project: string | null;
	} | null;
	github: {
		issues_open: number | null;
		issues_closed: number | null;
		issues_opened_30d: number | null;
		issues_closed_30d: number | null;
		last_issue_at: string | null;
		recent_issues: { repo: string | null; number: number; title: string; state: string; updated_at: string }[];
	} | null;
	/** Present only in the billing variant (and only when the company has Zoho data). */
	billing?: {
		currency: string | null;
		outstanding: number | null;
		overdue: number | null;
		invoiced_12m: number | null;
		paid_12m: number | null;
		last_payment_at: string | null;
		last_invoice_at: string | null;
		overdue_invoices: { number: string | null; due_date: string | null; balance: number | null; currency: string | null }[];
	};
	automations: { automation: string; contact: string; enrolled_at: string }[];
	snapshots: { domain: string; status: string; created_at: string; top_issue: string | null }[];
	open_items: { awaiting_replies: number; stale_deals: number; overdue_invoices?: number };
};

export type CollectedBrief = {
	input: BriefInput;
	sources: BriefSource[];
	openItems: number;
	/** The company has Zoho billing data (whether or not this variant includes it). */
	hasBilling: boolean;
	includesBilling: boolean;
};

type ContactRow = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	subscribed: number;
	tier: string | null;
	score: number | null;
	last_open_at: string | null;
	last_click_at: string | null;
	last_reply_at: string | null;
};

function displayName(c: { email: string; name: string | null; first_name: string | null; last_name: string | null }): string {
	const n = (c.name ?? '').trim() || [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
	return n ? `${n} <${c.email}>` : c.email;
}

function dayMonth(at: string): string {
	const d = new Date(`${at.slice(0, 19).replace(' ', 'T')}Z`);
	if (Number.isNaN(d.getTime())) return at.slice(0, 10);
	return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function sqliteDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function excerpt(t: string | null | undefined): string | null {
	const s = (t ?? '').replace(/\s+/g, ' ').trim();
	if (!s) return null;
	return s.length > EXCERPT_MAX ? `${s.slice(0, EXCERPT_MAX)}…` : s;
}

/** Whether the company has mirrored Zoho data (cheap; used without reading any figure). */
export async function companyHasBilling(db: D1Database, companyId: number): Promise<boolean> {
	const r = await db
		.prepare(
			`SELECT (EXISTS (SELECT 1 FROM company_zoho_contacts WHERE company_id = ?)
			      OR EXISTS (SELECT 1 FROM company_metrics WHERE company_id = ? AND zoho_synced_at IS NOT NULL)) AS n`
		)
		.bind(companyId, companyId)
		.first<{ n: number }>();
	return !!r?.n;
}

/** Collect one company's brief input. Null when the company doesn't exist. */
export async function collectBriefSources(
	db: D1Database,
	companyId: number,
	opts: { billing: boolean; now?: Date }
): Promise<CollectedBrief | null> {
	const now = opts.now ?? new Date();
	const co = await getCompany(db, companyId);
	if (!co) return null;
	const base = `/companies/${companyId}`;
	const sources: BriefSource[] = [];
	const addSource = (tag: string, href: string, label: string): string => {
		let t = tag;
		for (let i = 2; sources.some((s) => s.tag.toLowerCase() === t.toLowerCase()); i++) t = `${tag} #${i}`;
		sources.push({ tag: t, href, label });
		return t;
	};

	// ---- contacts + engagement ----
	const contacts = await db
		.prepare(
			`SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.subscribed,
			        e.tier, e.score, e.last_open_at, e.last_click_at, e.last_reply_at
			 FROM contacts c LEFT JOIN contact_engagement e ON e.contact_id = c.id
			 WHERE c.company_id = ? AND c.archived_at IS NULL
			 ORDER BY MAX(COALESCE(e.last_reply_at, ''), COALESCE(e.last_click_at, ''), COALESCE(e.last_open_at, '')) DESC, c.id DESC
			 LIMIT ?`
		)
		.bind(companyId, BRIEF_CONTACTS_MAX)
		.all<ContactRow>();
	const byId = new Map(contacts.results.map((c) => [c.id, c]));
	if (contacts.results.length) addSource('contacts', `${base}#contacts`, `Contacts at ${co.name}`);
	if ((co.notes ?? '').trim()) addSource('notes', base, 'Company notes');

	// ---- conversations (last 90 days; shared with the company page panel, #567) ----
	const threads = await companyConversations(db, companyId, { now, days: BRIEF_CONVERSATION_DAYS, contacts: BRIEF_CONVERSATION_CONTACTS });
	const conversations: BriefInput['conversations'] = [];
	let awaiting = 0;
	for (const t of threads) if (t.awaiting) awaiting++;
	for (const t of threads.slice(0, BRIEF_CONVERSATIONS_MAX)) {
		const lastIn = [...t.messages].reverse().find((m) => m.dir === 'in');
		const kind = t.last_dir === 'in' ? 'reply' : 'email';
		const contact = t.contact_id ? byId.get(t.contact_id) : undefined;
		const tag = addSource(`${kind} ${dayMonth(t.last_at)}`, `/conversations/${encodeURIComponent(t.key)}`, `Conversation: ${t.subject || '(no subject)'}`);
		conversations.push({
			source: tag,
			subject: t.subject || '(no subject)',
			with: contact ? displayName(contact) : t.name ? `${t.name} <${t.email}>` : t.email,
			last_at: t.last_at,
			awaiting_our_reply: t.awaiting,
			messages: t.count,
			their_replies: t.replies,
			last_reply_excerpt: lastIn ? excerpt(lastIn.text ?? lastIn.snippet) : null
		});
	}

	// ---- pipeline ----
	const staleBefore = sqliteDay(new Date(now.getTime() - STALE_DEAL_DAYS * 86_400_000));
	const cards = await db
		.prepare(
			`SELECT pc.contact_id, pc.value, pc.note, pc.entered_stage_at, s.name AS stage, s.kind AS stage_kind,
			        c.email, c.name, c.first_name, c.last_name
			 FROM pipeline_cards pc JOIN contacts c ON c.id = pc.contact_id JOIN pipeline_stages s ON s.id = pc.stage_id
			 WHERE c.company_id = ? ORDER BY s.position, pc.position LIMIT 25`
		)
		.bind(companyId)
		.all<{
			contact_id: number;
			value: number | null;
			note: string | null;
			entered_stage_at: string;
			stage: string;
			stage_kind: string;
			email: string;
			name: string | null;
			first_name: string | null;
			last_name: string | null;
		}>();
	const history = await db
		.prepare(
			`SELECT ph.created_at, fs.name AS from_stage, ts.name AS to_stage, c.email, c.name, c.first_name, c.last_name
			 FROM pipeline_history ph JOIN contacts c ON c.id = ph.contact_id
			 LEFT JOIN pipeline_stages fs ON fs.id = ph.from_stage_id LEFT JOIN pipeline_stages ts ON ts.id = ph.to_stage_id
			 WHERE c.company_id = ? ORDER BY ph.id DESC LIMIT 10`
		)
		.bind(companyId)
		.all<{ created_at: string; from_stage: string | null; to_stage: string | null; email: string; name: string | null; first_name: string | null; last_name: string | null }>();
	let staleDeals = 0;
	let pipeline: BriefInput['pipeline'] = null;
	if (cards.results.length || history.results.length) {
		const one = cards.results.length === 1 ? cards.results[0].contact_id : null;
		const tag = addSource('pipeline', one ? `/contacts/${one}` : '/pipeline', 'Pipeline cards and stage history');
		pipeline = {
			source: tag,
			cards: cards.results.map((c) => {
				const stale = c.stage_kind === 'open' && c.entered_stage_at.slice(0, 10) < staleBefore;
				if (stale) staleDeals++;
				return {
					contact: displayName(c),
					stage: c.stage,
					stage_kind: c.stage_kind,
					value: c.value,
					entered_stage_at: c.entered_stage_at,
					stale,
					note: excerpt(c.note)
				};
			}),
			history: history.results.map((h) => ({ contact: displayName(h), from: h.from_stage, to: h.to_stage, at: h.created_at }))
		};
	}

	// ---- integrations: Timing + GitHub ----
	const m = await db
		.prepare(
			`SELECT m.hours_7d, m.hours_30d, m.hours_90d, m.hours_total, m.last_tracked_at, m.last_tracked_title, m.timing_synced_at,
			        m.issues_open, m.issues_closed, m.issues_opened_30d, m.issues_closed_30d, m.last_issue_at, m.recent_issues, m.github_synced_at,
			        co.timing_project_name
			 FROM companies co LEFT JOIN company_metrics m ON m.company_id = co.id WHERE co.id = ?`
		)
		.bind(companyId)
		.first<{
			hours_7d: number | null;
			hours_30d: number | null;
			hours_90d: number | null;
			hours_total: number | null;
			last_tracked_at: string | null;
			last_tracked_title: string | null;
			timing_synced_at: string | null;
			issues_open: number | null;
			issues_closed: number | null;
			issues_opened_30d: number | null;
			issues_closed_30d: number | null;
			last_issue_at: string | null;
			recent_issues: string | null;
			github_synced_at: string | null;
			timing_project_name: string | null;
		}>();
	let timing: BriefInput['timing'] = null;
	if (m?.timing_synced_at) {
		addSource('timing', `${base}#integrations`, 'Timing hours');
		timing = {
			hours_7d: m.hours_7d,
			hours_30d: m.hours_30d,
			hours_90d: m.hours_90d,
			hours_total: m.hours_total,
			last_tracked_at: m.last_tracked_at,
			last_tracked_title: m.last_tracked_title,
			project: m.timing_project_name
		};
	}
	let github: BriefInput['github'] = null;
	if (m?.github_synced_at) {
		addSource('github', `${base}#integrations`, 'GitHub issues');
		let recent: { repo?: string; number: number; title: string; state: string; updated_at: string }[] = [];
		try {
			const parsed = JSON.parse(m.recent_issues ?? '[]');
			if (Array.isArray(parsed)) recent = parsed;
		} catch {
			/* no recent list */
		}
		github = {
			issues_open: m.issues_open,
			issues_closed: m.issues_closed,
			issues_opened_30d: m.issues_opened_30d,
			issues_closed_30d: m.issues_closed_30d,
			last_issue_at: m.last_issue_at,
			recent_issues: recent.slice(0, 5).map((i) => ({ repo: i.repo ?? null, number: i.number, title: String(i.title ?? '').slice(0, 200), state: i.state, updated_at: i.updated_at }))
		};
	}

	// ---- Zoho billing (only when the viewer may see money) ----
	const hasBilling = await companyHasBilling(db, companyId);
	let billing: BriefInput['billing'];
	let overdueInvoices = 0;
	if (opts.billing && hasBilling) {
		const b = await db
			.prepare(
				`SELECT ar_outstanding, ar_overdue, invoiced_12m, paid_12m, last_payment_at, last_invoice_at, billing_currency
				 FROM company_metrics WHERE company_id = ?`
			)
			.bind(companyId)
			.first<{
				ar_outstanding: number | null;
				ar_overdue: number | null;
				invoiced_12m: number | null;
				paid_12m: number | null;
				last_payment_at: string | null;
				last_invoice_at: string | null;
				billing_currency: string | null;
			}>();
		const overdue = await db
			.prepare(
				`SELECT i.invoice_number, i.due_date, i.balance, i.currency_code FROM zoho_invoices i
				 JOIN company_zoho_contacts z ON z.zoho_contact_id = i.zoho_contact_id
				 WHERE z.company_id = ? AND COALESCE(i.balance, 0) > 0 AND i.due_date IS NOT NULL AND i.due_date < ?
				   AND COALESCE(i.status, '') NOT IN ('draft', 'void')
				 ORDER BY i.due_date LIMIT 10`
			)
			.bind(companyId, sqliteDay(now))
			.all<{ invoice_number: string | null; due_date: string | null; balance: number | null; currency_code: string | null }>();
		overdueInvoices = overdue.results.length;
		addSource('zoho', `${base}#billing`, 'Zoho Books billing');
		billing = {
			currency: b?.billing_currency ?? null,
			outstanding: b?.ar_outstanding ?? null,
			overdue: b?.ar_overdue ?? null,
			invoiced_12m: b?.invoiced_12m ?? null,
			paid_12m: b?.paid_12m ?? null,
			last_payment_at: b?.last_payment_at ?? null,
			last_invoice_at: b?.last_invoice_at ?? null,
			overdue_invoices: overdue.results.map((i) => ({ number: i.invoice_number, due_date: i.due_date, balance: i.balance, currency: i.currency_code }))
		};
	}

	// ---- automations + snapshot feature rows (via the seam, #608) ----
	const autos = await db
		.prepare(
			`SELECT a.id, a.name, e.enrolled_at, c.email, c.name AS cname, c.first_name, c.last_name
			 FROM automation_enrollments e JOIN automations a ON a.id = e.automation_id JOIN contacts c ON c.id = e.contact_id
			 WHERE c.company_id = ? AND e.status = 'active' ORDER BY e.enrolled_at DESC LIMIT 10`
		)
		.bind(companyId)
		.all<{ id: number; name: string; enrolled_at: string; email: string; cname: string | null; first_name: string | null; last_name: string | null }>();
	if (autos.results.length) {
		const ids = new Set(autos.results.map((a) => a.id));
		addSource('automations', ids.size === 1 ? `/automations/${autos.results[0].id}` : '/automations', 'Active automation passes');
	}
	const snaps = await snapshot.briefRows(db, companyId);
	if (snaps.length) addSource('snapshot', `/contacts/${snaps[0].contact_id}`, 'Snapshot');

	const input: BriefInput = {
		company: { id: co.id, name: co.name, domain: co.domain, website: co.website, notes: excerpt(co.notes) ? (co.notes ?? '').slice(0, 2000) : null },
		contacts: contacts.results.map((c) => ({
			name: displayName(c),
			email: c.email,
			subscribed: !!c.subscribed,
			tier: c.tier,
			score: c.score === null ? null : Math.round(c.score),
			last_open_at: c.last_open_at,
			last_click_at: c.last_click_at,
			last_reply_at: c.last_reply_at
		})),
		contacts_total: co.contact_count,
		conversations,
		pipeline,
		timing,
		github,
		...(billing ? { billing } : {}),
		automations: autos.results.map((a) => ({
			automation: a.name,
			contact: displayName({ email: a.email, name: a.cname, first_name: a.first_name, last_name: a.last_name }),
			enrolled_at: a.enrolled_at
		})),
		snapshots: snaps.map((s) => ({ domain: s.domain, status: s.status, created_at: s.created_at, top_issue: s.top_issue })),
		open_items: { awaiting_replies: awaiting, stale_deals: staleDeals, ...(billing ? { overdue_invoices: overdueInvoices } : {}) }
	};
	return {
		input,
		sources,
		openItems: awaiting + staleDeals + (billing ? overdueInvoices : 0),
		hasBilling,
		includesBilling: !!billing
	};
}
