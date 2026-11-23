import { describe, it, expect } from 'vitest';

// #348: the dscrm CLI's pure parts — argument parsing, the request each command makes,
// the markdown → draft body rule, table output and error messages.
import { draftBody, errorMessage, formatTable, parseArgs, planRequest } from '../scripts/dscrm-lib.mjs';

const plan = (argv: string[]) => {
	const { positional, flags } = parseArgs(argv);
	return planRequest(positional, flags);
};

describe('parseArgs', () => {
	it('splits positionals and flags; --x=v and --x v both work', () => {
		expect(parseArgs(['automations', 'list', '--status', 'draft', '--table'])).toEqual({
			positional: ['automations', 'list'],
			flags: { status: 'draft', table: true }
		});
		expect(parseArgs(['campaigns', 'list', '--status=sent']).flags).toEqual({ status: 'sent' });
		expect(parseArgs(['-h']).flags.help).toBe(true);
		expect(parseArgs(['--help']).flags.help).toBe(true);
	});

	it('refuses unknown flags and missing values', () => {
		expect(() => parseArgs(['--nope'])).toThrow(/Unknown option --nope/);
		expect(() => parseArgs(['automations', 'list', '--status'])).toThrow(/needs a value/);
		expect(() => parseArgs(['--table=yes'])).toThrow(/takes no value/);
	});
});

describe('planRequest', () => {
	it('automations', () => {
		expect(plan(['automations', 'list'])).toEqual({ method: 'GET', path: '/api/v1/automations' });
		expect(plan(['automations', 'list', '--status', 'paused', '--label', 'onboarding'])).toEqual({
			method: 'GET',
			path: '/api/v1/automations?status=paused&label=onboarding'
		});
		expect(plan(['automations', 'get', '7'])).toEqual({ method: 'GET', path: '/api/v1/automations/7' });
		expect(plan(['automations', 'create', 'flow.json'])).toEqual({ method: 'POST', path: '/api/v1/automations', readFile: 'flow.json' });
		expect(plan(['automations', 'update', '7', 'flow.json'])).toEqual({ method: 'PUT', path: '/api/v1/automations/7/spec', readFile: 'flow.json' });
		expect(plan(['automations', 'duplicate', '7'])).toEqual({ method: 'POST', path: '/api/v1/automations/7/duplicate' });
	});

	it('contacts and campaigns', () => {
		expect(plan(['contacts', 'search', 'ann', 'lee'])).toEqual({ method: 'GET', path: '/api/v1/contacts?q=ann+lee' });
		expect(plan(['contacts', 'search', 'a@b.example.net', '--limit', '5']).path).toBe('/api/v1/contacts?q=a%40b.example.net&limit=5');
		expect(plan(['campaigns', 'list'])).toEqual({ method: 'GET', path: '/api/v1/campaigns' });
		expect(plan(['campaigns', 'draft', 'post.md'])).toEqual({ method: 'POST', path: '/api/v1/campaigns', readFile: 'post.md', markdown: true });
	});

	it('bad commands and arguments are usage errors', () => {
		expect(() => plan(['automations', 'get'])).toThrow(/positive id/);
		expect(() => plan(['automations', 'get', 'abc'])).toThrow(/positive id/);
		expect(() => plan(['automations', 'update', '3'])).toThrow(/spec\.json/);
		expect(() => plan(['automations', 'activate', '3'])).toThrow(/Unknown command/);
		expect(() => plan(['contacts', 'search'])).toThrow(/Missing <q>/);
		expect(() => plan(['campaigns', 'send', '1'])).toThrow(/Unknown command/);
	});
});

describe('draftBody', () => {
	it('takes the first # heading as the subject unless --subject is given', () => {
		expect(draftBody('# Hello there\n\nBody text\n', undefined)).toEqual({ subject: 'Hello there', body: 'Body text\n' });
		expect(draftBody('Body only', 'Subj')).toEqual({ subject: 'Subj', body: 'Body only' });
		expect(() => draftBody('no heading', undefined)).toThrow(/No subject/);
	});
});

describe('output', () => {
	it('formats rows and records as a table', () => {
		const t = formatTable([
			{ id: 1, name: 'A', labels: ['x', 'y'] },
			{ id: 22, name: 'Bee' }
		]);
		expect(t.split('\n')[0]).toMatch(/^id\s+name\s+labels$/);
		expect(t).toContain('x, y');
		expect(formatTable([])).toBe('(no rows)');
		expect(formatTable({ id: 3, status: 'draft' }).split('\n')[2]).toMatch(/^id\s+3$/);
	});

	it('error messages carry the API message and spec problems', () => {
		expect(errorMessage(403, { error: 'Nope.' })).toBe('Error 403: Nope.');
		expect(errorMessage(400, { error: 'Bad spec.', problems: [{ path: 'steps[0]', message: 'subject is required' }] })).toBe(
			'Error 400: Bad spec.\n  steps[0]: subject is required'
		);
		expect(errorMessage(502, null)).toBe('Error 502: HTTP 502');
	});
});
