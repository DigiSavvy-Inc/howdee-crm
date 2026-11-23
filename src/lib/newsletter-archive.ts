// #481: public newsletter archive — universal (client + server) vocabulary: slugs, the
// web template's page settings ("web canvas"), and the settings' defaults. Never call the
// public page an "Archive" on its own (#472 uses that word for hiding lists): the page is the
// **Newsletter archive**, the action is "Publish to newsletter archive".
import { normalizeHex } from '$lib/brand';

export const ARCHIVE_PATH = '/newsletter';
export const ARCHIVE_PAGE_SIZE = 20;
export const ARCHIVE_FEED_SIZE = 20;
export const ARCHIVE_TITLE_DEFAULT = 'Newsletter';
export const ARCHIVE_TITLE_MAX = 80;
export const ARCHIVE_INTRO_MAX = 1000;
/** #483: the web-only version of an issue. */
export const ISSUE_TITLE_MAX = 200;
export const ISSUE_TEASER_MAX = 300;

/** The template kind for archive page templates (templates.kind = 'web'). */
export const WEB_TEMPLATE_KIND = 'web';

/** Lowercase ASCII slug of a subject: letters / digits joined by single dashes, ≤ 60 chars,
 *  cut at a dash. Accents are folded; anything else drops out. Empty → 'issue'. */
export function subjectSlug(subject: string): string {
	const folded = String(subject ?? '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/\{\{[^}]*\}\}/g, ' ') // merge tags never end up in a public URL
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	let s = folded.slice(0, 60);
	if (folded.length > 60 && s.includes('-')) s = s.slice(0, s.lastIndexOf('-'));
	return s.replace(/-+$/g, '') || 'issue';
}

/** `YYYY-MM-DD-<subject-slug>` from the sent date (UTC date part of the stored timestamp). */
export function archiveSlugBase(sentAt: string | null | undefined, subject: string): string {
	const d = /^\d{4}-\d{2}-\d{2}/.exec(String(sentAt ?? ''))?.[0] ?? new Date().toISOString().slice(0, 10);
	return `${d}-${subjectSlug(subject)}`;
}

/** The public URL of an issue. */
export function archiveUrl(base: string, slug: string): string {
	return `${base.replace(/\/+$/, '')}${ARCHIVE_PATH}/${slug}`;
}

/** #587: paths under /newsletter that are routes of their own, never an issue slug. */
export const RESERVED_ARCHIVE_SLUGS = ['subscribe', 'feed.xml', 'img'] as const;

/** A slug that is safe to look up (route param). Reserved route names never are (#587). */
export function validArchiveSlug(s: string): boolean {
	if ((RESERVED_ARCHIVE_SLUGS as readonly string[]).includes(s)) return false;
	return /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,80}$/.test(s);
}

/** #587: the sign-up page under the archive (popup fallback, shareable address, POST target). */
export const ARCHIVE_SUBSCRIBE_PATH = `${ARCHIVE_PATH}/subscribe`;

// ---------------------------------------------------------------------------
// Web template settings (stored as JSON in templates.canvas for kind = 'web')
// ---------------------------------------------------------------------------

