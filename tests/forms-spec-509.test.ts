import { describe, it, expect } from 'vitest';
import {
	FORM_LIMITS,
	applyPreset,
	blankField,
	coerceAnswers,
	emptyForm,
	keyFromLabel,
	normalizeFormSpec,
	settingsOutcome,
	slugify,
	styleVars,
	validateFormSpec,
	withSettingsOutcome,
	type FormField,
	type FormSpec
} from '../src/lib/forms';

// #509: the form spec's strict save check, lenient read and answer coercion.

function q(type: FormField['type'], label: string, key: string, extra: Partial<FormField> = {}): FormField {
	return { ...blankField(type, label), key, ...extra };
}
function spec(extra: Partial<FormSpec> = {}): FormSpec {
	return { ...emptyForm('Test form'), ...extra };
}
const paths = (s: FormSpec) => validateFormSpec(s).map((p) => p.path);
const messages = (s: FormSpec) => validateFormSpec(s).map((p) => p.message).join(' | ');

describe('validateFormSpec', () => {
	it('accepts a new form', () => {
		expect(validateFormSpec(emptyForm('Hello'))).toEqual([]);
	});

	it('needs a title', () => {
		expect(paths(spec({ title: '  ' }))).toContain('title');
		expect(paths(spec({ title: 'x'.repeat(FORM_LIMITS.title + 1) }))).toContain('title');
	});

	it('limits the intro', () => {
		expect(paths(spec({ intro_md: 'x'.repeat(FORM_LIMITS.intro + 1) }))).toContain('intro_md');
	});

	it('limits the number of fields and pages', () => {
		const base = emptyForm('x');
		const many = Array.from({ length: FORM_LIMITS.fields }, (_, i) => q('short_text', `Q${i}`, `q${i}`));
		expect(paths(spec({ fields: [...base.fields, ...many] }))).toContain('fields');
		const breaks = Array.from({ length: FORM_LIMITS.pages }, () => blankField('page_break', 'P'));
		expect(messages(spec({ fields: [...base.fields, ...breaks] }))).toMatch(/at most 20 pages/);
	});

	it('limits label, help and placeholder length', () => {
		const s = spec();
		s.fields.push(q('short_text', 'x'.repeat(FORM_LIMITS.label + 1), 'a', { help: 'h'.repeat(FORM_LIMITS.help + 1), placeholder: 'p'.repeat(FORM_LIMITS.placeholder + 1) }));
		const p = paths(s);
		expect(p).toContain('fields[1].label');
		expect(p).toContain('fields[1].help');
		expect(p).toContain('fields[1].placeholder');
	});

	it('checks answer keys: format and uniqueness', () => {
		const s = spec();
		s.fields.push(q('short_text', 'A', '1bad'), q('short_text', 'B', 'dup'), q('short_text', 'C', 'dup'), q('short_text', 'D', 'x'.repeat(FORM_LIMITS.key + 1)));
		const p = paths(s);
		expect(p).toContain('fields[1].key');
		expect(p).toContain('fields[3].key');
		expect(p).not.toContain('fields[2].key');
		expect(p).toContain('fields[4].key');
	});

	it('needs a question label (not for hidden values)', () => {
		const s = spec();
		s.fields.push(q('short_text', '', 'a'), q('hidden', '', 'b'));
		expect(paths(s)).toContain('fields[1].label');
		expect(paths(s)).not.toContain('fields[2].label');
	});

	it('checks options: at least one, at most 50, no blanks or duplicates', () => {
		const s = spec();
		s.fields.push(
			q('radio', 'None', 'none', { options: [] }),
			q('select', 'Many', 'many', { options: Array.from({ length: FORM_LIMITS.options + 1 }, (_, i) => ({ value: `o${i}`, label: `o${i}` })) }),
			q('checkboxes', 'Dup', 'dup', { options: [{ value: 'A', label: 'A' }, { value: 'a', label: 'a' }, { value: '', label: '' }] })
		);
		const p = paths(s);
		expect(p).toContain('fields[1].options');
		expect(p).toContain('fields[2].options');
		expect(p).toContain('fields[3].options[1]');
		expect(p).toContain('fields[3].options[2]');
	});

	it('refuses required on a type that cannot be required', () => {
		const s = spec();
		s.fields.push(q('heading', 'H', '', { required: true }));
		expect(paths(s)).toContain('fields[1].required');
	});

	it('refuses two questions filling the same contact field or custom field', () => {
		const s = spec();
		s.fields.push(
			q('short_text', 'First', 'first', { map: { to: 'contact', field: 'first_name' } }),
			q('short_text', 'Also first', 'first2', { map: { to: 'contact', field: 'first_name' } }),
			q('short_text', 'Role', 'role', { map: { to: 'meta', key: 'role' } }),
			q('short_text', 'Role again', 'role2', { map: { to: 'meta', key: 'Role' } }),
			q('email', 'Second email', 'email2', { map: { to: 'contact', field: 'email' } })
		);
		const p = validateFormSpec(s);
		expect(p.find((x) => x.path === 'fields[2].map')?.message).toMatch(/First name/);
		expect(p.find((x) => x.path === 'fields[4].map')?.message).toMatch(/role/i);
		expect(p.find((x) => x.path === 'fields[5].map')?.message).toMatch(/Email/);
	});

	it('only an Email question can be the contact email', () => {
		const s = spec({ fields: [q('short_text', 'Mail', 'mail', { required: true, map: { to: 'contact', field: 'email' } })] });
		expect(messages(s)).toMatch(/Only an Email question/);
	});

	it('requires an email question unless anonymous submissions are allowed', () => {
		const none = spec({ fields: [q('short_text', 'Name', 'name')] });
		expect(paths(none)).toContain('fields');
		const optional = spec();
		optional.fields[0].required = false;
		expect(paths(optional)).toContain('fields[0].required');
		const anon = spec({ fields: [q('short_text', 'Name', 'name')] });
		anon.settings.allow_anonymous = true;
		expect(validateFormSpec(anon)).toEqual([]);
	});

	it('checks tag mappings', () => {
		const s = spec();
		s.fields.push(
			q('short_text', 'Free', 'free', { map: { to: 'tag' } }),
			q('checkbox', 'Tick', 'tick', { map: { to: 'tag' } }),
			q('short_text', 'Pre', 'pre', { map: { to: 'tag_prefix', prefix: 'x:' } }),
			q('checkboxes', 'Interests', 'interests', { options: [{ value: 'A', label: 'A' }], map: { to: 'tag_prefix', prefix: 'interest:' } })
		);
		const p = paths(s);
		expect(p).toContain('fields[1].map');
		expect(p).toContain('fields[2].map');
		expect(p).toContain('fields[3].map');
		expect(p).not.toContain('fields[4].map');
	});

	it('checks outcomes: redirect URL, message XOR redirect, limits', () => {
		const bad = withSettingsOutcome(spec(), [{ type: 'redirect', url: 'javascript:alert(1)' }]);
		expect(messages(bad)).toMatch(/full http/);
		const both = withSettingsOutcome(spec(), [{ type: 'message_md', md: 'hi' }, { type: 'redirect', url: 'https://x.test/' }]);
		expect(messages(both)).toMatch(/either a message or a redirect/);
		const long = withSettingsOutcome(spec(), [{ type: 'message_md', md: 'x'.repeat(FORM_LIMITS.message + 1) }]);
		expect(messages(long)).toMatch(/Message is over/);
		const tags = withSettingsOutcome(spec(), Array.from({ length: FORM_LIMITS.actions + 1 }, (_, i) => ({ type: 'add_tag' as const, tag: `t${i}` })));
		expect(paths(tags)).toContain('outcomes[0].actions');
	});

	it('checks settings: button label, retention, notify count, origins', () => {
		const s = spec();
		s.settings.submit_label = '';
		s.settings.retention_days = 0;
		s.settings.notify_user_ids = Array.from({ length: FORM_LIMITS.notify + 1 }, (_, i) => i + 1);
		s.settings.allowed_origins = Array.from({ length: FORM_LIMITS.origins + 1 }, (_, i) => `https://s${i}.test`);
		const p = paths(s);
		expect(p).toEqual(expect.arrayContaining(['settings.submit_label', 'settings.retention_days', 'settings.notify_user_ids', 'settings.allowed_origins']));
		s.settings.retention_days = FORM_LIMITS.retentionMax + 1;
		expect(paths(s)).toContain('settings.retention_days');
	});
});

