import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { GET as searchGET } from '../src/routes/api/search/+server';
import { siteSearch, escapeLike } from '../src/lib/server/site-search';
import { automationsListQuery } from '../src/lib/server/automation-labels';
import { automationsFilterUrl } from '../src/lib/automations-filter';
import {
	SEARCH_TOTAL_CAP,
	highlightParts,
	isSearchShortcut,
	isTypingTarget,
	looksLikeEmail,
	parseRecent,
	pushRecent,
	RECENT_MAX,
	seeAllHref,
	searchShortcutHint,
	totalLabel,
	type SearchResponse
} from '../src/lib/site-search';
import layout from '../src/routes/+layout.svelte?raw';
import palette from '../src/lib/components/SearchPalette.svelte?raw';
import help from '../src/lib/components/HelpPanel.svelte?raw';
import automationsPage from '../src/routes/automations/+page.svelte?raw';

const db = (env as any).DB as D1Database;

const admin = { id: 1, role: 'admin', github_login: 'boss' };
const member = { id: 2, role: 'member', github_login: 'pal' };

function ev(q: string | null, user: unknown, extra = '') {
	const url = new URL(`https://app.test/api/search${q === null ? '' : `?q=${encodeURIComponent(q)}`}${extra}`);
	return { request: new Request(url), platform: { env }, url, params: {}, locals: { user } } as any;
}
async function search(q: string, user: unknown = admin): Promise<SearchResponse> {
	const res = await searchGET(ev(q, user));
	expect(res.status).toBe(200);
	return JSON.parse(await res.text());
}
async function status(q: string | null, user: unknown): Promise<number> {
	try {
		return (await searchGET(ev(q, user))).status;
	} catch (e: any) {
		return e?.status ?? 500;
	}
}

async function contact(email: string, f: { first?: string; last?: string; company?: string; archived?: boolean } = {}): Promise<number> {
	const r = await db
		.prepare(`INSERT INTO contacts (email, first_name, last_name, company, subscribed, source, archived_at) VALUES (?, ?, ?, ?, 1, 'test', ?) RETURNING id`)
		.bind(email, f.first ?? null, f.last ?? null, f.company ?? null, f.archived ? '2026-01-01 00:00:00' : null)
		.first<{ id: number }>();
	return r!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare("DELETE FROM contacts WHERE email LIKE '%@srch.test'"),
		db.prepare("DELETE FROM companies WHERE name LIKE 'Zq%'"),
		db.prepare("DELETE FROM campaigns WHERE subject LIKE 'Zq%'"),
		db.prepare("DELETE FROM automations WHERE name LIKE 'Zq%'")
	]);
});

