// Ask AI in the editor (#679): the vocabulary the popover (AskAiPopover.svelte) and the
// server (server/ai/editor-ask*.ts) share. Universal and pure: no DOM, no database.
//
// #680 adds write mode: with no selection (the slash menu's Ask AI) it writes new blocks at
// the cursor from a prompt or one of the WRITE_STARTERS.
//
// The popover sends the selection (blocks + inline runs), the document, the target and one
// quick action or a prompt to POST /api/assistant/editor; the answer streams back as the
// model's partial tool JSON (`text` events, read with `readPartialResult` for the live
// preview) and ends with `done` carrying the validated result, or `error`.

import type { Block, Inline } from '$lib/blocks';
import { blocksToMarkdown } from '$lib/blocks-markdown';

export const EDITOR_ASK_TOOL = 'editor_ask';

export type EditorTarget = 'email' | 'page';
export const EDITOR_TARGETS: readonly EditorTarget[] = ['email', 'page'];
export const isEditorTarget = (v: unknown): v is EditorTarget => v === 'email' || v === 'page';

export type AskQuick =
	| 'improve'
	| 'fix'
	| 'shorter'
	| 'longer'
	| 'simplify'
	| 'tone_friendly'
	| 'tone_professional'
	| 'tone_direct'
	| 'bulleted_list'
	| 'numbered_list'
	| 'heading_paragraphs'
	| 'button'
	| 'translate';

export type QuickGroup = 'edit' | 'tone' | 'turn' | 'translate';

/** The popover's quick actions, in display order (grouped). */
export const ASK_QUICK: { id: AskQuick; label: string; group: QuickGroup }[] = [
	{ id: 'improve', label: 'Improve writing', group: 'edit' },
	{ id: 'fix', label: 'Fix spelling and grammar', group: 'edit' },
	{ id: 'shorter', label: 'Make shorter', group: 'edit' },
	{ id: 'longer', label: 'Make longer', group: 'edit' },
	{ id: 'simplify', label: 'Simplify', group: 'edit' },
	{ id: 'tone_friendly', label: 'Friendly', group: 'tone' },
	{ id: 'tone_professional', label: 'Professional', group: 'tone' },
	{ id: 'tone_direct', label: 'Direct', group: 'tone' },
	{ id: 'bulleted_list', label: 'Bulleted list', group: 'turn' },
	{ id: 'numbered_list', label: 'Numbered list', group: 'turn' },
	{ id: 'heading_paragraphs', label: 'Heading and paragraphs', group: 'turn' },
	{ id: 'button', label: 'Button', group: 'turn' },
	{ id: 'translate', label: 'Translate', group: 'translate' }
];

export const QUICK_GROUP_LABELS: Record<QuickGroup, string> = { edit: 'Edit', tone: 'Change tone', turn: 'Turn into', translate: 'Translate' };

export const isAskQuick = (v: unknown): v is AskQuick => typeof v === 'string' && ASK_QUICK.some((q) => q.id === v);
export const quickLabel = (q: AskQuick): string => ASK_QUICK.find((x) => x.id === q)?.label ?? q;

/** The short language list under Translate; "Other…" takes a typed name. */
export const TRANSLATE_LANGUAGES = ['Spanish', 'French', 'German', 'Portuguese', 'Italian'] as const;
export const LANGUAGE_MAX = 40;

