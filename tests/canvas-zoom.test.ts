import { describe, it, expect } from 'vitest';
import {
	clampPan,
	clampZoom,
	fitScale,
	fitView,
	initialView,
	openSavedView,
	parseStoredView,
	serializeView,
	stepZoom,
	wheelZoomFactor,
	zoomAt,
	zoomLabel
} from '../src/lib/canvas-zoom';

describe('clampZoom (#147)', () => {
	it('keeps values inside 20%–200% (#218)', () => {
		expect(clampZoom(1)).toBe(1);
		expect(clampZoom(0.1)).toBe(0.2);
		expect(clampZoom(0.3)).toBe(0.3);
		expect(clampZoom(5)).toBe(2);
	});
	it('rounds to whole percents and resets garbage to 100%', () => {
		expect(clampZoom(0.7000000001)).toBe(0.7);
		expect(clampZoom(0.756)).toBe(0.76);
		expect(clampZoom(NaN)).toBe(1);
		expect(clampZoom(Infinity)).toBe(1);
	});
});

describe('stepZoom', () => {
	it('moves 10% per press on the grid', () => {
		expect(stepZoom(1, 1)).toBe(1.1);
		expect(stepZoom(1, -1)).toBe(0.9);
		expect(stepZoom(0.2, -1)).toBe(0.2);
		expect(stepZoom(2, 1)).toBe(2);
	});
	it('snaps off-grid values (wheel / fit / 75%) to the next grid stop', () => {
		expect(stepZoom(0.75, 1)).toBe(0.8);
		expect(stepZoom(0.75, -1)).toBe(0.7);
		expect(stepZoom(0.72, 1)).toBe(0.8);
		expect(stepZoom(0.72, -1)).toBe(0.7);
	});
});

describe('fitScale', () => {
	it('fits the limiting dimension', () => {
		expect(fitScale(1000, 2000, 800, 600)).toBe(0.3);
		expect(fitScale(1000, 10000, 800, 600)).toBe(0.2); // floored at 20%
		expect(fitScale(1000, 1000, 800, 600)).toBe(0.6);
		expect(fitScale(1000, 800, 900, 1000)).toBe(0.9);
	});
	it('never zooms in past 100% for a small flow', () => {
		expect(fitScale(300, 200, 800, 600)).toBe(1);
	});
	it('rounds down so the result really fits', () => {
		expect(fitScale(1000, 1000, 666, 2000)).toBe(0.66);
	});
	it('returns 100% for degenerate sizes', () => {
		expect(fitScale(0, 100, 800, 600)).toBe(1);
		expect(fitScale(100, 100, 0, 0)).toBe(1);
	});
});

describe('zoomLabel / parseStoredView', () => {
	it('formats percentages', () => {
		expect(zoomLabel(0.75)).toBe('75%');
		expect(zoomLabel(1.1)).toBe('110%');
	});
	it('parses the #147 bare-number format as zoom only', () => {
		expect(parseStoredView(null)).toBeNull();
		expect(parseStoredView('')).toBeNull();
		expect(parseStoredView('abc')).toBeNull();
		expect(parseStoredView('0')).toBeNull();
		expect(parseStoredView('0.6')).toEqual({ k: 0.6, x: null, y: null });
		expect(parseStoredView('9')).toEqual({ k: 2, x: null, y: null });
	});
	it('round-trips zoom + pan (#218)', () => {
		expect(parseStoredView(serializeView({ k: 0.5, x: 12.4, y: -30.6 }))).toEqual({ k: 0.5, x: 12, y: -31 });
		expect(parseStoredView('{"k":0.1,"x":1,"y":2}')).toEqual({ k: 0.2, x: 1, y: 2 });
		expect(parseStoredView('{"k":1,"x":"a"}')).toEqual({ k: 1, x: null, y: null });
		expect(parseStoredView('{"k":-1,"x":0,"y":0}')).toBeNull();
		expect(parseStoredView('{bad')).toBeNull();
	});
});

describe('zoomAt (#218)', () => {
	it('keeps the world point under the cursor fixed', () => {
		const v = { x: 40, y: 10, k: 1 };
		const px = 240;
		const py = 110;
		const wx = (px - v.x) / v.k;
		const wy = (py - v.y) / v.k;
		const n = zoomAt(v, 2, px, py);
		expect(n.k).toBe(2);
		expect(n.x + wx * n.k).toBeCloseTo(px);
		expect(n.y + wy * n.k).toBeCloseTo(py);
	});
	it('clamps the scale to 0.2–2 and still pins the point', () => {
		const v = { x: 0, y: 0, k: 0.5 };
		const a = zoomAt(v, 0.01, 100, 100);
		expect(a.k).toBe(0.2);
		expect(a.x + (100 / 0.5) * a.k).toBeCloseTo(100);
		expect(zoomAt(v, 50, 0, 0).k).toBe(2);
	});
	it('wheel deltas zoom in for negative deltaY, out for positive', () => {
		expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
		expect(wheelZoomFactor(10)).toBeLessThan(1);
		expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48));
	});
});

