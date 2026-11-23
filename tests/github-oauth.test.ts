import { describe, it, expect, vi } from 'vitest';
import { authorizeUrl, exchangeCode, fetchGitHubUser } from '../src/lib/server/github-oauth';
import { USER_AGENT } from '../src/lib/server/user-agent';

describe('authorizeUrl', () => {
	it('has the right shape: client_id, encoded redirect_uri, state, no scope', () => {
		const url = authorizeUrl('client123', 'https://app.test/auth/github/callback', 'st.abc');
		expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
		const parsed = new URL(url);
		expect(parsed.searchParams.get('client_id')).toBe('client123');
		expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.test/auth/github/callback');
		expect(parsed.searchParams.get('state')).toBe('st.abc');
		expect(parsed.searchParams.has('scope')).toBe(false);
		expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.test%2Fauth%2Fgithub%2Fcallback');
	});
});

describe('exchangeCode', () => {
	const args = {
		clientId: 'id',
		clientSecret: 'secret',
		code: 'code123',
		redirectUri: 'https://app.test/auth/github/callback'
	};

	it('returns the access token string on success', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'gho_abc' }), { status: 200 }));
		const token = await exchangeCode(args, fetchImpl as any);
		expect(token).toBe('gho_abc');
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://github.com/login/oauth/access_token',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('throws when the body has an error field', async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 })
		);
		await expect(exchangeCode(args, fetchImpl as any)).rejects.toThrow();
	});

	it('throws when access_token is missing', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
		await expect(exchangeCode(args, fetchImpl as any)).rejects.toThrow();
	});

	it('throws on a non-2xx response', async () => {
		const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
		await expect(exchangeCode(args, fetchImpl as any)).rejects.toThrow();
	});
});

describe('fetchGitHubUser', () => {
	it('parses id/login/name/avatar_url on success and sends the User-Agent header', async () => {
		const fetchImpl = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({ id: 123, login: 'octocat', name: 'The Octocat', avatar_url: 'https://a.test/x.png' }),
					{ status: 200 }
				)
		);
		const user = await fetchGitHubUser('token123', fetchImpl as any);
		expect(user).toEqual({ id: 123, login: 'octocat', name: 'The Octocat', avatar_url: 'https://a.test/x.png' });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [calledUrl, calledInit] = fetchImpl.mock.calls[0]!;
		expect(calledUrl).toBe('https://api.github.com/user');
		const headers = new Headers(calledInit?.headers);
		expect(headers.get('User-Agent')).toBe(USER_AGENT);
		expect(headers.get('Authorization')).toBe('Bearer token123');
	});

	it('throws on a non-2xx response', async () => {
		const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
		await expect(fetchGitHubUser('bad-token', fetchImpl as any)).rejects.toThrow();
	});
});
