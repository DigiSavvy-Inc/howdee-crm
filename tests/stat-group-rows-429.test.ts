import { describe, it, expect } from 'vitest';
import statGroup from '../src/lib/components/StatGroup.svelte?raw';
import statCell from '../src/lib/components/StatCell.svelte?raw';
import overview from '../src/lib/components/ContactsOverview.svelte?raw';

// #429: a StatGroup with 7+ cells wraps into balanced rows at ≥ 900px instead of one mushed row.
// Vitest has no Svelte compiler here and doesn't run container queries, so this checks the
// source the browser keys on: the group's markup + the :has(> :nth-child(N)) bands.

const wide = statGroup.slice(statGroup.indexOf('@container (min-width: 900px)'));
const band = (sel: string, cols: number) =>
	new RegExp(`${sel.replace(/[()[\]:>.*+]/g, '\\$&')} \\{\\s*grid-template-columns: repeat\\(${cols}, minmax\\(0, 1fr\\)\\);\\s*grid-auto-flow: row;`);

/** Mirrors the CSS: columns per cell count at ≥ 900px, and the last cell's span. */
function layout(n: number): { cols: number; lastSpan: number } {
	const cols = n <= 6 ? n : n <= 8 ? 4 : n <= 10 ? 5 : 6;
	const rem = n % cols;
	return { cols, lastSpan: rem === 0 ? 1 : cols - rem + 1 };
}

describe('#429 StatGroup rows', () => {
	it('keeps the group a single grid container the cells are direct children of', () => {
		expect(statGroup).toMatch(/<div class="stat-group"[^>]*>\s*\{@render children\(\)\}\s*<\/div>/);
		expect(statCell).toContain('class="stat-cell');
	});

	it('the Contacts overview renders all its tiles as cells of one group', () => {
		expect(overview).toMatch(
			/<StatGroup[^>]*>\s*\{#each overview\.tiles as t \(t\.key\)\}\s*<StatCell [^>]*\/>\s*\{\/each\}\s*<\/StatGroup>/
		);
	});

	it('defines exclusive 4 / 5 / 6 column bands for 7–8, 9–10 and 11+ cells', () => {
		expect(wide).toMatch(band('.stat-group:has(> :global(:nth-child(7))):not(:has(> :global(:nth-child(9))))', 4));
		expect(wide).toMatch(band('.stat-group:has(> :global(:nth-child(9))):not(:has(> :global(:nth-child(11))))', 5));
		expect(wide).toMatch(band('.stat-group:has(> :global(:nth-child(11)))', 6));
		// Up to 6 cells there is no ≥ 900px rule: the one-row column flow from 600px stays.
		expect(wide).not.toMatch(/nth-child\([1-6]\)\)\)/);
	});

	it('a short last row is filled by the last cell spanning the leftover columns', () => {
		for (const n of [7, 9, 11, 13, 14, 15, 16]) {
			const { cols, lastSpan } = layout(n);
			const k = n % cols;
			const span = lastSpan === cols ? '1 / -1' : `span ${lastSpan}`;
			expect(wide, `${n} cells`).toContain(
				`:global(.stat-cell:last-child:nth-child(${cols}n + ${k})) {\n\t\t\tgrid-column: ${span};`
			);
		}
		expect(layout(9)).toEqual({ cols: 5, lastSpan: 2 }); // 5 + 4
		expect(layout(8)).toEqual({ cols: 4, lastSpan: 1 }); // 4 + 4
		expect(layout(10)).toEqual({ cols: 5, lastSpan: 1 }); // 5 + 5
	});
});