describe('normalizeFormSpec', () => {
	it('turns junk into a usable spec', () => {
		for (const junk of [null, 42, 'not json', '[]', { fields: 'x' }, { fields: [{ type: 'nope' }, 7, null] }]) {
			const s = normalizeFormSpec(junk);
			expect(s.title).toBe('Untitled form');
			expect(s.fields).toEqual([]);
			expect(s.style.preset).toBe('feedback');
			expect(s.settings.retention_days).toBe(365);
			expect(s.settings.noindex).toBe(true);
		}
	});

	it('keeps good fields, drops bad maps and junk colours', () => {
		const s = normalizeFormSpec({
			title: 'T',
			fields: [
				{ type: 'short_text', id: 'a', key: 'role', label: 'Role', map: { to: 'contact', field: 'password' } },
				{ type: 'radio', key: 'pick', label: 'Pick', options: ['One', { label: 'Two' }], map: { to: 'list', list_id: 'x' } },
				{ type: 'checkbox', key: 'ok', label: 'Ok', show_when: { match: 'any', rules: [{ field: 'role', op: 'eq', value: 'x' }, { field: '', op: 'eq' }] } }
			],
			style: { bg: 'red', accent: '#ABC', radius: 3, width: 9999, font: 'comic' }
		});
		expect(s.fields[0].map).toBeNull();
		expect(s.fields[1].options).toEqual([
			{ value: 'One', label: 'One' },
			{ value: 'Two', label: 'Two' }
		]);
		expect(s.fields[1].map).toBeNull();
		expect(s.fields[2].show_when).toEqual({ match: 'any', rules: [{ field: 'role', op: 'eq', value: 'x' }] });
		expect(s.style.bg).toBe('#f9f9f9');
		expect(s.style.accent).toBe('#aabbcc');
		expect(s.style.radius).toBe(9);
		expect(s.style.width).toBe(560);
		expect(s.style.font).toBe('ui');
		expect(s.pages).toEqual([{ id: 'start', title: 'T' }]);
	});

	it('derives pages from page breaks', () => {
		const s = normalizeFormSpec({ title: 'T', fields: [{ type: 'short_text', key: 'a', label: 'A' }, { type: 'page_break', id: 'pb', label: 'Second' }] });
		expect(s.pages).toEqual([{ id: 'start', title: 'T' }, { id: 'pb', title: 'Second' }]);
	});

	it('round-trips a valid spec', () => {
		const s = emptyForm('Round');
		expect(normalizeFormSpec(JSON.stringify(s))).toEqual(s);
	});
});

