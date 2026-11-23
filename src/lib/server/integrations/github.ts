// GitHub repos on a company (#169, Integrations 4/5). A company can have repos attached
// (`company_repos`); a sync pulls per-repo issue counts + the most recently updated issues
// and aggregates them into the company's `company_metrics` github columns (#168's table —
// only those columns are written, so Timing's columns are never touched).
//
// Per repo, one sync is:
//  - GET /repos/{o}/{r}/issues?state=all&sort=updated (PRs filtered out) with If-None-Match.
//    A 304 keeps the stored recent issues; when the counts (last_synced_at) are also younger
//    than SEARCH_REFRESH_MS, nothing changed and the search calls are skipped entirely.
//  - 4 Search API calls (open, closed, opened in 30d, closed in 30d) → `total_count`.
// The Search API allows 30 requests/min, so a run takes at most MAX_REPOS_PER_RUN repos,
// least-recently-synced first (repos whose last sync failed go last), and stops at the first
// rate-limit response (logged in the run's errors). Whatever didn't run is the oldest next
// time, so the next cron resumes there.

import type { FetchFn, IntegrationEnv, SyncDetail, SyncTrigger } from './index';
import { USER_AGENT } from '../user-agent';

const GITHUB_BASE = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 10_000;
/** 4 search calls per repo → 7 repos = 28 calls, under the 30/min search limit. */
export const MAX_REPOS_PER_RUN = 7;
/** A 304 on the issues listing skips the searches if the counts are younger than this. */
const SEARCH_REFRESH_MS = 24 * 60 * 60 * 1000;
const RECENT_KEEP = 5;

export type RepoRef = { owner: string; repo: string };

export type RecentIssue = {
	number: number;
	title: string;
	state: 'open' | 'closed';
	html_url: string;
	updated_at: string;
	/** "owner/repo" — set on the company-level (aggregated) list only. */
	repo?: string;
};

export type RepoRow = {
	id: number;
	company_id: number;
	owner: string;
	repo: string;
	added_at: string;
	last_synced_at: string | null;
	last_error: string | null;
	etag: string | null;
	issues_open: number | null;
	issues_closed: number | null;
	issues_opened_30d: number | null;
	issues_closed_30d: number | null;
	last_issue_at: string | null;
	recent_issues: string | null;
};

