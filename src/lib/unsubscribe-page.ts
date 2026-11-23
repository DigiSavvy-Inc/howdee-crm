// Customizable unsubscribe page (#374) — universal (client + server) vocabulary: the stored
// config shape, defaults, validation, video URL parsing and the media limits. The config lives
// in app_state `unsubscribe_page` (JSON; see $lib/server/unsubscribe-page.ts), so no migration.
//
// Compliance (not configurable): the page always renders the email address, the
// "Unsubscribe from everything" button and the topic preferences, in that order, before any
// custom text or video. Videos never autoplay, and an embed's iframe src is always built
// from a parsed provider + id — a pasted URL is never embedded as-is.

import { normalizeHex } from '$lib/brand';

export const UNSUB_PAGE_KEY = 'unsubscribe_page';

/** Reasons the unsubscribe page offers (also the contact page's unsubscribe confirm, #507). */
export const UNSUBSCRIBE_REASONS = [
	'Too many emails',
	'Content is not relevant to me',
	'I never signed up for this',
	'Just cleaning up my inbox',
	'Other'
];
/** The contact page's default unsubscribe reason, listed before UNSUBSCRIBE_REASONS (#507). */
export const OPERATOR_UNSUB_REASON = 'Operator request';

export const HEADING_MAX = 80;
export const MESSAGE_MAX = 1000;
export const CAPTION_MAX = 200;
export const LINKS_MAX = 4;
export const LINK_LABEL_MAX = 60;
export const LINK_URL_MAX = 500;

export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const POSTER_MAX_BYTES = 2 * 1024 * 1024;
export const VIDEO_TYPES: Record<string, 'mp4' | 'webm'> = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
export const POSTER_TYPES: Record<string, 'png' | 'jpg' | 'webp'> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp'
};
/** R2 keys for uploaded media, served by /img/unsubscribe/[file]. */
export const MEDIA_KEY_RE = /^unsubscribe\/(video|poster)-[a-f0-9-]{36}\.(mp4|webm|png|jpg|webp)$/;

export type VideoProvider = 'youtube' | 'vimeo' | 'loom';
export const PROVIDER_LABELS: Record<VideoProvider, string> = { youtube: 'YouTube', vimeo: 'Vimeo', loom: 'Loom' };

/** The only hosts an embed iframe may load from (also the page's CSP `frame-src`). */
export const EMBED_ORIGINS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://www.loom.com'] as const;

export type ParsedVideo = { provider: VideoProvider; id: string; hash?: string };

export type PageVideo =
	| ({ kind: 'embed'; url: string } & ParsedVideo)
	| { kind: 'upload'; key: string; type: 'video/mp4' | 'video/webm'; posterKey: string | null };

export type PageLink = { label: string; url: string };

/** Which view of the public page renders. */
export type UnsubState = 'before' | 'after' | 'resubscribed' | 'prefsSaved' | 'invalid';

export type UnsubPageConfig = {
	heading: string;
	/** Markdown, shown after the unsubscribe controls. */
	intro: string;
	video: PageVideo | null;
	caption: string;
	/** Below the controls (default) or beside them on wide screens. Never above. */
	placement: 'below' | 'beside';
	afterHeading: string;
	/** Markdown, shown under the "will no longer receive" line after unsubscribing. */
	afterMessage: string;
	afterVideo: PageVideo | null;
	afterCaption: string;
	links: PageLink[];
	/** "Changed your mind? Resubscribe" after unsubscribing. Off by default. */
	resubscribe: boolean;
	/** Button / link accent; null = the theme's primary. */
	accent: string | null;
};

export const DEFAULT_HEADING = 'Email preferences';
export const DEFAULT_AFTER_HEADING = "You're unsubscribed";

export const DEFAULT_UNSUB_PAGE: UnsubPageConfig = {
	heading: DEFAULT_HEADING,
	intro: '',
	video: null,
	caption: '',
	placement: 'below',
	afterHeading: DEFAULT_AFTER_HEADING,
	afterMessage: '',
	afterVideo: null,
	afterCaption: '',
	links: [],
	resubscribe: false,
	accent: null
};

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[a-f0-9]{6,20}$/i;
const LOOM_ID = /^[a-f0-9]{32}$/i;