export const WEB_WIDTHS = [600, 680, 760, 880] as const;
export const WEB_FONT_SIZES = [16, 17, 18, 19, 20] as const;
export const WEB_FONTS = [
	{ key: 'sans', label: 'Sans (system UI)', stack: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" },
	{ key: 'serif', label: 'Serif (Georgia)', stack: "Georgia,'Times New Roman',serif" },
	{ key: 'humanist', label: 'Humanist (Avenir / Segoe)', stack: "Avenir,'Avenir Next','Segoe UI',Helvetica,Arial,sans-serif" }
] as const;
export type WebFontKey = (typeof WEB_FONTS)[number]['key'];

export type WebCanvas = {
	/** Page background (light theme); dark mode uses the built-in dark palette. */
	bg?: string;
	/** Article column width, px. */
	width?: (typeof WEB_WIDTHS)[number];
	font?: WebFontKey;
	fontSize?: (typeof WEB_FONT_SIZES)[number];
	/** Link and accent colour (light theme). */
	link?: string;
};

/** The built-in look: a neutral palette (#595 — no longer the original brand guidelines'), not
 *  the app's tokens. The install's archive theme (app_state `newsletter_archive_theme`,
 *  `parseArchiveTheme`) overrides the colours key by key; a web template's Page settings
 *  override bg / link. */
export const WEB_DEFAULTS = {
	bg: '#f9fafb',
	surface: '#ffffff',
	text: '#111827',
	muted: '#4b5563',
	hairline: '#e5e7eb',
	link: '#1d4ed8',
	brand: '#1d4ed8',
	onBrand: '#ffffff',
	cta: '#111827',
	// Dark theme (prefers-color-scheme: dark)
	darkBg: '#111827',
	darkSurface: '#1f2937',
	darkText: '#f9fafb',
	darkMuted: '#9ca3af',
	darkHairline: '#374151',
	darkLink: '#93c5fd',
	darkOnBrand: '#111827',
	width: 680 as (typeof WEB_WIDTHS)[number],
	font: 'sans' as WebFontKey,
	fontSize: 18 as (typeof WEB_FONT_SIZES)[number],
	lineHeight: 1.65
} as const;

/** #595: the archive's colours, stored in app_state `newsletter_archive_theme` as JSON holding
 *  only these keys (hex). No settings UI; migration 0122 seeds an install that holds data with
 *  the former built-in palette, so its archive looks as before. */
export const ARCHIVE_THEME_KEY = 'newsletter_archive_theme';
export const ARCHIVE_THEME_COLORS = [
	'bg',
	'surface',
	'text',
	'muted',
	'hairline',
	'link',
	'brand',
	'onBrand',
	'cta',
	'darkBg',
	'darkSurface',
	'darkText',
	'darkMuted',
	'darkHairline',
	'darkLink',
	'darkOnBrand'
] as const;
export type ArchiveThemeColor = (typeof ARCHIVE_THEME_COLORS)[number];
export type ArchiveTheme = Record<ArchiveThemeColor, string>;

/** The neutral built-in colours (WEB_DEFAULTS). */
export function defaultArchiveTheme(): ArchiveTheme {
	const out = {} as ArchiveTheme;
	for (const k of ARCHIVE_THEME_COLORS) out[k] = WEB_DEFAULTS[k];
	return out;
}

/** Lenient read of the stored JSON: each valid hex colour overrides the neutral default for its
 *  key; a missing or malformed key (or a value that isn't JSON at all) stays neutral. */
export function parseArchiveTheme(raw: unknown): ArchiveTheme {
	const out = defaultArchiveTheme();
	let v = raw;
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v);
		} catch {
			return out;
		}
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
	const o = v as Record<string, unknown>;
	for (const k of ARCHIVE_THEME_COLORS) {
		const hex = normalizeHex(o[k]);
		if (hex) out[k] = hex;
	}
	return out;
}

function oneOf<T>(v: unknown, list: readonly T[]): T | undefined {
	const n = typeof list[0] === 'number' ? Number(v) : v;
	return list.includes(n as T) ? (n as T) : undefined;
}

/** Junk-tolerant: anything unknown is dropped (unset = the built-in default). */
export function sanitizeWebCanvas(v: unknown): WebCanvas {
	let o: unknown = v;
	if (typeof v === 'string') {
		try {
			o = JSON.parse(v);
		} catch {
			o = null;
		}
	}
	if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
	const r = o as Record<string, unknown>;
	const out: WebCanvas = {};
	const bg = normalizeHex(r.bg);
	if (bg) out.bg = bg;
	const link = normalizeHex(r.link);
	if (link) out.link = link;
	const width = oneOf(r.width, WEB_WIDTHS);
	if (width) out.width = width;
	const fontSize = oneOf(r.fontSize, WEB_FONT_SIZES);
	if (fontSize) out.fontSize = fontSize;
	const font = oneOf(r.font, WEB_FONTS.map((f) => f.key));
	if (font) out.font = font;
	return out;
}

/** #493: email font preset → the closest web font (others: unset = the default). */
const EMAIL_TO_WEB_FONT: Record<string, WebFontKey> = { system: 'sans', helvetica: 'sans', georgia: 'serif', times: 'serif' };

