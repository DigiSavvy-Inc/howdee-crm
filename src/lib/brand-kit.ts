// #595: the brand kit — the colour swatches and logos the editors offer as presets
// (BlockEditor `swatches` / `brandLogos`, ColorField). Stored as JSON in app_state
// `brand_kit` (src/lib/server/brand-kit.ts), edited at Settings → Brand kit. Unset = a
// neutral palette and no logos; migration 0122 seeded an existing install's former
// hardcoded palette + logos. Client- AND server-safe.
import type { BrandLogo, Swatch } from '@digisavvy/block-editor/blocks';
import { normalizeHex } from '$lib/brand';

export const BRAND_KIT_KEY = 'brand_kit';

export type KitBackground = 'light' | 'dark';
export const KIT_BACKGROUNDS: { key: KitBackground; label: string }[] = [
	{ key: 'light', label: 'Light background' },
	{ key: 'dark', label: 'Dark background' }
];

export type KitSwatch = { key: string; label: string; hex: string };
/** `src` is an absolute image URL (emails need one); `background` = what it's made to sit on. */
export type KitLogo = { key: string; label: string; src: string; alt: string; background: KitBackground };
export type BrandKit = { swatches: KitSwatch[]; logos: KitLogo[] };

export const KIT_LIMITS = { swatches: 24, logos: 12, label: 40, alt: 80 } as const;

/** A fresh install's palette: neutral greys plus a few plain accents. */
export const NEUTRAL_SWATCHES: KitSwatch[] = [
	{ key: 'black', label: 'Black', hex: '#111111' },
	{ key: 'charcoal', label: 'Charcoal', hex: '#374151' },
	{ key: 'gray', label: 'Gray', hex: '#6b7280' },
	{ key: 'light-gray', label: 'Light gray', hex: '#e5e7eb' },
	{ key: 'off-white', label: 'Off-white', hex: '#f9fafb' },
	{ key: 'white', label: 'White', hex: '#ffffff' },
	{ key: 'blue', label: 'Blue', hex: '#1d4ed8' },
	{ key: 'green', label: 'Green', hex: '#15803d' },
	{ key: 'red', label: 'Red', hex: '#b91c1c' },
	{ key: 'amber', label: 'Amber', hex: '#b45309' }
];

export function defaultBrandKit(): BrandKit {
	return { swatches: NEUTRAL_SWATCHES.map((s) => ({ ...s })), logos: [] };
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/i;

export function cleanLabel(v: unknown, max: number = KIT_LIMITS.label): string {
	return String(v ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

/** http(s) URL only; anything else → ''. */
export function cleanLogoSrc(v: unknown): string {
	const s = String(v ?? '').trim();
	try {
		const u = new URL(s);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
	} catch {
		return '';
	}
}

/** Lenient read of the stored JSON: junk entries are dropped; a value that isn't a kit
 *  at all → the neutral default. An empty list stays empty (the admin removed them). */
export function normalizeBrandKit(raw: unknown): BrandKit {
	let v = raw;
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v);
		} catch {
			return defaultBrandKit();
		}
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) return defaultBrandKit();
	const o = v as { swatches?: unknown; logos?: unknown };
	const seen = new Set<string>();
	const swatches: KitSwatch[] = [];
	for (const s of Array.isArray(o.swatches) ? o.swatches : []) {
		const r = (s ?? {}) as Record<string, unknown>;
		const key = String(r.key ?? '');
		const hex = normalizeHex(r.hex);
		const label = cleanLabel(r.label);
		if (!KEY_RE.test(key) || !hex || !label || seen.has('s:' + key)) continue;
		seen.add('s:' + key);
		swatches.push({ key, label, hex });
		if (swatches.length >= KIT_LIMITS.swatches) break;
	}
	const logos: KitLogo[] = [];
	for (const l of Array.isArray(o.logos) ? o.logos : []) {
		const r = (l ?? {}) as Record<string, unknown>;
		const key = String(r.key ?? '');
		const src = cleanLogoSrc(r.src);
		const label = cleanLabel(r.label);
		if (!KEY_RE.test(key) || !src || !label || seen.has('l:' + key)) continue;
		seen.add('l:' + key);
		logos.push({ key, label, src, alt: cleanLabel(r.alt, KIT_LIMITS.alt), background: r.background === 'dark' ? 'dark' : 'light' });
		if (logos.length >= KIT_LIMITS.logos) break;
	}
	return { swatches, logos };
}

/** What BlockEditor's `swatches` prop takes (null kit = the neutral default). */
export function editorSwatches(kit: BrandKit | null | undefined): Swatch[] {
	return (kit ?? defaultBrandKit()).swatches.map((s) => ({ key: s.key, label: s.label, hex: s.hex }));
}

/** What BlockEditor's `brandLogos` prop takes. */
export function editorLogos(kit: BrandKit | null | undefined): BrandLogo[] {
	return (kit?.logos ?? []).map((l) => ({ key: l.key, label: l.label, src: l.src, alt: l.alt || l.label }));
}

