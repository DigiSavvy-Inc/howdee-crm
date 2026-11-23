import { describe, it, expect } from 'vitest';
import { safeMetaJson } from '../src/lib/server/meta';

describe('safeMetaJson', () => {
	it('passes small objects through untouched', () => {
		const json = safeMetaJson({ tier: 'hot', score: 92 });
		expect(JSON.parse(json!)).toEqual({ tier: 'hot', score: 92 });
	});

	it('always emits valid JSON when capping (the truncation-bug class)', () => {
		const out = safeMetaJson({ tier: 'hot', details: 'x'.repeat(9000), note: 'keep' });
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out!); // must not throw
		expect(parsed.tier).toBe('hot');
		expect(parsed.note).toBe('keep');
		expect(parsed.details).toBeUndefined(); // largest value dropped
	});

	it('returns null when nothing fits', () => {
		expect(safeMetaJson({ d: 'y'.repeat(9000) })).toBeNull();
	});

	it('returns null for an empty object', () => {
		expect(safeMetaJson({})).toBeNull();
	});
});
