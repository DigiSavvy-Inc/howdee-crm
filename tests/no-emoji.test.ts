import { describe, it, expect } from 'vitest';

// #209: UI chrome uses the glyph set (Icon.svelte), never emoji / dingbats / geometric
// shapes. Sources are bundled at build time (no fs in workerd), so new files are picked up.
const sources = import.meta.glob('../src/**/*.{svelte,ts}', { query: '?raw', import: 'default', eager: true }) as Record<
	string,
	string
>;

const BANNED = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}]/u;

// Genuine content strings only, matched by exact (trimmed) line. Keep this short.
const ALLOWED_LINES = new Set<string>([]);

describe('no emoji in source', () => {
	it('scans a non-trivial number of files', () => {
		expect(Object.keys(sources).length).toBeGreaterThan(50);
	});

	it('has no emoji / dingbat / geometric-shape characters', () => {
		const hits: string[] = [];
		for (const [file, text] of Object.entries(sources)) {
			text.split('\n').forEach((line, i) => {
				const m = line.match(BANNED);
				if (m && !ALLOWED_LINES.has(line.trim())) hits.push(`${file.replace('../', '')}:${i + 1} ${m[0]}`);
			});
		}
		expect(hits, hits.join('\n')).toEqual([]);
	});
});
