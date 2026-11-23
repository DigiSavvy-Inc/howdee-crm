import { describe, it, expect } from 'vitest';
import {
	initials,
	hueFor,
	initialsSvg,
	gravatarUrl,
	githubLogin,
	isFreemailDomain,
	resolveAvatar,
	avatarIsFresh
} from '../src/lib/server/avatars';
import { sha256Hex } from '../src/lib/server/api-keys';

describe('initials', () => {
	it('uses first + last word of a multi-word name, ignoring middle words', () => {
		expect(initials('Jane Q. Doe', null, null, null)).toBe('JD');
	});
	it('falls back to first_name + last_name when no name is set', () => {
		expect(initials(null, 'Jane', 'Doe', null)).toBe('JD');
	});
	it('falls back to the email local-part first letter', () => {
		expect(initials(null, null, null, 'bob@example.com')).toBe('B');
	});
	it('falls back to "?" when nothing is available', () => {
		expect(initials(null, null, null, null)).toBe('?');
	});
	it('handles a single-word name', () => {
		expect(initials('Madonna', null, null, null)).toBe('M');
	});
});

describe('hueFor', () => {
	it('is deterministic for the same email', () => {
		expect(hueFor('bob@example.com')).toBe(hueFor('bob@example.com'));
	});
	it('is case-insensitive', () => {
		expect(hueFor('Bob@Example.com')).toBe(hueFor('bob@example.com'));
	});
	it('returns an integer in [0, 360) for sample emails', () => {
		for (const email of ['a@example.com', 'jane.doe@acme.example', 'x@y.z', '']) {
			const h = hueFor(email);
			expect(Number.isInteger(h)).toBe(true);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
		}
	});
});

describe('initialsSvg', () => {
	it('embeds the letters and an hsl() fill', () => {
		const svg = initialsSvg('JD', 200);
		expect(svg).toContain('JD');
		expect(svg).toContain('hsl(');
	});
});

describe('gravatarUrl', () => {
	it('matches the SHA-256-based URL computed via sha256Hex', async () => {
		const email = 'MyEmailAddress@example.com ';
		const expected = `https://gravatar.com/avatar/${await sha256Hex(email.trim().toLowerCase())}?d=404&s=160`;
		expect(await gravatarUrl(email)).toBe(expected);
	});

	it('matches a hard-coded hash vector (cross-check against sha256Hex regressing)', async () => {
		// Verified independently: `printf '%s' "myemailaddress@example.com" | shasum -a 256`
		const url = await gravatarUrl('MyEmailAddress@example.com ');
		expect(url).toBe(
			'https://gravatar.com/avatar/84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee?d=404&s=160'
		);
	});
});

describe('githubLogin', () => {
	it('strips a leading @', () => {
		expect(githubLogin({ github: '@octocat' })).toBe('octocat');
	});
	it('strips a github.com profile URL', () => {
		expect(githubLogin({ github_login: 'https://github.com/octocat' })).toBe('octocat');
	});
	it('rejects an invalid login', () => {
		expect(githubLogin({ github_username: 'not a valid login!' })).toBeNull();
	});
	it('returns null when no field is present', () => {
		expect(githubLogin({})).toBeNull();
		expect(githubLogin(null)).toBeNull();
	});
});

describe('isFreemailDomain', () => {
	it('matches exact freemail domains', () => {
		expect(isFreemailDomain('gmail.com')).toBe(true);
	});
	it('matches wildcard freemail families', () => {
		expect(isFreemailDomain('yahoo.co.uk')).toBe(true);
		expect(isFreemailDomain('hotmail.com')).toBe(true);
	});
	it('does not match business domains', () => {
		expect(isFreemailDomain('cloudflare.com')).toBe(false);
		expect(isFreemailDomain('ourco.example')).toBe(false);
	});
});

// --- resolveAvatar: mocked fetchImpl keyed on URL substring ---

function imageResponse(contentType: string, byteLength: number): Response {
	return new Response(new Uint8Array(byteLength), {
		status: 200,
		headers: { 'content-type': contentType }
	});
}

function notFoundResponse(): Response {
	return new Response(null, { status: 404 });
}

describe('resolveAvatar', () => {
	it('returns gravatar when it hits', async () => {
		const fetchImpl = async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes('gravatar.com')) return imageResponse('image/png', 100);
			throw new Error(`unexpected fetch: ${u}`);
		};
		const result = await resolveAvatar('bob@example.com', null, fetchImpl as unknown as typeof fetch);
		expect(result.source).toBe('gravatar');
		expect(result.contentType).toBe('image/png');
	});

	it('falls through to github when gravatar 404s and a login is set', async () => {
		const fetchImpl = async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes('gravatar.com')) return notFoundResponse();
			if (u.includes('github.com')) return imageResponse('image/png', 100);
			throw new Error(`unexpected fetch: ${u}`);
		};
		const result = await resolveAvatar(
			'bob@example.com',
			{ github: 'octocat' },
			fetchImpl as unknown as typeof fetch
		);
		expect(result.source).toBe('github');
	});

	it('falls through to a domain favicon for a business domain with no github login', async () => {
		const fetchImpl = async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes('gravatar.com')) return notFoundResponse();
			if (u.includes('s2/favicons')) return imageResponse('image/png', 2048);
			throw new Error(`unexpected fetch: ${u}`);
		};
		const result = await resolveAvatar('qa@acme.example', null, fetchImpl as unknown as typeof fetch);
		expect(result.source).toBe('domain');
	});

	it('skips the domain step entirely for a freemail domain', async () => {
		let domainFetchCalled = false;
		const fetchImpl = async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes('gravatar.com')) return notFoundResponse();
			if (u.includes('s2/favicons')) {
				domainFetchCalled = true;
				throw new Error('domain favicon should never be fetched for a freemail domain');
			}
			throw new Error(`unexpected fetch: ${u}`);
		};
		const result = await resolveAvatar('user@gmail.com', null, fetchImpl as unknown as typeof fetch);
		expect(result.source).toBe('none');
		expect(result.transient).toBeFalsy();
		expect(domainFetchCalled).toBe(false);
	});

	it('returns transient:true when fetch throws', async () => {
		const fetchImpl = async () => {
			throw new Error('network down');
		};
		const result = await resolveAvatar('bob@example.com', null, fetchImpl as unknown as typeof fetch);
		expect(result).toEqual({ source: 'none', transient: true });
	});
});

describe('avatarIsFresh', () => {
	function daysAgo(n: number): string {
		return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
	}

	it('is false when the check is more than 30 days old', () => {
		const row = { avatar_checked_at: daysAgo(31), avatar_email: 'bob@example.com' };
		expect(avatarIsFresh(row, 'bob@example.com')).toBe(false);
	});

	it('is false when the email has changed since the check', () => {
		const row = { avatar_checked_at: daysAgo(1), avatar_email: 'old@example.com' };
		expect(avatarIsFresh(row, 'new@example.com')).toBe(false);
	});

	it('is true when recently checked for the current email', () => {
		const row = { avatar_checked_at: daysAgo(1), avatar_email: 'bob@example.com' };
		expect(avatarIsFresh(row, 'bob@example.com')).toBe(true);
	});
});
