// The outbound webhook URL guard (#303, moved here for #620 so a form spec can be checked
// on both sides). https only, no credentials, no localhost / *.local / *.internal names and
// no private, loopback, link-local, CGNAT, multicast or reserved IP literals. Checked on save
// AND again right before every send.

export const WEBHOOK_URL_MAX = 2000;

function privateV4(host: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return (
		a === 0 || // "this" network
		a === 10 ||
		a === 127 || // loopback
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) || // link-local (cloud metadata)
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && Number(m[3]) === 0) ||
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast + reserved + broadcast
	);
}

function privateV6(host: string): boolean {
	const h = host.toLowerCase();
	if (h === '::' || h === '::1') return true;
	if (h.startsWith('::ffff:')) return true; // IPv4-mapped — refuse rather than decode
	if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique local fc00::/7
	if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // link-local fe80::/10
	return false;
}

/** Why `raw` can't be a job webhook, or null when it's fine. Checked on save AND at send. */
export function webhookUrlProblem(raw: string): string | null {
	const s = raw.trim();
	if (!s) return 'Enter a webhook URL.';
	if (s.length > WEBHOOK_URL_MAX) return 'That URL is too long.';
	let url: URL;
	try {
		url = new URL(s);
	} catch {
		return "That isn't a valid URL.";
	}
	if (url.protocol !== 'https:') return 'Webhook URLs must start with https://.';
	if (url.username || url.password) return "Webhook URLs can't contain a username or password.";
	// URL normalises the host: lowercased, and numeric forms like 2130706433 → 127.0.0.1.
	let host = url.hostname.replace(/\.$/, '');
	if (host.startsWith('[') && host.endsWith(']')) {
		host = host.slice(1, -1);
		if (privateV6(host)) return "That address is private — webhooks can't point at a local or internal network.";
		return null;
	}
	if (!host) return "That isn't a valid URL.";
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
		return "That host is local — webhooks can't point at a local or internal network.";
	}
	if (privateV4(host)) return "That address is private — webhooks can't point at a local or internal network.";
	return null;
}