/**
 * A pasted video link → provider + id, or null for anything that isn't a recognised
 * YouTube (watch, youtu.be, shorts, embed, live), Vimeo (incl. unlisted hash, player URL)
 * or Loom (share / embed) link.
 */
export function parseVideoUrl(raw: unknown): ParsedVideo | null {
	if (typeof raw !== 'string') return null;
	const s = raw.trim();
	if (!s || s.length > LINK_URL_MAX) return null;
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (url.username || url.password || url.port) return null;
	const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
	const parts = url.pathname.split('/').filter(Boolean);

	if (host === 'youtu.be') {
		return parts.length === 1 && YT_ID.test(parts[0]) ? { provider: 'youtube', id: parts[0] } : null;
	}
	if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
		let id: string | null = null;
		if (parts.length === 1 && parts[0] === 'watch') id = url.searchParams.get('v');
		else if (parts.length === 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
		return id && YT_ID.test(id) ? { provider: 'youtube', id } : null;
	}
	if (host === 'vimeo.com' || host === 'player.vimeo.com') {
		let id: string | undefined;
		let hash: string | undefined;
		if (host === 'player.vimeo.com') {
			if (parts.length !== 2 || parts[0] !== 'video') return null;
			id = parts[1];
			hash = url.searchParams.get('h') ?? undefined;
		} else {
			// vimeo.com/123, vimeo.com/123/abcdef (unlisted), vimeo.com/channels/x/123, …/video/123
			const i = parts.findIndex((p) => VIMEO_ID.test(p));
			if (i < 0) return null;
			id = parts[i];
			const rest = parts.slice(i + 1);
			if (rest.length > 1) return null;
			hash = rest[0] ?? url.searchParams.get('h') ?? undefined;
		}
		if (!id || !VIMEO_ID.test(id)) return null;
		if (hash !== undefined && !VIMEO_HASH.test(hash)) return null;
		return hash ? { provider: 'vimeo', id, hash: hash.toLowerCase() } : { provider: 'vimeo', id };
	}
	if (host === 'loom.com') {
		if (parts.length !== 2 || (parts[0] !== 'share' && parts[0] !== 'embed')) return null;
		// A share slug can carry a title prefix: "my-video-<32 hex>".
		const id = parts[1].slice(-32);
		return LOOM_ID.test(id) && (parts[1].length === 32 || parts[1].at(-33) === '-') ? { provider: 'loom', id: id.toLowerCase() } : null;
	}
	return null;
}

/** The iframe src for a parsed video — built from the id only, never the pasted URL. No autoplay. */
export function embedSrc(v: ParsedVideo): string | null {
	if (v.provider === 'youtube' && YT_ID.test(v.id)) return `https://www.youtube-nocookie.com/embed/${v.id}?rel=0`;
	if (v.provider === 'vimeo' && VIMEO_ID.test(v.id)) {
		const h = v.hash && VIMEO_HASH.test(v.hash) ? `&h=${v.hash}` : '';
		return `https://player.vimeo.com/video/${v.id}?dnt=1${h}`;
	}
	if (v.provider === 'loom' && LOOM_ID.test(v.id)) return `https://www.loom.com/embed/${v.id}`;
	return null;
}

/** Same-origin URL of an uploaded video / poster. */
export function mediaUrl(key: string | null | undefined): string | null {
	return key && MEDIA_KEY_RE.test(key) ? `/img/${key}` : null;
}

/** Page-level CSP for the public page: frames only from the three video hosts, media only from us. */
export function unsubscribeCsp(): string {
	return `frame-src ${EMBED_ORIGINS.join(' ')}; media-src 'self'; object-src 'none'; base-uri 'self'`;
}

export type FileCheck<E extends string> = { ok: true; ext: E } | { ok: false; error: string; status: number };

