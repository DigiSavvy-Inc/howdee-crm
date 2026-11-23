// Dashboard activity feed (#133) — one normalized, newest-first stream over the tables
// that already record "something happened": tracking events, replies, unsubscribes (with
// reason), form submissions (webhook_events), new contacts, automation passes, and site
// tracking (#153: `site_events` pageviews + custom events, type `visited`), and pipeline
// moves (#207: `pipeline_history`, type `pipeline`), domain-auth breakages (#304: the
// JSON list in `app_state.domain_auth_events`, type `domain_auth`), and deliverability alerts
// (#305: `deliverability_checks` at warning/critical, type `deliverability`), and assistant
// permission changes (#322 addendum: the JSON list in `app_state.ai_setting_events`, type
// `assistant_setting`). Pure read layer, no new schema.
//
// Each source is its own SELECT with its own ORDER BY … LIMIT (so SQLite never sorts
// more than `limit` rows per source). These used to be combined with one big UNION ALL
// and re-sorted in SQL, but D1 caps the number of terms in a compound SELECT
// ("too many terms in compound SELECT: SQLITE_ERROR") well below the ~8-10 sources this
// feed can have active at once (all types minus `delivery`, plus the events query covering
// open/click/bounce/delivery in one source). So instead each source runs as its own
// independent query — via `db.batch()` when available (one network round trip), falling
// back to `Promise.all` otherwise — and the results are concatenated, sorted by `at` DESC
// (ties broken by `type` then the source row's own id, newest id first) and sliced to
// `limit` in JS. Only the sources the requested types need are queried at all — a type
// with no matching source is skipped entirely, not filtered out after the fact.
//
// Unsubscribes come from the `unsubscribes` table only, never from `events`: the Postmark
// webhook writes BOTH an `unsubscribe`/`spam` event and an `unsubscribes` row, and only the
// latter carries a reason (and covers our own /unsubscribe page) — reading both would
// show every Postmark unsubscribe twice.

export type ActivityType =
	| 'open'
	| 'click'
	| 'bounce'
	| 'delivery'
	| 'unsubscribe'
	| 'spam'
	| 'reply'
	| 'form'
	| 'contact'
	| 'confirm_sent' // #510: double opt-in email sent
	| 'confirmed' // #510: confirmed the subscription
	| 'enrolled'
	| 'completed'
	| 'visited'
	| 'pipeline'
	| 'domain_auth'
	| 'deliverability'
	| 'assistant_setting'
	// #566: company timeline only (company-timeline.ts) — never read by recentActivity.
	| 'gmail'
	| 'github'
	| 'invoice'
	| 'payment'
	| 'timing';

export type ActivityItem = {
	at: string; // UTC 'YYYY-MM-DD HH:MM:SS'
	type: ActivityType;
	contact_id: number | null;
	email: string | null;
	name: string | null;
	campaign_id: number | null;
	subject: string | null;
	automation_id: number | null;
	automation_name: string | null;
	detail: string | null; // for `visited`: the path (pageview) or the event name
	site_name?: string | null; // `visited` only: the tracking site's name
	site_kind?: 'pageview' | 'event' | null; // `visited` only
	// `pipeline` only (#207): detail = the destination stage (NULL when removed), plus:
	pipeline_action?: 'added' | 'moved' | 'removed' | null;
	pipeline_from?: string | null; // the stage it left (moved/removed)
	actor_kind?: string | null; // user | automation | api | system — automation_id/_name set for 'automation'
	actor_label?: string | null; // @login for a user
	// `deliverability` only (#305): detail = the level (warning|critical), plus the check.
	check_key?: string | null; // '2h' | '24h' | '7d:<date>'
	// `assistant_setting` only (#322 addendum): detail = 'on' | 'off' (allowDelete) or the
	// choice 'off' | 'admins' | 'everyone' (allowCode, #327), actor_label = '@login',
	// setting = which permission ('allowDelete' | 'allowCode').
	setting?: string | null;
	// `form` only (#516): the hosted form a submission came from (NULL for a form webhook).
	form_id?: number | null;
	// `reply` only: the replies row id (#566: the company timeline links it to its conversation).
	reply_id?: number | null;
	// #566 company timeline: the conversation thread key (`reply`, `gmail`), Gmail's direction,
	// an external link (GitHub issue, Zoho invoice), a reference (repo#n, invoice number), a
	// status (issue / invoice) and an amount (invoice / payment).
	conv_key?: string | null;
	direction?: 'in' | 'out' | null;
	url?: string | null;
	ref?: string | null;
	status?: string | null;
	amount?: number | null;
	currency?: string | null;
};

