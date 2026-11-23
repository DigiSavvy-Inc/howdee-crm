// #311: pre-send checks — the pure rules (client- AND server-safe, no DB, no network).
// Each check is `block` | `warn` | `pass`. A block needs an explicit "Send anyway" tick,
// which the compose send action enforces server-side (src/lib/server/presend-checks.ts
// gathers the inputs: rendered HTML, audience rows, R2 sizes, settings).
import { isMergeToken, parseCompanyToken } from '$lib/merge-tags';
import { unsubscribeProblems, type MailHeader } from '$lib/list-unsubscribe';
import { isFormTagToken } from '$lib/form-embed';

export type CheckLevel = 'block' | 'warn' | 'pass';
export type CheckCategory = 'links' | 'images' | 'content' | 'audience';

export type Check = {
	id: string;
	category: CheckCategory;
	level: CheckLevel;
	title: string;
	detail?: string;
	/** The offending links / tags / images, capped at 10. */
	items?: string[];
	href?: string;
};

export type ChecksReport = {
	checks: Check[];
	blocks: number;
	warns: number;
	passes: number;
	/** True when the optional "Check links" (live HEAD/GET) ran. */
	linksChecked: boolean;
};

export const CATEGORY_LABELS: Record<CheckCategory, string> = {
	links: 'Links',
	images: 'Images',
	content: 'Content',
	audience: 'Audience'
};

export const SUBJECT_MAX = 80;
const ITEMS_CAP = 10;

export function summarize(checks: Check[], linksChecked = false): ChecksReport {
	const count = (l: CheckLevel) => checks.filter((c) => c.level === l).length;
	return { checks, blocks: count('block'), warns: count('warn'), passes: count('pass'), linksChecked };
}

const cap = (xs: string[]) => [...new Set(xs)].slice(0, ITEMS_CAP);

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
	return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

// ---------------------------------------------------------------- links

export type Link = { href: string; text: string };

/** #560: the in-page targets a `#x` link can jump to: `<a name>` values and `id`s on any tag. */
export function anchorTargets(html: string): Set<string> {
	const out = new Set<string>();
	for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)) {
		const id = attr(m[0], 'id');
		if (id) out.add(id);
		if (m[1].toLowerCase() === 'a') {
			const name = attr(m[0], 'name');
			if (name) out.add(name);
		}
	}
	return out;
}

function decodeFragment(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Every `<a href>` in the email, minus the unsubscribe placeholder, mailto:, tel: and
 *  #560's jump links to a section in the same email (a table of contents). */
export function extractLinks(html: string): Link[] {
	const out: Link[] = [];
	let targets: Set<string> | null = null;
	for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const href = attr(m[1], 'href');
		if (href === null) continue;
		const h = href.trim();
		if (h.includes('%%UNSUB_URL%%') || /^(mailto|tel):/i.test(h)) continue;
		if (h.length > 1 && h.startsWith('#')) {
			targets ??= anchorTargets(html);
			const frag = h.slice(1);
			if (targets.has(frag) || targets.has(decodeFragment(frag))) continue;
		}
		const text = m[2].replace(/<img\b[^>]*>/gi, '[image]').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
		out.push({ href: h, text: decodeEntities(text) });
	}
	return out;
}

const PLACEHOLDER_HOSTS = /(^|\.)(example\.(com|org|net)|localhost|test|invalid)$/i;