/** MP4 / WebM, ≤ 50 MB. */
export function validateVideoFile(file: { type: string; size: number }): FileCheck<'mp4' | 'webm'> {
	if (!file.size) return { ok: false, error: 'The video file is empty.', status: 400 };
	const ext = VIDEO_TYPES[file.type];
	if (!ext) return { ok: false, error: 'Video must be an MP4 or WebM file.', status: 415 };
	if (file.size > VIDEO_MAX_BYTES) return { ok: false, error: 'Video must be 50 MB or smaller.', status: 413 };
	return { ok: true, ext };
}

/** PNG / JPEG / WebP, ≤ 2 MB. */
export function validatePosterFile(file: { type: string; size: number }): FileCheck<'png' | 'jpg' | 'webp'> {
	if (!file.size) return { ok: false, error: 'The poster image is empty.', status: 400 };
	const ext = POSTER_TYPES[file.type];
	if (!ext) return { ok: false, error: 'Poster must be a PNG, JPEG or WebP image.', status: 415 };
	if (file.size > POSTER_MAX_BYTES) return { ok: false, error: 'Poster must be 2 MB or smaller.', status: 413 };
	return { ok: true, ext };
}

/** An http(s) URL without credentials, or null. */
export function cleanLinkUrl(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const s = raw.trim();
	if (!s || s.length > LINK_URL_MAX) return null;
	try {
		const u = new URL(s);
		if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
		return u.href;
	} catch {
		return null;
	}
}

