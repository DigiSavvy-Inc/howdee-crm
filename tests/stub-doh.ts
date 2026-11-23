import { beforeEach } from 'vitest';

// #306: tests must never hit the network for DNS. Address hygiene (MX check) and the
// domain-auth panel both call Cloudflare DNS-over-HTTPS via dohQuery (src/lib/server/spam.ts).
// This default answers every DoH lookup locally with "NOERROR, one record of the asked type"
// — i.e. every domain (including made-up ones like w.test) has MX — and passes every other
// request through to the real fetch.
//
// Tests that care about DNS outcomes (address-hygiene, domain-auth, …) replace
// globalThis.fetch themselves (assignment, vi.stubGlobal or vi.spyOn); their stub wins, and
// restoring "the original" fetch lands back on this wrapper. Production code is untouched.
const DOH_HOSTS = new Set(['cloudflare-dns.com', '1.1.1.1', '1.0.0.1']);
const TYPE_CODES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };

const passthrough = globalThis.fetch;

function dohUrl(input: RequestInfo | URL): URL | null {
	try {
		const url = new URL(input instanceof Request ? input.url : String(input));
		return DOH_HOSTS.has(url.hostname) && url.pathname === '/dns-query' ? url : null;
	} catch {
		return null;
	}
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = dohUrl(input);
	if (!url) return passthrough(input as any, init);
	const name = url.searchParams.get('name') ?? '';
	const typeName = (url.searchParams.get('type') ?? 'A').toUpperCase();
	const type = TYPE_CODES[typeName] ?? (Number(typeName) || 1);
	const data =
		type === 15 ? `10 mx.${name}.` : type === 16 ? '"v=test"' : type === 28 ? '::1' : '192.0.2.1';
	return new Response(
		JSON.stringify({ Status: 0, Answer: [{ name: `${name}.`, type, TTL: 300, data }] }),
		{ status: 200, headers: { 'content-type': 'application/dns-json' } }
	);
}) as typeof fetch;

// The MX cache is per isolate; never let one test's answers leak into the next. Imported
// lazily (after the test file's own imports and vi.mock calls): a static import here would
// load hygiene.ts — and its dependency graph — before the test file's mocks apply.
beforeEach(async () => {
	(await import('$lib/server/hygiene')).clearMxCache();
});
