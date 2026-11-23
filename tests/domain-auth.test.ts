import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
	applyTransitions,
	checkDmarc,
	checkPostmarkDkim,
	checkReturnPath,
	checkSpf,
	countSpfLookups,
	domainAuthAlert,
	domainOf,
	fetchPostmarkDomains,
	mapPostmarkDomain,
	recordResult,
	spfAll,
	spfDirectLookups,
	txtValue,
	type AuthCheck,
	type CheckStatus,
	type DomainAuthResult
} from '../src/lib/server/domain-auth';
import { recentActivity } from '../src/lib/server/activity';

// #304: domain-auth panel — record parsing, Postmark mapping, pass → fail alerting.
const db = (env as any).DB as D1Database;

describe('record parsing', () => {
	it('joins quoted TXT chunks', () => {
		expect(txtValue('"v=DKIM1; k=rsa; " "p=ABC"')).toBe('v=DKIM1; k=rsa; p=ABC');
		expect(txtValue('v=spf1 -all')).toBe('v=spf1 -all');
	});

	it('DMARC: exactly one record passes with its policy', () => {
		const c = checkDmarc('x.example.net', ['v=DMARC1; p=quarantine; pct=50; rua=mailto:d@x.example.net', 'google-site-verification=abc']);
		expect(c.status).toBe('pass');
		expect(c.summary).toContain('p=quarantine');
		expect(c.summary).toContain('pct=50');
		expect(c.summary).toContain('rua=mailto:d@x.example.net');
	});

	it('DMARC: none or more than one record fails', () => {
		const none = checkDmarc('x.example.net', []);
		expect(none.status).toBe('fail');
		expect(none.record).toMatchObject({ type: 'TXT', host: '_dmarc.x.example.net' });
		const two = checkDmarc('x.example.net', ['v=DMARC1; p=none', 'v=DMARC1; p=reject']);
		expect(two.status).toBe('fail');
		expect(two.summary).toMatch(/2 DMARC records/);
	});

	it('DMARC: p=none warns, a missing p fails', () => {
		expect(checkDmarc('x.example.net', ['v=DMARC1; p=none']).status).toBe('warn');
		expect(checkDmarc('x.example.net', ['v=DMARC1; rua=mailto:a@x.example.net']).status).toBe('fail');
	});

	it('SPF: counts lookup mechanisms and nested targets', () => {
		expect(spfDirectLookups('v=spf1 include:a.com a mx ip4:1.2.3.4 ~include:b.example.net exists:%{i}.x.example.net ptr ~all')).toEqual({
			lookups: 6,
			nested: ['a.com', 'b.example.net']
		});
		expect(spfDirectLookups('v=spf1 redirect=_spf.x.example.net')).toEqual({ lookups: 1, nested: ['_spf.x.example.net'] });
		expect(spfDirectLookups('v=spf1 ip4:1.2.3.4 -all').lookups).toBe(0);
	});

	it('SPF: follows includes recursively', async () => {
		const zone: Record<string, string[]> = {
			'a.com': ['v=spf1 include:c.example.net include:d.com -all'],
			'c.example.net': ['v=spf1 a mx -all'],
			'd.com': ['v=spf1 ip4:1.1.1.1 -all']
		};
		const r = await countSpfLookups('v=spf1 include:a.com ~all', async (n) => zone[n] ?? []);
		expect(r.count).toBe(5); // a.com, c.example.net, d.com, a, mx
		expect(r.errors).toEqual([]);
	});

	it('SPF: the all qualifier', () => {
		expect(spfAll('v=spf1 include:a.com ~all').qualifier).toBe('~');
		expect(spfAll('v=spf1 -all').qualifier).toBe('-');
		expect(spfAll('v=spf1 ?all').qualifier).toBe('?');
		expect(spfAll('v=spf1 all').qualifier).toBe('+');
		expect(spfAll('v=spf1 include:a.com')).toEqual({ qualifier: null, redirect: false });
		expect(spfAll('v=spf1 redirect=x.example.net')).toEqual({ qualifier: null, redirect: true });
	});

	it('SPF check: one record, lookups near / over 10, the ending', async () => {
		const noop = async () => ['v=spf1 -all'];
		expect((await checkSpf('x.example.net', ['v=spf1 include:a.com ~all'], noop)).status).toBe('pass');
		expect((await checkSpf('x.example.net', ['v=spf1 include:a.com ?all'], noop)).status).toBe('warn');
		expect((await checkSpf('x.example.net', ['v=spf1 include:a.com'], noop)).status).toBe('warn');
		expect((await checkSpf('x.example.net', [], noop)).status).toBe('fail');
		expect((await checkSpf('x.example.net', ['v=spf1 -all', 'v=spf1 ~all'], noop)).status).toBe('fail');
		const eight = 'v=spf1 ' + Array.from({ length: 8 }, (_, i) => `include:i${i}.com`).join(' ') + ' ~all';
		const near = await checkSpf('x.example.net', [eight], noop);
		expect(near.status).toBe('warn');
		expect(near.fix).toMatch(/8 of 10/);
		const eleven = 'v=spf1 ' + Array.from({ length: 11 }, (_, i) => `include:i${i}.com`).join(' ') + ' ~all';
		expect((await checkSpf('x.example.net', [eleven], noop)).status).toBe('fail');
	});

	it('SPF check: an include without an SPF record fails', async () => {
		const c = await checkSpf('x.example.net', ['v=spf1 include:gone.example.net ~all'], async () => []);
		expect(c.status).toBe('fail');
		expect(c.summary).toContain('gone.example.net has no SPF record');
	});

	it('domainOf reads addresses, display names and bare domains', () => {
		expect(domainOf('Alan <alan@Ourco.example>')).toBe('ourco.example');
		expect(domainOf('alan@shop.x.example.net')).toBe('shop.x.example.net');
		expect(domainOf('example.org')).toBe('example.org');
		expect(domainOf('')).toBeNull();
	});
});