describe('GET /api/search', () => {
	it('groups results and ranks exact, then prefix, then substring', async () => {
		await contact('xzqmidx@srch.test', { first: 'Mid' }); // substring
		await contact('zqalpha@srch.test', { first: 'Pre' }); // prefix (email)
		await contact('other@srch.test', { first: 'zqalpha' }); // exact (first name)
		await db.prepare("INSERT INTO companies (name, domain) VALUES ('Zqalpha Corp', 'zqalpha.example')").run();
		await db.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at) VALUES ('Zqalpha launch', '', '', 'a@b.c', 'sent', '2026-10-01 10:00:00')").run();
		await db.prepare("INSERT INTO automations (name, status) VALUES ('Zqalpha nurture', 'active')").run();

		const r = await search('zqalpha');
		expect(Object.keys(r)).toEqual(expect.arrayContaining(['contacts', 'companies', 'campaigns', 'automations']));
		expect(r.contacts.items.map((c) => c.email)).toEqual(['other@srch.test', 'zqalpha@srch.test']);
		expect(r.contacts.total).toBe(2);
		expect(r.contacts.items[0].href).toMatch(/^\/contacts\/\d+$/);
		expect(r.contacts.items[0].tier).toBe('new');
		expect(r.companies.items[0]).toMatchObject({ title: 'Zqalpha Corp', domain: 'zqalpha.example', contact_count: 0 });
		expect(r.campaigns.items[0]).toMatchObject({ title: 'Zqalpha launch', status: 'sent', date: '2026-10-01 10:00:00' });
		expect(r.campaigns.items[0].href).toMatch(/^\/campaign\/\d+$/);
		expect(r.automations.items[0]).toMatchObject({ title: 'Zqalpha nurture', status: 'active', trigger: 'Manual enrollment' });

		const sub = await search('zqmid');
		expect(sub.contacts.items.map((c) => c.email)).toEqual(['xzqmidx@srch.test']);
	});

	it('leaves archived contacts out', async () => {
		await contact('zqarch@srch.test', { archived: true });
		await contact('zqlive@srch.test');
		const r = await search('zq');
		const emails = r.contacts.items.map((c) => c.email);
		expect(emails).toContain('zqlive@srch.test');
		expect(emails).not.toContain('zqarch@srch.test');
	});

	it('caps total at 100 and limits items', async () => {
		const stmts = [];
		for (let i = 0; i < SEARCH_TOTAL_CAP + 5; i++)
			stmts.push(db.prepare("INSERT INTO contacts (email, subscribed, source) VALUES (?, 1, 'test')").bind(`zqcap${i}@srch.test`));
		await db.batch(stmts);
		const r = await search('zqcap');
		expect(r.contacts.items.length).toBe(5);
		expect(r.contacts.total).toBe(SEARCH_TOTAL_CAP);
		expect(r.contacts.capped).toBe(true);
		expect(totalLabel(r.contacts)).toBe('100+');
		const more = await siteSearch(db, 'zqcap', 99);
		expect(more.contacts.items.length).toBe(10);
	});

	it('treats LIKE wildcards literally', async () => {
		await contact('zq50%_off@srch.test');
		await contact('zq50xyoff@srch.test');
		expect(escapeLike('a%b_c\\')).toBe('a\\%b\\_c\\\\');
		const r = await search('zq50%_');
		expect(r.contacts.items.map((c) => c.email)).toEqual(['zq50%_off@srch.test']);
		const pct = await search('%');
		expect(pct.contacts.items.every((c) => c.email.includes('%') || c.title.includes('%') || (c.company ?? '').includes('%'))).toBe(true);
	});

	it('matches automations by tag (label)', async () => {
		const a = await db.prepare("INSERT INTO automations (name, status) VALUES ('Zq onboarding', 'draft') RETURNING id").first<{ id: number }>();
		await db.prepare("INSERT INTO automation_labels (automation_id, label) VALUES (?, 'zqtagged')").bind(a!.id).run();
		const r = await search('zqtagged');
		expect(r.automations.items.map((x) => x.title)).toEqual(['Zq onboarding']);
		const list = await automationsListQuery(db, { label: null, status: null, q: 'zqtagged' });
		expect(list.automations.map((x) => x.name)).toEqual(['Zq onboarding']);
	});

	it('shows members the same records as admins (the list pages do not filter by role)', async () => {
		await contact('zqrole@srch.test');
		await db.prepare("INSERT INTO companies (name) VALUES ('Zqrole Inc')").run();
		const a = await search('zqrole', admin);
		const m = await search('zqrole', member);
		expect(m).toEqual(a);
		expect(m.contacts.total).toBe(1);
		expect(m.companies.total).toBe(1);
	});

	it('refuses an empty query and a missing session', async () => {
		expect(await status('', admin)).toBe(400);
		expect(await status('   ', admin)).toBe(400);
		expect(await status(null, admin)).toBe(400);
		expect(await status('x', null)).toBe(401);
	});
});

describe('site-search helpers', () => {
	it('looksLikeEmail', () => {
		expect(looksLikeEmail('jane@example.com')).toBe(true);
		expect(looksLikeEmail(' jane.doe+x@mail.shop.example.org ')).toBe(true);
		for (const s of ['jane', 'jane@', '@example.com', 'jane@example', 'jane doe@example.com', 'a@b@c.example.net', 'jane@example..com', '.jane@example.com', 'jane.@example.com'])
			expect(looksLikeEmail(s), s).toBe(false);
	});

	it('highlightParts marks every case-insensitive match as text parts', () => {
		expect(highlightParts('Ann <b>ann</b>', 'ann')).toEqual([
			{ text: 'Ann', match: true },
			{ text: ' <b>', match: false },
			{ text: 'ann', match: true },
			{ text: '</b>', match: false }
		]);
		expect(highlightParts('Bob', 'zz')).toEqual([{ text: 'Bob', match: false }]);
	});

	it('shortcut: Cmd+K on a Mac, Ctrl+K elsewhere', () => {
		const k = { key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
		expect(isSearchShortcut({ ...k, metaKey: true }, true)).toBe(true);
		expect(isSearchShortcut({ ...k, ctrlKey: true }, true)).toBe(false);
		expect(isSearchShortcut({ ...k, ctrlKey: true }, false)).toBe(true);
		expect(isSearchShortcut({ ...k, metaKey: true }, false)).toBe(false);
		expect(isSearchShortcut({ ...k, ctrlKey: true, shiftKey: true }, false)).toBe(false);
		expect(searchShortcutHint(true)).toBe('⌘K');
		expect(searchShortcutHint(false)).toBe('Ctrl+K');
	});

	it('isTypingTarget', () => {
		expect(isTypingTarget({ tagName: 'INPUT' } as any)).toBe(true);
		expect(isTypingTarget({ tagName: 'TEXTAREA' } as any)).toBe(true);
		expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as any)).toBe(true);
		expect(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false, closest: () => null } as any)).toBe(false);
		expect(isTypingTarget(null)).toBe(false);
	});

	it('recents: parse junk safely, de-dupe, cap', () => {
		expect(parseRecent('nope')).toEqual([]);
		expect(parseRecent(JSON.stringify([{ type: 'contacts', id: 1, title: 'A', href: '//evil.example' }]))).toEqual([]);
		let list: ReturnType<typeof parseRecent> = [];
		for (let i = 0; i < 12; i++) list = pushRecent(list, { type: 'contacts', id: i, title: `C${i}`, href: `/contacts/${i}` });
		list = pushRecent(list, { type: 'contacts', id: 5, title: 'C5', href: '/contacts/5' });
		expect(list.length).toBe(RECENT_MAX);
		expect(list[0].id).toBe(5);
		expect(list.filter((x) => x.id === 5).length).toBe(1);
		expect(parseRecent(JSON.stringify(list))).toEqual(list);
	});

	it('seeAllHref fills the query in', () => {
		expect(seeAllHref('contacts', 'a b&c')).toBe('/contacts?q=a%20b%26c');
		expect(seeAllHref('automations', 'x')).toBe('/automations?q=x');
	});
});

