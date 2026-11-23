import { afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
	configureReportHost,
	guardReportUrl,
	keyedContactReportUrl,
	reportHost,
	reportOrigin,
	validateReportUrl
} from '../src/lib/server/report-url';

// #661: the contact `report_url` guard's host is the Worker var SNAPSHOT_REPORT_HOST, with no
// built-in host. Unset = report_url is an ordinary custom field.

const HOST = 'reports.ourco.example';
const PAGE = `https://${HOST}/acme.example/2026-10-01-full-audit.html`;

afterEach(() => configureReportHost(env)); // back to the pool's binding (tests/report-host.ts)

describe('report host (#661)', () => {
	it('comes from SNAPSHOT_REPORT_HOST, trimmed and lowercased; junk or missing = unset', () => {
		configureReportHost({ SNAPSHOT_REPORT_HOST: ` ${HOST.toUpperCase()} ` });
		expect(reportHost()).toBe(HOST);
		expect(reportOrigin()).toBe(`https://${HOST}`);
		for (const env of [{}, null, undefined, 'x', { SNAPSHOT_REPORT_HOST: '' }, { SNAPSHOT_REPORT_HOST: 'https://x.example/' }, { SNAPSHOT_REPORT_HOST: 'nodot' }, { SNAPSHOT_REPORT_HOST: 7 }]) {
			configureReportHost(env);
			expect(reportHost()).toBeNull();
			expect(reportOrigin()).toBe('');
		}
	});

	it('with a host: only keyed pages on it are kept', () => {
		configureReportHost({ SNAPSHOT_REPORT_HOST: HOST });
		expect(validateReportUrl(`${PAGE}?key=abc#x`)).toEqual({ ok: true, url: `${PAGE}?key=abc` });
		expect(keyedContactReportUrl(PAGE)).toBeNull();
		expect(keyedContactReportUrl('https://other.example/acme.example/file.html?key=abc')).toBeNull();
		const kept = { report_url: `${PAGE}?key=abc` };
		guardReportUrl(kept);
		expect(kept.report_url).toBe(`${PAGE}?key=abc`);
		const dropped: Record<string, unknown> = { report_url: PAGE, other: 'x' };
		guardReportUrl(dropped);
		expect(dropped).toEqual({ other: 'x' });
	});

	it('without a host: nothing validates, and the guard leaves report_url alone', () => {
		configureReportHost({});
		expect(validateReportUrl(`${PAGE}?key=abc`)).toEqual({ ok: false, host: HOST, reason: 'no report host configured' });
		expect(keyedContactReportUrl(`${PAGE}?key=abc`)).toBeNull();
		const meta = { report_url: 'https://anywhere.example/page' };
		guardReportUrl(meta);
		expect(meta.report_url).toBe('https://anywhere.example/page');
	});
});