// ── Edits (pure; the server wraps them with a read + write) ──────────────────────────

export type KitOp =
	| { op: 'addSwatch'; label: unknown; hex: unknown }
	| { op: 'updateSwatch'; key: string; label: unknown; hex: unknown }
	| { op: 'removeSwatch'; key: string }
	| { op: 'moveSwatch'; key: string; dir: 'up' | 'down' }
	| { op: 'addLogo'; label: unknown; alt: unknown; background: unknown; src: string }
	| { op: 'updateLogo'; key: string; label: unknown; alt: unknown; background: unknown }
	| { op: 'removeLogo'; key: string }
	| { op: 'moveLogo'; key: string; dir: 'up' | 'down' };

export type KitOpResult = { ok: true; kit: BrandKit; removed?: KitLogo } | { ok: false; error: string };

function newKey(prefix: string, taken: Set<string>): string {
	for (;;) {
		const k = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
		if (!taken.has(k)) return k;
	}
}

function move<T extends { key: string }>(list: T[], key: string, dir: 'up' | 'down'): T[] | null {
	const i = list.findIndex((x) => x.key === key);
	if (i < 0) return null;
	const j = dir === 'up' ? i - 1 : i + 1;
	if (j < 0 || j >= list.length) return list;
	const out = [...list];
	[out[i], out[j]] = [out[j], out[i]];
	return out;
}

function swatchFields(label: unknown, hex: unknown): { ok: true; label: string; hex: string } | { ok: false; error: string } {
	const l = cleanLabel(label);
	const h = normalizeHex(hex);
	if (!l) return { ok: false, error: 'Give the colour a name.' };
	if (!h) return { ok: false, error: 'Enter a hex colour such as #1a9ec4.' };
	return { ok: true, label: l, hex: h };
}

export function applyKitOp(kit: BrandKit, op: KitOp): KitOpResult {
	const swatches = [...kit.swatches];
	const logos = [...kit.logos];
	switch (op.op) {
		case 'addSwatch': {
			if (swatches.length >= KIT_LIMITS.swatches) return { ok: false, error: `A brand kit holds up to ${KIT_LIMITS.swatches} colours.` };
			const f = swatchFields(op.label, op.hex);
			if (!f.ok) return f;
			swatches.push({ key: newKey('c', new Set(swatches.map((s) => s.key))), label: f.label, hex: f.hex });
			return { ok: true, kit: { swatches, logos } };
		}
		case 'updateSwatch': {
			const i = swatches.findIndex((s) => s.key === op.key);
			if (i < 0) return { ok: false, error: 'That colour is no longer in the kit.' };
			const f = swatchFields(op.label, op.hex);
			if (!f.ok) return f;
			swatches[i] = { key: op.key, label: f.label, hex: f.hex };
			return { ok: true, kit: { swatches, logos } };
		}
		case 'removeSwatch': {
			const next = swatches.filter((s) => s.key !== op.key);
			if (next.length === swatches.length) return { ok: false, error: 'That colour is no longer in the kit.' };
			return { ok: true, kit: { swatches: next, logos } };
		}
		case 'moveSwatch': {
			const next = move(swatches, op.key, op.dir);
			if (!next) return { ok: false, error: 'That colour is no longer in the kit.' };
			return { ok: true, kit: { swatches: next, logos } };
		}
		case 'addLogo': {
			if (logos.length >= KIT_LIMITS.logos) return { ok: false, error: `A brand kit holds up to ${KIT_LIMITS.logos} logos.` };
			const label = cleanLabel(op.label);
			const src = cleanLogoSrc(op.src);
			if (!label) return { ok: false, error: 'Give the logo a name.' };
			if (!src) return { ok: false, error: 'The logo upload has no usable URL.' };
			logos.push({ key: newKey('logo', new Set(logos.map((l) => l.key))), label, src, alt: cleanLabel(op.alt, KIT_LIMITS.alt), background: op.background === 'dark' ? 'dark' : 'light' });
			return { ok: true, kit: { swatches, logos } };
		}
		case 'updateLogo': {
			const i = logos.findIndex((l) => l.key === op.key);
			if (i < 0) return { ok: false, error: 'That logo is no longer in the kit.' };
			const label = cleanLabel(op.label);
			if (!label) return { ok: false, error: 'Give the logo a name.' };
			logos[i] = { ...logos[i], label, alt: cleanLabel(op.alt, KIT_LIMITS.alt), background: op.background === 'dark' ? 'dark' : 'light' };
			return { ok: true, kit: { swatches, logos } };
		}
		case 'removeLogo': {
			const removed = logos.find((l) => l.key === op.key);
			if (!removed) return { ok: false, error: 'That logo is no longer in the kit.' };
			return { ok: true, kit: { swatches, logos: logos.filter((l) => l.key !== op.key) }, removed };
		}
		case 'moveLogo': {
			const next = move(logos, op.key, op.dir);
			if (!next) return { ok: false, error: 'That logo is no longer in the kit.' };
			return { ok: true, kit: { swatches, logos: next } };
		}
	}
}