function str(v: unknown, max: number): string {
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function readVideo(v: unknown): PageVideo | null {
	if (!v || typeof v !== 'object') return null;
	const o = v as Record<string, unknown>;
	if (o.kind === 'embed') {
		const p = parseVideoUrl(o.url);
		return p ? { kind: 'embed', url: String(o.url).trim(), ...p } : null;
	}
	if (o.kind === 'upload' && typeof o.key === 'string' && MEDIA_KEY_RE.test(o.key) && o.key.startsWith('unsubscribe/video-')) {
		const type = o.type === 'video/webm' ? 'video/webm' : 'video/mp4';
		const posterKey =
			typeof o.posterKey === 'string' && MEDIA_KEY_RE.test(o.posterKey) && o.posterKey.startsWith('unsubscribe/poster-')
				? o.posterKey
				: null;
		return { kind: 'upload', key: o.key, type, posterKey };
	}
	return null;
}

/** Lenient read of the stored JSON: anything missing or invalid falls back to its default. */
export function normalizeUnsubPage(raw: unknown): UnsubPageConfig {
	let o: Record<string, unknown> = {};
	if (typeof raw === 'string') {
		try {
			const p = JSON.parse(raw);
			if (p && typeof p === 'object') o = p;
		} catch {
			/* defaults */
		}
	} else if (raw && typeof raw === 'object') o = raw as Record<string, unknown>;
	const links = Array.isArray(o.links)
		? (o.links as unknown[])
				.map((l) => {
					const r = (l ?? {}) as Record<string, unknown>;
					const url = cleanLinkUrl(r.url);
					const label = str(r.label, LINK_LABEL_MAX);
					return url && label ? { label, url } : null;
				})
				.filter((l): l is PageLink => !!l)
				.slice(0, LINKS_MAX)
		: [];
	return {
		heading: str(o.heading, HEADING_MAX) || DEFAULT_HEADING,
		intro: str(o.intro, MESSAGE_MAX),
		video: readVideo(o.video),
		caption: str(o.caption, CAPTION_MAX),
		placement: o.placement === 'beside' ? 'beside' : 'below',
		afterHeading: str(o.afterHeading, HEADING_MAX) || DEFAULT_AFTER_HEADING,
		afterMessage: str(o.afterMessage, MESSAGE_MAX),
		afterVideo: readVideo(o.afterVideo),
		afterCaption: str(o.afterCaption, CAPTION_MAX),
		links,
		resubscribe: o.resubscribe === true,
		accent: normalizeHex(o.accent) || null
	};
}

export type UnsubPageInput = {
	heading?: string;
	intro?: string;
	caption?: string;
	placement?: string;
	afterHeading?: string;
	afterMessage?: string;
	afterCaption?: string;
	links?: { label?: string; url?: string }[];
	resubscribe?: boolean;
	accent?: string;
};

/**
 * Strict check of the text fields an admin saves (videos are resolved separately, since an
 * upload needs R2). Blank heading = the default. Returns the first problem, or the cleaned values.
 */
export function validateUnsubPageText(
	input: UnsubPageInput
): { ok: true; value: Omit<UnsubPageConfig, 'video' | 'afterVideo'> } | { ok: false; error: string } {
	const t = (v: string | undefined) => (v ?? '').trim();
	const heading = t(input.heading);
	const afterHeading = t(input.afterHeading);
	if ([...heading].length > HEADING_MAX || [...afterHeading].length > HEADING_MAX)
		return { ok: false, error: `Headings must be ${HEADING_MAX} characters or fewer.` };
	const intro = t(input.intro);
	const afterMessage = t(input.afterMessage);
	if ([...intro].length > MESSAGE_MAX || [...afterMessage].length > MESSAGE_MAX)
		return { ok: false, error: `Messages must be ${MESSAGE_MAX.toLocaleString('en-US')} characters or fewer.` };
	const caption = t(input.caption);
	const afterCaption = t(input.afterCaption);
	if ([...caption].length > CAPTION_MAX || [...afterCaption].length > CAPTION_MAX)
		return { ok: false, error: `Captions must be ${CAPTION_MAX} characters or fewer.` };
	if (input.placement && input.placement !== 'below' && input.placement !== 'beside')
		return { ok: false, error: 'Pick a video placement: below or beside the controls.' };
	const links: PageLink[] = [];
	for (const l of input.links ?? []) {
		const label = t(l.label);
		const rawUrl = t(l.url);
		if (!label && !rawUrl) continue;
		if (!label) return { ok: false, error: 'Each link needs a label.' };
		if ([...label].length > LINK_LABEL_MAX) return { ok: false, error: `Link labels must be ${LINK_LABEL_MAX} characters or fewer.` };
		const url = cleanLinkUrl(rawUrl);
		if (!url) return { ok: false, error: `“${label}” needs an http(s) URL.` };
		links.push({ label, url });
	}
	if (links.length > LINKS_MAX) return { ok: false, error: `Up to ${LINKS_MAX} links.` };
	const accentRaw = t(input.accent);
	const accent = accentRaw ? normalizeHex(accentRaw) : '';
	if (accentRaw && !accent) return { ok: false, error: 'Accent colour must be a hex value like #147793.' };
	return {
		ok: true,
		value: {
			heading: heading || DEFAULT_HEADING,
			intro,
			caption,
			placement: input.placement === 'beside' ? 'beside' : 'below',
			afterHeading: afterHeading || DEFAULT_AFTER_HEADING,
			afterMessage,
			afterCaption,
			links,
			resubscribe: input.resubscribe === true,
			accent: accent || null
		}
	};
}

/** Every R2 key a config points at (videos + posters). */
export function mediaKeys(cfg: Pick<UnsubPageConfig, 'video' | 'afterVideo'>): string[] {
	const out: string[] = [];
	for (const v of [cfg.video, cfg.afterVideo]) {
		if (v?.kind === 'upload') {
			out.push(v.key);
			if (v.posterKey) out.push(v.posterKey);
		}
	}
	return out;
}

/** The video (and its caption) a state shows: the "before" one before unsubscribing, the
 *  "after" one after; none on the other views. */
export function videoForState(cfg: UnsubPageConfig, state: UnsubState): { video: PageVideo | null; caption: string } {
	if (state === 'before') return { video: cfg.video, caption: cfg.caption };
	if (state === 'after') return { video: cfg.afterVideo, caption: cfg.afterCaption };
	return { video: null, caption: '' };
}

/** A short label for the Settings page ("YouTube video", "Uploaded MP4"). */
export function videoLabel(v: PageVideo | null): string {
	if (!v) return 'None';
	return v.kind === 'embed' ? `${PROVIDER_LABELS[v.provider]} video` : `Uploaded ${v.type === 'video/webm' ? 'WebM' : 'MP4'}`;
}
