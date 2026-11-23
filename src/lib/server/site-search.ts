// Site-wide search (#477): one round trip (db.batch) over contacts, companies, campaigns and
// automations for the Cmd/Ctrl+K palette. Read-only. Every signed-in user sees what the four
// list pages show them (none of those pages filters rows by role), archived contacts are left
// out like the /api/contacts/search typeahead, and company billing is never read.
//
// Ranking inside a group: exact match (any field), then prefix, then substring; ties go to the
// most recent record. Matching uses the escaped-LIKE convention of /api/contacts/search, so a
// user's %, _ and \ are literal.

import { triggerText, type TriggerContext, type TriggerFields } from '$lib/automation-trigger';
import { triggerEmailNames } from '$lib/server/engagement-trigger-read';
import { SEARCH_TOTAL_CAP, type SearchResponse } from '$lib/site-search';
import { visibleCampaignSql } from '$lib/server/system-mail';
import { activeContactSql } from '$lib/server/active-audience';

export const SEARCH_MAX_LIMIT = 10;

/** `\`, `%`, `_` escaped for `LIKE … ESCAPE '\'`. */
export function escapeLike(q: string): string {
	return q.replace(/[\\%_]/g, '\\$&');
}

/** The rank of the best field: 0 = exact (case-insensitive), 1 = prefix, 2 = substring. */
function rankSql(fields: string[]): string {
	const exact = fields.map((f) => `${f} LIKE ?1 ESCAPE '\\'`).join(' OR ');
	const prefix = fields.map((f) => `${f} LIKE ?2 ESCAPE '\\'`).join(' OR ');
	return `CASE WHEN ${exact} THEN 0 WHEN ${prefix} THEN 1 ELSE 2 END`;
}
function matchSql(fields: string[]): string {
	return `(${fields.map((f) => `${f} LIKE ?3 ESCAPE '\\'`).join(' OR ')})`;
}
/** COUNT that stops at cap + 1 rows, so a broad query never counts the whole table. */
function cappedCount(from: string, where: string): string {
	return `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${from} WHERE ${where} LIMIT ${SEARCH_TOTAL_CAP + 1})`;
}

// Same fields as the /contacts quick search (buildContactSearch), so "See all" lands on the
// same set.
const CONTACT_FIELDS = [
	'c.email',
	'c.name',
	'c.first_name',
	'c.last_name',
	'c.company',
	"TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))"
];
const COMPANY_FIELDS = ['co.name', 'co.domain'];
// Campaigns have no internal name column; the subject is the name (/campaigns ?q= matches it).
const CAMPAIGN_FIELDS = ['cp.subject'];
const AUTOMATION_FIELDS = ['a.name'];
// Labels ("automation tags", #74/#432) match too.
const AUTOMATION_MATCH = `(a.name LIKE ?3 ESCAPE '\\' OR EXISTS (SELECT 1 FROM automation_labels al WHERE al.automation_id = a.id AND al.label LIKE ?3 ESCAPE '\\'))`;

// #705: the active audience only — unsubscribed / archived contacts are found on /contacts.
const CONTACT_WHERE = `${activeContactSql('c')} AND ${matchSql(CONTACT_FIELDS)}`;
const COMPANY_WHERE = matchSql(COMPANY_FIELDS);
const CAMPAIGN_WHERE = `${visibleCampaignSql('cp')} AND (${matchSql(CAMPAIGN_FIELDS)})`; // #668

type ContactRow = { id: number; email: string; name: string | null; first_name: string | null; last_name: string | null; company: string | null; tier: string | null };
type CompanyRow = { id: number; name: string; domain: string | null; contact_count: number };
type CampaignRow = { id: number; subject: string; status: string; sent_at: string | null; scheduled_at: string | null; created_at: string | null };
type AutomationRow = TriggerFields & { id: number; name: string; status: string; reentry: string };

function total(n: number | undefined): { total: number; capped: boolean } {
	const v = n ?? 0;
	return v > SEARCH_TOTAL_CAP ? { total: SEARCH_TOTAL_CAP, capped: true } : { total: v, capped: false };
}

