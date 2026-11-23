import { describe, it, expect } from 'vitest';
import { TRIGGER_TYPES } from '../src/lib/automation-trigger';
import { radioKeyTarget } from '../src/lib/trigger-type-picker';
import picker from '../src/lib/components/automations/TriggerTypePicker.svelte?raw';
import page from '../src/routes/automations/[id]/+page.svelte?raw';

// Picker as the drawer uses it: the card a key lands on becomes the bound value, which the
// hidden native radio (bind:group) mirrors — so this is the value the form posts.
function press(value: string, key: string): string {
	const i = TRIGGER_TYPES.findIndex((t) => t.type === value);
	const next = radioKeyTarget(key, i, TRIGGER_TYPES.length);
	return next === null ? value : TRIGGER_TYPES[next].type;
}

describe('TRIGGER_TYPES descriptions (#425)', () => {
	it('every kind has a label, icon and a one-line description', () => {
		expect(TRIGGER_TYPES.length).toBeGreaterThanOrEqual(5);
		for (const t of TRIGGER_TYPES) {
			expect(t.label).toBeTruthy();
			expect(t.icon).toBeTruthy();
			expect(t.description.trim().length).toBeGreaterThan(0);
			expect(t.description).not.toMatch(/\n/);
		}
		expect(TRIGGER_TYPES.find((t) => t.type === 'site_visit')?.description).toBe('From site tracking');
	});
});

describe('radioKeyTarget (#425)', () => {
	it('arrows move and wrap, Home / End jump, other keys are ignored', () => {
		expect(radioKeyTarget('ArrowRight', 0, 5)).toBe(1);
		expect(radioKeyTarget('ArrowDown', 4, 5)).toBe(0);
		expect(radioKeyTarget('ArrowLeft', 0, 5)).toBe(4);
		expect(radioKeyTarget('ArrowUp', 2, 5)).toBe(1);
		expect(radioKeyTarget('Home', 3, 5)).toBe(0);
		expect(radioKeyTarget('End', 0, 5)).toBe(4);
		expect(radioKeyTarget('a', 1, 5)).toBeNull();
		expect(radioKeyTarget('ArrowRight', -1, 5)).toBe(1);
		expect(radioKeyTarget('ArrowRight', 0, 0)).toBeNull();
	});

	it('keyboard navigation changes the selected trigger type', () => {
		expect(press('manual', 'ArrowDown')).toBe('list_added');
		expect(press('manual', 'ArrowUp')).toBe(TRIGGER_TYPES[TRIGGER_TYPES.length - 1].type);
		expect(press('list_added', 'Tab')).toBe('list_added');
	});
});

describe('TriggerTypePicker markup (#425)', () => {
	it('is a radiogroup of role="radio" cards rendering label + description', () => {
		expect(picker).toContain('role="radiogroup"');
		expect(picker).toContain('role="radio"');
		expect(picker).toContain('aria-checked={value === o.type}');
		expect(picker).toContain('{o.label}');
		expect(picker).toContain('{o.description}');
		expect(picker).toContain('<Icon name={o.icon}');
		expect(picker).not.toContain('{@html');
	});

	it('keeps a hidden native radio bound to the value, named trigger_type by default', () => {
		expect(picker).toMatch(/name = 'trigger_type'/);
		expect(picker).toMatch(/<input class="ttp-native" type="radio" \{name\} value=\{o\.type\} bind:group=\{value\}/);
	});

	it('is used inside the ?/setTrigger form with every trigger kind', () => {
		const form = page.slice(page.indexOf('action="?/setTrigger"'), page.indexOf('</form>', page.indexOf('action="?/setTrigger"')));
		expect(form).toContain('<TriggerTypePicker options={TRIGGER_TYPES} bind:value={triggerType} />');
		expect(form).not.toMatch(/name="trigger_type"/); // one source of the field: the picker
	});

	it('lays out as an auto-fill grid that drops to one column at 640px', () => {
		expect(picker).toContain('repeat(auto-fill, minmax(200px, 1fr))');
		expect(picker).toContain('gap: var(--card-gap)');
		expect(picker).toMatch(/@media \(max-width: 640px\)[\s\S]*grid-template-columns: 1fr/);
		expect(picker).toContain('min-height: 44px');
	});
});