export type GithubMetrics = {
	issues_open: number | null;
	issues_closed: number | null;
	issues_opened_30d: number | null;
	issues_closed_30d: number | null;
	last_issue_at: string | null;
	recent_issues: RecentIssue[];
	github_synced_at: string | null;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `owner/repo`, `github.com/owner/repo`, or a GitHub URL (any deeper path, `.git`, query or
 * hash is ignored) → `{ owner, repo }`. Anything else → null.
 */
export function parseRepoInput(raw: string | null | undefined): RepoRef | null {
	let s = (raw ?? '').trim();
	if (!s) return null;
	s = s.replace(/^git@github\.com:/i, 'github.com/');
	let hosted = false;
	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
	if (scheme) {
		s = s.slice(scheme[0].length);
		hosted = true;
	}
	const host = /^(?:www\.)?github\.com\//i.exec(s);
	if (host) {
		s = s.slice(host[0].length);
		hosted = true;
	} else if (hosted) {
		return null; // a URL on some other host
	}
	const parts = s.split(/[?#]/)[0].split('/').filter(Boolean);
	if (parts.length < 2 || (!hosted && parts.length !== 2)) return null;
	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/i, '');
	if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
	return { owner, repo };
}

type ApiIssue = {
	number?: number;
	title?: string;
	state?: string;
	html_url?: string;
	updated_at?: string;
	pull_request?: unknown;
};

/** The issues listing also returns pull requests (they carry `pull_request`) — drop them. */
export function filterIssues(items: unknown): RecentIssue[] {
	if (!Array.isArray(items)) return [];
	const out: RecentIssue[] = [];
	for (const it of items as ApiIssue[]) {
		if (!it || typeof it !== 'object' || it.pull_request) continue;
		if (typeof it.number !== 'number' || typeof it.html_url !== 'string') continue;
		out.push({
			number: it.number,
			title: String(it.title ?? '').slice(0, 300),
			state: it.state === 'closed' ? 'closed' : 'open',
			html_url: it.html_url,
			updated_at: String(it.updated_at ?? '')
		});
	}
	return out;
}

function parseRecent(json: string | null): RecentIssue[] {
	if (!json) return [];
	try {
		const v = JSON.parse(json);
		return Array.isArray(v) ? (v as RecentIssue[]) : [];
	} catch {
		return [];
	}
}

const maxStr = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Company-level totals over its repos. Repos never synced don't count; none synced → nulls. */
export function aggregateRepos(rows: RepoRow[]): GithubMetrics {
	const synced = rows.filter((r) => r.last_synced_at);
	if (!synced.length) {
		return {
			issues_open: null,
			issues_closed: null,
			issues_opened_30d: null,
			issues_closed_30d: null,
			last_issue_at: null,
			recent_issues: [],
			github_synced_at: null
		};
	}
	const sum = (k: 'issues_open' | 'issues_closed' | 'issues_opened_30d' | 'issues_closed_30d') =>
		synced.reduce((n, r) => n + (r[k] ?? 0), 0);
	let lastIssue: string | null = null;
	let syncedAt: string | null = null;
	const recent: RecentIssue[] = [];
	for (const r of synced) {
		lastIssue = maxStr(lastIssue, r.last_issue_at);
		syncedAt = maxStr(syncedAt, r.last_synced_at);
		for (const i of parseRecent(r.recent_issues)) recent.push({ ...i, repo: `${r.owner}/${r.repo}` });
	}
	recent.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
	return {
		issues_open: sum('issues_open'),
		issues_closed: sum('issues_closed'),
		issues_opened_30d: sum('issues_opened_30d'),
		issues_closed_30d: sum('issues_closed_30d'),
		last_issue_at: lastIssue,
		recent_issues: recent.slice(0, RECENT_KEEP),
		github_synced_at: syncedAt
	};
}

/** SQLite-style UTC timestamp, like datetime('now'). */
function sqlNow(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class RateLimitError extends Error {}

function headers(env: IntegrationEnv, extra: Record<string, string> = {}) {
	return {
		Authorization: `Bearer ${env.GITHUB_TOKEN}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': USER_AGENT,
		...extra
	};
}

async function gh(f: FetchFn, env: IntegrationEnv, path: string, extra?: Record<string, string>): Promise<Response> {
	return await f(`${GITHUB_BASE}${path}`, { headers: headers(env, extra), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** A 403/429 that is GitHub's (primary or secondary) rate limit rather than a permission error. */
async function isRateLimited(res: Response): Promise<boolean> {
	if (res.status === 429) return true;
	if (res.status !== 403) return false;
	if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')) return true;
	const body = await res.clone().text().catch(() => '');
	return /rate limit/i.test(body);
}

/** Shown when the token can see a repo but not its issues (403/404 on the issues listing). */
export const ISSUES_ACCESS_ERROR =
	'GitHub refused issue access (HTTP 403). The token needs Issues: Read-only (fine-grained) or the repo scope (classic).';

async function searchCount(f: FetchFn, env: IntegrationEnv, q: string): Promise<number> {
	const res = await gh(f, env, `/search/issues?q=${encodeURIComponent(q)}&per_page=1`);
	if (await isRateLimited(res)) throw new RateLimitError('GitHub search rate limit hit — resuming next run');
	if (!res.ok) throw new Error(`search HTTP ${res.status}`);
	const body = (await res.json().catch(() => null)) as { total_count?: number } | null;
	if (typeof body?.total_count !== 'number') throw new Error('search returned no total_count');
	return body.total_count;
}

// ---------------------------------------------------------------------------
// Attach / remove
// ---------------------------------------------------------------------------

export type AttachResult = { ok: true; id: number; fullName: string } | { ok: false; error: string };

/** Validate `input` against GitHub (GET /repos) and attach it. Nothing is stored on an error. */
export async function attachRepo(
	db: D1Database,
	env: IntegrationEnv,
	companyId: number,
	input: string,
	f: FetchFn = fetch
): Promise<AttachResult> {
	const ref = parseRepoInput(input);
	if (!ref) return { ok: false, error: 'Enter a repo as owner/repo or a GitHub URL.' };
	if (!env.GITHUB_TOKEN?.trim()) return { ok: false, error: 'GITHUB_TOKEN is not set — see Settings → Integrations.' };

	const taken = await existingOwner(db, ref);
	if (taken) return { ok: false, error: taken.company_id === companyId ? 'That repo is already attached.' : `That repo is already attached to ${taken.name}.` };

	let res: Response;
	try {
		res = await gh(f, env, `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`);
	} catch (e) {
		return { ok: false, error: `Couldn't reach GitHub: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
	}
	if (res.status === 404) return { ok: false, error: `${ref.owner}/${ref.repo} wasn't found, or the token can't see it. For an org repo, a fine-grained token's resource owner must be the org.` };
	if (await isRateLimited(res)) return { ok: false, error: 'GitHub rate limit hit — try again in a minute.' };
	if (res.status === 401 || res.status === 403) return { ok: false, error: `GitHub refused access to ${ref.owner}/${ref.repo} (HTTP ${res.status}).` };
	if (!res.ok) return { ok: false, error: `GitHub returned HTTP ${res.status}.` };

	// Store GitHub's canonical owner/name (fixes case, follows a rename/transfer redirect).
	const body = (await res.json().catch(() => null)) as { full_name?: string } | null;
	const canon = parseRepoInput(body?.full_name ?? '') ?? ref;

	// The token can see the repo; make sure it can read issues too (a Metadata-only
	// fine-grained token can't). A rate limit or network error doesn't block the attach.
	try {
		const probe = await gh(f, env, `/repos/${encodeURIComponent(canon.owner)}/${encodeURIComponent(canon.repo)}/issues?per_page=1`);
		if ((probe.status === 403 && !(await isRateLimited(probe))) || probe.status === 404) return { ok: false, error: ISSUES_ACCESS_ERROR };
	} catch {
		// unreachable — the sync will report it
	}
	if (canon.owner !== ref.owner || canon.repo !== ref.repo) {
		const t = await existingOwner(db, canon);
		if (t) return { ok: false, error: `That repo is already attached${t.company_id === companyId ? '' : ` to ${t.name}`}.` };
	}
	try {
		const row = await db
			.prepare('INSERT INTO company_repos (company_id, owner, repo) VALUES (?, ?, ?) RETURNING id')
			.bind(companyId, canon.owner, canon.repo)
			.first<{ id: number }>();
		return { ok: true, id: row!.id, fullName: `${canon.owner}/${canon.repo}` };
	} catch (e) {
		if (String(e).includes('UNIQUE')) return { ok: false, error: 'That repo is already attached.' };
		throw e;
	}
}

async function existingOwner(db: D1Database, ref: RepoRef) {
	return db
		.prepare(
			`SELECT cr.company_id, co.name FROM company_repos cr JOIN companies co ON co.id = cr.company_id
			 WHERE cr.owner = ? AND cr.repo = ?`
		)
		.bind(ref.owner, ref.repo)
		.first<{ company_id: number; name: string }>();
}

/** Detach a repo and re-aggregate the company's metrics without it. */
export async function removeRepo(db: D1Database, companyId: number, repoId: number): Promise<boolean> {
	const res = await db.prepare('DELETE FROM company_repos WHERE id = ? AND company_id = ?').bind(repoId, companyId).run();
	await writeCompanyMetrics(db, companyId);
	return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

type RepoOutcome = 'synced' | 'not_modified';

async function syncRepo(db: D1Database, env: IntegrationEnv, r: RepoRow, f: FetchFn, now: Date): Promise<RepoOutcome> {
	const slug = `${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
	const res = await gh(
		f,
		env,
		`/repos/${slug}/issues?state=all&sort=updated&direction=desc&per_page=20`,
		r.etag ? { 'If-None-Match': r.etag } : {}
	);
	if (await isRateLimited(res)) throw new RateLimitError('GitHub rate limit hit — resuming next run');

	let recent: RecentIssue[] | null = null; // null = 304, keep stored
	let etag = r.etag;
	if (res.status === 304) {
		const fresh =
			r.last_synced_at && r.issues_open !== null && now.getTime() - Date.parse(`${r.last_synced_at.replace(' ', 'T')}Z`) < SEARCH_REFRESH_MS;
		if (fresh) {
			// last_synced_at is left alone: it dates the counts, so repeated 304s can't
			// postpone the daily search refresh (the 30-day windows slide).
			await db.prepare('UPDATE company_repos SET last_error = NULL WHERE id = ?').bind(r.id).run();
			return 'not_modified';
		}
	} else if (res.ok) {
		recent = filterIssues(await res.json().catch(() => null));
		etag = res.headers.get('etag') ?? null;
	} else {
		throw new Error(
			res.status === 404 ? 'HTTP 404 — repo not found or no access' : res.status === 403 ? ISSUES_ACCESS_ERROR : `issues HTTP ${res.status}`
		);
	}

	const repoQ = `repo:${r.owner}/${r.repo} is:issue`;
	const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
	const open = await searchCount(f, env, `${repoQ} is:open`);
	const closed = await searchCount(f, env, `${repoQ} is:closed`);
	const opened30 = await searchCount(f, env, `${repoQ} created:>=${since}`);
	const closed30 = await searchCount(f, env, `${repoQ} closed:>=${since}`);

	const lastIssue = recent && recent.length ? maxStr(r.last_issue_at, recent[0].updated_at) : r.last_issue_at;
	await db
		.prepare(
			`UPDATE company_repos SET issues_open = ?, issues_closed = ?, issues_opened_30d = ?, issues_closed_30d = ?,
			   last_issue_at = ?, recent_issues = ?, etag = ?, last_synced_at = ?, last_error = NULL
			 WHERE id = ?`
		)
		.bind(
			open,
			closed,
			opened30,
			closed30,
			lastIssue,
			recent ? JSON.stringify(recent.slice(0, RECENT_KEEP)) : r.recent_issues,
			etag,
			sqlNow(now),
			r.id
		)
		.run();
	return 'synced';
}

/** Re-aggregate a company's repos into company_metrics (github columns only). */
export async function writeCompanyMetrics(db: D1Database, companyId: number): Promise<GithubMetrics> {
	const rows = await db.prepare('SELECT * FROM company_repos WHERE company_id = ?').bind(companyId).all<RepoRow>();
	const m = aggregateRepos(rows.results);
	await db
		.prepare(
			`INSERT INTO company_metrics (company_id, issues_open, issues_closed, issues_opened_30d, issues_closed_30d,
			   last_issue_at, recent_issues, github_synced_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(company_id) DO UPDATE SET issues_open = excluded.issues_open,
			   issues_closed = excluded.issues_closed, issues_opened_30d = excluded.issues_opened_30d,
			   issues_closed_30d = excluded.issues_closed_30d, last_issue_at = excluded.last_issue_at,
			   recent_issues = excluded.recent_issues, github_synced_at = excluded.github_synced_at`
		)
		.bind(
			companyId,
			m.issues_open,
			m.issues_closed,
			m.issues_opened_30d,
			m.issues_closed_30d,
			m.last_issue_at,
			m.github_synced_at ? JSON.stringify(m.recent_issues) : null,
			m.github_synced_at
		)
		.run();
	return m;
}

/**
 * The GitHub provider's sync (cron + Sync now). `companyId` limits it to one company's repos
 * (the company page's Sync now). Throws nothing per repo — failures land in `errors` and on
 * the repo's `last_error`; a rate limit stops the run.
 */
export async function syncGithubRepos(
	db: D1Database,
	env: IntegrationEnv,
	opts: { trigger: SyncTrigger; fetch?: FetchFn; companyId?: number; now?: Date }
): Promise<SyncDetail> {
	const f = opts.fetch ?? fetch;
	const now = opts.now ?? new Date();
	const where = opts.companyId ? 'WHERE company_id = ?' : '';
	const binds = opts.companyId ? [opts.companyId] : [];
	const all = await db
		.prepare(
			`SELECT * FROM company_repos ${where}
			 ORDER BY last_error IS NOT NULL, last_synced_at IS NOT NULL, last_synced_at, id`
		)
		.bind(...binds)
		.all<RepoRow>();
	const batch = all.results.slice(0, MAX_REPOS_PER_RUN);

	const counts = { repos: all.results.length, synced: 0, not_modified: 0, failed: 0, deferred: 0 };
	const errors: string[] = [];
	const touched = new Set<number>();
	let i = 0;
	for (; i < batch.length; i++) {
		const r = batch[i];
		try {
			const out = await syncRepo(db, env, r, f, now);
			counts[out]++;
			touched.add(r.company_id);
		} catch (e) {
			const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
			if (e instanceof RateLimitError) {
				errors.push(`${r.owner}/${r.repo}: ${msg}`);
				break;
			}
			counts.failed++;
			errors.push(`${r.owner}/${r.repo}: ${msg}`);
			await db.prepare('UPDATE company_repos SET last_error = ? WHERE id = ?').bind(msg, r.id).run();
		}
	}
	counts.deferred = all.results.length - (counts.synced + counts.not_modified + counts.failed);
	for (const cid of touched) await writeCompanyMetrics(db, cid);
	return { counts, errors };
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export type RepoView = Omit<RepoRow, 'recent_issues' | 'etag'> & { recent: RecentIssue[] };

export async function companyRepos(db: D1Database, companyId: number): Promise<RepoView[]> {
	const rows = await db
		.prepare('SELECT * FROM company_repos WHERE company_id = ? ORDER BY owner COLLATE NOCASE, repo COLLATE NOCASE')
		.bind(companyId)
		.all<RepoRow>();
	return rows.results.map(({ recent_issues, etag: _etag, ...r }) => ({ ...r, recent: parseRecent(recent_issues) }));
}

/** The company's aggregated GitHub numbers, or null until a sync has written them. */
export async function githubMetrics(db: D1Database, companyId: number): Promise<GithubMetrics | null> {
	const row = await db
		.prepare(
			`SELECT issues_open, issues_closed, issues_opened_30d, issues_closed_30d, last_issue_at, recent_issues,
			   github_synced_at FROM company_metrics WHERE company_id = ?`
		)
		.bind(companyId)
		.first<Omit<GithubMetrics, 'recent_issues'> & { recent_issues: string | null }>();
	if (!row?.github_synced_at) return null;
	return { ...row, recent_issues: parseRecent(row.recent_issues) };
}