describe('Postmark domains', () => {
	afterEach(() => vi.unstubAllGlobals());

	const detail = {
		ID: 42,
		Name: 'Ourco.example',
		SPFVerified: true,
		DKIMVerified: false,
		DKIMHost: '',
		DKIMTextValue: '',
		DKIMPendingHost: '20261001pm._domainkey.ourco.example',
		DKIMPendingTextValue: 'k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC',
		DKIMUpdateStatus: 'Pending',
		ReturnPathDomain: 'pm-bounces.ourco.example',
		ReturnPathDomainVerified: true,
		ReturnPathDomainCNAMEValue: 'pm.mtasv.net'
	};

	it('maps the domain detail response', () => {
		expect(mapPostmarkDomain(detail)).toEqual({
			id: 42,
			name: 'ourco.example',
			dkimVerified: false,
			dkimHost: null,
			dkimValue: null,
			dkimPendingHost: '20261001pm._domainkey.ourco.example',
			dkimPendingValue: 'k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC',
			dkimUpdateStatus: 'Pending',
			returnPathDomain: 'pm-bounces.ourco.example',
			returnPathVerified: true,
			returnPathCname: 'pm.mtasv.net'
		});
	});

	it('lists domains, reads the wanted ones with the account token header', async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const h = new Headers(init?.headers);
			if (h.get('X-Postmark-Account-Token') !== 'acct') return new Response('{}', { status: 401 });
			if (url.endsWith('/domains?count=500&offset=0')) {
				return Response.json({ TotalCount: 2, Domains: [{ ID: 42, Name: 'Ourco.example' }, { ID: 7, Name: 'other.example.net' }] });
			}
			if (url.endsWith('/domains/42')) return Response.json(detail);
			return new Response('unexpected', { status: 500 });
		});
		vi.stubGlobal('fetch', fetchMock);
		const { domains, error } = await fetchPostmarkDomains('acct', ['ourco.example']);
		expect(error).toBeNull();
		expect(domains.get('ourco.example')?.dkimPendingHost).toBe('20261001pm._domainkey.ourco.example');
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const bad = await fetchPostmarkDomains('server-token', ['ourco.example']);
		expect(bad.domains.size).toBe(0);
		expect(bad.error).toMatch(/account API token/);
	});

	it('DKIM check: pending key → fail with the exact record; verified + DNS key → pass', () => {
		const pm = mapPostmarkDomain(detail);
		const pending = checkPostmarkDkim(pm, null, null);
		expect(pending.status).toBe('fail');
		expect(pending.record).toEqual({ type: 'TXT', host: detail.DKIMPendingHost, value: detail.DKIMPendingTextValue });

		const ok = mapPostmarkDomain({
			...detail,
			DKIMVerified: true,
			DKIMHost: '2025pm._domainkey.ourco.example',
			DKIMTextValue: 'k=rsa;p=XYZ',
			DKIMPendingHost: '',
			DKIMPendingTextValue: ''
		});
		const pass = checkPostmarkDkim(ok, null, ['k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ']);
		expect(pass.status).toBe('pass');
		expect(pass.summary).toContain('2025pm');
		expect(checkPostmarkDkim(ok, null, []).status).toBe('fail'); // key gone from DNS
		expect(checkPostmarkDkim(null, 'rejected', null).status).toBe('unknown');
	});

	it('Return-Path check: CNAME to pm.mtasv.net', () => {
		const pm = mapPostmarkDomain(detail);
		expect(checkReturnPath('ourco.example', pm, ['pm.mtasv.net.']).status).toBe('pass');
		expect(checkReturnPath('ourco.example', pm, []).status).toBe('fail');
		expect(checkReturnPath('ourco.example', null, []).status).toBe('warn');
		expect(checkReturnPath('ourco.example', pm, null).status).toBe('unknown');
	});
});

