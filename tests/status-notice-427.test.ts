import { describe, it, expect } from 'vitest';
import editor from '../src/routes/automations/[id]/+page.svelte?raw';
import dashboard from '../src/routes/+page.svelte?raw';
import conversations from '../src/routes/conversations/+page.svelte?raw';
import backups from '../src/routes/settings/backups/+page.svelte?raw';
import deliverability from '../src/lib/components/DeliverabilityAlerts.svelte?raw';
import { statusTone } from '../src/lib/automation-editor';

// #427: one shared .notice box (app.css) instead of page-local alerts / banners / left bars,
// and the automation editor's status line as plain meta text unless there's something to flag.
const now = '2026-10-22 12:00:00';
const base = { status: 'active', failed: 0, pendingTriggers: 0, nextRunAt: null, now };

describe('#427 shared notice styling', () => {
	// (.notice itself lives in src/app.css; Vitest blanks CSS imports, so it isn't read here.)
	it('the dashboard, conversations, backups and deliverability alerts use it', () => {
		expect(dashboard).toContain('class="notice err" role="alert"');
		expect(dashboard).toContain('class="notice warn"');
		expect(dashboard).not.toMatch(/class="alert/);
		expect(conversations).toContain('class="notice ok" role="status"');
		expect(conversations).toContain('class="notice err" role="alert"');
		expect(conversations).not.toContain('class="banner');
		expect(backups).toContain('class="notice warn stale" role="alert"');
		expect(backups).not.toContain('class="banner');
		expect(deliverability).toMatch(/class="notice da"[^>]*role="status"/);
	});
});

describe('#427 automation editor status line', () => {
	it('renders no .status-strip and no bespoke left-bar boxes', () => {
		expect(editor).not.toMatch(/status-strip|st-active|st-paused|warn-banner/);
		expect(editor).not.toMatch(/inset 3px 0 0/);
	});

	it('is a plain muted meta line when nothing needs flagging, else a .notice of the tone', () => {
		expect(editor).toContain("statusTone === 'meta' ? 'muted status-meta' : `notice ${statusTone}`");
		expect(statusTone(base)).toBe('meta');
		expect(statusTone({ ...base, status: 'draft' })).toBe('meta');
		expect(statusTone({ ...base, nextRunAt: '2026-10-22 11:50:00' })).toBe('meta');
	});

	it('is .notice.warn when paused, with pending triggers, or overdue', () => {
		expect(statusTone({ ...base, status: 'paused' })).toBe('warn');
		expect(statusTone({ ...base, pendingTriggers: 3 })).toBe('warn');
		expect(statusTone({ ...base, nextRunAt: '2026-10-22 11:00:00' })).toBe('warn');
	});

	it('is .notice.err with failed passes', () => {
		expect(statusTone({ ...base, failed: 1 })).toBe('err');
		expect(statusTone({ ...base, status: 'paused', failed: 2 })).toBe('err');
	});

	it('the other automation notices (pending triggers, activate confirm) use .notice.warn', () => {
		expect(editor).toContain('class="notice warn pending-triggers" role="status"');
		expect((editor.match(/<p class="notice warn">/g) ?? []).length).toBe(2);
	});
});
