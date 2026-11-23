import { describe, it, expect } from 'vitest';
import { LAYOUT, forkPath, layoutFlow, measureLane, treeFromSteps, type FlowLayout, type LaneBox, type LayoutStep } from '../src/lib/canvas-layout';

const C = LAYOUT;
const laneMin = Math.max(C.minLaneWidth, C.laneCardWidth + 2 * C.lanePad);

function overlaps(a: LaneBox, b: LaneBox): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width;
}
function contains(outer: LaneBox, inner: LaneBox): boolean {
	return inner.x >= outer.x + C.lanePad - 1e-9 && inner.x + inner.width <= outer.x + outer.width - C.lanePad + 1e-9;
}
/**
 * Lanes are drawn as rectangles. Two lanes can only share vertical space when they are
 * siblings, or one is nested inside the other — so: siblings must be disjoint, nested
 * lanes must sit inside their ancestor lane, and a nested lane must not touch any lane
 * that isn't its ancestor at the ancestor's level.
 */
function assertNoIntersections(l: FlowLayout) {
	const laneOfStep = new Map<number, LaneBox>();
	const findParentLane = (parentId: number): LaneBox | undefined => laneOfStep.get(parentId);
	// Index which lane each step lives in, by re-walking: a lane contains a node when
	// the node's column is horizontally inside it and the lane is the deepest such.
	for (const [id, n] of l.nodes) {
		let best: LaneBox | undefined;
		for (const ln of l.lanes) {
			if (ln.parentId === id) continue;
			if (n.x >= ln.x && n.x + n.width <= ln.x + ln.width && (!best || ln.depth > best.depth)) best = ln;
		}
		if (best) laneOfStep.set(id, best);
	}
	for (const a of l.lanes) {
		expect(a.x).toBeGreaterThanOrEqual(0);
		expect(a.x + a.width).toBeLessThanOrEqual(l.width + 1e-9);
		const parentLane = findParentLane(a.parentId);
		if (parentLane) expect(contains(parentLane, a)).toBe(true);
		for (const b of l.lanes) {
			if (a === b) continue;
			if (a.parentId === b.parentId) expect(overlaps(a, b)).toBe(false);
			// lanes at the same depth under different parents never overlap either
			if (a.depth === b.depth) expect(overlaps(a, b)).toBe(false);
		}
	}
}

describe('layoutFlow (#218)', () => {
	it('single trunk: every card centred in a card-wide column', () => {
		const l = layoutFlow([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(l.width).toBe(C.cardWidth);
		expect(l.lanes).toEqual([]);
		for (const id of [1, 2, 3]) expect(l.nodes.get(id)).toEqual({ x: 0, width: C.cardWidth });
	});

	it('one condition: two lanes side by side, centred under the card', () => {
		const l = layoutFlow([{ id: 1 }, { id: 2, lanes: [[{ id: 3 }], [{ id: 4 }]] }]);
		const b = l.branches.get(2)!;
		expect(b.lanes).toHaveLength(2);
		expect(b.lanes[0].width).toBe(laneMin);
		expect(b.lanes[1].x).toBe(b.lanes[0].x + b.lanes[0].width + C.laneGap);
		expect(b.width).toBe(2 * laneMin + C.laneGap);
		expect(l.width).toBe(b.width);
		// trunk card sits centred over the fork
		expect(l.nodes.get(1)!.x + C.cardWidth / 2).toBeCloseTo(b.width / 2);
		assertNoIntersections(l);
	});

	it('nested condition in the NO lane (the screenshot case) widens the parent lane', () => {
		// Wait → Email → Wait → Condition{ YES: End; NO: Email → Wait → Condition{ YES: End; NO: Tag → End } }
		const tree: LayoutStep[] = [
			{ id: 1 },
			{ id: 2 },
			{ id: 3 },
			{
				id: 4,
				lanes: [[{ id: 5 }], [{ id: 6 }, { id: 7 }, { id: 8, lanes: [[{ id: 9 }], [{ id: 10 }, { id: 11 }]] }]]
			}
		];
		const l = layoutFlow(tree);
		const outer = l.branches.get(4)!;
		const inner = l.branches.get(8)!;
		const outerNo = outer.lanes[1];
		expect(outerNo.width).toBeGreaterThanOrEqual(inner.width + 2 * C.lanePad);
		expect(outer.lanes[0].width).toBe(laneMin);
		// inner lanes live inside the outer NO lane, and clear of the outer YES lane
		const outerYesBox = l.lanes.find((x) => x.parentId === 4 && x.index === 0)!;
		const outerNoBox = l.lanes.find((x) => x.parentId === 4 && x.index === 1)!;
		for (const ln of l.lanes.filter((x) => x.parentId === 8)) {
			expect(contains(outerNoBox, ln)).toBe(true);
			expect(overlaps(outerYesBox, ln)).toBe(false);
		}
		assertNoIntersections(l);
	});

	it('split with 3 lanes', () => {
		const l = layoutFlow([{ id: 1, lanes: [[{ id: 2 }], [{ id: 3 }], [{ id: 4, lanes: [[], []] }]] }]);
		const b = l.branches.get(1)!;
		expect(b.lanes).toHaveLength(3);
		expect(b.lanes[2].width).toBeGreaterThan(b.lanes[0].width);
		expect(b.width).toBe(b.lanes.reduce((t, x) => t + x.width, 0) + 2 * C.laneGap);
		assertNoIntersections(l);
	});

	it('empty lanes still get the minimum lane width', () => {
		expect(measureLane([], 1)).toBe(C.minLaneWidth);
		const l = layoutFlow([{ id: 1, lanes: [[], []] }]);
		const b = l.branches.get(1)!;
		expect(b.lanes.map((x) => x.width)).toEqual([C.minLaneWidth, C.minLaneWidth]);
		// the condition card is wider than two empty lanes → lanes centred under it
		const total = 2 * C.minLaneWidth + C.laneGap;
		expect(b.width).toBe(Math.max(C.cardWidth, total));
		expect(b.lanes[0].x).toBeCloseTo((b.width - total) / 2);
		assertNoIntersections(l);
	});
});

describe('treeFromSteps', () => {
	it('nests branch children as YES then NO lanes, in row order', () => {
		const rows = [
			{ id: 1, type: 'email', parent_step_id: null, branch_label: null },
			{ id: 2, type: 'branch', parent_step_id: null, branch_label: null },
			{ id: 3, type: 'end', parent_step_id: 2, branch_label: 'no' },
			{ id: 4, type: 'email', parent_step_id: 2, branch_label: 'yes' },
			{ id: 5, type: 'tag', parent_step_id: 2, branch_label: 'no' }
		];
		expect(treeFromSteps(rows)).toEqual([{ id: 1 }, { id: 2, lanes: [[{ id: 4 }], [{ id: 3 }, { id: 5 }]] }]);
	});
});

describe('forkPath', () => {
	it('runs from the parent centre down to the lane centre', () => {
		expect(forkPath(100, 40, 20)).toBe('M 100 0 C 100 12, 40 8, 40 20');
	});
});
