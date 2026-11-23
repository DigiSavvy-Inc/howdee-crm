// #88: minimal GitHub OAuth (web application flow) — no scope requested, since we only
// need the public profile (id/login/name/avatar) to check against the users allowlist.
import { USER_AGENT } from './user-agent';

export type GitHubUser = {
	id: number;
	login: string;
	name: string | null;
	avatar_url: string | null;
};

/** Build the GitHub authorize URL. No `scope` param — public profile only. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		state
	});
	return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

type ExchangeArgs = {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
};

/** Exchange an OAuth code for an access token. Throws on any failure shape. */
export async function exchangeCode(
	args: ExchangeArgs,
	fetchImpl: typeof fetch = fetch
): Promise<string> {
	const res = await fetchImpl('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json'
		},
		body: JSON.stringify({
			client_id: args.clientId,
			client_secret: args.clientSecret,
			code: args.code,
			redirect_uri: args.redirectUri
		})
	});
	if (!res.ok) {
		throw new Error(`GitHub token exchange failed: HTTP ${res.status}`);
	}
	const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
	if (data.error) {
		throw new Error(`GitHub token exchange error: ${data.error_description ?? data.error}`);
	}
	if (!data.access_token) {
		throw new Error('GitHub token exchange returned no access_token.');
	}
	return data.access_token;
}

/** Fetch the authenticated GitHub user's public profile. Throws on non-2xx. */
export async function fetchGitHubUser(
	token: string,
	fetchImpl: typeof fetch = fetch
): Promise<GitHubUser> {
	const res = await fetchImpl('https://api.github.com/user', {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': USER_AGENT
		}
	});
	if (!res.ok) {
		throw new Error(`GitHub user fetch failed: HTTP ${res.status}`);
	}
	const data = (await res.json()) as {
		id: number;
		login: string;
		name: string | null;
		avatar_url: string | null;
	};
	return {
		id: data.id,
		login: data.login,
		name: data.name ?? null,
		avatar_url: data.avatar_url ?? null
	};
}

/** True when both GitHub OAuth env vars are set (non-empty). */
export function githubConfigured(env: { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string } | undefined): boolean {
	return !!env?.GITHUB_CLIENT_ID && !!env?.GITHUB_CLIENT_SECRET;
}
