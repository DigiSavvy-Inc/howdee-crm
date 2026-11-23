import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	checkPostmarkDkim,
	checkSummary,
	lastDomainAuth,
	POSTMARK_TOKEN_FIX,
	recordResult,
	statusChanges,
	statusSnapshot,
	type AuthCheck,
	type CheckStatus,
	type DomainAuthResult
} from '../src/lib/server/domain-auth';
import { actions as deliverabilityActions, load as deliverabilityLoad } from '../src/routes/deliverability/+page.server';
import { changeText, checkedText } from '../src/lib/domain-auth-view';

// #363: Re-check feedback on /deliverability — inline confirmation, "was → now" marks, prev kept.
const db = (env as any).DB as D1Database;

type Statuses = Partial<Record<'dmarc' | 'spf' | 'google_dkim', CheckStatus>>;

function result(at: string, domains: Record<string, Statuses>): DomainAuthResult {
	return {
		at,
		trigger: 'manual',
		postmarkError: null,
		domains: Object.entries(domains).map(([domain, statuses]) => ({
			domain,
			postmark: null,
			checks: (Object.entries(statuses) as [AuthCheck['key'], CheckStatus][]).map(([key, status]) => ({
				key,
				label: key,
				status,
				summary: `${key} ${status}`,
				...(key === 'google_dkim' ? { informational: true } : {})
			}))
		}))
	};
}

beforeEach(async () => {
	await db.prepare("DELETE FROM app_state WHERE key IN ('domain_auth', 'domain_auth_alert', 'domain_auth_events')").run();
});

describe('previous result + status changes', () => {
	it('recordResult keeps the run before as prev (statuses only, not nested)', async () => {
		await recordResult(db, result('2026-10-18T09:00:00.000Z', { 'x.com': { dmarc: 'fail', spf: 'unknown' } }));
		expect((await lastDomainAuth(db))?.prev).toBeNull();

		await recordResult(db, result('2026-10-19T09:00:00.000Z', { 'x.com': { dmarc: 'pass', spf: 'pass' } }));
		await recordResult(db, result('2026-10-19T10:00:00.000Z', { 'x.com': { dmarc: 'pass', spf: 'fail' } }));
		const stored = await lastDomainAuth(db);
		expect(stored?.prev).toEqual({ at: '2026-10-19T09:00:00.000Z', statuses: { 'x.com/dmarc': 'pass', 'x.com/spf': 'pass' } });
		expect(JSON.stringify(stored?.prev)).not.toContain('prev');
		expect(statusChanges(stored)).toEqual({ 'x.com/spf': { was: 'pass', now: 'fail' } });
	});

	it('diffs pass → fail and unknown → pass; unchanged and new checks are not marked', () => {
		const prev = result('2026-10-18T09:00:00.000Z', { 'x.com': { dmarc: 'pass', spf: 'unknown', google_dkim: 'warn' } });
		const next = result('2026-10-19T09:00:00.000Z', { 'x.com': { dmarc: 'fail', spf: 'pass', google_dkim: 'warn' }, 'y.com': { dmarc: 'pass' } });
		next.prev = statusSnapshot(prev);
		expect(statusChanges(next)).toEqual({
			'x.com/dmarc': { was: 'pass', now: 'fail' },
			'x.com/spf': { was: 'unknown', now: 'pass' }
		});
		expect(statusChanges({ ...next, prev: null })).toEqual({});
		expect(statusChanges(null)).toEqual({});
		expect(changeText({ was: 'fail', now: 'pass' })).toBe('was Fail → now Pass');
	});
});

describe('Re-check confirmation', () => {
	it('counts domains passing vs needing attention (informational checks ignored)', () => {
		const r = result('2026-10-19T09:00:00.000Z', {
			'a.com': { dmarc: 'pass', spf: 'pass', google_dkim: 'warn' },
			'b.com': { dmarc: 'warn', spf: 'pass' }
		});
		expect(checkSummary(r)).toEqual({ domains: 2, passing: 1, attention: 1 });
		expect(checkedText(checkSummary(r))).toBe('Checked just now: 2 domains, 1 passing, 1 needs attention');
		expect(checkedText({ domains: 1, passing: 1, attention: 0 })).toBe('Checked just now: 1 domain, 1 passing, 0 need attention');
		expect(checkedText({ domains: 0, passing: 0, attention: 0 })).toBe('Checked just now: no sending domain found.');
	});

	it('the checkDomainAuth action returns the counts the confirmation renders, and load marks changes', async () => {
		await recordResult(db, result('2026-10-18T09:00:00.000Z', { 'x.test': { dmarc: 'pass' } }));
		const event = {
			platform: { env: { DB: db, POSTMARK_FROM: 'jdoe@x.test' } },
			request: new Request('https://app.test/deliverability?/checkDomainAuth', { method: 'POST', body: new FormData() })
		} as any;
		const out = (await deliverabilityActions.checkDomainAuth(event)) as any;
		expect(out.domainChecked.domains).toBeGreaterThanOrEqual(1);
		expect(out.domainChecked.passing + out.domainChecked.attention).toBe(out.domainChecked.domains);
		expect(checkedText(out.domainChecked)).toMatch(/^Checked just now: \d+ domains?, \d+ passing, \d+ needs? attention$/);

		const stored = await lastDomainAuth(db);
		expect(stored?.prev?.statuses['x.test/dmarc']).toBe('pass');
		const data = (await deliverabilityLoad({ platform: event.platform, url: new URL('https://app.test/deliverability') } as any)) as any;
		const now = stored!.domains.find((d) => d.domain === 'x.test')!.checks.find((c) => c.key === 'dmarc')!.status;
		if (now === 'pass') expect(data.domainChanges['x.test/dmarc']).toBeUndefined();
		else expect(data.domainChanges['x.test/dmarc']).toEqual({ was: 'pass', now });
	});
});

describe('account-token hint', () => {
	it('lives in the DKIM row with where to get it', () => {
		const c = checkPostmarkDkim(null, 'no Postmark token set', null);
		expect(c.fix).toBe(POSTMARK_TOKEN_FIX);
		expect(c.fix).toContain('Postmark → Account → API Tokens');
		expect(c.fix).toContain('npx wrangler secret put POSTMARK_ACCOUNT_TOKEN');
	});
});
