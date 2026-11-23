// Keyboard model for the automation Trigger drawer's type picker (#425). Universal and pure —
// the component maps a key to the index it should select, so the rule is testable without a DOM.

/** WAI-ARIA radio group: arrows wrap, Home / End jump; anything else → null (not handled). */
export function radioKeyTarget(key: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	const i = index < 0 ? 0 : index;
	switch (key) {
		case 'ArrowRight':
		case 'ArrowDown':
			return (i + 1) % count;
		case 'ArrowLeft':
		case 'ArrowUp':
			return (i - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}
