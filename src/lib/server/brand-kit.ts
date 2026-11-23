// #595: brand kit storage — app_state `brand_kit` (JSON, see $lib/brand-kit). Logos upload
// to R2 `MEDIA` beside the Branding logo (#188) as `branding/kit-<sha256-16>.<ext>`,
// served publicly by /img/branding/[file]; the kit stores the absolute URL.
import { BRAND_KIT_KEY, applyKitOp, defaultBrandKit, normalizeBrandKit, type BrandKit, type KitOp, type KitOpResult } from '$lib/brand-kit';
import { KIT_LOGO_KEY_RE } from '$lib/branding';
import { validateLogoFile } from './branding';

export async function getBrandKit(db: D1Database | null | undefined): Promise<BrandKit> {
	if (!db) return defaultBrandKit();
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(BRAND_KIT_KEY).first<{ value: string | null }>();
		return row?.value ? normalizeBrandKit(row.value) : defaultBrandKit();
	} catch {
		// Cosmetic — a failed read must never break a page.
		return defaultBrandKit();
	}
}

const cache = new WeakMap<object, Promise<BrandKit>>();
/** One read per request (root layout load). */
export function brandKitFor(event: { locals: object; platform?: App.Platform }): Promise<BrandKit> {
	let p = cache.get(event.locals);
	if (!p) {
		p = getBrandKit(event.platform?.env?.DB);
		cache.set(event.locals, p);
	}
	return p;
}

export async function saveBrandKit(db: D1Database, kit: BrandKit): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(BRAND_KIT_KEY, JSON.stringify(normalizeBrandKit(kit)))
		.run();
}

/** Read, apply one edit, write. A removed kit upload is deleted from R2 (best-effort). */
export async function editBrandKit(db: D1Database, op: KitOp, bucket?: R2Bucket): Promise<KitOpResult> {
	const r = applyKitOp(await getBrandKit(db), op);
	if (!r.ok) return r;
	await saveBrandKit(db, r.kit);
	const key = r.removed ? kitUploadKey(r.removed.src) : null;
	if (key && bucket && !r.kit.logos.some((l) => kitUploadKey(l.src) === key)) await bucket.delete(key).catch(() => undefined);
	return r;
}

/** The R2 key of a kit upload's URL (`…/img/branding/kit-….png`), else null. */
export function kitUploadKey(src: string): string | null {
	try {
		const m = new URL(src).pathname.match(/\/img\/(branding\/kit-[a-f0-9]{16}\.(?:png|webp))$/);
		return m && KIT_LOGO_KEY_RE.test(m[1]) ? m[1] : null;
	} catch {
		return null;
	}
}

export type KitLogoCheck = { ok: true; ext: 'png' | 'webp' } | { ok: false; error: string; status: number };

/** The Branding logo's checks (≤ 512 KB), minus SVG: kit logos go into emails, and email
 *  clients don't show SVG. */
export function validateKitLogoFile(file: { type: string; size: number }): KitLogoCheck {
	const c = validateLogoFile(file);
	if (!c.ok) return c.status === 415 ? { ok: false, error: 'Logo must be a PNG or WebP image.', status: 415 } : c;
	if (c.ext === 'svg') return { ok: false, error: 'Email clients can’t show SVG — upload a PNG or WebP logo.', status: 415 };
	return { ok: true, ext: c.ext };
}

/** Store a kit logo in R2; resolves to its absolute public URL. */
export async function storeKitLogo(
	bucket: R2Bucket,
	file: { type: string; arrayBuffer(): Promise<ArrayBuffer> },
	ext: 'png' | 'webp',
	base: string
): Promise<string> {
	const bytes = await file.arrayBuffer();
	const d = await crypto.subtle.digest('SHA-256', bytes);
	const hash = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
	const key = `branding/kit-${hash}.${ext}`;
	await bucket.put(key, bytes, { httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' } });
	return `${base.replace(/\/+$/, '')}/img/${key}`;
}