function contactName(r: ContactRow): string {
	const n = (r.name ?? '').trim() || [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
	return n || r.email;
}

/** Runs the four groups. `q` is trimmed by the caller and non-empty. */
export async function siteSearch(db: D1Database, q: string, limit = 5): Promise<SearchResponse> {
	const n = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit) || 5));
	const esc = escapeLike(q.slice(0, 100));
	const binds = [esc, `${esc}%`, `%${esc}%`];

	const stmts = [
		db
			.prepare(
				`SELECT c.id, c.email, c.name, c.first_name, c.last_name,
				        COALESCE(co.name, c.company) AS company, ce.tier
				 FROM contacts c
				 LEFT JOIN companies co ON co.id = c.company_id
				 LEFT JOIN contact_engagement ce ON ce.contact_id = c.id
				 WHERE ${CONTACT_WHERE}
				 ORDER BY ${rankSql(CONTACT_FIELDS)}, c.id DESC
				 LIMIT ${n}`
			)
			.bind(...binds),
		db.prepare(cappedCount('contacts c', CONTACT_WHERE)).bind(...binds),
		db
			.prepare(
				`SELECT co.id, co.name, co.domain,
				        (SELECT COUNT(*) FROM contacts x WHERE x.company_id = co.id AND ${activeContactSql('x')}) AS contact_count
				 FROM companies co
				 WHERE ${COMPANY_WHERE}
				 ORDER BY ${rankSql(COMPANY_FIELDS)}, co.updated_at DESC, co.id DESC
				 LIMIT ${n}`
			)
			.bind(...binds),
		db.prepare(cappedCount('companies co', COMPANY_WHERE)).bind(...binds),
		db
			.prepare(
				`SELECT cp.id, cp.subject, cp.status, cp.sent_at, cp.scheduled_at, cp.created_at
				 FROM campaigns cp
				 WHERE ${CAMPAIGN_WHERE}
				 ORDER BY ${rankSql(CAMPAIGN_FIELDS)}, COALESCE(cp.sent_at, cp.scheduled_at, cp.created_at) DESC, cp.id DESC
				 LIMIT ${n}`
			)
			.bind(...binds),
		db.prepare(cappedCount('campaigns cp', CAMPAIGN_WHERE)).bind(...binds),
		db
			.prepare(
				`SELECT a.id, a.name, a.status, a.reentry, a.trigger_type, a.trigger_list_id, a.trigger_metric,
				        a.trigger_direction, a.trigger_threshold, a.trigger_site_id, a.trigger_path_op, a.trigger_path,
				        a.trigger_cooldown_hours, a.trigger_stage_id, a.trigger_config
				 FROM automations a
				 WHERE ${AUTOMATION_MATCH}
				 ORDER BY ${rankSql(AUTOMATION_FIELDS)}, a.id DESC
				 LIMIT ${n}`
			)
			.bind(...binds),
		db.prepare(cappedCount('automations a', AUTOMATION_MATCH)).bind(...binds)
	];
	const res = await db.batch(stmts);
	const rows = <T>(i: number) => (res[i].results ?? []) as T[];
	const count = (i: number) => (rows<{ n: number }>(i)[0]?.n ?? 0);

	const automations = rows<AutomationRow>(6);
	const triggers = await automationTriggerTexts(db, automations);

	return {
		q,
		contacts: {
			items: rows<ContactRow>(0).map((r) => ({
				id: r.id,
				title: contactName(r),
				email: r.email,
				company: r.company || null,
				tier: r.tier ?? 'new',
				href: `/contacts/${r.id}`
			})),
			...total(count(1))
		},
		companies: {
			items: rows<CompanyRow>(2).map((r) => ({
				id: r.id,
				title: r.name,
				domain: r.domain,
				contact_count: r.contact_count,
				href: `/companies/${r.id}`
			})),
			...total(count(3))
		},
		campaigns: {
			// Same target as the /campaigns rows: the campaign page (a draft or scheduled one offers
			// Edit from there).
			items: rows<CampaignRow>(4).map((r) => ({
				id: r.id,
				title: r.subject || '(no subject)',
				status: r.status,
				date: r.sent_at ?? r.scheduled_at ?? null,
				href: `/campaign/${r.id}`
			})),
			...total(count(5))
		},
		automations: {
			items: automations.map((r, i) => ({
				id: r.id,
				title: r.name,
				status: r.status,
				trigger: triggers[i],
				href: `/automations/${r.id}`
			})),
			...total(count(7))
		}
	};
}

/** The list page's trigger line (`triggerText`) for a handful of automations — one extra
 *  batch, only when there are automations to describe. */
async function automationTriggerTexts(db: D1Database, rows: AutomationRow[]): Promise<string[]> {
	if (!rows.length) return [];
	const listIds = new Set<number>();
	for (const r of rows) {
		if (r.trigger_list_id) listIds.add(r.trigger_list_id);
		try {
			const cfg = r.trigger_config ? JSON.parse(r.trigger_config) : null;
			if (cfg && typeof cfg.list_id === 'number') listIds.add(cfg.list_id);
			if (cfg && typeof cfg.topic_list_id === 'number') listIds.add(cfg.topic_list_id);
		} catch {
			// a junk config just names no list
		}
	}
	try {
		const [lists, sites, stages, scores] = await db.batch([
			db
				.prepare(`SELECT id, name, kind, (kind = 'segment' AND rules IS NOT NULL) AS dynamic FROM lists WHERE id IN (SELECT value FROM json_each(?))`)
				.bind(JSON.stringify([...listIds])),
			db.prepare('SELECT id, name FROM tracking_sites'),
			db.prepare('SELECT id, name FROM pipeline_stages'),
			db.prepare('SELECT id, name FROM score_defs')
		]);
		const ctx: TriggerContext = {
			lists: (lists.results ?? []) as TriggerContext['lists'],
			sites: (sites.results ?? []) as TriggerContext['sites'],
			stages: (stages.results ?? []) as TriggerContext['stages'],
			scores: (scores.results ?? []) as { id: number; name: string }[],
			emails: await triggerEmailNames(db, rows)
		};
		return rows.map((r) => {
			try {
				return triggerText(r, ctx);
			} catch {
				return '';
			}
		});
	} catch {
		return rows.map(() => '');
	}
}
