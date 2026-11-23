// #441: Settings → Mail's Gmail setup steps follow the current Google Auth Platform console.
import { describe, expect, it } from 'vitest';
import page from '../src/routes/settings/mail/+page.svelte?raw';

describe('Settings → Mail Gmail setup text (#441)', () => {
	it('points at Google Auth Platform → Data Access and enabling the Gmail API', () => {
		expect(page).toContain('Data Access');
		expect(page).toContain('Gmail API');
		expect(page).toContain('Google Auth Platform');
		expect(page).toContain('https://www.googleapis.com/auth/gmail.readonly');
	});

	it('no longer sends people to the old OAuth consent screen scopes page', () => {
		expect(page).not.toContain('OAuth consent screen');
	});
});
