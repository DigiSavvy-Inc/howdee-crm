import { describe, it, expect } from 'vitest';
import { nextMenuIndex } from '../src/lib/user-menu';

// #141: arrow-key navigation in the user-chip menu.

describe('nextMenuIndex', () => {
	it('ArrowDown moves forward and wraps', () => {
		expect(nextMenuIndex(0, 'ArrowDown', 3)).toBe(1);
		expect(nextMenuIndex(2, 'ArrowDown', 3)).toBe(0);
	});

	it('ArrowUp moves back and wraps', () => {
		expect(nextMenuIndex(1, 'ArrowUp', 3)).toBe(0);
		expect(nextMenuIndex(0, 'ArrowUp', 3)).toBe(2);
	});

	it('with no focused item, ArrowDown picks the first and ArrowUp the last', () => {
		expect(nextMenuIndex(-1, 'ArrowDown', 4)).toBe(0);
		expect(nextMenuIndex(-1, 'ArrowUp', 4)).toBe(3);
	});

	it('Home / End jump to the ends', () => {
		expect(nextMenuIndex(2, 'Home', 4)).toBe(0);
		expect(nextMenuIndex(0, 'End', 4)).toBe(3);
	});

	it('ignores other keys and empty menus', () => {
		expect(nextMenuIndex(0, 'Enter', 3)).toBeNull();
		expect(nextMenuIndex(0, 'a', 3)).toBeNull();
		expect(nextMenuIndex(-1, 'ArrowDown', 0)).toBeNull();
	});
});
