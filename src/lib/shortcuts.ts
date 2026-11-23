// Keyboard shortcuts (#572): one label helper for every hint, and the one list the Help
// panel shows. Universal and pure — safe during server rendering (no navigator access
// unless asked for, and `detectMac()` answers false on the server).
//
// A combo is written with `Mod` for the platform's main modifier: Cmd on a Mac, Ctrl on
// Windows and Linux. `keyLabel('Mod+K', true)` → "⌘K", `keyLabel('Mod+K', false)` → "Ctrl+K".
// Every handler for a `Mod+…` shortcut accepts metaKey OR ctrlKey (search alone is strict,
// see `isSearchShortcut`), so the label only decides what we *show*.

/** Apple platform? (from navigator.platform / userAgent). */
export function isMacPlatform(platform: string): boolean {
	return /mac|iphone|ipad|ipod/i.test(platform);
}

/** This computer is a Mac? False on the server and when the browser won't say. */
export function detectMac(): boolean {
	if (typeof navigator === 'undefined') return false;
	const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
	return isMacPlatform(nav.userAgentData?.platform || nav.platform || nav.userAgent || '');
}

const MAC_MODS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
const OTHER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

function normPart(p: string): string {
	const l = p.toLowerCase();
	if (l === 'mod' || l === 'cmd' || l === 'meta') return 'Mod';
	if (l === 'ctrl' || l === 'control') return 'Ctrl';
	if (l === 'alt' || l === 'option') return 'Alt';
	if (l === 'shift') return 'Shift';
	return p.length === 1 ? p.toUpperCase() : p;
}

/** The label for a combo on this platform: "⌘K" / "⇧⌘F" on a Mac, "Ctrl+K" / "Ctrl+Shift+F" elsewhere. */
export function keyLabel(combo: string, mac: boolean): string {
	// '+' as the key itself ("Mod++") survives the split as an empty last part.
	const parts = combo === '+' ? ['+'] : combo.split('+').map((p, i, a) => (p === '' && i === a.length - 1 ? '+' : p)).filter(Boolean);
	const mods = parts.slice(0, -1).map(normPart);
	const key = normPart(parts[parts.length - 1] ?? '');
	if (mac) {
		const sorted = MAC_ORDER.filter((m) => mods.includes(m)).map((m) => MAC_MODS[m]);
		return sorted.join('') + key;
	}
	const sorted = OTHER_ORDER.filter((m) => mods.includes(m)).map((m) => (m === 'Mod' ? 'Ctrl' : m));
	return [...new Set(sorted), key].join('+');
}

export type Shortcut = {
	/** What it does. */
	action: string;
	/** Where it works. */
	where: string;
	/** One or more combos (alternatives), in `keyLabel` syntax. */
	keys: string[];
	/** Shown after the keys, e.g. "outside a text field". */
	note?: string;
};

/** #679: Ask AI on the editor's selection — ⇧⌘Enter on a Mac, Ctrl+Shift+Enter elsewhere. Free
 *  in the app, in the block editor (its own shortcuts: `builtinShortcuts` in the package) and
 *  in Chrome, Safari, Firefox and Edge on both. Registered with the editor as a host-action
 *  shortcut (`$lib/editor-host`). */
export const ASK_AI_SHORTCUT = 'Mod+Shift+Enter';

/** Every shortcut the app itself handles (#572). The block editor's own shortcuts
 *  (formatting, alignment, headings, moving blocks) live in @digisavvy/block-editor. */
export const SHORTCUTS: Shortcut[] = [
	{ action: 'Search', where: 'Anywhere', keys: ['Mod+K'] },
	{ action: 'Search', where: 'Anywhere', keys: ['/'], note: 'outside a text field' },
	{ action: 'Open the result in a new tab', where: 'Search', keys: ['Mod+Enter'] },
	{ action: 'Open or close the assistant', where: 'Anywhere', keys: ['Mod+J'] },
	{ action: 'Write mode on / off', where: 'Email, template and page editors', keys: ['Mod+Shift+F'], note: 'Esc exits' },
	{ action: 'Ask AI about the selected text', where: 'Email, template and page editors', keys: [ASK_AI_SHORTCUT] },
	{ action: 'Save', where: 'Form builder', keys: ['Mod+S'] },
	{ action: 'Send the reply', where: 'Conversations reply box', keys: ['Mod+Enter'] },
	{ action: 'Build the report', where: 'Reports → Describe it', keys: ['Mod+Enter'] },
	{ action: 'Next / previous conversation', where: 'Conversations list', keys: ['J', 'K'] },
	{ action: 'Select the focused conversation', where: 'Conversations list', keys: ['X'] },
	{ action: 'Open the focused conversation', where: 'Conversations list', keys: ['Enter'] },
	{ action: 'Search conversations', where: 'Conversations list', keys: ['/'] },
	{ action: 'Zoom in / out', where: 'Automation canvas', keys: ['+', '-'], note: 'or Mod+scroll' },
	{ action: 'Zoom to 100%', where: 'Automation canvas', keys: ['0'] },
	{ action: 'Pan', where: 'Automation canvas', keys: ['↑', '↓', '←', '→'], note: 'or Space+drag' }
];

/** A note with its `Mod+…` resolved for this platform ("or Mod+scroll" → "or ⌘scroll"). */
function noteText(note: string, mac: boolean): string {
	return note.replace(/\bMod\+([^\s,]+)/g, (_m, rest: string) => keyLabel(`Mod+${rest}`, mac));
}

/** One key cell as plain text: the combos joined with " / ", plus the note in brackets. */
export function shortcutKeysText(s: Shortcut, mac: boolean): string {
	const keys = s.keys.map((k) => keyLabel(k, mac)).join(' / ');
	return s.note ? `${keys} (${noteText(s.note, mac)})` : keys;
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One key cell as HTML: a `<kbd>` per combo (so a combo never breaks, but the list can wrap
 *  between combos), then the note as muted text outside any `<kbd>`. */
export function shortcutKeysHtml(s: Shortcut, mac: boolean): string {
	const keys = s.keys.map((k) => `<kbd>${esc(keyLabel(k, mac))}</kbd>`).join(' / ');
	return s.note ? `${keys} <span class="hp-note">${esc(noteText(s.note, mac))}</span>` : keys;
}

/** The Help panel's table: one row per shortcut, Mac and Windows columns. */
export function shortcutsTableHtml(list: Shortcut[] = SHORTCUTS): string {
	const rows = list
		.map(
			(s) =>
				`<tr><td>${esc(s.action)}<br><span class="hp-where">${esc(s.where)}</span></td><td>${shortcutKeysHtml(s, true)}</td><td>${shortcutKeysHtml(s, false)}</td></tr>`
		)
		.join('');
	return `<table class="hp-keys"><thead><tr><th scope="col">Action</th><th scope="col">Mac</th><th scope="col">Windows</th></tr></thead><tbody>${rows}</tbody></table>`;
}