describe('fitView / initialView (#218)', () => {
	it('fits the flow bbox with a 24px margin, centred horizontally', () => {
		const v = fitView(2000, 1000, 1000, 600);
		// limiting: (1000-48)/2000 = 0.476, (600-48)/1000 = 0.552
		expect(v.k).toBe(0.47);
		expect(v.x).toBeCloseTo((1000 - 2000 * 0.47) / 2);
		expect(v.y).toBe(24);
		expect(2000 * v.k).toBeLessThanOrEqual(1000 - 48);
		expect(1000 * v.k).toBeLessThanOrEqual(600 - 48);
	});
	it('never zooms past 100% for a small flow', () => {
		expect(fitView(300, 200, 1000, 600).k).toBe(1);
	});
	it('opens at Fit only when the flow is wider than the viewport', () => {
		expect(initialView(2000, 800, 1000, 600).k).toBeLessThan(1);
		const narrow = initialView(400, 3000, 1000, 600);
		expect(narrow.k).toBe(1);
		expect(narrow.x).toBe(300);
	});
});

describe('clampPan (#218, #228)', () => {
	it('keeps one full step card visible on a large flow', () => {
		// card 340×72 at k=1; 40% of 2000×1000 is larger, so the card wins
		const lost = clampPan({ x: -5000, y: 9000, k: 1 }, 2000, 1000, 1200, 600);
		expect(lost.x).toBe(340 - 2000);
		expect(lost.y).toBe(600 - 72);
		const right = clampPan({ x: 5000, y: -5000, k: 1 }, 2000, 1000, 1200, 600);
		expect(right.x).toBe(1200 - 340);
		expect(right.y).toBe(72 - 1000);
	});
	it('scales the card with the zoom', () => {
		const v = clampPan({ x: -5000, y: 9000, k: 0.5 }, 2000, 1000, 1200, 600);
		expect(v.x).toBe(170 - 1000);
		expect(v.y).toBe(600 - 36);
	});
	it('keeps 40% of the flow when that is smaller than a card', () => {
		// flow 500×100 at k=1: 40% = 200×40, smaller than 340×72
		const v = clampPan({ x: -5000, y: 9000, k: 1 }, 500, 100, 1200, 600);
		expect(v.x).toBe(200 - 500);
		expect(v.y).toBe(600 - 40);
	});
	it('never asks for more than the viewport', () => {
		const v = clampPan({ x: -5000, y: 0, k: 2 }, 2000, 1000, 300, 600);
		expect(v.x).toBe(300 - 4000);
	});
	it('a clamped flow still shows the kept size inside the viewport', () => {
		for (const pos of [-1e5, -800, 0, 400, 1e5]) {
			const v = clampPan({ x: pos, y: pos, k: 0.8 }, 1500, 900, 800, 500);
			const visW = Math.min(800, v.x + 1500 * 0.8) - Math.max(0, v.x);
			const visH = Math.min(500, v.y + 900 * 0.8) - Math.max(0, v.y);
			expect(visW).toBeGreaterThanOrEqual(Math.min(340 * 0.8, 1500 * 0.8 * 0.4) - 1e-9);
			expect(visH).toBeGreaterThanOrEqual(Math.min(72 * 0.8, 900 * 0.8 * 0.4) - 1e-9);
		}
	});
	it('leaves an on-screen view alone', () => {
		expect(clampPan({ x: 10, y: 20, k: 1 }, 500, 500, 600, 400)).toEqual({ x: 10, y: 20, k: 1 });
	});
});

describe('openSavedView (#228)', () => {
	it('uses the saved view on a desktop viewport', () => {
		expect(openSavedView({ k: 1, x: -300, y: 10 }, 2000, 800, 1200, 700)).toEqual({ k: 1, x: -300, y: 10 });
	});
	it('centres a zoom-only saved view', () => {
		expect(openSavedView({ k: 0.5, x: null, y: null }, 1000, 800, 1200, 700)).toEqual({ k: 0.5, x: 350, y: 24 });
	});
	it('opens at Fit on a phone when the saved zoom is wider than the viewport', () => {
		const v = openSavedView({ k: 1, x: -300, y: 10 }, 1400, 800, 390, 700);
		expect(v).toEqual(fitView(1400, 800, 390, 700));
		expect(1400 * v.k).toBeLessThanOrEqual(390);
	});
	it('keeps the saved view on a phone when it already fits', () => {
		expect(openSavedView({ k: 0.25, x: 20, y: 10 }, 1400, 800, 390, 700)).toEqual({ k: 0.25, x: 20, y: 10 });
	});
});
