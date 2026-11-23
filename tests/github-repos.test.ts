import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	ISSUES_ACCESS_ERROR,
	MAX_REPOS_PER_RUN,
	aggregateRepos,
	attachRepo,
	companyRepos,
	filterIssues,
	githubMetrics,
	parseRepoInput,
	removeRepo,
	syncGithubRepos,
	type RepoRow
} from '../src/lib/server/integrations/github';
import { githubProviderFor, runProviderSync } from '../src/lib/server/integrations';
import { deleteCompany, listCompanies } from '../src/lib/server/companies';

const db = (env as any).DB as D1Database;
const ENV = { GITHUB_TOKEN: 'ghp_test' };
const NOW = new Date('2026-10-06T12:00:00Z');

beforeEach(async () => {
	await db.prepare('DELETE FROM company_repos').run();
	await db.prepare('DELETE FROM company_metrics').run();
	await db.prepare('DELETE FROM companies').run();
	await db.prepare('DELETE FROM integration_syncs').run();
	await db.prepare(`DELETE FROM app_state WHERE key LIKE 'integration_%'`).run();
});

async function company(name: string): Promise<number> {
	const r = await db.prepare('INSERT INTO companies (name) VALUES (?) RETURNING id').bind(name).first<{ id: number }>();
	return r!.id;
}

async function addRepoRow(companyId: number, owner: string, repo: string): Promise<number> {
	const r = await db
		.prepare('INSERT INTO company_repos (company_id, owner, repo) VALUES (?, ?, ?) RETURNING id')
		.bind(companyId, owner, repo)
		.first<{ id: number }>();
	return r!.id;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Counts = { open: number; closed: number; opened30: number; closed30: number };

/** A fake GitHub: per-repo counts + issue listings; records every URL and header set. */
function fakeGithub(repos: Record<string, { counts: Counts; issues?: unknown[]; etag?: string }>) {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	let searchBudget = Infinity;
	const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ url: String(input), headers });
		if (url.pathname === '/search/issues') {
			if (searchBudget-- <= 0) {
				return json({ message: 'You have exceeded a secondary rate limit.' }, 403, { 'retry-after': '60' });
			}
			const q = url.searchParams.get('q')!;
			const slug = /repo:(\S+)/.exec(q)![1];
			const c = repos[slug].counts;
			const n = q.includes('is:open') ? c.open : q.includes('is:closed') ? c.closed : q.includes('created:') ? c.opened30 : c.closed30;
			return json({ total_count: n, items: [] });
		}
		const m = /^\/repos\/([^/]+)\/([^/]+)(\/issues)?$/.exec(url.pathname);
		if (m) {
			const slug = `${m[1]}/${m[2]}`;
			const r = repos[slug];
			if (!r) return json({ message: 'Not Found' }, 404);
			if (!m[3]) return json({ full_name: slug });
			if (r.etag && headers['If-None-Match'] === r.etag) return new Response(null, { status: 304 });
			return json(r.issues ?? [], 200, r.etag ? { etag: r.etag } : {});
		}
		return json({}, 404);
	}) as typeof fetch;
	return {
		f,
		calls,
		limitSearches(n: number) {
			searchBudget = n;
		}
	};
}

const issue = (number: number, updated_at: string, state = 'open', pr = false) => ({
	number,
	title: `Issue ${number}`,
	state,
	html_url: `https://github.com/o/r/issues/${number}`,
	updated_at,
	...(pr ? { pull_request: { url: 'x' } } : {})
});

describe('parseRepoInput', () => {
	it('accepts owner/repo and GitHub URLs', () => {
		const want = { owner: 'Acme-Co', repo: 'crm-app' };
		for (const s of [
			'Acme-Co/crm-app',
			'  Acme-Co/crm-app  ',
			'https://github.com/Acme-Co/crm-app',
			'https://github.com/Acme-Co/crm-app/',
			'https://www.github.com/Acme-Co/crm-app.git',
			'github.com/Acme-Co/crm-app/issues/169?x=1#top',
			'git@github.com:Acme-Co/crm-app.git'
		]) {
			expect(parseRepoInput(s), s).toEqual(want);
		}
	});

	it('rejects junk and other hosts', () => {
		for (const s of ['', 'justaname', 'a/b/c', 'https://gitlab.com/a/b', 'https://github.com/onlyowner', '-bad/repo', 'o/..', 'o/re po']) {
			expect(parseRepoInput(s), s).toBeNull();
		}
	});
});