/** Every type except `delivery` (one per send — it would drown the feed). */
export const DEFAULT_ACTIVITY_TYPES: ActivityType[] = [
	'open',
	'click',
	'bounce',
	'unsubscribe',
	'spam',
	'reply',
	'form',
	'contact',
	'confirm_sent',
	'confirmed',
	'enrolled',
	'completed',
	'visited',
	'pipeline',
	'domain_auth',
	'deliverability',
	'assistant_setting'
];

/** Filter chips on the dashboard feed card → `?feed=` value → the types it shows. */
export const FEED_FILTERS: { key: string; label: string; types: ActivityType[] }[] = [
	{ key: 'all', label: 'All', types: DEFAULT_ACTIVITY_TYPES },
	{ key: 'opens', label: 'Opens', types: ['open'] },
	{ key: 'clicks', label: 'Clicks', types: ['click'] },
	{ key: 'unsubs', label: 'Unsubs', types: ['unsubscribe', 'spam'] },
	{ key: 'replies', label: 'Replies', types: ['reply'] },
	{ key: 'forms', label: 'Forms', types: ['form'] },
	{ key: 'contacts', label: 'New contacts', types: ['contact', 'confirm_sent', 'confirmed'] },
	{ key: 'automations', label: 'Automations', types: ['enrolled', 'completed'] },
	{ key: 'site', label: 'Site', types: ['visited'] },
	{ key: 'pipeline', label: 'Pipeline', types: ['pipeline'] },
	{ key: 'deliverability', label: 'Alerts', types: ['deliverability'] }
];

export function parseFeedFilter(value: string | null): string {
	return FEED_FILTERS.some((f) => f.key === value) ? (value as string) : 'all';
}

export function feedTypes(key: string): ActivityType[] {
	return (FEED_FILTERS.find((f) => f.key === key) ?? FEED_FILTERS[0]).types;
}

// Feed size (25/50/100), stored in app_state so the choice sticks across sessions.
export const FEED_SIZES = [25, 50, 100];
export const FEED_SIZE_KEY = 'dashboard_feed_size';

export async function getFeedSize(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(FEED_SIZE_KEY).first<{ value: string | null }>();
	const n = Number(row?.value);
	return FEED_SIZES.includes(n) ? n : 25;
}

export async function setFeedSize(db: D1Database, size: number): Promise<boolean> {
	if (!FEED_SIZES.includes(size)) return false;
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(FEED_SIZE_KEY, String(size))
		.run();
	return true;
}

// Display name off a contacts row aliased `c`: full name, else first + last, else NULL.
const NAME_SQL = `COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''))`;

const EVENT_TYPES: ActivityType[] = ['open', 'click', 'bounce', 'delivery'];

// Every per-source SELECT yields the common columns plus `sort_id` (that source's own
// row id) so sources can be merged and tie-broken in JS without a SQL UNION.
type Source = { sql: string; params: unknown[] };
type SourceRow = ActivityItem & { sort_id: number | null };

/** #423: a contacts predicate — `where` is a `WHERE …` over unaliased `contacts` (contactsWhere). */
export type ActivityScope = { where: string; binds: unknown[] };

export type ActivityOptions = {
	limit?: number;
	types?: ActivityType[];
	// #423: only rows about contacts matching this filter (sources with no contact are skipped).
	scope?: ActivityScope;
	// #423: drop rows about archived contacts (rows with no contact stay).
	excludeArchived?: boolean;
	// #423: only rows at/after this UTC 'YYYY-MM-DD HH:MM:SS'.
	since?: string;
	// #566: only rows about these contacts. The fast path for a small scope (a company): each
	// source filters its own contact column with `IN (SELECT value FROM json_each(?))`, so SQLite
	// walks the contact index instead of the whole table. Sources with no contact are skipped.
	contactIds?: number[];
};

