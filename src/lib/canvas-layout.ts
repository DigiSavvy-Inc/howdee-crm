// Automation canvas layout (#218) — pure subtree-width layout shared by the builder page
// and tests. Heights stay with CSS (the flow is a vertical column); this decides widths
// and horizontal offsets so nested branches widen their parent lane instead of
// overflowing it.

import { stepHasLanes } from './automation-flow';

export interface LayoutConstants {
	/** Card width for trunk steps. */
	cardWidth: number;
	/** Card width for steps inside a lane (any depth). */
	laneCardWidth: number;
	/** A lane is never narrower than this. */
	minLaneWidth: number;
	/** Horizontal padding + border on each side of a lane's content. */
	lanePad: number;
	/** Gap between sibling lanes. */
	laneGap: number;
}

export const LAYOUT: LayoutConstants = {
	cardWidth: 340,
	laneCardWidth: 280,
	minLaneWidth: 240,
	lanePad: 12,
	laneGap: 20
};

/** A step and, for a condition / split, its lanes (each an ordered list of steps). */
export interface LayoutStep {
	id: number;
	lanes?: LayoutStep[][];
}

export interface LaneLayout {
	/** Left edge relative to the branch group's left edge. */
	x: number;
	width: number;
	/** Horizontal centre relative to the branch group's left edge. */
	center: number;
}

export interface BranchLayout {
	/** Width of the whole branch group (card + lanes + connectors). */
	width: number;
	lanes: LaneLayout[];
}

/** A lane in absolute canvas coordinates (x from the flow's left edge). */
export interface LaneBox {
	parentId: number;
	index: number;
	depth: number;
	x: number;
	width: number;
}

export interface FlowLayout {
	width: number;
	/** Per step: absolute left edge + width of the step's subtree column. */
	nodes: Map<number, { x: number; width: number }>;
	branches: Map<number, BranchLayout>;
	lanes: LaneBox[];
}

function cardW(depth: number, c: LayoutConstants): number {
	return depth === 0 ? c.cardWidth : c.laneCardWidth;
}

/** Width a step (and everything under it) needs. */
export function measureStep(s: LayoutStep, depth: number, c: LayoutConstants = LAYOUT): number {
	const card = cardW(depth, c);
	if (!s.lanes || s.lanes.length === 0) return card;
	return Math.max(card, lanesWidth(s.lanes, depth + 1, c));
}

/** Width one lane needs: its widest step plus padding, never below the minimum. */
export function measureLane(steps: LayoutStep[], depth: number, c: LayoutConstants = LAYOUT): number {
	const inner = steps.reduce((m, s) => Math.max(m, measureStep(s, depth, c)), 0);
	return Math.max(c.minLaneWidth, inner + 2 * c.lanePad);
}

function lanesWidth(lanes: LayoutStep[][], depth: number, c: LayoutConstants): number {
	const sum = lanes.reduce((t, l) => t + measureLane(l, depth, c), 0);
	return sum + c.laneGap * Math.max(0, lanes.length - 1);
}

/** Width of a flow (trunk or lane content): its widest step. */
export function measureFlow(steps: LayoutStep[], depth = 0, c: LayoutConstants = LAYOUT): number {
	return steps.reduce((m, s) => Math.max(m, measureStep(s, depth, c)), 0);
}

/**
 * Lay out the trunk. Every step is centred in its containing column (the trunk, or a
 * lane's content box); a branch's lanes are centred under it, side by side.
 */
export function layoutFlow(trunk: LayoutStep[], c: LayoutConstants = LAYOUT): FlowLayout {
	const out: FlowLayout = { width: 0, nodes: new Map(), branches: new Map(), lanes: [] };
	const width = Math.max(measureFlow(trunk, 0, c), c.cardWidth);
	out.width = width;
	placeFlow(trunk, 0, 0, width, c, out);
	return out;
}

function placeFlow(steps: LayoutStep[], depth: number, left: number, colW: number, c: LayoutConstants, out: FlowLayout) {
	for (const s of steps) {
		const w = measureStep(s, depth, c);
		const x = left + (colW - w) / 2;
		out.nodes.set(s.id, { x, width: w });
		if (!s.lanes || s.lanes.length === 0) continue;
		const widths = s.lanes.map((l) => measureLane(l, depth + 1, c));
		const total = widths.reduce((t, v) => t + v, 0) + c.laneGap * (widths.length - 1);
		let lx = (w - total) / 2;
		const lanes: LaneLayout[] = [];
		s.lanes.forEach((lane, i) => {
			const lw = widths[i];
			lanes.push({ x: lx, width: lw, center: lx + lw / 2 });
			out.lanes.push({ parentId: s.id, index: i, depth: depth + 1, x: x + lx, width: lw });
			placeFlow(lane, depth + 1, x + lx + c.lanePad, lw - 2 * c.lanePad, c, out);
			lx += lw + c.laneGap;
		});
		out.branches.set(s.id, { width: w, lanes });
	}
}

/** Build the layout tree from the flat step rows (branch lanes are YES then NO; #397: an
 *  event wait's lanes are "Did it" then "Timed out"). */
export function treeFromSteps(
	steps: { id: number; type: string; parent_step_id: number | null; branch_label: string | null; wait_config?: string | null }[]
): LayoutStep[] {
	const build = (parent: number | null, label: string | null): LayoutStep[] =>
		steps
			.filter((s) => s.parent_step_id === parent && (parent === null || s.branch_label === label))
			.map((s) => (stepHasLanes(s) ? { id: s.id, lanes: [build(s.id, 'yes'), build(s.id, 'no')] } : { id: s.id }));
	return build(null, null);
}

/** SVG path from (fromX, 0) curving down to (toX, h) — the fork and the re-join. */
export function forkPath(fromX: number, toX: number, h: number): string {
	return `M ${fromX} 0 C ${fromX} ${h * 0.6}, ${toX} ${h * 0.4}, ${toX} ${h}`;
}