describe('filterIssues', () => {
	it('drops pull requests and malformed items', () => {
		const out = filterIssues([issue(1, '2026-10-01T00:00:00Z'), issue(2, '2026-10-02T00:00:00Z', 'open', true), { title: 'x' }, null]);
		expect(out.map((i) => i.number)).toEqual([1]);
		expect(out[0]).toEqual({ number: 1, title: 'Issue 1', state: 'open', html_url: 'https://github.com/o/r/issues/1', updated_at: '2026-10-01T00:00:00Z' });
	});
	it('handles a non-array body', () => {
		expect(filterIssues({ message: 'x' })).toEqual([]);
	});
});

describe('aggregateRepos', () => {
	const row = (over: Partial<RepoRow>): RepoRow => ({
		id: 1, company_id: 1, owner: 'o', repo: 'r', added_at: '', last_synced_at: '2026-10-06 10:00:00', last_error: null, etag: null,
		issues_open: 0, issues_closed: 0, issues_opened_30d: 0, issues_closed_30d: 0, last_issue_at: null, recent_issues: null, ...over
	});
	it('sums counts, takes the latest activity, merges recent issues newest first (top 5)', () => {
		const m = aggregateRepos([
			row({ repo: 'a', issues_open: 3, issues_closed: 10, issues_opened_30d: 1, issues_closed_30d: 2, last_issue_at: '2026-10-01T00:00:00Z',
				recent_issues: JSON.stringify([1, 2, 3].map((n) => issue(n, `2026-10-0${n}T00:00:00Z`))) }),
			row({ repo: 'b', issues_open: 4, issues_closed: 5, issues_opened_30d: 6, issues_closed_30d: 7, last_issue_at: '2026-10-05T00:00:00Z',
				last_synced_at: '2026-10-06 11:00:00', recent_issues: JSON.stringify([4, 5, 6].map((n) => issue(n, `2026-09-0${n}T00:00:00Z`))) }),
			row({ repo: 'never', issues_open: 99, last_synced_at: null })
		]);
		expect(m).toMatchObject({ issues_open: 7, issues_closed: 15, issues_opened_30d: 7, issues_closed_30d: 9,
			last_issue_at: '2026-10-05T00:00:00Z', github_synced_at: '2026-10-06 11:00:00' });
		expect(m.recent_issues.map((i) => `${i.repo}#${i.number}`)).toEqual(['o/a#3', 'o/a#2', 'o/a#1', 'o/b#6', 'o/b#5']);
	});
	it('is all null when nothing has synced', () => {
		expect(aggregateRepos([row({ last_synced_at: null })])).toMatchObject({ issues_open: null, github_synced_at: null, recent_issues: [] });
	});
});

