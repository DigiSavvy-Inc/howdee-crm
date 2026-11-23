// #436: whole-dollar money (sub-lines) and compact tile money (from $10k).
import { describe, it, expect } from 'vitest';
import { money, moneyTile, moneyWhole } from '../src/lib/money';

describe('moneyWhole', () => {
	it('null / undefined → em dash, like money()', () => {
		expect(moneyWhole(null, 'USD')).toBe('—');
		expect(moneyWhole(undefined, 'USD')).toBe(money(undefined, 'USD'));
	});
	it('drops cents', () => {
		expect(moneyWhole(0, 'USD')).toBe('$0');
		expect(moneyWhole(6350, 'USD')).toBe('$6,350');
		expect(moneyWhole(49800, 'USD')).toBe('$49,800');
		expect(moneyWhole(2150.4, 'USD')).toBe('$2,150');
	});
	it('compact with one decimal from 1,000,000 up', () => {
		expect(moneyWhole(1234567, 'USD')).toBe('$1.2M');
		expect(moneyWhole(999999, 'USD')).toBe('$999,999');
	});
	it('keeps the record currency', () => {
		expect(moneyWhole(6350, 'EUR')).toBe('€6,350');
		expect(moneyWhole(6350, 'NOPE')).toBe('6,350 NOPE');
	});
	it('negatives', () => {
		expect(moneyWhole(-6350, 'USD')).toBe('-$6,350');
		expect(moneyWhole(-1234567, 'USD')).toBe('-$1.2M');
	});
});

describe('moneyTile', () => {
	it('null / undefined → em dash', () => {
		expect(moneyTile(null, 'USD')).toBe('—');
		expect(moneyTile(undefined, 'USD')).toBe('—');
	});
	it('exact whole dollars below 10,000', () => {
		expect(moneyTile(0, 'USD')).toBe('$0');
		expect(moneyTile(6350, 'USD')).toBe('$6,350');
		expect(moneyTile(9999, 'USD')).toBe('$9,999');
	});
	it('compact k with one decimal from 10,000, trailing .0 dropped', () => {
		expect(moneyTile(10000, 'USD')).toBe('$10k');
		expect(moneyTile(50000, 'USD')).toBe('$50k');
		expect(moneyTile(49800, 'USD')).toBe('$49.8k');
		expect(moneyTile(123456, 'USD')).toBe('$123.5k');
		expect(moneyTile(999900, 'USD')).toBe('$999.9k');
	});
	it('compact M from 1,000,000 (and when k would round to 1000)', () => {
		expect(moneyTile(1000000, 'USD')).toBe('$1M');
		expect(moneyTile(999950, 'USD')).toBe('$1M');
		expect(moneyTile(1234567, 'USD')).toBe('$1.2M');
	});
	it('negatives', () => {
		expect(moneyTile(-6350, 'USD')).toBe('-$6,350');
		expect(moneyTile(-49800, 'USD')).toBe('-$49.8k');
		expect(moneyTile(-1234567, 'USD')).toBe('-$1.2M');
	});
	it('keeps the record currency', () => {
		expect(moneyTile(49800, 'EUR')).toBe('€49.8k');
		expect(moneyTile(49800, 'NOPE')).toBe('49.8k NOPE');
		expect(moneyTile(6350, 'NOPE')).toBe('6,350 NOPE');
	});
});
