// #573: one light / dark switch in the header (and the phone menu) instead of the three
// light / dark / system buttons, plus "Match device theme" in the account menu.
import { describe, expect, it } from 'vitest';

const raw = import.meta.glob(
	['../src/routes/+layout.svelte', '../src/app.html', '../src/lib/components/HelpPanel.svelte'],
	{ query: '?raw', import: 'default', eager: true }
) as Record<string, string>;
const src = (suffix: string) => {
	const key = Object.keys(raw).find((k) => k.endsWith(suffix));
	if (!key) throw new Error(`missing ${suffix}`);
	return raw[key];
};
const layout = src('routes/+layout.svelte');
const markup = layout.slice(layout.indexOf('</script>'), layout.indexOf('<style>'));
const css = layout.slice(layout.indexOf('<style>'));

describe('theme switch (#573)', () => {
	it('is one role="switch" button, checked when dark, with sun and moon icons', () => {
		const sw = markup.match(/<button[^>]*class="theme-switch"[\s\S]*?<\/button>/)?.[0] ?? '';
		expect(sw).toMatch(/role="switch"/);
		expect(sw).toMatch(/aria-checked=\{isDark\}/);
		expect(sw).toMatch(/type="button"/); // native button: Space and Enter flip it
		expect(sw).toMatch(/name="theme-light"/);
		expect(sw).toMatch(/name="theme-dark"/);
		expect(sw).toMatch(/theme-switch-knob/);
	});

	it('the three theme buttons are gone', () => {
		expect(markup).not.toMatch(/theme-toggle/);
		expect(markup).not.toMatch(/theme-system/);
		expect(layout).not.toMatch(/'system'/);
	});

	it('follows the device until flipped; flipping stores the choice', () => {
		expect(layout).toMatch(/new MediaQuery\('prefers-color-scheme: dark'\)/);
		expect(layout).toMatch(/storedTheme \? storedTheme === 'dark' : deviceDark\.current/);
		expect(layout).toMatch(/localStorage\.setItem\('theme', t\)/);
		expect(layout).toMatch(/localStorage\.removeItem\('theme'\)/);
	});

	it('is in the header and the phone menu, next to the unchanged nav button', () => {
		expect(markup).toMatch(/<div class="toggles">\{@render toggles\(\)\}<\/div>/);
		expect(markup).toMatch(/<div class="usermenu-toggles">\{@render toggles\(\)\}<\/div>/);
		expect(markup).toMatch(/class="theme-btn nav-toggle"/);
	});

	it('the account menu has "Match device theme", which clears the stored choice', () => {
		const item = markup.match(/<button[^>]*role="menuitem"[^>]*>(?:(?!<\/button>)[\s\S])*Match device theme<\/button>/)?.[0];
		expect(item).toBeTruthy();
		expect(item).toMatch(/setTheme\(null\)/);
	});

	it('the knob slides and stops sliding under reduced motion', () => {
		expect(css).toMatch(/\.theme-switch\[aria-checked='true'\] \.theme-switch-knob \{\s*transform: translateX/);
		expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.theme-switch-knob \{\s*transition: none/);
	});

	it('the early theme script in app.html still applies the stored choice before paint', () => {
		expect(src('app.html')).toMatch(/localStorage\.getItem\('theme'\)/);
	});

	it('help mentions the switch and Match device theme', () => {
		expect(src('components/HelpPanel.svelte')).toMatch(/Match device theme/);
	});
});
