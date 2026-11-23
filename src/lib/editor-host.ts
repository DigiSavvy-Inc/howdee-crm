// #558: the app's side of the block editor (@digisavvy/block-editor). Every BlockEditor
// call site passes `upload={uploadMedia}`, `brandLogos={editorLogos(data.brandKit)}` and
// `swatches={editorSwatches(data.brandKit)}` (the brand kit, #595, $lib/brand-kit).
// #679: `selectionActions={editorActions(target, data.editorAsk)}` adds Ask AI to the
// selection bubble (one helper, so each call site passes one prop).
// #680: `slashActions={editorSlashActions(target, data.editorAsk[, () => subject])}` adds Ask AI
// to the slash menu (write new content at the cursor).
import type { ImageUpload, SelectionAction, SelectionContext, SlashHostAction } from '@digisavvy/block-editor';
import { SUBJECT_MAX, type AskMode, type EditorTarget } from '$lib/editor-ask';
import { ASK_AI_SHORTCUT } from '$lib/shortcuts';

const UPLOAD_FAILED = 'Upload failed.';

/** Stores an image in the media bucket (POST /api/media) and resolves to its public URL.
 *  Rejects with the endpoint's error message (e.g. "file too large (5 MB max)"), else
 *  "Upload failed."; the editor shows it under the Design panel's upload button. The
 *  editor has already converted an AVIF file to WebP / JPEG before calling this. */
export const uploadMedia: ImageUpload = async (file) => {
	const fd = new FormData();
	fd.append('file', file);
	let res: Response;
	let j: { url?: string; error?: string } | null;
	try {
		res = await fetch('/api/media', { method: 'POST', body: fd });
		j = (await res.json()) as typeof j;
	} catch {
		throw new Error(UPLOAD_FAILED);
	}
	if (!res.ok || !j?.url) throw new Error(j?.error || UPLOAD_FAILED);
	return j.url;
};

// ---- #679: host actions (the selection bubble; #680 adds a slash-menu entry here) ----

/** Where the popover goes, in viewport px: under the selection (`top`, `left`) and the
 *  selection's own top edge (`selTop`, to flip above it when there's no room below). */
export type AskAiPlace = { top: number; left: number; selTop: number };
/** `mode` edit = the selection bubble (#679); write = the slash menu (#680): no selection,
 *  `cursor` = how many top-level blocks sit before the caret (null = unknown → the end),
 *  `subject` = the page's subject line, when it has one. */
export type AskAiOpen = { ctx: SelectionContext; target: EditorTarget; place: AskAiPlace; mode: AskMode; cursor: number | null; subject: string };

let askAiOpener: ((o: AskAiOpen) => void) | null = null;

/** The Ask AI popover (mounted once in the root layout) registers here; returns the unregister. */
export function registerAskAi(fn: (o: AskAiOpen) => void): () => void {
	askAiOpener = fn;
	return () => {
		if (askAiOpener === fn) askAiOpener = null;
	};
}

type Rect = { top: number; left: number; bottom: number };
type HasRect = { getBoundingClientRect(): Rect };

/** The selection in viewport coordinates. `ctx.anchor` is relative to the editor canvas the
 *  action came from: the canvas holding the focused element (the bubble's button, or the text
 *  for the shortcut); without one, the browser's own selection range. */
export function askAiPlace(
	anchor: SelectionContext['anchor'],
	active: { closest(sel: string): HasRect | null } | null,
	range: HasRect | null
): AskAiPlace {
	const canvas = active?.closest('.be-canvas');
	if (canvas) {
		const r = canvas.getBoundingClientRect();
		return { top: r.top + anchor.bottom, left: r.left + anchor.left, selTop: r.top + anchor.top };
	}
	if (range) {
		const r = range.getBoundingClientRect();
		return { top: r.bottom, left: r.left, selTop: r.top };
	}
	return { top: 120, left: 16, selTop: 120 };
}

/**
 * The host actions every BlockEditor call site passes as `selectionActions`. `askAi` is the
 * layout's `editorAsk` (the setting is on and this person has assistant access); without it
 * there's no Ask AI button and no shortcut. `target` = the editor's target (a page gets no
 * merge tags).
 */