describe('palette wiring', () => {
	it('is mounted once in the root layout, with a header button', () => {
		expect(layout.match(/<SearchPalette\b/g)?.length).toBe(1);
		expect(layout).toMatch(/class="assistant-btn search-btn"/);
		expect(layout).toMatch(/e\.preventDefault\(\);\s*searchOpen = !searchOpen/);
	});

	it('is an accessible dialog with a combobox over a listbox', () => {
		expect(palette).toMatch(/role="dialog"/);
		expect(palette).toMatch(/aria-modal="true"/);
		expect(palette).toMatch(/role="combobox"/);
		expect(palette).toMatch(/aria-activedescendant=/);
		expect(palette).toMatch(/role="listbox"/);
		expect(palette).toMatch(/AbortController/);
		expect(palette).not.toMatch(/\{@html/);
	});

	it('starts empty on every open: closing clears the query, results and state', () => {
		const closed = palette.slice(palette.indexOf('// Closed (Esc'), palette.indexOf('function close()'));
		expect(closed).toMatch(/query = '';\s*results = null;\s*loading = false;\s*failed = false;/);
	});

	it('phones: a 16px input (no iOS zoom) and a "Close" button instead of "Esc"', () => {
		const phone = palette.slice(palette.indexOf('@media (max-width: 768px)'));
		expect(phone).toMatch(/\.sp-head input \{[^}]*font-size: 16px;/);
		expect(phone).toMatch(/\.sp-close-wide \{\s*display: none;/);
		expect(phone).toMatch(/\.sp-close-narrow \{\s*display: inline;/);
		expect(palette).toMatch(/aria-label="Close search"><span class="sp-close-wide">Esc<\/span><span class="sp-close-narrow">Close<\/span>/);
	});

	it('is in the help panel', () => {
		expect(help).toContain("title: `Search (${k('Mod+K')})`");
	});
});

describe('/automations?q= (See all)', () => {
	it('scopes the status counts to the search and filters by status within it', async () => {
		await db.prepare("INSERT INTO automations (name, status) VALUES ('Zq audit one', 'active'), ('Zq audit two', 'draft'), ('Zq other', 'active')").run();
		const r = await automationsListQuery(db, { label: null, status: 'active', q: 'zq audit' });
		expect(r.automations.map((a) => a.name)).toEqual(['Zq audit one']);
		expect(r.statusCounts).toEqual({ all: 2, active: 1, paused: 0, draft: 1 });
	});

	it('status tabs keep the search, URL-encoded', () => {
		expect(automationsPage).toMatch(/href=\{urlWith\(\{ status: o\.value \}\)\}/);
		expect(automationsFilterUrl({ status: 'active', tag: null }, { status: 'paused', q: 'a b&c' })).toBe('?status=paused&q=a+b%26c');
		expect(automationsFilterUrl({ status: 'active', tag: null }, { status: 'all', q: null })).toBe('?status=all');
	});

	it('says no match for the search, not "No automations yet"', () => {
		const empty = automationsPage.slice(automationsPage.indexOf('{#if data.automations.length === 0}'));
		expect(empty).toMatch(/\{#if data\.q\}\s*No automations match “\{data\.q\}”\./);
		expect(empty.indexOf('No automations match “{data.q}”')).toBeLessThan(empty.indexOf('No automations yet'));
		expect(empty).toMatch(/<a href="\/automations">Clear search<\/a>/);
	});

	// #579: tag chips, the picker, Clear and the header count all honour the search.
	it('urlWith carries the search by default so tag / clear links keep it', () => {
		expect(automationsPage).toMatch(/\.\.\.\(data\.q \? \{ q: data\.q \} : \{\}\),\s*\.\.\.overrides/);
		expect(automationsPage).toMatch(/href=\{urlWith\(\{ tag: sameTag\(lc\.label\) \? null : lc\.label \}\)\}/);
		expect(automationsPage).toMatch(/<a class="clear" href=\{urlWith\(\{ tag: null, status: 'all' \}\)\}>/);
		expect(automationsFilterUrl({ status: null, tag: null }, { q: 'zq', tag: 'vip' })).toBe('?q=zq&tag=vip');
	});

	it('header shows matched of total while a search is on', () => {
		expect(automationsPage).toMatch(/\{#if filtered \|\| data\.q\}\s*<span class="muted">\{data\.matched\} of \{data\.total\}/);
	});
});
