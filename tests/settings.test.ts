import { describe, it, expect } from 'vitest';
import { fromAllowed, parseEmailList } from '../src/lib/server/settings';

describe('fromAllowed (#43)', () => {
	it('empty setting = no enforcement', () => {
		expect(fromAllowed('anyone@anywhere.example.net', null)).toBe(true);
		expect(fromAllowed('anyone@anywhere.example.net', '  ')).toBe(true);
	});
	it('domain entries approve any address on the domain', () => {
		expect(fromAllowed('alan@ourco.example', 'ourco.example')).toBe(true);
		expect(fromAllowed('ANYONE@Ourco.example', 'ourco.example')).toBe(true);
		expect(fromAllowed('alan@evil.example.net', 'ourco.example')).toBe(false);
	});
	it('full-address entries are exact matches', () => {
		expect(fromAllowed('special@partner.example.net', 'ourco.example, special@partner.example.net')).toBe(true);
		expect(fromAllowed('other@partner.example.net', 'ourco.example, special@partner.example.net')).toBe(false);
	});
});

describe('parseEmailList', () => {
	it('splits, lowercases, dedupes, drops junk, caps', () => {
		expect(parseEmailList('A@b.example.net, a@b.example.net; c@d.example.net\nnotanemail')).toEqual(['a@b.example.net', 'c@d.example.net']);
		expect(parseEmailList(null)).toEqual([]);
	});
});
