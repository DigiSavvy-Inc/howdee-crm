// Automation canvas zoom + pan (#147, #218) — pure helpers shared by the builder page
// and tests. The canvas is a viewport with a world inside it, drawn with
// `translate(x, y) scale(k)` (transform-origin 0 0): a world point (wx, wy) lands at
// viewport point (x + wx·k, y + wy·k).

import { LAYOUT } from './canvas-layout';

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;
/** Presets in the percentage menu (Fit is computed, not listed here). */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
/** Margin Fit leaves around the flow. */
export const FIT_MARGIN = 24;
/**
 * Pan clamping keeps at least one full step card on screen (#228) — a trunk card's
 * width and a typical card's height, in world px (scaled by the zoom).
 */
export const PAN_KEEP_CARD = { w: LAYOUT.cardWidth, h: 72 };
/** …or this share of the flow's bbox on each axis, whichever is smaller. */
export const PAN_KEEP_SHARE = 0.4;
/** Viewports at or below this width open a too-wide saved view at Fit (#228). */
export const PHONE_MAX_WIDTH = 768;

export interface View {
	x: number;
	y: number;
	k: number;
}

/** Clamp to 20%–200%, rounded to whole percents; anything non-finite resets to 100%. */
export function clampZoom(z: number): number {
	if (!Number.isFinite(z)) return 1;
	return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;
}

/** One −/+ button press: snap to the 10% grid, then move one step in `dir`. */
export function stepZoom(z: number, dir: 1 | -1): number {
	const snapped = Math.round(clampZoom(z) / ZOOM_STEP) * ZOOM_STEP;
	const next = Math.abs(snapped - z) > 0.001 && Math.sign(snapped - z) === dir ? snapped : snapped + dir * ZOOM_STEP;
	return clampZoom(next);
}

/**
 * Scale at which content of (contentW × contentH) fits a viewport of (viewportW ×
 * viewportH). Never zooms in past 100% (a short flow already fits) and never below
 * 20%; degenerate sizes give 100%.
 */
export function fitScale(contentW: number, contentH: number, viewportW: number, viewportH: number): number {
	if (!(contentW > 0 && contentH > 0 && viewportW > 0 && viewportH > 0)) return 1;
	const s = Math.min(viewportW / contentW, viewportH / contentH, 1);
	return clampZoom(Math.floor(s * 100) / 100);
}

/** Zoom to `k`, keeping the world point under viewport point (px, py) where it is. */
export function zoomAt(v: View, k: number, px: number, py: number): View {
	const next = clampZoom(k);
	const wx = (px - v.x) / v.k;
	const wy = (py - v.y) / v.k;
	return { k: next, x: px - wx * next, y: py - wy * next };
}

/** Wheel delta → zoom factor (pinch arrives as ctrl+wheel with small pixel deltas). */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
	const dy = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
	return Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01);
}

/**
 * Keep at least one full step card — or PAN_KEEP_SHARE of the flow, when that is
 * smaller — inside the viewport on each axis (#228). Never more than the viewport.
 */
export function clampPan(
	v: View,
	contentW: number,
	contentH: number,
	viewportW: number,
	viewportH: number,
	card: { w: number; h: number } = PAN_KEEP_CARD
): View {
	const axis = (pos: number, size: number, cardSize: number, vp: number) => {
		const k = Math.min(cardSize * v.k, size * PAN_KEEP_SHARE, vp);
		const min = k - size;
		const max = vp - k;
		return min > max ? (min + max) / 2 : Math.min(max, Math.max(min, pos));
	};
	return {
		k: v.k,
		x: axis(v.x, contentW * v.k, card.w, viewportW),
		y: axis(v.y, contentH * v.k, card.h, viewportH)
	};
}

/**
 * Fit the whole flow into the viewport with `margin` on every side: centred
 * horizontally, top-aligned. Never above 100%.
 */
export function fitView(contentW: number, contentH: number, viewportW: number, viewportH: number, margin = FIT_MARGIN): View {
	const k = fitScale(contentW, contentH, Math.max(1, viewportW - 2 * margin), Math.max(1, viewportH - 2 * margin));
	return { k, x: (viewportW - contentW * k) / 2, y: margin };
}

/**
 * The view on first open: Fit when the flow is wider than the viewport, else 100%
 * centred at the top.
 */
export function initialView(contentW: number, contentH: number, viewportW: number, viewportH: number): View {
	if (contentW > viewportW - 2 * FIT_MARGIN) return fitView(contentW, contentH, viewportW, viewportH);
	return { k: 1, x: (viewportW - contentW) / 2, y: FIT_MARGIN };
}

/**
 * The view to open with when a saved one exists (#228): the saved view as is, except on
 * a phone-sized viewport (≤ PHONE_MAX_WIDTH) where the flow at the saved zoom is wider
 * than the viewport — then Fit. The caller doesn't persist it, so the saved desktop
 * view survives until the user pans/zooms on the phone.
 */
export function openSavedView(
	saved: { k: number; x: number | null; y: number | null },
	contentW: number,
	contentH: number,
	viewportW: number,
	viewportH: number
): View {
	if (viewportW <= PHONE_MAX_WIDTH && contentW * saved.k > viewportW) {
		return fitView(contentW, contentH, viewportW, viewportH);
	}
	if (saved.x !== null && saved.y !== null) return { k: saved.k, x: saved.x, y: saved.y };
	return { k: saved.k, x: (viewportW - contentW * saved.k) / 2, y: FIT_MARGIN };
}

/** "75%" */
export function zoomLabel(z: number): string {
	return `${Math.round(z * 100)}%`;
}

/**
 * Parse a persisted `canvas-zoom:<id>` value — `{"k":…,"x":…,"y":…}` (#218) or a bare
 * zoom number from #147 (no pan). Null when absent/invalid.
 */
export function parseStoredView(v: string | null): { k: number; x: number | null; y: number | null } | null {
	if (v === null || v.trim() === '') return null;
	const n = Number(v);
	if (Number.isFinite(n)) return n > 0 ? { k: clampZoom(n), x: null, y: null } : null;
	try {
		const o = JSON.parse(v) as Record<string, unknown>;
		const k = Number(o?.k);
		if (!Number.isFinite(k) || k <= 0) return null;
		const x = Number(o.x);
		const y = Number(o.y);
		return Number.isFinite(x) && Number.isFinite(y) ? { k: clampZoom(k), x, y } : { k: clampZoom(k), x: null, y: null };
	} catch {
		return null;
	}
}

/** Serialize a view for `canvas-zoom:<id>`. */
export function serializeView(v: View): string {
	return JSON.stringify({ k: v.k, x: Math.round(v.x), y: Math.round(v.y) });
}
