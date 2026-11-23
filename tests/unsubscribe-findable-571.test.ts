import { describe, expect, it } from 'vitest';
import bulkBar from '../src/lib/components/ContactBulkBar.svelte?raw';
import control from '../src/lib/components/SubscriptionControl.svelte?raw';
import contactPage from '../src/routes/contacts/[id]/+page.svelte?raw';
import help from '../src/lib/components/HelpPanel.svelte?raw';

// #571: Unsubscribe was hard to find — a status-looking badge on the contact page and the ninth
// row of the bulk bar. These pin the new, obvious places.

describe('contacts bulk bar (#571)', () => {
	// The bar's first line: the BulkBar shell's count, then everything before the Action row.
	const head = bulkBar.slice(bulkBar.indexOf('<BulkBar '), bulkBar.indexOf('<div class="bulk-row">'));

	it('puts Unsubscribe and Resubscribe on the first line, next to the selection count', () => {
		expect(head).toContain(`count="{count.toLocaleString('en-US')} selected"`);
		expect(head).toContain('action="?/bulkUnsubscribe"');
		expect(head).toContain('action="?/bulkResubscribe"');
		expect(head).toContain('name="suppress" value="1"');
		expect(head).toContain('Also suppress in Postmark');
		expect(head).toContain('They stop getting campaigns and automation emails');
		expect(head).toContain('Only resubscribe people who have agreed to get your email.');
	});

	it('has one place, not two: the lower Subscription row is gone', () => {
		expect(bulkBar.match(/\?\/bulkUnsubscribe/g)).toHaveLength(1);
		expect(bulkBar.match(/\?\/bulkResubscribe/g)).toHaveLength(1);
		expect(bulkBar).not.toContain('<span class="muted">Subscription</span>');
	});
});

describe('contact page Unsubscribe button (#571)', () => {
	it('sits beside Edit and Archive and keeps the badge', () => {
		const edit = contactPage.indexOf('edit-btn');
		const button = contactPage.indexOf('<SubscriptionControl variant="button"');
		const archive = contactPage.indexOf('action="?/setArchived"');
		expect(button).toBeGreaterThan(edit);
		expect(archive).toBeGreaterThan(button);
		expect(contactPage.match(/<SubscriptionControl\b/g)).toHaveLength(2);
	});

	it('puts the Unsubscribe / Resubscribe result on its own line, not beside the name', () => {
		expect(contactPage).toMatch(/\.head \{[^}]*flex-wrap: wrap/);
		expect(control).toContain('<span class="sub-error sub-result" role="alert">');
		expect(control).toContain('<span class="muted small sub-result" role="status">');
		expect(control).toMatch(/\.sub-result \{[^}]*flex-basis: 100%;[^}]*order: 1;/);
	});

	it('opens the same step and posts ?/setSubscribed, reads Resubscribe when unsubscribed, hides while pending', () => {
		const btn = control.slice(control.indexOf("{#if variant === 'button'}"), control.indexOf('{:else}\n<span class="sub-control"'));
		expect(btn).toContain("{#if mode !== 'pending'}");
		expect(btn).toContain("{subscribed ? 'Unsubscribe' : 'Resubscribe'}");
		expect(btn).toContain('<Modal');
		expect(btn.match(/action="\?\/setSubscribed"/g)).toHaveLength(2);
		expect(btn).toContain('{@render unsubFields()}');
		// The shared fields carry reason, note and the Postmark option.
		const fields = control.slice(control.indexOf('{#snippet unsubFields()}'), control.indexOf('{/snippet}'));
		expect(fields).toContain('name="reason"');
		expect(fields).toContain('name="note"');
		expect(fields).toContain('Also suppress in Postmark');
	});
});

describe('help (#571)', () => {
	it('explains both places and the Postmark option', () => {
		expect(help).toContain('Unsubscribe someone yourself');
		expect(help).toContain('Also suppress in Postmark');
	});
});
