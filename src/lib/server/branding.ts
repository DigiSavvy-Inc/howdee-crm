// Branding settings (#188): app name, short name and an uploaded logo, stored in app_state
// under `app_name`, `app_short_name`, `logo_key` (unset = the defaults, so nothing changes
// until an admin edits them). The logo bytes live in R2 (`MEDIA`) at
// `branding/logo-<hash>.<ext>`, served by /img/branding/[file].
import {
	APP_NAME_MAX,
	DEFAULT_APP_NAME,
	DEFAULT_BRANDING,
	DEFAULT_SHORT_NAME,
	LOGO_KEY_RE,
	LOGO_MAX_BYTES,
	LOGO_TYPES,
	SHORT_NAME_MAX,
	logoUrlFor,
	type Branding
} from '$lib/branding';

const KEYS = ['app_name', 'app_short_name', 'logo_key'] as const;

export async function getBranding(db: D1Database | undefined | null): Promise<Branding> {
	if (!db) return { ...DEFAULT_BRANDING };
	try {
		const rows = await db
			.prepare(`SELECT key, value FROM app_state WHERE key IN (?, ?, ?)`)
			.bind(...KEYS)
			.all<{ key: string; value: string | null }>();
		const v = new Map(rows.results.map((r) => [r.key, r.value?.trim() || null]));
		const logoKey = v.get('logo_key') ?? null;
		const valid = logoKey && LOGO_KEY_RE.test(logoKey) ? logoKey : null;
		return {
			appName: v.get('app_name') || DEFAULT_APP_NAME,
			shortName: v.get('app_short_name') || DEFAULT_SHORT_NAME,
			logoKey: valid,
			logoUrl: logoUrlFor(valid)
		};
	} catch {
		// Branding is cosmetic — a failed read must never break a page.
		return { ...DEFAULT_BRANDING };
	}
}

// One read per request: the root layout load and anything else in the same request share it.
const cache = new WeakMap<object, Promise<Branding>>();
export function brandingFor(event: { locals: object; platform?: App.Platform }): Promise<Branding> {
	let p = cache.get(event.locals);
	if (!p) {
		p = getBranding(event.platform?.env?.DB);
		cache.set(event.locals, p);
	}
	return p;
}

export type BrandingTextResult =
	| { ok: true; appName: string | null; shortName: string | null }
	| { ok: false; error: string };

/** Trim + length-cap the two names. Blank = back to the default (stored as NULL). */
export function validateBrandingText(appNameRaw: unknown, shortNameRaw: unknown): BrandingTextResult {
	const appName = String(appNameRaw ?? '').trim();
	const shortName = String(shortNameRaw ?? '').trim();
	if ([...appName].length > APP_NAME_MAX) return { ok: false, error: `App name must be ${APP_NAME_MAX} characters or fewer.` };
	if ([...shortName].length > SHORT_NAME_MAX)
		return { ok: false, error: `Short name must be ${SHORT_NAME_MAX} characters or fewer.` };
	return { ok: true, appName: appName || null, shortName: shortName || null };
}

export type LogoCheck = { ok: true; ext: 'png' | 'svg' | 'webp' } | { ok: false; error: string; status: number };

/** Type + size check for an uploaded logo (PNG/SVG/WebP, ≤ 512 KB). */
export function validateLogoFile(file: { type: string; size: number }): LogoCheck {
	if (!file.size) return { ok: false, error: 'The logo file is empty.', status: 400 };
	const ext = LOGO_TYPES[file.type];
	if (!ext) return { ok: false, error: 'Logo must be a PNG, SVG or WebP image.', status: 415 };
	if (file.size > LOGO_MAX_BYTES) return { ok: false, error: 'Logo must be 512 KB or smaller.', status: 413 };
	return { ok: true, ext };
}

/** SVGs with script-ish content are refused outright (they're also served with a sandbox CSP). */
export function unsafeSvg(text: string): boolean {
	return /<script|<foreignObject|\son[a-z]+\s*=|javascript:/i.test(text);
}

async function hashHex(bytes: ArrayBuffer): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function upsert(db: D1Database, values: Partial<Record<(typeof KEYS)[number], string | null>>) {
	const stmt = db.prepare(
		`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	);
	const stmts = Object.entries(values).map(([k, v]) => stmt.bind(k, v ?? null));
	if (stmts.length) await db.batch(stmts);
}

export async function saveBrandingText(db: D1Database, appName: string | null, shortName: string | null) {
	await upsert(db, { app_name: appName, app_short_name: shortName });
}

/** Store an uploaded logo in R2 and point `logo_key` at it; the previous logo is removed. */
export async function saveLogo(
	db: D1Database,
	bucket: R2Bucket,
	file: { type: string; arrayBuffer(): Promise<ArrayBuffer> },
	ext: 'png' | 'svg' | 'webp'
): Promise<string> {
	const bytes = await file.arrayBuffer();
	const key = `branding/logo-${await hashHex(bytes)}.${ext}`;
	const prev = (await getBranding(db)).logoKey;
	await bucket.put(key, bytes, {
		httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' }
	});
	await upsert(db, { logo_key: key });
	if (prev && prev !== key) await bucket.delete(prev).catch(() => undefined);
	return key;
}

/** Back to the bundled logomark. */
export async function removeLogo(db: D1Database, bucket: R2Bucket | undefined): Promise<void> {
	const prev = (await getBranding(db)).logoKey;
	await upsert(db, { logo_key: null });
	if (prev && bucket) await bucket.delete(prev).catch(() => undefined);
}

const BUNDLED_ICONS = [
	{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
	{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
	{ src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
];

/** The PWA manifest (#135), built from the branding settings (#188). */
export function buildManifest(b: Branding) {
	const ext = b.logoKey?.split('.').pop();
	const raster = b.logoUrl && (ext === 'png' || ext === 'webp');
	return {
		name: b.appName,
		short_name: b.shortName,
		id: '/',
		start_url: '/',
		scope: '/',
		display: 'standalone',
		// Theme light --bg (neutral-2) / --header-bg (neutral-1), src/app.css.
		background_color: '#f9f9f9',
		theme_color: '#ffffff',
		icons: raster
			? [{ src: b.logoUrl, sizes: 'any', type: ext === 'png' ? 'image/png' : 'image/webp', purpose: 'any' }]
			: BUNDLED_ICONS
	};
}