function result(at: string, statuses: Partial<Record<'dmarc' | 'spf', CheckStatus>>): DomainAuthResult {
	const checks: AuthCheck[] = (Object.entries(statuses) as ['dmarc' | 'spf', CheckStatus][]).map(([key, status]) => ({
		key,
		label: key === 'dmarc' ? 'DMARC' : 'SPF',
		status,
		summary: `${key} ${status}`
	}));
	return { at, trigger: 'cron', postmarkError: null, domains: [{ domain: 'x.example.net', checks, postmark: null }] };
}

describe('pass → fail alerting', () => {
	beforeEach(async () => {
		await db.prepare("DELETE FROM app_state WHERE key IN ('domain_auth', 'domain_auth_alert', 'domain_auth_events')").run();
	});

	it('raises the banner and the activity row once, clears on recovery', async () => {
		expect(await recordResult(db, result('2026-10-15T09:00:00.000Z', { dmarc: 'pass', spf: 'pass' }))).toEqual([]);
		expect(await domainAuthAlert(db)).toEqual([]);

		const raised = await recordResult(db, result('2026-10-16T09:00:00.000Z', { dmarc: 'fail', spf: 'pass' }));
		expect(raised).toHaveLength(1);
		let alert = await domainAuthAlert(db);
		expect(alert).toHaveLength(1);
		expect(alert[0].text).toBe('DMARC broken on x.example.net: mail may bounce');

		// Still failing the next day: same banner, nothing new raised.
		expect(await recordResult(db, result('2026-10-17T09:00:00.000Z', { dmarc: 'fail', spf: 'pass' }))).toEqual([]);
		alert = await domainAuthAlert(db);
		expect(alert).toHaveLength(1);
		expect(alert[0].since).toBe('2026-10-16T09:00:00.000Z');

		const feed = (await recentActivity(db, { limit: 50, types: ['domain_auth'] })).filter((a) => a.type === 'domain_auth');
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({ at: '2026-10-16 09:00:00', email: 'x.example.net' });
		expect(feed[0].detail).toContain('DMARC broken on x.example.net');

		// Fixed: the banner goes away.
		await recordResult(db, result('2026-10-18T09:00:00.000Z', { dmarc: 'pass', spf: 'pass' }));
		expect(await domainAuthAlert(db)).toEqual([]);
	});

	it('a first-ever fail or warn → fail raises nothing', () => {
		expect(applyTransitions(null, result('2026-10-16T00:00:00Z', { dmarc: 'fail' }), null).raised).toEqual([]);
		const prev = result('2026-10-15T00:00:00Z', { spf: 'warn' });
		expect(applyTransitions(prev, result('2026-10-16T00:00:00Z', { spf: 'fail' }), null).raised).toEqual([]);
	});

	it('a failed lookup in between does not hide pass → fail', () => {
		const a = result('2026-10-14T00:00:00Z', { dmarc: 'pass' });
		const b = result('2026-10-15T00:00:00Z', { dmarc: 'unknown' });
		applyTransitions(a, b, null); // stamps lastKnown on b
		const { raised } = applyTransitions(b, result('2026-10-16T00:00:00Z', { dmarc: 'fail' }), null);
		expect(raised).toHaveLength(1);
	});
});