describe('helpers', () => {
	it('slugify and keyFromLabel', () => {
		expect(slugify('Book a Call — Now!')).toBe('book-a-call-now');
		expect(keyFromLabel("What's your role?")).toBe('whats_your_role');
		expect(keyFromLabel('2026 budget')).toBe('q_2026_budget');
	});

	it('presets change colours, not width or logo', () => {
		const s = { ...emptyForm('x').style, width: 720, logo: false };
		const d = applyPreset(s, 'dark');
		expect(d.bg).toBe('#161b22');
		expect(d.width).toBe(720);
		expect(d.logo).toBe(false);
		expect(styleVars(d)).toContain('--f-bg:#161b22');
	});

	it('the Settings outcome is the default one', () => {
		const s = emptyForm('x');
		expect(settingsOutcome(s).id).toBe('default');
		const next = withSettingsOutcome(s, [{ type: 'add_tag', tag: 'lead' }]);
		expect(next.outcomes).toHaveLength(1);
		expect(next.outcomes[0].actions).toEqual([{ type: 'add_tag', tag: 'lead' }]);
	});
});

describe('coerceAnswers', () => {
	const s = spec();
	s.fields.push(
		q('number', 'Age', 'age'),
		q('url', 'Site', 'site'),
		q('radio', 'Pick', 'pick', { options: [{ value: 'A', label: 'Alpha' }] }),
		q('checkboxes', 'Many', 'many', { options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] }),
		q('consent', 'I agree', 'agree', { required: true }),
		q('date', 'When', 'when')
	);

	it('coerces per type and requires what is required', () => {
		const { answers, errors } = coerceAnswers(s, { email: ' Ann@Example.COM ', age: '42', site: 'example.com', pick: 'A', many: ['y', 'x'], agree: 'on', when: '2026-11-03', junk: 'x' });
		expect(errors).toEqual({});
		expect(answers).toEqual({ email: 'ann@example.com', age: 42, site: 'https://example.com/', pick: 'A', many: ['x', 'y'], agree: true, when: '2026-11-03' });
	});

	it('reports bad values and missing required answers', () => {
		const { errors } = coerceAnswers(s, { email: 'nope', age: 'abc', site: 'javascript:1', pick: 'Z', many: ['q'], when: '2026-13-45' });
		expect(Object.keys(errors).sort()).toEqual(['age', 'agree', 'email', 'many', 'pick', 'site', 'when']);
		expect(coerceAnswers(s, {}).errors.email).toBe('This question is required.');
	});
});