/** Why a link looks like a placeholder or a fake URL, or null when it looks real. */
export function placeholderReason(rawHref: string): string | null {
	const href = rawHref.trim();
	if (!href) return 'empty link';
	if (href === '#') return 'goes nowhere (#)';
	// #560: extractLinks drops jump links whose section is in the email; this one's isn't.
	if (href.startsWith('#')) return 'no matching section in this email';
	// A leading merge tag ({{field:report_url}}) is filled per recipient — not a placeholder.
	if (/^\{\{|^%7B%7B/i.test(href)) return null;
	if (/your[-_ ]?(link|url)[-_ ]?here|link[-_ ]?here|url[-_ ]?here|insert[-_ ]?(link|url)/i.test(href)) return 'placeholder text';
	if (/\[link\]|%5Blink%5D/i.test(href)) return 'placeholder text';
	if (/\bTODO\b|\bTBD\b/.test(href)) return 'placeholder text';
	const m = /^(https?):\/\/([^/?#]*)/i.exec(href);
	if (!m) {
		if (/^https?:/i.test(href)) return 'no host';
		return 'not a full http(s) URL';
	}
	const host = m[2].replace(/^[^@]*@/, '').replace(/:\d*$/, '').toLowerCase();
	if (!host) return 'no host';
	if (PLACEHOLDER_HOSTS.test(host) || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]') return `placeholder host (${host})`;
	if (!host.includes('.')) return `not a public host (${host})`;
	return null;
}

/** URL without utm_* parameters, and its sorted utm string. Non-URLs → null. */
export function splitUtm(href: string): { base: string; utm: string } | null {
	let u: URL;
	try {
		u = new URL(href);
	} catch {
		return null;
	}
	const utm: string[] = [];
	for (const [k, v] of [...u.searchParams.entries()]) {
		if (k.toLowerCase().startsWith('utm_')) {
			utm.push(`${k}=${v}`);
			u.searchParams.delete(k);
		}
	}
	u.hash = '';
	return { base: u.toString(), utm: utm.sort().join('&') };
}

export function linkChecks(links: Link[]): Check[] {
	const out: Check[] = [];
	const bad = links
		.map((l) => ({ l, why: placeholderReason(l.href) }))
		.filter((x): x is { l: Link; why: string } => !!x.why);
	out.push(
		bad.length
			? {
					id: 'links.placeholder',
					category: 'links',
					level: 'block',
					title: `${bad.length} placeholder or broken link${bad.length === 1 ? '' : 's'}`,
					detail: 'Replace these before sending — recipients will click them.',
					items: cap(bad.map(({ l, why }) => `${l.href || '(empty)'} — ${why}${l.text ? ` · “${l.text.slice(0, 40)}”` : ''}`))
				}
			: { id: 'links.placeholder', category: 'links', level: 'pass', title: links.length ? `${links.length} link${links.length === 1 ? '' : 's'}, none look like placeholders` : 'No links' }
	);

	const groups = new Map<string, Set<string>>();
	for (const l of links) {
		const s = splitUtm(l.href);
		if (!s) continue;
		if (!groups.has(s.base)) groups.set(s.base, new Set());
		groups.get(s.base)!.add(s.utm);
	}
	const dupes = [...groups.entries()].filter(([, utms]) => utms.size > 1);
	out.push(
		dupes.length
			? {
					id: 'links.utm',
					category: 'links',
					level: 'warn',
					title: `${dupes.length} link${dupes.length === 1 ? '' : 's'} repeated with different UTMs`,
					detail: 'The same page is tagged two ways, which splits its clicks in analytics.',
					items: cap(dupes.map(([base, utms]) => `${base} — ${[...utms].map((u) => u || '(no UTM)').join(' vs ')}`))
				}
			: { id: 'links.utm', category: 'links', level: 'pass', title: 'UTMs are consistent' }
	);
	return out;
}

// ---------------------------------------------------------------- images

export type Img = { src: string; alt: string | null; width: string | null };

export function extractImages(html: string): Img[] {
	const out: Img[] = [];
	for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
		const tag = m[0];
		const style = attr(tag, 'style') ?? '';
		const styleW = /(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim() ?? null;
		out.push({ src: attr(tag, 'src') ?? '', alt: attr(tag, 'alt'), width: attr(tag, 'width') ?? styleW });
	}
	return out;
}

export const LARGE_IMAGE_BYTES = 1024 * 1024;
/** Fewer visible characters than this next to an image = an "image-only" email. */
export const IMAGE_ONLY_TEXT = 200;

export function imageChecks(images: Img[], contentText: string, sizes: Map<string, number> = new Map()): Check[] {
	const out: Check[] = [];
	if (!images.length) {
		out.push({ id: 'images.none', category: 'images', level: 'pass', title: 'No images' });
		return out;
	}
	const noAlt = images.filter((i) => !(i.alt ?? '').trim());
	out.push(
		noAlt.length
			? { id: 'images.alt', category: 'images', level: 'warn', title: `${noAlt.length} image${noAlt.length === 1 ? '' : 's'} without alt text`, detail: 'Alt text shows when images are blocked and is read by screen readers.', items: cap(noAlt.map((i) => i.src || '(no src)')) }
			: { id: 'images.alt', category: 'images', level: 'pass', title: 'Every image has alt text' }
	);
	const noWidth = images.filter((i) => !(i.width ?? '').trim());
	out.push(
		noWidth.length
			? { id: 'images.width', category: 'images', level: 'warn', title: `${noWidth.length} image${noWidth.length === 1 ? '' : 's'} without a width`, detail: 'Some clients (Outlook) show these at full size.', items: cap(noWidth.map((i) => i.src || '(no src)')) }
			: { id: 'images.width', category: 'images', level: 'pass', title: 'Every image has a width' }
	);
	const large = images.filter((i) => (sizes.get(i.src) ?? 0) > LARGE_IMAGE_BYTES);
	if (large.length) {
		out.push({
			id: 'images.size',
			category: 'images',
			level: 'warn',
			title: `${large.length} image${large.length === 1 ? '' : 's'} over 1 MB`,
			detail: 'Large images load slowly on phones; compress them first.',
			items: cap(large.map((i) => `${i.src} — ${(sizes.get(i.src)! / (1024 * 1024)).toFixed(1)} MB`))
		});
	} else if (sizes.size) {
		out.push({ id: 'images.size', category: 'images', level: 'pass', title: 'Uploaded images are under 1 MB' });
	}
	const textLen = contentText.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().length;
	out.push(
		textLen < IMAGE_ONLY_TEXT
			? { id: 'images.text', category: 'images', level: 'warn', title: 'Mostly images, little text', detail: `Only ${textLen} characters of text. Image-heavy mail is more likely to land in spam and is blank when images are off.` }
			: { id: 'images.text', category: 'images', level: 'pass', title: 'Enough text alongside the images' }
	);
	return out;
}

// ---------------------------------------------------------------- merge tags

export type MergeTagUse = { key: string; fallback: string | null };

/** Merge tags used (known vocabulary) and unknown `{{…}}` / `*|…|*` tokens that would show
 *  verbatim. Conditional markers are known but carry no value. */
export function findMergeTags(...sources: string[]): { used: MergeTagUse[]; unknown: string[] } {
	const used = new Map<string, MergeTagUse>();
	const unknown: string[] = [];
	for (const raw of sources) {
		const s = raw.replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}').replace(/%7C/gi, '|');
		for (const m of s.matchAll(/\{\{([^{}]*)\}\}/g)) {
			const inner = m[1];
			// #515: {{form:<slug>}} becomes the contact's prefilled form link; it carries no field value.
			if (isFormTagToken(inner)) continue;
			if (!isMergeToken(inner)) {
				unknown.push(m[0]);
				continue;
			}
			if (/^(#if\s|else$|\/if$)/.test(inner)) continue;
			const ct = parseCompanyToken(inner);
			const key = ct ? `company.${ct.key}` : inner.trim();
			const fallback = ct ? ct.fallback || null : key === 'first_name' || key === 'name' ? 'there' : null;
			const prev = used.get(key);
			// One use without a fallback is enough to leave someone blank.
			if (!prev || (prev.fallback && !fallback)) used.set(key, { key, fallback });
		}
		for (const m of s.matchAll(/\*\|[A-Z0-9_:]+\|\*/g)) unknown.push(m[0]);
	}
	return { used: [...used.values()], unknown: [...new Set(unknown)] };
}

export type CoverageRecipient = {
	first_name?: string | null;
	last_name?: string | null;
	name?: string | null;
	company?: string | null;
	meta?: string | null;
	/** {{company.*}} values; null/undefined = no linked company. */
	companyFields?: Record<string, string> | null;
};

export type CoverageRow = { key: string; fallback: string | null; missing: number; total: number; pct: number };

function metaOf(r: CoverageRecipient): Record<string, unknown> {
	if (!r.meta) return {};
	try {
		const v = JSON.parse(r.meta);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';

/** Does this recipient have a value for the tag (before any fallback)? */
export function hasValue(key: string, r: CoverageRecipient): boolean {
	switch (key) {
		case 'first_name':
			return !blank(r.first_name);
		case 'last_name':
			return !blank(r.last_name);
		case 'name':
			return !blank(r.name) || !blank(r.first_name) || !blank(r.last_name);
		case 'company':
			return !blank(r.company);
		case 'email':
			return true;
	}
	if (key.startsWith('field:')) return !blank(metaOf(r)[key.slice(6).trim()]);
	if (key.startsWith('company.')) return !blank(r.companyFields?.[key.slice(8)]);
	return true;
}

/** Share of the audience each used tag would leave blank (or on its fallback). */
export function mergeTagCoverage(used: MergeTagUse[], recipients: CoverageRecipient[]): CoverageRow[] {
	const total = recipients.length;
	return used
		.filter((u) => u.key !== 'email')
		.map((u) => {
			const missing = recipients.reduce((n, r) => n + (hasValue(u.key, r) ? 0 : 1), 0);
			return { key: u.key, fallback: u.fallback, missing, total, pct: total ? Math.round((missing * 100) / total) : 0 };
		});
}

/** With the built-in "there" fallback, warn at this share missing. */
export const FALLBACK_WARN_PCT = 25;

const TAG_NOUN: Record<string, string> = { first_name: 'first name', last_name: 'last name', name: 'name', company: 'company' };
const noun = (key: string) => TAG_NOUN[key] ?? (key.startsWith('field:') ? `“${key.slice(6)}” field` : `company ${key.slice(8).replace(/_/g, ' ')}`);

export function mergeTagChecks(unknown: string[], coverage: CoverageRow[] | null): Check[] {
	const out: Check[] = [];
	out.push(
		unknown.length
			? { id: 'content.merge_unknown', category: 'content', level: 'block', title: `${unknown.length} merge tag${unknown.length === 1 ? '' : 's'} won't fill in`, detail: 'These show to recipients exactly as typed. Use the merge-tag menu ({{) to insert a known tag.', items: cap(unknown) }
			: { id: 'content.merge_unknown', category: 'content', level: 'pass', title: 'Every merge tag is recognised' }
	);
	if (!coverage) return out;
	for (const c of coverage) {
		const tag = `{{${c.key}${c.fallback && c.key.startsWith('company.') ? `|${c.fallback}` : ''}}}`;
		const who = `${c.pct}% of recipients (${c.missing} of ${c.total}) have no ${noun(c.key)}`;
		if (c.missing === 0) {
			out.push({ id: `content.merge.${c.key}`, category: 'content', level: 'pass', title: `${tag}: every recipient has a value` });
		} else if (c.fallback) {
			out.push({
				id: `content.merge.${c.key}`,
				category: 'content',
				level: c.pct >= FALLBACK_WARN_PCT ? 'warn' : 'pass',
				title: `${tag}: ${who}`,
				detail: `They'll see “${c.fallback}”.`
			});
		} else {
			out.push({
				id: `content.merge.${c.key}`,
				category: 'content',
				level: 'warn',
				title: `${tag}: ${who}`,
				detail: c.key.startsWith('company.') ? `It will be blank for them. Add a fallback: {{${c.key}|…}}.` : 'It will be blank for them. Wrap it in {{#if …}} or reword.'
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------- content

/** Conservative spam-trigger phrases (warn only). */
export const SPAM_PHRASES = [
	'act now',
	'100% free',
	'risk free',
	'risk-free',
	'click here',
	'buy now',
	'order now',
	'limited time',
	'urgent',
	'winner',
	'you have been selected',
	'cash bonus',
	'no obligation',
	'double your',
	'earn money',
	'make money',
	'guaranteed',
	'miracle',
	'once in a lifetime',
	'congratulations',
	'free gift',
	'$$$'
];

export function spamPhrases(text: string): string[] {
	const t = text.toLowerCase();
	return SPAM_PHRASES.filter((p) => (/^[a-z0-9 -]+$/.test(p) ? new RegExp(`\\b${p.replace(/-/g, '\\-')}\\b`).test(t) : t.includes(p)));
}

/** Mostly capital letters (at least 8 letters, ≥ 70% upper). */
export function isShouting(s: string): boolean {
	const letters = s.replace(/[^A-Za-z]/g, '');
	if (letters.length < 8) return false;
	return letters.replace(/[^A-Z]/g, '').length / letters.length >= 0.7;
}

/** ALL-CAPS words of 5+ letters (short acronyms like HTML / SEO don't count). */
export function capsWords(text: string): string[] {
	return [...new Set(text.match(/\b[A-Z]{5,}\b/g) ?? [])];
}

/** A postal-address-ish line: a PO box, or a street number + street word, or a US ZIP. */
export function looksLikeAddress(text: string): boolean {
	return (
		/\bP\.?\s?O\.?\s+Box\s+\d+/i.test(text) ||
		/\b\d{1,6}\s+[A-Za-z0-9.' ]{2,40}\b(St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Suite|Ste)\b\.?/i.test(text) ||
		/\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(text)
	);
}

const norm = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[\s,]+/g, ' ').trim();

export type ContentInput = {
	subject: string;
	preheader: string;
	/** The full rendered email (HTML, unsubscribe placeholder still in). */
	html: string;
	/** The body's own text (no signature / footer). */
	contentText: string;
	/** #373: the full plain-text version and the headers a broadcast send adds. Each one
	 *  given must carry the unsubscribe path too (the server checks always pass both). */
	text?: string;
	headers?: MailHeader[] | null;
	/** Settings → General → Mailing address, if set. */
	mailingAddress: string | null;
};

// Stands in for headers a caller didn't pass (only the HTML / text are checked then).
const STAND_IN_HEADERS: MailHeader[] = [
	{ Name: 'List-Unsubscribe', Value: '<x>' },
	{ Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }
];

export function contentChecks(input: ContentInput): Check[] {
	const out: Check[] = [];
	const subject = input.subject.trim();
	if (!subject) out.push({ id: 'content.subject', category: 'content', level: 'block', title: 'Subject is empty' });
	else if (subject.length > SUBJECT_MAX)
		out.push({ id: 'content.subject', category: 'content', level: 'warn', title: `Subject is ${subject.length} characters`, detail: `Over ${SUBJECT_MAX} gets cut off in most inboxes.` });
	else out.push({ id: 'content.subject', category: 'content', level: 'pass', title: `Subject is ${subject.length} characters` });

	out.push(
		input.preheader.trim()
			? { id: 'content.preheader', category: 'content', level: 'pass', title: 'Preview text is set' }
			: { id: 'content.preheader', category: 'content', level: 'warn', title: 'No preview text', detail: 'Inboxes show the first words of the body instead.' }
	);

	// #373: the broadcast stream's unsubscribe handling is Custom, so Postmark adds no link or
	// header: ours are the only unsubscribe path. Missing any part blocks (and the send path
	// refuses the message regardless).
	const unsub = unsubscribeProblems(
		{ html: input.html, text: input.text ?? '%%UNSUB_URL%%', headers: input.headers === undefined ? STAND_IN_HEADERS : input.headers },
		'%%UNSUB_URL%%'
	);
	out.push(
		unsub.length
			? {
					id: 'content.unsubscribe',
					category: 'content',
					level: 'block',
					title: unsub[0],
					detail: 'Postmark adds no unsubscribe link of its own on this stream, so a broadcast without ours is never sent.',
					...(unsub.length > 1 ? { items: unsub } : {})
				}
			: { id: 'content.unsubscribe', category: 'content', level: 'pass', title: 'Unsubscribe link is in the body', detail: 'Also in the plain-text version and the List-Unsubscribe headers: the only unsubscribe path on this stream.' }
	);

	const plain = `${input.contentText}\n${input.html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')}`;
	const addr = (input.mailingAddress ?? '').trim();
	if (addr) {
		const first = norm(addr.split(/\r?\n/)[0] ?? addr);
		out.push(
			norm(decodeEntities(plain)).includes(first)
				? { id: 'content.address', category: 'content', level: 'pass', title: 'Mailing address is in the email' }
				: { id: 'content.address', category: 'content', level: 'warn', title: 'Mailing address is missing', detail: `CAN-SPAM needs a physical address. Add “${addr.split(/\r?\n/)[0]}” to the body or the template footer.`, href: '/settings' }
		);
	} else {
		out.push(
			looksLikeAddress(decodeEntities(plain))
				? { id: 'content.address', category: 'content', level: 'pass', title: 'A postal address appears in the email' }
				: { id: 'content.address', category: 'content', level: 'warn', title: 'No physical address found', detail: 'CAN-SPAM needs a postal address in marketing email. Set one in Settings → General and add it to your footer.', href: '/settings' }
		);
	}

	const spam = spamPhrases(`${subject}\n${input.preheader}\n${input.contentText}`);
	const shouting = isShouting(subject);
	const caps = capsWords(`${subject}\n${input.contentText}`);
	const bangs = /!{2,}/.test(`${subject}${input.contentText}`);
	const items = [
		...(shouting ? ['Subject is mostly capital letters'] : []),
		...(caps.length >= 3 ? [`ALL-CAPS words: ${caps.slice(0, 5).join(', ')}`] : []),
		...(bangs ? ['Repeated exclamation marks (!!)'] : []),
		...spam.map((p) => `“${p}”`)
	];
	out.push(
		items.length
			? { id: 'content.spammy', category: 'content', level: 'warn', title: 'Wording that spam filters dislike', items: cap(items) }
			: { id: 'content.spammy', category: 'content', level: 'pass', title: 'No spammy wording found' }
	);
	return out;
}

// ---------------------------------------------------------------- audience

export type AudienceStats = {
	recipients: number;
	/** Members left out because they bounced / were suppressed (not subscribed). */
	excludedBounced: number;
	/** Recipients (subscribed) with a past bounce. */
	pastBounce: number;
	lastSend: { campaignId: number; subject: string; sent: number; bounced: number } | null;
	/** Recipients sent to before, with no open/click in the last 12 months. */
	neverEngaged: number;
};

export const BOUNCE_RATE_WARN = 0.05;
export const PAST_BOUNCE_WARN = 0.02;
export const NEVER_ENGAGED_WARN = 0.3;

const pctOf = (n: number, d: number) => (d ? `${Math.round((n * 1000) / d) / 10}%` : '0%');

export function audienceChecks(a: AudienceStats): Check[] {
	const out: Check[] = [];
	out.push(
		a.recipients
			? { id: 'audience.count', category: 'audience', level: 'pass', title: `${a.recipients.toLocaleString('en-US')} recipient${a.recipients === 1 ? '' : 's'}` }
			: { id: 'audience.count', category: 'audience', level: 'block', title: 'No recipients', detail: 'This list or segment has no subscribed contacts.' }
	);
	if (!a.recipients) return out;

	const bounceNote = a.excludedBounced ? ` ${a.excludedBounced.toLocaleString('en-US')} bounced or suppressed member${a.excludedBounced === 1 ? ' is' : 's are'} left out.` : '';
	out.push(
		a.pastBounce / a.recipients > PAST_BOUNCE_WARN
			? { id: 'audience.bounced', category: 'audience', level: 'warn', title: `${pctOf(a.pastBounce, a.recipients)} of recipients have bounced before`, detail: `${a.pastBounce} still subscribed after a bounce.${bounceNote}`, href: '/deliverability' }
			: { id: 'audience.bounced', category: 'audience', level: 'pass', title: `${a.pastBounce} recipient${a.pastBounce === 1 ? ' has' : 's have'} bounced before`, detail: bounceNote.trim() || undefined }
	);

	if (a.lastSend && a.lastSend.sent) {
		const rate = a.lastSend.bounced / a.lastSend.sent;
		out.push({
			id: 'audience.last_bounce',
			category: 'audience',
			level: rate > BOUNCE_RATE_WARN ? 'warn' : 'pass',
			title: `Last send to this list bounced ${pctOf(a.lastSend.bounced, a.lastSend.sent)}`,
			detail: `“${a.lastSend.subject}”: ${a.lastSend.bounced} of ${a.lastSend.sent}.${rate > BOUNCE_RATE_WARN ? ' Above 5% — clean the list on Deliverability first.' : ''}`,
			href: rate > BOUNCE_RATE_WARN ? '/deliverability' : `/campaign/${a.lastSend.campaignId}`
		});
	}

	out.push(
		a.neverEngaged / a.recipients > NEVER_ENGAGED_WARN
			? { id: 'audience.cold', category: 'audience', level: 'warn', title: `${pctOf(a.neverEngaged, a.recipients)} haven't opened or clicked in 12 months`, detail: `${a.neverEngaged.toLocaleString('en-US')} recipients. Sending to many cold contacts hurts inbox placement.`, href: '/deliverability' }
			: { id: 'audience.cold', category: 'audience', level: 'pass', title: `${pctOf(a.neverEngaged, a.recipients)} haven't engaged in 12 months` }
	);
	return out;
}

/** #414: contacts left out because they opted out of the email's topic on the preference page. */
export function topicSkipCheck(skipped: number, topic: string): Check {
	return {
		id: 'audience.topic_optout',
		category: 'audience',
		level: 'pass',
		title: `${skipped.toLocaleString('en-US')} recipient${skipped === 1 ? '' : 's'} skipped: opted out of ${topic}`
	};
}

// ---------------------------------------------------------------- live link check results

export type LinkProbe = { url: string; status: number | null; finalUrl?: string; error?: string; login?: boolean };

export function linkProbeChecks(probes: LinkProbe[], skipped: number): Check[] {
	const broken = probes.filter((p) => p.status === 404 || p.status === 410);
	const flaky = probes.filter((p) => !broken.includes(p) && (p.status === null || p.status >= 400));
	const login = probes.filter((p) => p.login && !broken.includes(p) && !flaky.includes(p));
	const out: Check[] = [];
	const extra = skipped ? ` ${skipped} more not checked (limit 30).` : '';
	if (broken.length)
		out.push({ id: 'links.live_broken', category: 'links', level: 'block', title: `${broken.length} link${broken.length === 1 ? '' : 's'} not found`, items: cap(broken.map((p) => `${p.url} — ${p.status}`)) });
	if (flaky.length)
		out.push({ id: 'links.live_error', category: 'links', level: 'warn', title: `${flaky.length} link${flaky.length === 1 ? '' : 's'} answered with an error`, detail: 'Some sites refuse automated checks; open these to make sure.', items: cap(flaky.map((p) => `${p.url} — ${p.status ?? p.error ?? 'no answer'}`)) });
	if (login.length)
		out.push({ id: 'links.live_login', category: 'links', level: 'warn', title: `${login.length} link${login.length === 1 ? '' : 's'} redirect to a login page`, items: cap(login.map((p) => `${p.url} → ${p.finalUrl}`)) });
	if (!out.length) out.push({ id: 'links.live', category: 'links', level: 'pass', title: `${probes.length} link${probes.length === 1 ? '' : 's'} checked, all reachable`, detail: extra.trim() || undefined });
	else if (extra) out[out.length - 1].detail = `${out[out.length - 1].detail ?? ''}${extra}`.trim();
	return out;
}
