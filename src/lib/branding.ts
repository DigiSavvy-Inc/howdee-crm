// Branding (#188) — universal (client + server) vocabulary. The values themselves live in
// app_state (`app_name`, `app_short_name`, `logo_key`; see $lib/server/branding.ts) and reach
// every page through the root layout load as `data.branding`.

// #599 / #707: "Howdee CRM" is the final product name (slug `howdee-crm`), kept here only
// so a rename is a one-line change. #595 used the placeholder "Email CRM". An
// install that predates #595 got 'DS Email Marketing' / 'DS Email' stored by migration 0122,
// and any stored app_name / app_short_name always wins over these defaults.
export const PRODUCT_NAME = 'Howdee CRM';
export const DEFAULT_APP_NAME = PRODUCT_NAME;
export const DEFAULT_SHORT_NAME = PRODUCT_NAME;
export const APP_NAME_MAX = 40;
export const SHORT_NAME_MAX = 12;
export const LOGO_MAX_BYTES = 512 * 1024;

/** Logo uploads: PNG / SVG / WebP. SVG is served with a sandboxing CSP (see /img/branding). */
export const LOGO_TYPES: Record<string, 'png' | 'svg' | 'webp'> = {
	'image/png': 'png',
	'image/svg+xml': 'svg',
	'image/webp': 'webp'
};
export const LOGO_KEY_RE = /^branding\/logo-[a-f0-9]{16}\.(png|svg|webp)$/;
/** Brand kit logos (#595): same folder, PNG / WebP only (they go into emails). */
export const KIT_LOGO_KEY_RE = /^branding\/kit-[a-f0-9]{16}\.(png|webp)$/;

/** Where the header logo links (#188). */
export const BRAND_HREF = '/';

export type Branding = {
	appName: string;
	shortName: string;
	/** R2 key of the uploaded logo, or null for the bundled logomark. */
	logoKey: string | null;
	/** Same-origin URL of the uploaded logo (`/img/branding/…`), or null. */
	logoUrl: string | null;
};

export const DEFAULT_BRANDING: Branding = {
	appName: DEFAULT_APP_NAME,
	shortName: DEFAULT_SHORT_NAME,
	logoKey: null,
	logoUrl: null
};

export function logoUrlFor(key: string | null | undefined): string | null {
	return key && LOGO_KEY_RE.test(key) ? `/img/${key}` : null;
}

/** aria-label for the header brand link. */
export function brandLinkLabel(appName: string): string {
	return `${appName} — dashboard`;
}
