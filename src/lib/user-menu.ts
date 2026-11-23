// #141: keyboard model for the user-chip menu (Settings · Take the tour · Install app ·
// Sign out). Client- AND server-safe so it's unit-testable without a DOM.

/**
 * Index of the menu item to focus after `key`, given the currently focused index (-1 when
 * focus isn't on an item) and the item count. ArrowDown/ArrowUp wrap; Home/End jump.
 * Returns null for keys the menu doesn't handle (or an empty menu).
 */
export function nextMenuIndex(current: number, key: string, count: number): number | null {
	if (count <= 0) return null;
	switch (key) {
		case 'ArrowDown':
			return current < 0 ? 0 : (current + 1) % count;
		case 'ArrowUp':
			return current < 0 ? count - 1 : (current - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}
