import { describe, it, expect } from 'vitest';
import { personalize, renderEmailHtml, renderEmailText } from '../src/lib/server/email';
import { guessColumns, isEmail } from '../src/lib/csv';

describe('personalize', () => {
	const tpl = 'Hi {{first_name}} ({{name}} / {{last_name}}) at {{company}} — {{email}} %%UNSUB_URL%%';

	it('fills every merge tag', () => {
		const out = personalize(tpl, 'https://u', {
			email: 'ada@acme.example.net',
			name: 'Ada Lovelace',
			first_name: 'Ada',
			last_name: 'Lovelace',
			company: 'Acme'
		});
		expect(out).toBe('Hi Ada (Ada Lovelace / Lovelace) at Acme — ada@acme.example.net https://u');
	});

	it('falls back: first_name → "there", company → blank', () => {
		const out = personalize('Hey {{first_name}} from {{company}}!', '#', { email: 'x@y.example.net' });
		expect(out).toBe('Hey there from !');
	});

	it('derives full name from parts when name is missing', () => {
		const out = personalize('{{name}}', '#', { email: 'x@y.example.net', first_name: 'Ada', last_name: 'L' });
		expect(out).toBe('Ada L');
	});
});

describe('permission reminder (#54)', () => {
	it('includes the origin note in the HTML footer, escaped', () => {
		const html = renderEmailHtml('hi', { originNote: 'you signed up at <ourco.example>' });
		expect(html).toContain("You're receiving this email because: you signed up at &lt;ourco.example&gt;");
		expect(html).toContain('Unsubscribe here');
	});

	it('omits the reminder when there is no origin', () => {
		const html = renderEmailHtml('hi', {});
		expect(html).not.toContain("You're receiving this email because");
	});

	it('skips the reminder entirely on 1:1 sends (unsubscribe: false)', () => {
		const html = renderEmailHtml('hi', { unsubscribe: false, originNote: 'signed up' });
		expect(html).not.toContain("You're receiving this email because");
	});

	it('appears in the text version too', () => {
		const text = renderEmailText('hi', { originNote: 'you signed up at ourco.example' });
		expect(text).toContain("You're receiving this email because: you signed up at ourco.example");
	});
});

describe('csv helpers', () => {
	it('guessColumns finds email/name/company variants', () => {
		const g = guessColumns(['E-Mail', 'Full Name', 'Company Name', 'extra']);
		expect(g.email).toBe('E-Mail');
		expect(g.name).toBe('Full Name');
		expect(g.company).toBe('Company Name');
	});

	it('isEmail accepts valid, rejects junk', () => {
		expect(isEmail('a@b.example.net')).toBe(true);
		expect(isEmail('notanemail')).toBe(false);
		expect(isEmail('a @b.example.net')).toBe(false);
	});
});
