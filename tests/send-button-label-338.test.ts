import { describe, it, expect } from 'vitest';
import { sendButtonLabel, formatSendTime, weekdayShift } from '../src/lib/send-button-label';

// #338: the compose submit button says what will happen.
const base = { locale: 'en-US', timeZone: 'UTC', now: new Date('2026-10-18T12:00:00Z') };
const label = (o: Partial<Parameters<typeof sendButtonLabel>[0]>) =>
	sendButtonLabel({ mode: 'campaign', sendWhen: 'now', scheduledAt: null, count: 5, ...base, ...o });

describe('sendButtonLabel', () => {
	it('send now, plural and singular', () => {
		expect(label({}).label).toBe('Send now · 5 contacts');
		expect(label({ count: 1 }).label).toBe('Send now · 1 contact');
		expect(label({ busy: true }).label).toBe('Sending…');
	});

	it('schedule with a time, no year in the current year', () => {
		const r = label({ sendWhen: 'later', scheduledAt: new Date('2026-10-20T16:00:00Z') });
		expect(r).toEqual({ label: 'Schedule for Oct 20, 4:00 PM · 5 contacts', needsTime: false });
		expect(label({ sendWhen: 'later', scheduledAt: new Date('2026-10-20T16:00:00Z'), busy: true }).label).toBe(
			'Scheduling…'
		);
	});

	it('includes the year when it is not the current one', () => {
		const r = label({ sendWhen: 'later', scheduledAt: new Date('2027-01-05T09:30:00Z'), count: 1 });
		expect(r.label).toBe('Schedule for Jan 5, 2027, 9:30 AM · 1 contact');
	});

	it('no time yet → Schedule… and needs a time', () => {
		expect(label({ sendWhen: 'later' })).toEqual({ label: 'Schedule…', needsTime: true });
		expect(label({ sendWhen: 'later', scheduledAt: new Date('nope') }).needsTime).toBe(true);
	});

	it('weekdays only shows the Monday it moves to; best time adds a note', () => {
		// 2026-10-24 is a Saturday.
		const sat = new Date('2026-10-24T16:00:00Z');
		expect(label({ sendWhen: 'later', scheduledAt: sat, weekdayOnly: true }).label).toBe(
			'Schedule for Oct 26, 4:00 PM · 5 contacts'
		);
		expect(label({ sendWhen: 'later', scheduledAt: sat }).label).toBe('Schedule for Oct 24, 4:00 PM · 5 contacts');
		expect(label({ sendWhen: 'later', scheduledAt: sat, bestTime: true }).label).toBe(
			'Schedule for Oct 24, 4:00 PM (best time per contact) · 5 contacts'
		);
	});

	it('direct mode reads Send now', () => {
		expect(label({ mode: 'direct' }).label).toBe('Send now');
		expect(label({ mode: 'direct', busy: true }).label).toBe('Sending…');
	});
});

describe('helpers', () => {
	it('weekdayShift leaves weekdays alone, moves Sunday a day', () => {
		const wed = new Date('2026-10-21T10:00:00Z');
		expect(weekdayShift(wed, 'UTC')).toBe(wed);
		expect(weekdayShift(new Date('2026-10-25T10:00:00Z'), 'UTC').toISOString()).toBe('2026-10-26T10:00:00.000Z');
	});
	it('formatSendTime', () => {
		expect(formatSendTime(new Date('2026-12-31T23:05:00Z'), base.now, 'en-US', 'UTC')).toBe('Dec 31, 11:05 PM');
	});
});