describe('attachRepo', () => {
	it('validates against GitHub and stores the canonical name', async () => {
		const co = await company('Acme');
		const gh = fakeGithub({ 'Acme-Co/crm-app': { counts: { open: 0, closed: 0, opened30: 0, closed30: 0 } } });
		const res = await attachRepo(db, ENV, co, 'https://github.com/Acme-Co/crm-app', gh.f);
		expect(res).toMatchObject({ ok: true, fullName: 'Acme-Co/crm-app' });
		expect(gh.calls[0].url).toBe('https://api.github.com/repos/Acme-Co/crm-app');
		expect(gh.calls[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28');
		expect(gh.calls[0].headers.Authorization).toBe('Bearer ghp_test');
		expect((await companyRepos(db, co)).map((r) => `${r.owner}/${r.repo}`)).toEqual(['Acme-Co/crm-app']);
	});

	it('404 / bad input / duplicates are clear errors and store nothing new', async () => {
		const a = await company('A');
		const b = await company('B');
		const gh = fakeGithub({ 'o/r': { counts: { open: 0, closed: 0, opened30: 0, closed30: 0 } } });
		expect(await attachRepo(db, ENV, a, 'o/missing', gh.f)).toMatchObject({ ok: false, error: expect.stringContaining("wasn't found") });
		expect(await attachRepo(db, ENV, a, 'not a repo', gh.f)).toMatchObject({ ok: false });
		expect(await attachRepo(db, {}, a, 'o/r', gh.f)).toMatchObject({ ok: false, error: expect.stringContaining('GITHUB_TOKEN') });
		expect((await attachRepo(db, ENV, a, 'o/r', gh.f)).ok).toBe(true);
		expect(await attachRepo(db, ENV, b, 'O/R', gh.f)).toMatchObject({ ok: false, error: 'That repo is already attached to A.' });
		const n = await db.prepare('SELECT COUNT(*) AS n FROM company_repos').first<{ n: number }>();
		expect(n!.n).toBe(1);
	});

	it('403 is refused without storing', async () => {
		const co = await company('A');
		const f = (async () => json({ message: 'Resource not accessible' }, 403)) as typeof fetch;
		expect(await attachRepo(db, ENV, co, 'o/r', f)).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 403') });
		expect(await companyRepos(db, co)).toEqual([]);
	});

	/** Repo GET answers 200; the issues probe answers `issues`. */
	const probeFetch = (issues: () => Response) => {
		const urls: string[] = [];
		const f = (async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return new URL(String(input)).pathname.endsWith('/issues') ? issues() : json({ full_name: 'o/r' });
		}) as typeof fetch;
		return { f, urls };
	};

	it('repo visible but issues 403 → refused with the Issues message, nothing stored', async () => {
		const co = await company('A');
		const p = probeFetch(() => json({ message: 'Resource not accessible by personal access token' }, 403));
		expect(await attachRepo(db, ENV, co, 'o/r', p.f)).toEqual({ ok: false, error: ISSUES_ACCESS_ERROR });
		expect(p.urls[1]).toBe('https://api.github.com/repos/o/r/issues?per_page=1');
		expect(await companyRepos(db, co)).toEqual([]);
	});

	it('repo visible but issues 404 → refused too', async () => {
		const co = await company('A');
		const p = probeFetch(() => json({ message: 'Not Found' }, 404));
		expect(await attachRepo(db, ENV, co, 'o/r', p.f)).toEqual({ ok: false, error: ISSUES_ACCESS_ERROR });
		expect(await companyRepos(db, co)).toEqual([]);
	});

	it('issues 200 → attached', async () => {
		const co = await company('A');
		const p = probeFetch(() => json([]));
		expect(await attachRepo(db, ENV, co, 'o/r', p.f)).toMatchObject({ ok: true, fullName: 'o/r' });
	});

	it('a rate-limited or unreachable issues probe still attaches', async () => {
		const co = await company('A');
		const limited = probeFetch(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }));
		expect(await attachRepo(db, ENV, co, 'o/r', limited.f)).toMatchObject({ ok: true });
		const co2 = await company('B');
		await db.prepare('DELETE FROM company_repos').run();
		const down = probeFetch(() => {
			throw new Error('network down');
		});
		expect(await attachRepo(db, ENV, co2, 'o/r', down.f)).toMatchObject({ ok: true });
	});

	it('the 404 message hints at the fine-grained resource owner', async () => {
		const co = await company('A');
		const gh = fakeGithub({});
		const res = await attachRepo(db, ENV, co, 'Acme-Co/brightway-ai', gh.f);
		expect(res).toMatchObject({ ok: false, error: expect.stringContaining("resource owner must be the org") });
	});
});