/** Hard cap on one read — the CSV export's limit; the dashboards ask for 25–100. */
export const ACTIVITY_MAX = 5000;

/** Types that are about a contact (#423: the /contacts feed only offers these). */
export const CONTACT_ACTIVITY_TYPES: ActivityType[] = DEFAULT_ACTIVITY_TYPES.filter(
	(t) => t !== 'domain_auth' && t !== 'deliverability' && t !== 'assistant_setting'
);

export async function recentActivity(db: D1Database, opts: ActivityOptions = {}): Promise<ActivityItem[]> {
	const limit = Math.max(1, Math.min(ACTIVITY_MAX, Math.floor(opts.limit ?? 25)));
	const types = new Set(opts.types ?? DEFAULT_ACTIVITY_TYPES);
	const sources: Source[] = [];

	// #423: extra predicates per source — `cid` = the row's contact id expression, `at` = its
	// time column. Returned as ` AND …` text + binds, spliced before each source's ORDER BY.
	const scopeSql = opts.scope ? `SELECT id FROM contacts ${opts.scope.where}` : null;
	// `idCol` = the source's indexed contact column, when it differs from `cid` (events).
	const idsJson = opts.contactIds ? JSON.stringify([...new Set(opts.contactIds)]) : null;
	const extra = (cid: string, at: string, idCol: string = cid): { sql: string; binds: unknown[] } => {
		let sql = '';
		const binds: unknown[] = [];
		if (idsJson !== null) {
			sql += ` AND ${idCol} IN (SELECT value FROM json_each(?))`;
			binds.push(idsJson);
		}
		if (scopeSql) {
			sql += ` AND ${cid} IN (${scopeSql})`;
			binds.push(...opts.scope!.binds);
		}
		if (opts.excludeArchived) {
			sql += ` AND NOT EXISTS (SELECT 1 FROM contacts xa WHERE xa.id = ${cid} AND xa.archived_at IS NOT NULL)`;
		}
		if (opts.since) {
			sql += ` AND ${at} >= ?`;
			binds.push(opts.since);
		}
		return { sql, binds };
	};
	// A scoped feed only has contact rows: the app-wide sources (no contact) are skipped.
	const contactless = !!opts.scope || !!opts.contactIds;
	if (opts.contactIds && !opts.contactIds.length) return [];
	const sinceSql = (at: string) => (opts.since ? ` AND ${at} >= ?` : '');
	const sinceBinds = opts.since ? [opts.since] : [];

	const eventTypes = EVENT_TYPES.filter((t) => types.has(t));
	if (eventTypes.length) {
		// `detail` is the Postmark payload truncated to 4000 chars — possibly invalid JSON,
		// and json_extract throws on that, so guard with json_valid.
		// The webhook stores the recipient's contact on the event, so the id filter reads
		// e.contact_id (idx_events_contact_type_time).
		const x = extra('COALESCE(e.contact_id, r.contact_id)', 'e.recorded_at', 'e.contact_id');
		sources.push({
			sql: `SELECT e.recorded_at AS at, e.type AS type, COALESCE(e.contact_id, r.contact_id) AS contact_id,
			             COALESCE(c.email, r.email) AS email, ${NAME_SQL} AS name,
			             e.campaign_id AS campaign_id, cp.subject AS subject,
			             cp.automation_id AS automation_id, a.name AS automation_name,
			             CASE WHEN json_valid(e.detail) THEN
			               CASE e.type WHEN 'click' THEN json_extract(e.detail, '$.OriginalLink')
			                           WHEN 'bounce' THEN json_extract(e.detail, '$.Type') END
			             END AS detail,
			             e.id AS sort_id
			      FROM events e
			      LEFT JOIN recipients r ON r.id = e.recipient_id
			      LEFT JOIN contacts c ON c.id = COALESCE(e.contact_id, r.contact_id)
			      LEFT JOIN campaigns cp ON cp.id = e.campaign_id
			      LEFT JOIN automations a ON a.id = cp.automation_id
			      WHERE e.type IN (${eventTypes.map(() => '?').join(', ')})${x.sql}
			      ORDER BY e.recorded_at DESC, e.id DESC LIMIT ?`,
			params: [...eventTypes, ...x.binds, limit]
		});
	}

	if (types.has('reply')) {
		const x = extra('rp.contact_id', 'rp.received_at');
		sources.push({
			sql: `SELECT rp.received_at AS at, 'reply' AS type, rp.contact_id AS contact_id,
			             COALESCE(c.email, rp.from_email) AS email, ${NAME_SQL} AS name,
			             rp.campaign_id AS campaign_id, cp.subject AS subject,
			             cp.automation_id AS automation_id, a.name AS automation_name,
			             rp.subject AS detail, rp.id AS reply_id, rp.id AS sort_id
			      FROM replies rp
			      LEFT JOIN contacts c ON c.id = rp.contact_id
			      LEFT JOIN campaigns cp ON cp.id = rp.campaign_id
			      LEFT JOIN automations a ON a.id = cp.automation_id
			      WHERE 1 = 1${x.sql}
			      ORDER BY rp.received_at DESC, rp.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
	}

	if (types.has('unsubscribe') || types.has('spam')) {
		// The webhook records a spam complaint as an unsubscribes row with this reason.
		const kinds = [types.has('unsubscribe') ? 'unsubscribe' : null, types.has('spam') ? 'spam' : null].filter(Boolean);
		const x = extra('c.id', 'u.created_at');
		sources.push({
			sql: `SELECT * FROM (
			        SELECT u.created_at AS at,
			               CASE WHEN u.reason = 'Marked as spam' THEN 'spam' ELSE 'unsubscribe' END AS type,
			               c.id AS contact_id, u.email AS email, ${NAME_SQL} AS name,
			               u.campaign_id AS campaign_id, cp.subject AS subject,
			               cp.automation_id AS automation_id, a.name AS automation_name,
			               u.reason AS detail, u.id AS sort_id
			        FROM unsubscribes u
			        LEFT JOIN contacts c ON c.email = u.email
			        LEFT JOIN campaigns cp ON cp.id = u.campaign_id
			        LEFT JOIN automations a ON a.id = cp.automation_id
			        WHERE 1 = 1${x.sql}
			      ) WHERE type IN (${kinds.map(() => '?').join(', ')})
			      ORDER BY at DESC, sort_id DESC LIMIT ?`,
			params: [...x.binds, ...kinds, limit]
		});
	}

	if (types.has('form')) {
		// Accepted form submissions only — rejected/ignored ones (honeypot, junk) stay on
		// the /webhooks activity log, where debugging happens.
		const x = extra('c.id', 'w.created_at');
		sources.push({
			sql: `SELECT w.created_at AS at, 'form' AS type, c.id AS contact_id, w.email AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject, NULL AS automation_id, NULL AS automation_name,
			             COALESCE(k.label, 'form webhook') AS detail, w.id AS sort_id
			      FROM webhook_events w
			      LEFT JOIN webhook_keys k ON k.id = w.key_id
			      LEFT JOIN contacts c ON c.email = w.email
			      WHERE w.status IN ('added', 'updated')${x.sql}
			      ORDER BY w.created_at DESC, w.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
		// #509: hosted forms — accepted submissions that created / updated a contact; detail =
		// the form's name. Spam / rejected stay on the form's Submissions tab. #589: plus the
		// ratings given in that submission ("Feedback · rated 4 / 5").
		const xf = extra('s.contact_id', 's.created_at');
		sources.push({
			sql: `SELECT s.created_at AS at, 'form' AS type, s.contact_id AS contact_id, COALESCE(c.email, s.email) AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject, NULL AS automation_id, NULL AS automation_name,
			             f.name || COALESCE((SELECT ' · rated ' || group_concat(r.value || ' / ' || r.high, ', ')
			                                   FROM contact_ratings r WHERE r.submission_id = s.id), '') AS detail, s.id AS sort_id, f.id AS form_id
			      FROM form_submissions s
			      JOIN forms f ON f.id = s.form_id
			      LEFT JOIN contacts c ON c.id = s.contact_id
			      WHERE s.status IN ('added', 'updated')${xf.sql}
			      ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
			params: [...xf.binds, limit]
		});
	}

	if (types.has('contact')) {
		const x = extra('c.id', 'c.created_at');
		sources.push({
			sql: `SELECT c.created_at AS at, 'contact' AS type, c.id AS contact_id, c.email AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject, NULL AS automation_id, NULL AS automation_name,
			             c.source AS detail, c.id AS sort_id
			      FROM contacts c
			      WHERE 1 = 1${x.sql}
			      ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
	}

	// #510: double opt-in — the confirm email (first send) and the confirmation.
	if (types.has('confirm_sent')) {
		const x = extra('sc.contact_id', 'sc.created_at');
		sources.push({
			sql: `SELECT sc.created_at AS at, 'confirm_sent' AS type, sc.contact_id AS contact_id, c.email AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject, NULL AS automation_id, NULL AS automation_name,
			             sc.source AS detail, sc.id AS sort_id
			      FROM subscription_confirmations sc
			      JOIN contacts c ON c.id = sc.contact_id
			      WHERE 1 = 1${x.sql}
			      ORDER BY sc.created_at DESC, sc.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
	}
	if (types.has('confirmed')) {
		const x = extra('sc.contact_id', 'sc.confirmed_at');
		sources.push({
			sql: `SELECT sc.confirmed_at AS at, 'confirmed' AS type, sc.contact_id AS contact_id, c.email AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject, NULL AS automation_id, NULL AS automation_name,
			             NULL AS detail, sc.id AS sort_id
			      FROM subscription_confirmations sc
			      JOIN contacts c ON c.id = sc.contact_id
			      WHERE sc.confirmed_at IS NOT NULL${x.sql}
			      ORDER BY sc.confirmed_at DESC, sc.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
	}

	if (types.has('enrolled')) {
		const x = extra('en.contact_id', 'en.enrolled_at');
		sources.push({
			sql: `SELECT en.enrolled_at AS at, 'enrolled' AS type, en.contact_id AS contact_id, c.email AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject, en.automation_id AS automation_id, a.name AS automation_name,
			             NULL AS detail, en.id AS sort_id
			      FROM automation_enrollments en
			      JOIN contacts c ON c.id = en.contact_id
			      LEFT JOIN automations a ON a.id = en.automation_id
			      WHERE 1 = 1${x.sql}
			      ORDER BY en.enrolled_at DESC, en.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
	}

	if (types.has('completed')) {
		const x = extra('en.contact_id', 'en.ended_at');
		sources.push({
			sql: `SELECT en.ended_at AS at, 'completed' AS type, en.contact_id AS contact_id, c.email AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject, en.automation_id AS automation_id, a.name AS automation_name,
			             NULL AS detail, en.id AS sort_id
			      FROM automation_enrollments en
			      JOIN contacts c ON c.id = en.contact_id
			      LEFT JOIN automations a ON a.id = en.automation_id
			      WHERE en.status = 'completed' AND en.ended_at IS NOT NULL${x.sql}
			      ORDER BY en.ended_at DESC, en.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
	}

	if (types.has('visited')) {
		const x = extra('se.contact_id', 'se.occurred_at');
		sources.push({
			sql: `SELECT se.occurred_at AS at, 'visited' AS type, se.contact_id AS contact_id, c.email AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject, NULL AS automation_id, NULL AS automation_name,
			             CASE se.kind WHEN 'event' THEN se.name ELSE COALESCE(se.path, '/') END AS detail,
			             ts.name AS site_name, se.kind AS site_kind, se.id AS sort_id
			      FROM site_events se
			      JOIN contacts c ON c.id = se.contact_id
			      LEFT JOIN tracking_sites ts ON ts.id = se.site_id
			      WHERE 1 = 1${x.sql}
			      ORDER BY se.occurred_at DESC, se.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
	}

	if (types.has('pipeline')) {
		// A stage deletion's system rows have from = to (the destination) → 'moved'.
		const x = extra('h.contact_id', 'h.created_at');
		sources.push({
			sql: `SELECT h.created_at AS at, 'pipeline' AS type, h.contact_id AS contact_id, c.email AS email, ${NAME_SQL} AS name,
			             NULL AS campaign_id, NULL AS subject,
			             CASE WHEN h.actor_kind = 'automation' THEN h.actor_id END AS automation_id,
			             CASE WHEN h.actor_kind = 'automation' THEN a.name END AS automation_name,
			             ts.name AS detail, fs.name AS pipeline_from,
			             CASE WHEN h.to_stage_id IS NULL THEN 'removed' WHEN h.from_stage_id IS NULL THEN 'added' ELSE 'moved' END AS pipeline_action,
			             h.actor_kind AS actor_kind,
			             CASE WHEN h.actor_kind = 'user' THEN (SELECT '@' || u.github_login FROM users u WHERE u.id = h.actor_id) END AS actor_label,
			             h.id AS sort_id
			      FROM pipeline_history h
			      JOIN contacts c ON c.id = h.contact_id
			      LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id
			      LEFT JOIN pipeline_stages ts ON ts.id = h.to_stage_id
			      LEFT JOIN automations a ON a.id = h.actor_id AND h.actor_kind = 'automation'
			      WHERE 1 = 1${x.sql}
			      ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
			params: [...x.binds, limit]
		});
	}

	if (types.has('domain_auth') && !contactless) {
		// #304: a DMARC/SPF/DKIM/Return-Path check that went pass → fail. email = the domain,
		// detail = the banner text. Rows live as a JSON array in app_state (no table).
		sources.push({
			sql: `SELECT json_extract(j.value, '$.at') AS at, 'domain_auth' AS type, NULL AS contact_id,
			             json_extract(j.value, '$.domain') AS email, NULL AS name,
			             NULL AS campaign_id, NULL AS subject, NULL AS automation_id, NULL AS automation_name,
			             json_extract(j.value, '$.text') AS detail, CAST(j.key AS INTEGER) AS sort_id
			      FROM app_state s, json_each(CASE WHEN json_valid(s.value) AND json_type(s.value) = 'array' THEN s.value ELSE '[]' END) j
			      WHERE s.key = 'domain_auth_events'${sinceSql("json_extract(j.value, '$.at')")}
			      ORDER BY at DESC, sort_id DESC LIMIT ?`,
			params: [...sinceBinds, limit]
		});
	}

	if (types.has('deliverability') && !contactless) {
		sources.push({
			sql: `SELECT d.checked_at AS at, 'deliverability' AS type, NULL AS contact_id, NULL AS email, NULL AS name,
			             CASE WHEN d.scope = 'campaign' THEN d.ref_id END AS campaign_id,
			             CASE WHEN d.scope = 'campaign' THEN (SELECT subject FROM campaigns WHERE id = d.ref_id) END AS subject,
			             CASE WHEN d.scope = 'automation' THEN d.ref_id END AS automation_id,
			             CASE WHEN d.scope = 'automation' THEN (SELECT name FROM automations WHERE id = d.ref_id) END AS automation_name,
			             d.level AS detail, d.check_key AS check_key, d.id AS sort_id
			      FROM deliverability_checks d
			      WHERE d.level IN ('warning', 'critical')${sinceSql('d.checked_at')}
			      ORDER BY d.checked_at DESC, d.id DESC LIMIT ?`,
			params: [...sinceBinds, limit]
		});
	}

	if (types.has('assistant_setting') && !contactless) {
		// #322 addendum: Settings → Assistant → Permissions changes (who, on/off). Rows live as a
		// JSON array in app_state (no table), written by setAllowDelete / setAllowCode (./ai/config.ts).
		sources.push({
			sql: `SELECT json_extract(j.value, '$.at') AS at, 'assistant_setting' AS type, NULL AS contact_id,
			             NULL AS email, NULL AS name,
			             NULL AS campaign_id, NULL AS subject, NULL AS automation_id, NULL AS automation_name,
			             CASE WHEN json_type(j.value, '$.value') = 'text' THEN json_extract(j.value, '$.value')
			                  WHEN json_extract(j.value, '$.value') THEN 'on' ELSE 'off' END AS detail,
			             'user' AS actor_kind, '@' || json_extract(j.value, '$.login') AS actor_label,
			             json_extract(j.value, '$.setting') AS setting, CAST(j.key AS INTEGER) AS sort_id
			      FROM app_state s, json_each(CASE WHEN json_valid(s.value) AND json_type(s.value) = 'array' THEN s.value ELSE '[]' END) j
			      WHERE s.key = 'ai_setting_events'${sinceSql("json_extract(j.value, '$.at')")}
			      ORDER BY at DESC, sort_id DESC LIMIT ?`,
			params: [...sinceBinds, limit]
		});
	}

	if (!sources.length) return [];

	// Run each source as its own query (D1's compound-select cap — see the top-of-file
	// comment) rather than UNION ALL-ing them together. db.batch() sends them in a single
	// round trip; fall back to Promise.all if a test/runtime D1 stub doesn't implement it.
	const statements = sources.map((s) => db.prepare(s.sql).bind(...s.params));
	const resultSets: D1Result<SourceRow>[] =
		typeof db.batch === 'function'
			? await db.batch<SourceRow>(statements)
			: await Promise.all(statements.map((stmt) => stmt.all<SourceRow>()));

	// Merge in JS: concat every source's (already limited) rows, sort newest-first, tie
	// broken by type then that source row's own id (highest/newest first), then cut to
	// the overall limit.
	const merged = resultSets.flatMap((r) => r.results ?? []);
	merged.sort((a, b) => {
		if (a.at !== b.at) return a.at < b.at ? 1 : -1;
		if (a.type !== b.type) return a.type < b.type ? -1 : 1;
		return (b.sort_id ?? 0) - (a.sort_id ?? 0);
	});

	return merged.slice(0, limit).map(({ sort_id, ...item }) => item);
}

// ---------------------------------------------------------------------------
// #423: the /contacts feed — group by contact, row extras, type multi-select
// ---------------------------------------------------------------------------

export type ActivityGroup = {
	contact_id: number;
	email: string | null;
	name: string | null;
	at: string; // newest event
	items: ActivityItem[]; // newest first, ≤ perContact
	more: number; // events of this contact in the read beyond `items`
};

/** One group per contact (newest activity first) with its last `perContact` events. Rows with no contact are dropped. */
export function groupActivityByContact(items: ActivityItem[], perContact = 3, limit = 25): ActivityGroup[] {
	const groups = new Map<number, ActivityGroup>();
	for (const it of items) {
		if (it.contact_id == null) continue;
		let g = groups.get(it.contact_id);
		if (!g) {
			if (groups.size >= limit) continue;
			g = { contact_id: it.contact_id, email: it.email, name: it.name, at: it.at, items: [], more: 0 };
			groups.set(it.contact_id, g);
		}
		if (g.items.length < perContact) g.items.push(it);
		else g.more++;
	}
	return [...groups.values()];
}

export type ActivityExtra = { tier: string; score: number | null; company: string | null; company_id: number | null };

/** Tier + company per contact in the feed (the /contacts rows' extras), keyed by contact id. */
export async function activityExtras(db: D1Database, items: ActivityItem[]): Promise<Record<number, ActivityExtra>> {
	const ids = [...new Set(items.map((i) => i.contact_id).filter((id): id is number => id != null))];
	if (!ids.length) return {};
	const rows = await db
		.prepare(
			`SELECT c.id, c.company, c.company_id, COALESCE(ce.tier, 'new') AS tier, ce.score
			 FROM contacts c LEFT JOIN contact_engagement ce ON ce.contact_id = c.id
			 WHERE c.id IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(ids))
		.all<ActivityExtra & { id: number }>();
	return Object.fromEntries(rows.results.map(({ id, ...rest }) => [id, rest]));
}

/** `?feed_types=open,click` → the contact activity types it names (unknown dropped; none = all). */
export function parseFeedTypes(value: string | null): ActivityType[] {
	const picked = (value ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s): s is ActivityType => (CONTACT_ACTIVITY_TYPES as string[]).includes(s));
	return [...new Set(picked)];
}

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
	open: 'Opens',
	click: 'Clicks',
	bounce: 'Bounces',
	delivery: 'Deliveries',
	unsubscribe: 'Unsubscribes',
	spam: 'Spam complaints',
	reply: 'Replies',
	gmail: 'Gmail',
	github: 'GitHub',
	invoice: 'Invoices',
	payment: 'Payments',
	timing: 'Timing',
	form: 'Forms',
	contact: 'New contacts',
	confirm_sent: 'Confirmation sent',
	confirmed: 'Confirmed subscription',
	enrolled: 'Entered automation',
	completed: 'Completed automation',
	visited: 'Site',
	pipeline: 'Pipeline',
	domain_auth: 'Domain auth',
	deliverability: 'Alerts',
	assistant_setting: 'Assistant settings'
};