/** A typed language name: letters, spaces, hyphens, brackets only (it goes into the prompt). */
export function cleanLanguage(v: unknown): string {
	if (typeof v !== 'string') return '';
	const s = v.replace(/\s+/g, ' ').trim().slice(0, LANGUAGE_MAX);
	return /^[\p{L}][\p{L} ()'-]*$/u.test(s) ? s : '';
}

// ---- #680: write mode (no selection; new blocks at the cursor, from the slash menu) ----

/** `edit` = #679 (rewrite the selection); `write` = #680 (write new blocks at the cursor). */
export type AskMode = 'edit' | 'write';
export const isAskMode = (v: unknown): v is AskMode => v === 'edit' || v === 'write';

/** The subject line sent with a write request (the rest is cut). */
export const SUBJECT_MAX = 200;

export type WriteStarter = 'intro' | 'cta' | 'outline' | 'continue' | 'summarise';

/** The write popover's starters, in display order. `prompt` is what is sent as the request;
 *  `needsAbove` = only offered when something sits above the cursor. `{doc}` = email / page. */
export const WRITE_STARTERS: { id: WriteStarter; label: string; prompt: string; needsAbove: boolean }[] = [
	{ id: 'intro', label: 'Write an intro', prompt: 'Write a short introduction that opens this {doc}: one or two short paragraphs.', needsAbove: false },
	{
		id: 'cta',
		label: 'Write a call to action',
		prompt: 'Write a call to action: one short sentence that says what to do next, then one button with a 2–5 word label.',
		needsAbove: false
	},
	{ id: 'outline', label: 'Outline this {doc}', prompt: 'Write an outline of this {doc}: section headings (level 2), each with a few short bullets.', needsAbove: false },
	{
		id: 'continue',
		label: 'Continue writing',
		prompt: 'Continue writing from where the content before the cursor ends, in the same voice and format. Do not repeat what is already there.',
		needsAbove: true
	},
	{
		id: 'summarise',
		label: 'Summarise the {doc} above',
		prompt: 'Summarise the content before the cursor in a short paragraph or a few bullets. Only use what is there.',
		needsAbove: true
	}
];

const docWord = (target: EditorTarget) => (target === 'page' ? 'page' : 'email');
export const starterLabel = (s: { label: string }, target: EditorTarget): string => s.label.replace('{doc}', docWord(target));
export const starterPrompt = (s: { prompt: string }, target: EditorTarget): string => s.prompt.replace(/\{doc\}/g, docWord(target));

/** Is there anything above the cursor (`cursor` top-level blocks; null = the whole document)?
 *  Continue writing and Summarise need it. A block counts when it has text, or is an image,
 *  button or divider; an empty paragraph doesn't. */
export function hasContentBefore(doc: Block[], cursor: number | null): boolean {
	const before = cursor == null ? doc : doc.slice(0, Math.max(0, cursor));
	return blocksToMarkdown(before).trim() !== '';
}

export const PROMPT_MAX = 1000;
/** The selection's cap: above this many words the request is refused. */
export const SELECTION_WORDS_MAX = 4000;
/** The document context's cap, in estimated tokens (chars ÷ 4); the selection is always whole. */
export const DOCUMENT_TOKEN_CAP = 6000;
/** The request body's cap (bytes of JSON). */
export const BODY_BYTES_MAX = 600_000;

export const TOO_LONG_MESSAGE = `That selection is too long for Ask AI (over ${SELECTION_WORDS_MAX.toLocaleString('en-US')} words). Select a shorter part.`;
export const EDITOR_ASK_OFF_MESSAGE = 'Ask AI in the editor is turned off in Settings → Assistant → Permissions.';

export function countWords(s: string): number {
	const t = s.trim();
	return t ? t.split(/\s+/).length : 0;
}

/** What the server returns once the result passed every check. */
export type AskResult = { shape: 'inline'; inline: Inline[] } | { shape: 'blocks'; blocks: Block[] };

export type AskEvent =
	| { type: 'text'; text: string }
	| { type: 'done'; action_id: number; model: string; result: AskResult; notes: string[]; tokens: number; cost_micros: number }
	| { type: 'error'; message: string; reason?: 'rejected' | 'timeout' | 'failed' };

/** Why the endpoint refused before streaming, from the JSON error's `reason`. */
export type AskRefusal = 'no_key' | 'disabled' | 'not_allowed' | 'cap' | 'too_long' | 'bad_request';

// ---- partial tool JSON (the live preview) ----

/**
 * Best-effort parse of a JSON prefix: closes an open string, drops a dangling key / comma /
 * colon and closes open arrays and objects. Null when nothing usable can be read yet.
 */
export function parsePartialJson(src: string): unknown {
	const s = src.trim();
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		/* repair below */
	}
	type Ctx = { close: '}' | ']'; expectKey: boolean };
	const stack: Ctx[] = [];
	const closers = () => stack.map((c) => c.close).reverse().join('');
	// The last point where everything before it is complete, and the closers it needs.
	let safe = -1;
	let safeClose = '';
	const mark = (end: number) => {
		safe = end;
		safeClose = closers();
	};
	let inStr = false;
	let esc = false;
	let strIsKey = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === '\\') esc = true;
			else if (ch === '"') {
				inStr = false;
				if (!strIsKey) mark(i + 1);
			}
			continue;
		}
		const top = stack[stack.length - 1];
		if (ch === '"') {
			inStr = true;
			strIsKey = !!top && top.close === '}' && top.expectKey;
		} else if (ch === '{' || ch === '[') {
			stack.push({ close: ch === '{' ? '}' : ']', expectKey: ch === '{' });
			mark(i + 1);
		} else if (ch === '}' || ch === ']') {
			stack.pop();
			mark(i + 1);
		} else if (ch === ':') {
			if (top) top.expectKey = false;
		} else if (ch === ',') {
			if (top && top.close === '}') top.expectKey = true;
		} else if (!/\s/.test(ch)) {
			// A number or literal: complete once a delimiter follows it.
			let j = i;
			while (j < s.length && !/[\s,\]}:]/.test(s[j])) j++;
			if (j < s.length) mark(j);
			i = j - 1;
		}
	}
	const tries: string[] = [];
	// An open string value: close it, so its text shows while it streams.
	if (inStr && !strIsKey) tries.push(s.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '') + '"' + closers());
	if (safe >= 0) tries.push(s.slice(0, safe) + safeClose);
	for (const t of tries) {
		try {
			return JSON.parse(t);
		} catch {
			/* next */
		}
	}
	return null;
}

/** The streamed tool input so far, as preview content (unvalidated — the preview sanitises it). */
export function readPartialResult(json: string): { inline?: unknown[]; blocks?: unknown[] } | null {
	const v = parsePartialJson(json);
	if (!v || typeof v !== 'object') return null;
	const r = v as Record<string, unknown>;
	if (Array.isArray(r.blocks)) return { blocks: r.blocks };
	if (Array.isArray(r.inline)) return { inline: r.inline };
	return null;
}