describe('syncGithubRepos', () => {
	it('stores per-repo counts + non-PR recent issues and upserts the company metrics', async () => {
		const co = await company('Acme');
		await addRepoRow(co, 'o', 'a');
		await addRepoRow(co, 'o', 'b');
		const gh = fakeGithub({
			'o/a': { counts: { open: 3, closed: 10, opened30: 2, closed30: 4 },
				issues: [issue(9, '2026-10-05T00:00:00Z', 'open', true), issue(8, '2026-10-04T00:00:00Z'), issue(7, '2026-10-01T00:00:00Z', 'closed')] },
			'o/b': { counts: { open: 4, closed: 1, opened30: 1, closed30: 0 }, issues: [issue(1, '2026-09-20T00:00:00Z')] }
		});
		const detail = await syncGithubRepos(db, ENV, { trigger: 'manual', fetch: gh.f, now: NOW });
		expect(detail).toEqual({ counts: { repos: 2, synced: 2, not_modified: 0, failed: 0, deferred: 0 }, errors: [] });

		// The 30-day window and the search query shape.
		const qs = gh.calls.filter((c) => c.url.includes('/search/issues')).map((c) => new URL(c.url).searchParams.get('q'));
		expect(qs).toContain('repo:o/a is:issue is:open');
		expect(qs).toContain('repo:o/a is:issue created:>=2026-09-06');
		expect(qs).toContain('repo:o/a is:issue closed:>=2026-09-06');

		const repos = await companyRepos(db, co);
		const a = repos.find((r) => r.repo === 'a')!;
		expect(a).toMatchObject({ issues_open: 3, issues_closed: 10, issues_opened_30d: 2, issues_closed_30d: 4, last_issue_at: '2026-10-04T00:00:00Z', last_error: null });
		expect(a.recent.map((i) => i.number)).toEqual([8, 7]);

		const m = await githubMetrics(db, co);
		expect(m).toMatchObject({ issues_open: 7, issues_closed: 11, issues_opened_30d: 3, issues_closed_30d: 4, last_issue_at: '2026-10-04T00:00:00Z' });
		expect(m!.recent_issues.map((i) => `${i.repo}#${i.number}`)).toEqual(['o/a#8', 'o/a#7', 'o/b#1']);

		// Re-sync with new numbers updates the same metrics row (upsert, not insert).
		gh.calls.length = 0;
		await syncGithubRepos(db, ENV, { trigger: 'manual', fetch: gh.f, now: NOW });
		const rows = await db.prepare('SELECT COUNT(*) AS n FROM company_metrics WHERE company_id = ?').bind(co).first<{ n: number }>();
		expect(rows!.n).toBe(1);
	});

	it('upsert leaves other company_metrics columns alone', async () => {
		const co = await company('Acme');
		await addRepoRow(co, 'o', 'a');
		await db.prepare('INSERT INTO company_metrics (company_id, issues_open) VALUES (?, 99)').bind(co).run();
		const gh = fakeGithub({ 'o/a': { counts: { open: 1, closed: 2, opened30: 0, closed30: 0 } } });
		await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: gh.f, now: NOW });
		expect((await githubMetrics(db, co))!.issues_open).toBe(1);
	});

	it('a 304 within a day keeps the old values and skips the searches', async () => {
		const co = await company('Acme');
		await addRepoRow(co, 'o', 'a');
		const repos = { 'o/a': { counts: { open: 3, closed: 1, opened30: 1, closed30: 1 }, issues: [issue(5, '2026-10-05T00:00:00Z')], etag: 'W/"abc"' } };
		const gh = fakeGithub(repos);
		await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: gh.f, now: NOW });

		// GitHub's numbers change, but the listing says nothing changed (304).
		repos['o/a'].counts = { open: 50, closed: 50, opened30: 50, closed30: 50 };
		gh.calls.length = 0;
		const later = new Date(NOW.getTime() + 6 * 3600_000);
		const detail = await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: gh.f, now: later });
		expect(detail.counts).toMatchObject({ not_modified: 1, synced: 0 });
		expect(gh.calls).toHaveLength(1);
		expect(gh.calls[0].headers['If-None-Match']).toBe('W/"abc"');
		const [a] = await companyRepos(db, co);
		expect(a).toMatchObject({ issues_open: 3, last_synced_at: '2026-10-06 12:00:00' }); // dates the counts
		expect(a.recent.map((i) => i.number)).toEqual([5]);

		// After a day a 304 still refreshes the counts (30d windows slide) but keeps recent issues.
		const nextDay = new Date(NOW.getTime() + 30 * 3600_000);
		await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: gh.f, now: nextDay });
		const [a2] = await companyRepos(db, co);
		expect(a2.issues_open).toBe(50);
		expect(a2.recent.map((i) => i.number)).toEqual([5]);
	});

	it('stops on a search rate limit and resumes with the unsynced repos next run', async () => {
		const co = await company('Acme');
		for (const r of ['a', 'b', 'c']) await addRepoRow(co, 'o', r);
		const counts = { open: 1, closed: 1, opened30: 1, closed30: 1 };
		const gh = fakeGithub({ 'o/a': { counts }, 'o/b': { counts }, 'o/c': { counts } });
		gh.limitSearches(6); // repo a (4) + half of repo b
		const first = await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: gh.f, now: NOW });
		expect(first.counts).toMatchObject({ synced: 1, failed: 0, deferred: 2 });
		expect(first.errors[0]).toMatch(/^o\/b: .*rate limit/);
		let repos = await companyRepos(db, co);
		expect(repos.filter((r) => r.last_synced_at).map((r) => r.repo)).toEqual(['a']);
		expect(repos.find((r) => r.repo === 'b')!.last_error).toBeNull(); // a rate limit isn't a repo failure
		expect((await githubMetrics(db, co))!.issues_open).toBe(1);

		gh.limitSearches(Infinity);
		gh.calls.length = 0;
		const second = await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: gh.f, now: new Date(NOW.getTime() + 60_000) });
		expect(second.counts).toMatchObject({ synced: 3, deferred: 0 });
		// Never-synced repos go first.
		expect(gh.calls[0].url).toContain('/repos/o/b/issues');
		repos = await companyRepos(db, co);
		expect(repos.every((r) => r.last_synced_at)).toBe(true);
	});

	it(`takes at most ${MAX_REPOS_PER_RUN} repos per run`, async () => {
		const co = await company('Acme');
		const repos: Record<string, { counts: Counts }> = {};
		for (let i = 0; i < MAX_REPOS_PER_RUN + 2; i++) {
			await addRepoRow(co, 'o', `r${i}`);
			repos[`o/r${i}`] = { counts: { open: 1, closed: 0, opened30: 0, closed30: 0 } };
		}
		const gh = fakeGithub(repos);
		const d = await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: gh.f, now: NOW });
		expect(d.counts).toMatchObject({ synced: MAX_REPOS_PER_RUN, deferred: 2 });
		expect(gh.calls.filter((c) => c.url.includes('/search/')).length).toBeLessThanOrEqual(30);
	});

	it('a failing repo records last_error and the others still sync', async () => {
		const co = await company('Acme');
		await addRepoRow(co, 'o', 'gone');
		await addRepoRow(co, 'o', 'a');
		const gh = fakeGithub({ 'o/a': { counts: { open: 2, closed: 0, opened30: 0, closed30: 0 } } });
		const d = await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: gh.f, now: NOW });
		expect(d.counts).toMatchObject({ synced: 1, failed: 1 });
		const gone = (await companyRepos(db, co)).find((r) => r.repo === 'gone')!;
		expect(gone.last_error).toMatch(/404/);
		expect((await githubMetrics(db, co))!.issues_open).toBe(2);
	});

	it('a non-rate-limit 403 on the issues listing says which permission is missing', async () => {
		const co = await company('Acme');
		await addRepoRow(co, 'o', 'a');
		const f = (async () => json({ message: 'Resource not accessible by personal access token' }, 403)) as typeof fetch;
		const d = await syncGithubRepos(db, ENV, { trigger: 'cron', fetch: f, now: NOW });
		expect(d.counts).toMatchObject({ failed: 1 });
		const [a] = await companyRepos(db, co);
		expect(a.last_error).toBe(ISSUES_ACCESS_ERROR);
	});

	it('company Sync now goes through the shared runner, scoped to that company', async () => {
		const a = await company('A');
		const b = await company('B');
		await addRepoRow(a, 'o', 'a');
		await addRepoRow(b, 'o', 'b');
		const counts = { open: 1, closed: 0, opened30: 0, closed30: 0 };
		const gh = fakeGithub({ 'o/a': { counts }, 'o/b': { counts } });
		const res = await runProviderSync(db, ENV, githubProviderFor(a), 'manual', { fetch: gh.f });
		expect(res).toMatchObject({ provider: 'github', ok: true });
		expect(gh.calls.some((c) => c.url.includes('/o/b'))).toBe(false);
		const log = await db.prepare(`SELECT trigger, ok FROM integration_syncs`).all();
		expect(log.results).toEqual([{ trigger: 'manual', ok: 1 }]);
	});
});

