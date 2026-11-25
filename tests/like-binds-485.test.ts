import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { containsSql, endsWithSql, equalsCiSql, notContainsSql, startsWithSql } from '../src/lib/server/sql-match';
import { buildContactSearch } from '../src/lib/server/contact-search';

// #485: D1 refuses any LIKE / GLOB pattern over 50 bytes ("LIKE or GLOB pattern too complex",
// a 500). Local miniflare doesn't enforce the cap, so a round-trip test can't catch it — this
// scans the source instead. A bound LIKE pattern (`LIKE ?`, `LIKE ${…}`, a `'LIKE'` picked in a
// ternary) is only allowed where the bind is a short constant; everything built from user input
// goes through $lib/server/sql-match (instr / substr, no cap).
const sources = import.meta.glob('../src/**/*.{svelte,ts}', { query: '?raw', import: 'default', eager: true }) as Record<
	string,
	string
>;

const BOUND_LIKE = /\b(?:LIKE|GLOB)\s*(?:\?|\$\{)|'(?:NOT\s+)?(?:LIKE|GLOB)'/g;

// file → number of bound LIKEs, each with why its pattern stays short.
const ALLOWED: Record<string, number> = {
	// `step_undo:%` — a fixed 11-byte prefix.
	'src/lib/server/step-undo.ts': 1,
	// `${action}:%` — action is 'reset' | 'invite' | 'verify'.
	'src/lib/server/account-tokens.ts': 1
};

const db = env.DB;

describe('#485 no unbounded LIKE binds', () => {
	it('scans a non-trivial number of files', () => {
		expect(Object.keys(sources).length).toBeGreaterThan(50);
	});

	it('bound LIKE / GLOB patterns appear only in the allow-listed files', () => {
		const counts: Record<string, number> = {};
		const hits: string[] = [];
		for (const [path, text] of Object.entries(sources)) {
			const file = path.replace('../', '');
			text.split('\n').forEach((line, i) => {
				const n = (line.match(BOUND_LIKE) ?? []).length;
				if (!n) return;
				counts[file] = (counts[file] ?? 0) + n;
				if (!(file in ALLOWED)) hits.push(`${file}:${i + 1} ${line.trim()}`);
			});
		}
		expect(hits, `Use $lib/server/sql-match instead of a bound LIKE:\n${hits.join('\n')}`).toEqual([]);
		for (const [file, n] of Object.entries(ALLOWED)) expect(counts[file] ?? 0, file).toBe(n);
	});
});

describe('#485 sql-match keeps LIKE semantics for short input', () => {
	async function val(sql: string, ...binds: unknown[]): Promise<number | null> {
		const r = await db.prepare(`SELECT (${sql}) AS v`).bind(...binds).first<{ v: number | null }>();
		return r?.v ?? null;
	}

	it('contains / not contains: ASCII case-insensitive, % and _ literal, NULL → NULL', async () => {
		expect(await val(containsSql('?1', '?2'), 'Jane@Example.com', 'jane@')).toBe(1);
		expect(await val(containsSql('?1', '?2'), 'jane@example.com', 'EXAMPLE')).toBe(1);
		expect(await val(containsSql('?1', '?2'), '50%off', '50%')).toBe(1);
		expect(await val(containsSql('?1', '?2'), '50 off', '50%')).toBe(0);
		expect(await val(containsSql('?1', '?2'), 'aXb', 'a_b')).toBe(0);
		expect(await val(containsSql('?1', '?2'), null, 'x')).toBeNull();
		expect(await val(containsSql('?1', '?2'), 'anything', '')).toBe(1);
		expect(await val(notContainsSql('?1', '?2'), 'jane@example.com', 'bob')).toBe(1);
		expect(await val(notContainsSql('?1', '?2'), 'jane@example.com', 'JANE')).toBe(0);
	});

	it('starts with / equals / ends with', async () => {
		expect(await val(startsWithSql('?1', '?2'), 'Acme Corp', 'acme')).toBe(1);
		expect(await val(startsWithSql('?1', '?2'), 'The Acme Corp', 'acme')).toBe(0);
		expect(await val(equalsCiSql('?1', '?2'), 'Acme', 'ACME')).toBe(1);
		expect(await val(equalsCiSql('?1', '?2'), 'Acme', 'Acm')).toBe(0);
		expect(await val(endsWithSql('?1', '?2'), 'jane@Example.com', '@example.com')).toBe(1);
		expect(await val(endsWithSql('?1', '?2'), 'jane@example.com.invalid', '@example.com')).toBe(0);
		expect(await val(endsWithSql('?1', '?2'), 'jane@example.com', '')).toBe(1);
	});

	it('a needle far over 50 bytes still matches', async () => {
		const path = `/blog/${'a-very-long-article-slug-'.repeat(6)}end`;
		expect(new TextEncoder().encode(path).length).toBeGreaterThan(100);
		expect(await val(containsSql('?1', '?2'), `https://example.com${path}?x=1`, path)).toBe(1);
		expect(await val(startsWithSql('?1', '?2'), `${path}/more`, path)).toBe(1);
	});

	it('the contacts quick search binds the raw text, so a long query runs', async () => {
		const q = `${'long-search-text-'.repeat(5)}@example.com`;
		const { where, binds } = buildContactSearch(q);
		expect(where).not.toMatch(/\bLIKE\b/);
		expect(binds.every((b) => b === q)).toBe(true);
		const r = await db.prepare(`SELECT COUNT(*) AS n FROM contacts ${where}`).bind(...binds).first<{ n: number }>();
		expect(r?.n).toBe(0);
	});
});
