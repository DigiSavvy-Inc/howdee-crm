// Svelte action (#559): Enter in a single-line field must never submit the form through its
// first submit button (e.g. Compose's "Send test"). Explicit button clicks, textareas, links
// and contenteditable surfaces are untouched; other Enter handlers still run.
const NON_TEXT = new Set(['submit', 'button', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color']);

/** True when an Enter keydown on `target` would trigger the form's implicit submission. */
export function isImplicitSubmit(e: Pick<KeyboardEvent, 'key' | 'isComposing'>, target: EventTarget | null): boolean {
	if (e.key !== 'Enter' || e.isComposing) return false;
	const el = target as HTMLElement | null;
	if (!el || el.tagName !== 'INPUT') return false;
	return !NON_TEXT.has((el as HTMLInputElement).type);
}

export function noImplicitSubmit(form: HTMLFormElement) {
	const onKeydown = (e: KeyboardEvent) => {
		if (isImplicitSubmit(e, e.target)) e.preventDefault();
	};
	form.addEventListener('keydown', onKeydown);
	return { destroy: () => form.removeEventListener('keydown', onKeydown) };
}