describe('removal + cascade', () => {
	it('removing a repo re-aggregates the company metrics', async () => {
		const co = await company('Acme');
		const ra = await addRepoRow(co, 'o', 'a');
		await addRepoRow(co, 'o', 'b');
		const gh = fakeGithub({
			'o/a': { counts: { open: 3, closed: 0, opened30: 0, closed30: 0 } },
			'o/b': { counts: { open: 4, closed: 0, opened30: 0, closed30: 0 } }
		});
		await syncGithubRepos(db, ENV, { trigger: 'manual', fetch: gh.f, now: NOW });
		expect((await githubMetrics(db, co))!.issues_open).toBe(7);
		await removeRepo(db, co, ra);
		expect((await githubMetrics(db, co))!.issues_open).toBe(4);
	});

	it('deleting a company deletes its repos (ON DELETE CASCADE)', async () => {
		const co = await company('Acme');
		await addRepoRow(co, 'o', 'a');
		await deleteCompany(db, co);
		const n = await db.prepare('SELECT COUNT(*) AS n FROM company_repos').first<{ n: number }>();
		expect(n!.n).toBe(0);
	});
});

describe('companies list', () => {
	it('exposes and sorts by open issues (never-synced last)', async () => {
		const a = await company('Alpha');
		const b = await company('Beta');
		await company('Gamma');
		await db.prepare('INSERT INTO company_metrics (company_id, issues_open, github_synced_at) VALUES (?, 2, ?), (?, 9, ?)')
			.bind(a, '2026-10-06 00:00:00', b, '2026-10-06 00:00:00').run();
		const desc = await listCompanies(db, { sort: 'open_issues', dir: 'desc' });
		expect(desc.rows.map((r) => [r.name, r.issues_open])).toEqual([['Beta', 9], ['Alpha', 2], ['Gamma', null]]);
		const asc = await listCompanies(db, { sort: 'open_issues', dir: 'asc' });
		expect(asc.rows.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
	});
});
