import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { load as templateLoad } from '../src/routes/templates/[id]/+page.server';
import { renderTemplatePreview, type TemplateRow } from '../src/lib/server/templates';
import { sanitizeBlocks, countContentAreas } from '../src/lib/blocks';
import { editorialTemplateBlocks, EDITORIAL_TEMPLATE_NAME } from './fixtures/editorial-template';

// #262: migration 0072 seeds the Editorial builder template (EDITORIAL_TEMPLATE_NAME); #269's 0073
// swaps in the real logos when the row is still the 0072 seed.

const db = (env as any).DB as D1Database;
const migrations = (env as any).TEST_MIGRATIONS as { name: string; queries: string[] }[];
const migration = migrations.find((m) => m.name.startsWith('0072_'))!;
const logoMigration = migrations.find((m) => m.name.startsWith('0073_'))!;
// #270: 0074 adds templates.canvas (applied once by the pool) and rewrites the hero; only
// its UPDATE is re-run here.
const canvasMigration = migrations.find((m) => m.name.startsWith('0074_'))!;
const heroUpdate = { queries: canvasMigration.queries.filter((q) => q.includes('UPDATE templates')) };

async function run(m: { queries: string[] }) {
	for (const q of m.queries) await db.prepare(q).run();
}
async function runSeed() {
	await run(migration);
	await run(logoMigration);
	await run(heroUpdate);
}
const rows = () => db.prepare('SELECT * FROM templates WHERE name = ?').bind(EDITORIAL_TEMPLATE_NAME).all<TemplateRow & { id: number }>();

beforeEach(async () => {
	await db.prepare('DELETE FROM templates').run();
});

describe('Editorial template seed', () => {
	it('exists as migrations 0072 + 0073', () => {
		expect(migration?.name).toBe('0072_editorial_template.sql');
		expect(logoMigration?.name).toBe('0073_editorial_template_logo.sql');
		expect(canvasMigration?.name).toBe('0074_template_canvas.sql');
		expect(heroUpdate.queries).toHaveLength(1);
	});

	it('0074 turns the 0073 hero into a 2-column row, and leaves an edited row alone', async () => {
		await run(migration);
		await run(logoMigration);
		await run(heroUpdate);
		await run(heroUpdate);
		const after = (await rows()).results[0].blocks!;
		expect(after).toContain('"id":"ed-hero-row","type":"columns"');
		expect(after).toContain('"stack":false');

		await db.prepare('DELETE FROM templates').run();
		await run(migration);
		await run(logoMigration);
		const edited = (await rows()).results[0].blocks!.replace('Campaign label', 'My label');
		await db.prepare('UPDATE templates SET blocks = ? WHERE name = ?').bind(edited, EDITORIAL_TEMPLATE_NAME).run();
		await run(heroUpdate);
		expect((await rows()).results[0].blocks).toBe(edited);
	});

	it('0073 moves the 0072 seed to the real logos and guideline warm ink', async () => {
		await run(migration);
		const before = (await rows()).results[0].blocks!;
		expect(before).toContain('icon-512.png');
		await run(logoMigration);
		await run(logoMigration);
		const after = (await rows()).results[0].blocks!;
		expect(after).not.toContain('icon-512.png');
		expect(after).not.toContain('"beside"');
		expect(after).toContain('"bg":"#15130e"');
		expect(after).toContain('logo-white.png","alt":"Ourco","href":"https://ourco.example","width":180');
		expect(after).toContain('logomark.png');
	});

	it('0073 leaves an edited row alone', async () => {
		await run(migration);
		const edited = (await rows()).results[0].blocks!.replace('Campaign label', 'My label');
		await db.prepare('UPDATE templates SET blocks = ? WHERE name = ?').bind(edited, EDITORIAL_TEMPLATE_NAME).run();
		await run(logoMigration);
		expect((await rows()).results[0].blocks).toBe(edited);
	});

	it('inserts the template once, however often it runs', async () => {
		await runSeed();
		await runSeed();
		await runSeed();
		const { results } = await rows();
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ kind: 'builder', use_global_header: 0, use_global_footer: 1 });
	});

	it('does not touch an existing template with that name', async () => {
		await db.prepare("INSERT INTO templates (name, kind, blocks) VALUES (?, 'builder', '[]')").bind(EDITORIAL_TEMPLATE_NAME).run();
		await runSeed();
		const { results } = await rows();
		expect(results).toHaveLength(1);
		expect(results[0].blocks).toBe('[]');
	});

	it('stores exactly editorialTemplateBlocks() after 0074, already sanitised', async () => {
		await runSeed();
		const stored = JSON.parse((await rows()).results[0].blocks!);
		expect(stored).toEqual(sanitizeBlocks(editorialTemplateBlocks()));
		expect(sanitizeBlocks(stored)).toEqual(stored);
		expect(countContentAreas(stored)).toBe(1);
	});

	it('opens in the template editor with every design block', async () => {
		await runSeed();
		const id = (await rows()).results[0].id;
		const url = new URL(`https://app.test/templates/${id}`);
		const loaded = (await templateLoad({ platform: { env: { ...(env as any), PUBLIC_BASE_URL: 'https://app.test' } }, params: { id: String(id) }, url, request: new Request(url) } as any)) as any;
		const json = JSON.stringify(loaded.template.blocks);
		for (const needle of ['"type":"section"', '"type":"eyebrow"', '"size":"display"', '"type":"milestones"', '"style":"steps"', '"linkLabel"', '"style":"chip"', '"type":"content"']) {
			expect(json).toContain(needle);
		}
	});

	it('previews as a table-based email with the mobile media query', async () => {
		await runSeed();
		const row = (await rows()).results[0];
		const html = await renderTemplatePreview(db, row);
		expect(html).toContain('bgcolor="#15130e"');
		expect(html).toContain('bgcolor="#1a9ec4"');
		expect(html).toContain('class="ds-display"');
		expect(html).toContain('@media (max-width:480px)');
		expect(html).toContain('https://ourco.example/book/');
		expect(html).not.toContain('%%CONTENT_AREA%%');
	});
});

// From design-blocks.test.ts (#262), which moved to @digisavvy/block-editor (#558). The
// editor-schema half of the check (blocksToDoc → schema.check) is not here: the editor
// document is package-internal.
describe('editorial template blocks', () => {
	it('are valid and stable, with one content area', () => {
		const blocks = editorialTemplateBlocks();
		expect(sanitizeBlocks(blocks)).toEqual(blocks);
		expect(countContentAreas(blocks)).toBe(1);
	});
});