export function editorActions(target: EditorTarget, askAi: boolean | null | undefined): SelectionAction[] {
	if (!askAi) return [];
	return [
		{
			id: 'ask-ai',
			label: 'Ask AI',
			icon: 'sparkle',
			// The editor adds the shortcut's label to the tooltip itself.
			title: 'Ask AI to edit the selection',
			shortcut: ASK_AI_SHORTCUT,
			onSelect(ctx) {
				if (!askAiOpener) return ctx.close();
				const active = typeof document === 'undefined' ? null : document.activeElement;
				const sel = typeof window === 'undefined' ? null : window.getSelection();
				const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
				askAiOpener({ ctx, target, place: askAiPlace(ctx.anchor, active, range), mode: 'edit', cursor: null, subject: '' });
			}
		}
	];
}

// ---- #680: the slash menu's Ask AI (write new content at the cursor) ----

/** The bits of a DOM node `caretBlockIndex` reads (a real Node, or a stand-in in tests). */
export type DomLike = {
	parentNode: DomLike | null;
	previousElementSibling?: DomLike | null;
	classList?: { contains(c: string): boolean };
	className?: unknown;
};

/** ProseMirror's own widgets at the top level (the gap cursor) are no blocks. */
function isWidget(el: DomLike): boolean {
	const cls = typeof el.className === 'string' ? el.className : '';
	return /(^|\s)ProseMirror-/.test(cls);
}

/**
 * How many top-level blocks sit before the one holding `node` (the caret), inside `root` (the
 * editor's `.ProseMirror` element). Each top-level block of the document is one element child
 * of the root (the package's schema renders one element per block node: a paragraph `<p>`, a
 * list `<ul>`, a section or columns `<div>`); only ProseMirror's widgets (`ProseMirror-…`
 * classes, e.g. the gap cursor) are skipped. A caret inside a section or a column counts the
 * section / columns block. Null when `node` isn't inside `root`.
 */
export function caretBlockIndex(root: DomLike | null, node: DomLike | null): number | null {
	if (!root || !node) return null;
	let top: DomLike | null = node;
	while (top && top.parentNode !== root) top = top.parentNode;
	if (!top) return null;
	let n = 0;
	for (let el = top.previousElementSibling ?? null; el; el = el.previousElementSibling ?? null) if (!isWidget(el)) n++;
	return n;
}

/** The caret's top-level block index in the editor the slash action came from (null if unknown). */
function caretCursor(): number | null {
	if (typeof window === 'undefined') return null;
	const sel = window.getSelection();
	const node = sel?.anchorNode ?? null;
	if (!node) return null;
	const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
	const root = el?.closest('.be-canvas .ProseMirror') ?? null;
	return caretBlockIndex(root as unknown as DomLike | null, node as unknown as DomLike);
}

/**
 * The host actions every BlockEditor call site passes as `slashActions`: **Ask AI** in the slash
 * menu (type `/ai`), which writes new blocks at the cursor. `[]` when Ask AI isn't allowed (same
 * gate as `editorActions`). `subject`, where the page has a subject line, is read when the action
 * opens (≤ 200 characters).
 */
export function editorSlashActions(target: EditorTarget, askAi: boolean | null | undefined, subject?: () => string | null | undefined): SlashHostAction[] {
	if (!askAi) return [];
	return [
		{
			id: 'ask-ai-write',
			label: 'Ask AI',
			icon: 'sparkle',
			title: 'Write with a prompt',
			onSelect(ctx) {
				if (!askAiOpener) return ctx.close();
				const active = typeof document === 'undefined' ? null : document.activeElement;
				const sel = typeof window === 'undefined' ? null : window.getSelection();
				const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
				const subj = (subject?.() ?? '').replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX);
				askAiOpener({ ctx, target, place: askAiPlace(ctx.anchor, active, range), mode: 'write', cursor: caretCursor(), subject: subj });
			}
		}
	];
}
