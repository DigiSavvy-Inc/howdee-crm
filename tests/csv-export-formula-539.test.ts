import { describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import { csvCell } from '../src/lib/report-view';
import { unguardCsvCell } from '../src/lib/csv';

describe('contact exports guard formulas (#539)', () => {
	for (const lead of ['=', '+', '-', '@']) {
		it(`prefixes a value starting with ${lead}`, () => {
			const v = `${lead}HYPERLINK("http://x","y")`;
			expect(csvCell(v).replace(/^"/, '').startsWith("'" + lead)).toBe(true);
		});
		it(`round-trips ${lead} through import`, () => {
			const v = `${lead}cmd|' /C calc'!A0`;
			const parsed = Papa.parse<string[]>(csvCell(v), { delimiter: ',', transform: unguardCsvCell });
			expect(parsed.data[0][0]).toBe(v);
		});
	}
	it('leaves plain values and numbers alone', () => {
		expect(csvCell('Ada')).toBe('Ada');
		expect(csvCell(-5)).toBe('-5');
		expect(unguardCsvCell("'quoted")).toBe("'quoted");
	});
});
