// #262 / #558: the colour maths (normalizeHex, contrastRatio, autoTextColor, MIN_CONTRAST)
// lives in @digisavvy/block-editor and is re-exported here. Client- AND server-safe.
// #595: the palette and logos the editors offer are no longer hardcoded — they are the
// install's brand kit ($lib/brand-kit, Settings → Brand kit).

export { MIN_CONTRAST, autoTextColor, contrastRatio, normalizeHex, type Swatch } from '@digisavvy/block-editor/blocks';

/** Email-safe sans stack for branded blocks (no serif, by the owner's call). */
export const BRAND_FONT = 'Inter,Helvetica,Arial,sans-serif';