/** The value in `list` nearest to `n`; a tie goes to the larger one (640 → 680, not 600). */
function nearest<T extends number>(n: unknown, list: readonly T[]): T | undefined {
	if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
	let best: T | undefined;
	for (const v of list) if (best === undefined || Math.abs(v - n) <= Math.abs(best - n)) best = v;
	return best;
}

/** #493: an email template's canvas → page settings for "Copy as newsletter archive page":
 *  backdrop → bg, link → link, width / font size → the nearest web option, font → the matching
 *  web font when there is one. Anything else is left unset (the built-in default). */
export function webCanvasFromEmail(c: { backdrop?: string; link?: string; width?: number; fontSize?: number; font?: string }): WebCanvas {
	return sanitizeWebCanvas({
		bg: c.backdrop,
		link: c.link,
		width: nearest(c.width, WEB_WIDTHS),
		fontSize: nearest(c.fontSize, WEB_FONT_SIZES),
		font: c.font ? EMAIL_TO_WEB_FONT[c.font] : undefined
	});
}

/** The template editor's page-settings fields (`web_bg`, `web_link`, `web_width`, `web_font`,
 *  `web_size`; blank = the built-in default). */
export function webCanvasFromForm(data: FormData): WebCanvas {
	const v = (k: string) => String(data.get(k) ?? '').trim() || undefined;
	return sanitizeWebCanvas({ bg: v('web_bg'), link: v('web_link'), width: v('web_width'), font: v('web_font'), fontSize: v('web_size') });
}

export const webFontStack = (key: string | undefined): string => WEB_FONTS.find((f) => f.key === key)?.stack ?? WEB_FONTS[0].stack;

// ---------------------------------------------------------------------------
// Settings (app_state)
// ---------------------------------------------------------------------------

export type ArchiveSettings = {
	enabled: boolean;
	title: string;
	intro: string;
	subscribeUrl: string;
	/** templates.id of a kind='web' template; null = the built-in default. */
	templateId: number | null;
	/** Allow search engines (default on). */
	indexable: boolean;
	/** lists.id of lists / segments / topics whose broadcasts publish themselves. */
	autoGroups: number[];
	/** #587: slug of the published form shown in the Subscribe popup; '' = off (the link). */
	signupForm: string;
	/** #595: the archive's colours (app_state `newsletter_archive_theme`, read with these keys;
	 *  not one of ARCHIVE_KEYS, so saving the settings never writes it). */
	theme: ArchiveTheme;
};

export const ARCHIVE_KEYS = [
	'archive_enabled',
	'archive_title',
	'archive_intro',
	'archive_subscribe_url',
	'archive_template_id',
	'archive_indexable',
	'archive_auto_groups',
	'archive_signup_form'
] as const;

export function parseArchiveSettings(rows: Map<string, string | null>): ArchiveSettings {
	const get = (k: string) => (rows.get(k) ?? '').trim();
	let groups: number[] = [];
	try {
		const v = JSON.parse(get('archive_auto_groups') || '[]');
		if (Array.isArray(v)) groups = [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
	} catch {
		groups = [];
	}
	const tid = Number(get('archive_template_id'));
	return {
		enabled: get('archive_enabled') === '1',
		title: get('archive_title') || ARCHIVE_TITLE_DEFAULT,
		intro: get('archive_intro'),
		subscribeUrl: cleanSubscribeUrl(get('archive_subscribe_url')),
		templateId: Number.isInteger(tid) && tid > 0 ? tid : null,
		indexable: get('archive_indexable') !== '0',
		autoGroups: groups,
		signupForm: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(get('archive_signup_form')) ? get('archive_signup_form') : '',
		theme: parseArchiveTheme(rows.get(ARCHIVE_THEME_KEY) ?? null)
	};
}

/** http(s) URL or an app path (`/p/subscribe`); anything else is ''. */
export function cleanSubscribeUrl(v: unknown): string {
	const s = String(v ?? '').trim();
	if (!s) return '';
	if (/^\/(?!\/)[^\s"'<>]*$/.test(s)) return s.slice(0, 500);
	try {
		const u = new URL(s);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 500) : '';
	} catch {
		return '';
	}
}
