// #558: the block editor comes from @digisavvy/block-editor. These cover the app's side:
// the shared upload function, the wiring at every BlockEditor call site, the stylesheet and
// token order, the $lib shims, and the contract the app's CSS relies on in the installed
// editor (Write mode stamp, dialog check, localStorage keys, host layout tokens).
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pkg from '@digisavvy/block-editor/blocks';
import * as blocks from '../src/lib/blocks';
import * as blocksMarkdown from '../src/lib/blocks-markdown';
import * as mergeTags from '../src/lib/merge-tags';
import * as conditionals from '../src/lib/conditionals';
import * as imageConvert from '../src/lib/image-convert';
import { autoTextColor, contrastRatio, normalizeHex, MIN_CONTRAST } from '../src/lib/brand';
import { uploadMedia } from '../src/lib/editor-host';
import editorRaw from '../node_modules/@digisavvy/block-editor/dist/components/BlockEditor.svelte?raw';
import panelRaw from '../node_modules/@digisavvy/block-editor/dist/components/DesignPanel.svelte?raw';
import writeModeRaw from '../node_modules/@digisavvy/block-editor/dist/editor/write-mode.js?raw';
import writePrefsRaw from '../node_modules/@digisavvy/block-editor/dist/write-prefs.js?raw';
import layoutRaw from '../src/routes/+layout.svelte?raw';

const sites = import.meta.glob(
	[
		'../src/routes/compose/+page.svelte',
		'../src/routes/campaign/[[]id]/archive/+page.svelte',
		'../src/routes/templates/[[]id]/+page.svelte',
		'../src/routes/templates/global/+page.svelte',
		'../src/routes/pages/[[]id]/+page.svelte',
		'../src/routes/automations/[[]id]/+page.svelte'
	],
	{ query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

describe('uploadMedia', () => {
	afterEach(() => vi.unstubAllGlobals());

	function stub(impl: (url: string, init: RequestInit) => Promise<Response>) {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return impl(url, init);
		});
		return calls;
	}
	const file = () => new File(['png'], 'a.png', { type: 'image/png' });

	it('posts the file as `file` to /api/media and resolves to the URL', async () => {
		const calls = stub(async () => Response.json({ ok: true, url: 'https://app.test/img/k.png', key: 'k.png' }));
		await expect(uploadMedia(file())).resolves.toBe('https://app.test/img/k.png');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('/api/media');
		expect(calls[0].init.method).toBe('POST');
		const sent = (calls[0].init.body as FormData).get('file') as File;
		expect(sent.name).toBe('a.png');
	});

	it("rejects with the endpoint's error message", async () => {
		stub(async () => Response.json({ error: 'file too large (5 MB max)' }, { status: 413 }));
		await expect(uploadMedia(file())).rejects.toThrow('file too large (5 MB max)');
	});

	it('rejects with "Upload failed." on a network error, a non-JSON reply or no URL', async () => {
		stub(async () => {
			throw new TypeError('Failed to fetch');
		});
		await expect(uploadMedia(file())).rejects.toThrow(/^Upload failed\.$/);
		stub(async () => new Response('<html>502</html>', { status: 502 }));
		await expect(uploadMedia(file())).rejects.toThrow(/^Upload failed\.$/);
		stub(async () => Response.json({ ok: true }));
		await expect(uploadMedia(file())).rejects.toThrow(/^Upload failed\.$/);
		stub(async () => Response.json(null));
		await expect(uploadMedia(file())).rejects.toThrow(/^Upload failed\.$/);
	});
});

describe('call sites', () => {
	it('all six pages import the package editor and pass upload, brand logos and swatches', () => {
		expect(Object.keys(sites)).toHaveLength(6);
		let tags = 0;
		for (const [file, src] of Object.entries(sites)) {
			expect(src, file).toContain("import BlockEditor from '@digisavvy/block-editor';");
			expect(src, file).toContain("import { uploadMedia } from '$lib/editor-host';");
			expect(src, file).toContain("import { editorLogos, editorSwatches } from '$lib/brand-kit';");
			for (const tag of src.match(/<BlockEditor\b[\s\S]*?\/>/g) ?? []) {
				tags++;
				expect(tag, file).toContain('upload={uploadMedia}');
				expect(tag, file).toContain('brandLogos={editorLogos(data.brandKit)}');
				expect(tag, file).toContain('swatches={editorSwatches(data.brandKit)}');
			}
		}
		expect(tags).toBe(8);
	});

	// #595: the brand logos and swatches are the install's brand kit now — see
	// tests/brand-kit-595.test.ts (the seed keeps the old logos, alt text and palette).
});

describe('styles', () => {
	it('the root layout imports the editor stylesheet once, before app.css', () => {
		const a = layoutRaw.indexOf("import '@digisavvy/block-editor/styles.css';");
		expect(a).toBeGreaterThan(-1);
		expect(layoutRaw.indexOf("import '../app.css';")).toBeGreaterThan(a);
		expect(layoutRaw.split('@digisavvy/block-editor/styles.css')).toHaveLength(2);
	});

	// app.css's `--header-h / --sticky-actions-*: initial` reset is not read here: Vitest
	// blanks CSS imports (as in status-notice-427). Checked in the browser.
});

describe('$lib shims', () => {
	it('re-export the package implementation (one copy of each function)', () => {
		expect(blocks.renderBlocksEmailHtml).toBe(pkg.renderBlocksEmailHtml);
		expect(blocks.sanitizeBlocks).toBe(pkg.sanitizeBlocks);
		expect(blocksMarkdown.markdownToBlocks).toBe(pkg.markdownToBlocks);
		expect(mergeTags.applyMergeTokens).toBe(pkg.applyMergeTokens);
		expect(conditionals.evaluateConditionals).toBe(pkg.evaluateConditionals);
		expect(imageConvert.convertFileInput).toBe(pkg.convertFileInput);
		expect(normalizeHex).toBe(pkg.normalizeHex);
		expect(contrastRatio).toBe(pkg.contrastRatio);
		expect(autoTextColor).toBe(pkg.autoTextColor);
		expect(MIN_CONTRAST).toBe(4.5);
	});
});

describe('installed editor contract', () => {
	it('stamps <html data-write-mode> (the layout and the assistant button key on it)', () => {
		expect(writeModeRaw).toContain('data-write-mode');
		expect(writeModeRaw).toContain('data-write-mode-exit');
		expect(layoutRaw).toContain(':global(html[data-write-mode]) #app-nav');
	});

	it("treats the app's help and assistant panels as dialogs for Escape", () => {
		expect(editorRaw).toMatch(/querySelectorAll\('dialog\[open\], \[role="dialog"\], \[aria-modal="true"\], \.hp-panel, \.ap'\)/);
	});

	it('keeps the localStorage keys, so saved preferences survive', () => {
		expect(writeModeRaw).toContain("'ds-write-mode'");
		expect(writePrefsRaw).toContain("'ds-write-prefs'");
		expect(panelRaw).toContain("'ds-design-groups'");
	});
});
