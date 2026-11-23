import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import * as kitPage from '../src/routes/settings/brand-kit/+page.server';
import { load as layoutLoad } from '../src/routes/+layout.server';
import {
	BRAND_KIT_KEY,
	NEUTRAL_SWATCHES,
	applyKitOp,
	defaultBrandKit,
	editorLogos,
	editorSwatches,
	normalizeBrandKit,
	type BrandKit
} from '../src/lib/brand-kit';
import { getBrandKit, kitUploadKey, saveBrandKit } from '../src/lib/server/brand-kit';
import { DEFAULT_APP_NAME, DEFAULT_SHORT_NAME } from '../src/lib/branding';
import { getBranding } from '../src/lib/server/branding';
import { builtInBlocks, getArchiveTheme, renderIndexPage, renderWebTemplatePreview, saveArchiveSettings } from '../src/lib/server/newsletter-archive';
import { parseArchiveTheme } from '../src/lib/newsletter-archive';
import { load as templateLoad } from '../src/routes/templates/[id]/+page.server';
import { crmBases } from '../src/lib/server/archive-public';
import { serveBrandingLogo } from '../src/lib/server/media-serve';
import colorFieldRaw from '../src/lib/components/ColorField.svelte?raw';

// #595: the brand kit replaces the former hardcoded house swatches and logos.

const db = (env as any).DB as D1Database;
const migrations = (env as any).TEST_MIGRATIONS as { name: string; queries: string[] }[];
const seed = migrations.find((m) => m.name.startsWith('0122_'))!;
const admin = { id: 1, role: 'admin', github_login: 'admin-595' };
const member = { id: 2, role: 'member', github_login: 'member-595' };

function fakeBucket() {
	const store = new Map<string, { bytes: ArrayBuffer; type: string }>();
	return {
		store,
		async put(key: string, bytes: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
			store.set(key, { bytes, type: opts?.httpMetadata?.contentType ?? '' });
		},
		async get(key: string) {
			const o = store.get(key);
			return o ? { body: o.bytes, httpMetadata: { contentType: o.type }, httpEtag: '"e"' } : null;
		},
		async delete(key: string) {
			store.delete(key);
		}
	};
}

function ev(action: string, user: unknown, fields: Record<string, string | File> = {}, bucket?: unknown) {
	const url = new URL(`https://crm.test/settings/brand-kit?/${action}`);
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		request: new Request(url, { method: 'POST', body }),
		url,
		params: {},
		platform: { env: { ...(env as any), MEDIA: bucket, PUBLIC_BASE_URL: 'https://crm.test' } },
		locals: { user, authed: !!user },
		depends: () => {}
	} as any;
}

async function status(p: Promise<unknown>): Promise<number | undefined> {
	try {
		return ((await p) as { status?: number } | undefined)?.status;
	} catch (e) {
		return (e as { status?: number }).status;
	}
}

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 9, 5])], 'logo.png', { type: 'image/png' });

async function clean() {
	await db
		.prepare(`DELETE FROM app_state WHERE key IN ('brand_kit', 'app_name', 'app_short_name', 'logo_key', 'newsletter_archive_theme') OR key LIKE 'archive_%'`)
		.run();
	await db.prepare(`DELETE FROM contacts WHERE email LIKE '%@kit595.test'`).run();
	await db.prepare(`DELETE FROM templates WHERE name = 'Web 595'`).run();
}

beforeEach(clean);
afterAll(clean);

describe('defaults', () => {
	it('a fresh install: neutral palette, no logos, neutral app name', async () => {
		expect(await getBrandKit(db)).toEqual(defaultBrandKit());
		expect(defaultBrandKit().logos).toEqual([]);
		expect(defaultBrandKit().swatches).toEqual(NEUTRAL_SWATCHES);
		expect(JSON.stringify(NEUTRAL_SWATCHES)).not.toMatch(/#15130e|#066971|#ce423b/);
		expect(DEFAULT_APP_NAME).toBe('Howdee CRM');
		expect(DEFAULT_SHORT_NAME).toBe('Howdee CRM');
		expect((await getBranding(db)).appName).toBe('Howdee CRM');
	});

	it('normalizeBrandKit drops junk and keeps an emptied list empty', () => {
		expect(normalizeBrandKit('not json')).toEqual(defaultBrandKit());
		expect(normalizeBrandKit(null)).toEqual(defaultBrandKit());
		const k = normalizeBrandKit({
			swatches: [{ key: 'a', label: 'A', hex: '#ABC' }, { key: 'b', label: '', hex: '#000' }, { key: 'c', label: 'C', hex: 'nope' }, { key: 'a', label: 'dup', hex: '#000' }],
			logos: [{ key: 'l', label: 'L', src: 'javascript:alert(1)' }, { key: 'm', label: 'M', src: 'https://x.test/a.png', background: 'weird' }]
		});
		expect(k.swatches).toEqual([{ key: 'a', label: 'A', hex: '#aabbcc' }]);
		expect(k.logos).toEqual([{ key: 'm', label: 'M', src: 'https://x.test/a.png', alt: '', background: 'light' }]);
		expect(normalizeBrandKit({ swatches: [], logos: [] })).toEqual({ swatches: [], logos: [] });
	});
});

describe('migration 0122 seed', () => {
	async function runSeed() {
		for (const q of seed.queries) await db.prepare(q).run();
	}

	it('is 0122_brand_kit.sql', () => {
		expect(seed?.name).toBe('0122_brand_kit.sql');
	});

	it('an empty database gets nothing', async () => {
		const had = await db.prepare('SELECT (SELECT COUNT(*) FROM contacts) + (SELECT COUNT(*) FROM campaigns) AS n').first<{ n: number }>();
		if (had!.n > 0) return; // other test files share the DB; covered by the fresh pool instead
		await runSeed();
		expect(await db.prepare(`SELECT value FROM app_state WHERE key = 'brand_kit'`).first()).toBeNull();
		expect(await db.prepare(`SELECT value FROM app_state WHERE key = 'newsletter_archive_theme'`).first()).toBeNull();
	});

	it('an install with data keeps its swatches, logos and app name', async () => {
		await db.prepare(`INSERT INTO contacts (email) VALUES ('a@kit595.test')`).run();
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('app_short_name', '')`).run();
		await runSeed();
		await runSeed(); // idempotent
		const kit = await getBrandKit(db);
		expect(kit.swatches).toHaveLength(12);
		expect(kit.swatches[0]).toEqual({ key: 'warmInk', label: 'Warm ink', hex: '#15130e' });
		expect(kit.swatches.map((s) => s.hex)).toContain('#ce423b');
		expect(kit.logos.map((l) => l.key)).toEqual(['primary-white', 'primary', 'logomark']);
		expect(kit.logos.map((l) => l.background)).toEqual(['dark', 'light', 'light']);
		for (const l of kit.logos) expect(l.alt).toBe('Ourco');
		expect(editorLogos(kit)[1].src).toBe('https://crm.myapp.example/img/logo.png');
		const b = await getBranding(db);
		expect(b.appName).toBe('DS Email Marketing');
		expect(b.shortName).toBe('DS Email');
	});

	it('never overwrites a kit or a name an admin already set', async () => {
		await db.prepare(`INSERT INTO contacts (email) VALUES ('b@kit595.test')`).run();
		await saveBrandKit(db, { swatches: [{ key: 'x', label: 'X', hex: '#123456' }], logos: [] });
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('app_name', 'Acme Mail')`).run();
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('newsletter_archive_theme', '{"bg":"#010203"}')`).run();
		await runSeed();
		expect((await getBrandKit(db)).swatches).toEqual([{ key: 'x', label: 'X', hex: '#123456' }]);
		expect((await getBranding(db)).appName).toBe('Acme Mail');
		expect((await getArchiveTheme(db)).bg).toBe('#010203');
	});
});

describe('kit edits (pure)', () => {
	const base: BrandKit = { swatches: [{ key: 'a', label: 'A', hex: '#111111' }, { key: 'b', label: 'B', hex: '#222222' }], logos: [] };
	it('add / update / move / remove swatches', () => {
		let r = applyKitOp(base, { op: 'addSwatch', label: ' New ', hex: 'ABC' });
		expect(r.ok && r.kit.swatches[2]).toMatchObject({ label: 'New', hex: '#aabbcc' });
		r = applyKitOp(base, { op: 'updateSwatch', key: 'a', label: 'A2', hex: '#000' });
		expect(r.ok && r.kit.swatches[0]).toEqual({ key: 'a', label: 'A2', hex: '#000000' });
		r = applyKitOp(base, { op: 'moveSwatch', key: 'b', dir: 'up' });
		expect(r.ok && r.kit.swatches.map((s) => s.key)).toEqual(['b', 'a']);
		r = applyKitOp(base, { op: 'removeSwatch', key: 'a' });
		expect(r.ok && r.kit.swatches.map((s) => s.key)).toEqual(['b']);
		expect(applyKitOp(base, { op: 'addSwatch', label: 'x', hex: 'red' })).toMatchObject({ ok: false });
		expect(applyKitOp(base, { op: 'addSwatch', label: '', hex: '#000' })).toMatchObject({ ok: false });
		expect(applyKitOp(base, { op: 'removeSwatch', key: 'zzz' })).toMatchObject({ ok: false });
	});
});

describe('Settings → Brand kit', () => {
	it('members get 403 on load and every action; nothing written', async () => {
		expect(await status((kitPage.load as any)(ev('', member)))).toBe(403);
		for (const name of Object.keys(kitPage.actions)) {
			expect(await status((kitPage.actions as any)[name](ev(name, member, { label: 'X', hex: '#000000', key: 'black' }))), name).toBe(403);
		}
		expect(await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(BRAND_KIT_KEY).first()).toBeNull();
	});

	it('an admin adds, edits, reorders and removes swatches', async () => {
		const a = kitPage.actions as any;
		expect(await a.addSwatch(ev('addSwatch', admin, { label: 'Brand blue', hex: '#0055ff' }))).toMatchObject({ saved: true });
		let kit = await getBrandKit(db);
		const added = kit.swatches.at(-1)!;
		expect(added).toMatchObject({ label: 'Brand blue', hex: '#0055ff' });
		await a.updateSwatch(ev('updateSwatch', admin, { key: added.key, label: 'Blue', hex: '#0044ee' }));
		await a.moveSwatch(ev('moveSwatch', admin, { key: added.key, dir: 'up' }));
		await a.removeSwatch(ev('removeSwatch', admin, { key: 'black' }));
		kit = await getBrandKit(db);
		expect(kit.swatches.find((s) => s.key === 'black')).toBeUndefined();
		expect(kit.swatches.at(-2)).toEqual({ key: added.key, label: 'Blue', hex: '#0044ee' });
		expect(await status(a.addSwatch(ev('addSwatch', admin, { label: 'Bad', hex: 'nope' })))).toBe(400);
		const data = (await (kitPage.load as any)(ev('', admin))) as { kit: BrandKit };
		expect(data.kit).toEqual(kit);
	});

	it('an admin uploads, edits, reorders and removes logos (R2 under branding/kit-…)', async () => {
		const a = kitPage.actions as any;
		const bucket = fakeBucket();
		expect(await status(a.addLogo(ev('addLogo', admin, { label: 'Mark', file: new File(['<svg/>'], 'l.svg', { type: 'image/svg+xml' }) }, bucket)))).toBe(415);
		expect(await status(a.addLogo(ev('addLogo', admin, { label: '', file: PNG() }, bucket)))).toBe(400);
		expect(bucket.store.size).toBe(0);
		expect(await a.addLogo(ev('addLogo', admin, { label: 'Primary', alt: 'Acme', background: 'dark', file: PNG() }, bucket))).toMatchObject({ saved: true });
		await a.addLogo(ev('addLogo', admin, { label: 'Second', file: new File([new Uint8Array([1, 2, 3])], 's.png', { type: 'image/png' }) }, bucket));
		let kit = await getBrandKit(db);
		expect(kit.logos).toHaveLength(2);
		const [first, second] = kit.logos;
		expect(first).toMatchObject({ label: 'Primary', alt: 'Acme', background: 'dark' });
		expect(first.src).toMatch(/^https:\/\/crm\.test\/img\/branding\/kit-[a-f0-9]{16}\.png$/);
		const key = kitUploadKey(first.src)!;
		expect(bucket.store.has(key)).toBe(true);
		// Served publicly by /img/branding/[file].
		const res = await serveBrandingLogo(bucket as never, key.replace('branding/', ''));
		expect(res.headers.get('content-type')).toBe('image/png');

		await a.updateLogo(ev('updateLogo', admin, { key: second.key, label: 'Second logo', alt: 'Alt', background: 'light' }));
		await a.moveLogo(ev('moveLogo', admin, { key: second.key, dir: 'up' }));
		kit = await getBrandKit(db);
		expect(kit.logos.map((l) => l.label)).toEqual(['Second logo', 'Primary']);
		await a.removeLogo(ev('removeLogo', admin, { key: first.key }, bucket));
		expect((await getBrandKit(db)).logos.map((l) => l.key)).toEqual([second.key]);
		expect(bucket.store.has(key)).toBe(false);
	});
});

describe('pickers read the kit', () => {
	it('the root layout hands the kit to signed-in pages only', async () => {
		await saveBrandKit(db, { swatches: [{ key: 'k', label: 'K', hex: '#abcdef' }], logos: [{ key: 'l', label: 'L', src: 'https://crm.test/img/x.png', alt: '', background: 'light' }] });
		const signed = (await (layoutLoad as any)(ev('', admin))) as { brandKit: BrandKit };
		expect(editorSwatches(signed.brandKit)).toEqual([{ key: 'k', label: 'K', hex: '#abcdef' }]);
		expect(editorLogos(signed.brandKit)).toEqual([{ key: 'l', label: 'L', src: 'https://crm.test/img/x.png', alt: 'L' }]);
		const anon = (await (layoutLoad as any)(ev('', null))) as { brandKit: unknown };
		expect(anon.brandKit).toBeNull();
	});

	it('editor helpers fall back to the neutral palette; ColorField reads the kit', () => {
		expect(editorSwatches(null)).toEqual(NEUTRAL_SWATCHES);
		expect(editorLogos(null)).toEqual([]);
		expect(colorFieldRaw).toContain('editorSwatches(');
		expect(colorFieldRaw).toContain('brandKit');
		expect(colorFieldRaw).not.toContain('BRAND_SWATCHES');
	});
});

describe('newsletter archive fallback logo', () => {
	it('no Branding logo: the kit\'s primary logo, else its first light logo, else none', async () => {
		const logo = (key: string, background: 'light' | 'dark') => ({ key, label: key, src: `https://kit.test/img/${key}.png`, alt: '', background });
		const imgSrc = async () => ((await builtInBlocks(db, 'https://crm.test')).find((b) => b.type === 'image') as { src: string } | undefined)?.src;

		await saveBrandKit(db, { swatches: [], logos: [logo('mark', 'light'), logo('primary', 'dark')] });
		expect(await imgSrc()).toBe('https://kit.test/img/primary.png');

		await saveBrandKit(db, { swatches: [], logos: [logo('white', 'dark'), logo('mark', 'light'), logo('other', 'light')] });
		expect(await imgSrc()).toBe('https://kit.test/img/mark.png');

		await saveBrandKit(db, { swatches: [], logos: [logo('white', 'dark')] });
		expect(await imgSrc()).toBeUndefined();

		await saveBrandKit(db, { swatches: [], logos: [] });
		const blocks = await builtInBlocks(db, 'https://crm.test');
		expect(blocks.some((b) => b.type === 'image')).toBe(false);
		expect(blocks.some((b) => b.type === 'content')).toBe(true);
	});

	it("the install's own Branding logo is used when uploaded", async () => {
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('logo_key', 'branding/logo-0123456789abcdef.png')`).run();
		const blocks = await builtInBlocks(db, 'https://crm.test/');
		const img = blocks.find((b) => b.type === 'image') as { src: string } | undefined;
		expect(img?.src).toBe('https://crm.test/img/branding/logo-0123456789abcdef.png');
	});

	it('crmBases lists kit logo hosts served from /img/ only', async () => {
		await saveBrandKit(db, {
			swatches: [],
			logos: [
				{ key: 'a', label: 'A', src: 'https://old-crm.test/img/a.png', alt: '', background: 'light' },
				{ key: 'b', label: 'B', src: 'https://cdn.test/assets/b.png', alt: '', background: 'light' }
			]
		});
		const bases = await crmBases(db, { PUBLIC_BASE_URL: 'https://crm.test' });
		expect(bases).toContain('https://old-crm.test');
		expect(bases).not.toContain('https://cdn.test');
		expect(bases.join(' ')).not.toContain('crm.myapp.example');
	});
});

// #595: the public archive keeps the former built-in palette and logo on an install that holds
// data (migration 0122 seeds app_state `newsletter_archive_theme` and the kit); a fresh database
// gets the neutral palette and no logo. Values are hardcoded on purpose (main's rendering).
describe('newsletter archive theme', () => {
	const ctx = { base: 'https://crm.test', origin: 'https://crm.test' };
	const PRIMARY = 'https://crm.myapp.example/img/logo.png';
	const SEEDED_LIGHT = [
		'--nl-bg:#f5f3ed; --nl-surface:#ffffff; --nl-text:#15130e; --nl-muted:#544e44; --nl-hair:#ece8de;',
		'--nl-link:#066971; --nl-brand:#066971; --nl-on-brand:#ffffff;'
	];
	const SEEDED_DARK = [
		'--nl-bg:#15130e; --nl-surface:#1f1c16; --nl-text:#f5f3ed; --nl-muted:#b8b0a2;',
		'--nl-hair:#3a352c; --nl-link:#0ab5c2; --nl-brand:#0ab5c2; --nl-on-brand:#15130e; }'
	];
	const NEUTRAL_LIGHT = [
		'--nl-bg:#f9fafb; --nl-surface:#ffffff; --nl-text:#111827; --nl-muted:#4b5563; --nl-hair:#e5e7eb;',
		'--nl-link:#1d4ed8; --nl-brand:#1d4ed8; --nl-on-brand:#ffffff;'
	];
	const NEUTRAL_DARK = [
		'--nl-bg:#111827; --nl-surface:#1f2937; --nl-text:#f9fafb; --nl-muted:#9ca3af;',
		'--nl-hair:#374151; --nl-link:#93c5fd; --nl-brand:#93c5fd; --nl-on-brand:#111827; }'
	];

	async function runSeed() {
		for (const q of seed.queries) await db.prepare(q).run();
	}
	async function enableArchive() {
		expect(await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [] })).toBeNull();
	}
	async function indexHtml(): Promise<string> {
		const html = await renderIndexPage(db, 1, ctx);
		expect(html).not.toBeNull();
		return html!;
	}

	it('an install with data: the old built-in colours and the kit\'s primary logo, with no Branding upload', async () => {
		await db.prepare(`INSERT INTO contacts (email) VALUES ('theme@kit595.test')`).run();
		await runSeed();
		await enableArchive();
		expect(await getArchiveTheme(db)).toEqual({
			bg: '#f5f3ed',
			surface: '#ffffff',
			text: '#15130e',
			muted: '#544e44',
			hairline: '#ece8de',
			link: '#066971',
			brand: '#066971',
			onBrand: '#ffffff',
			cta: '#ce423b',
			darkBg: '#15130e',
			darkSurface: '#1f1c16',
			darkText: '#f5f3ed',
			darkMuted: '#b8b0a2',
			darkHairline: '#3a352c',
			darkLink: '#0ab5c2',
			darkOnBrand: '#15130e'
		});
		const html = await indexHtml();
		for (const s of [...SEEDED_LIGHT, ...SEEDED_DARK]) expect(html).toContain(s);
		expect(html).toMatch(new RegExp(`<header class="nl-head">[\\s\\S]*<img src="${PRIMARY.replaceAll('.', '\\.')}" alt="DS Email Marketing"`));
		const img = (await builtInBlocks(db, ctx.origin)).find((b) => b.type === 'image') as { src: string; alt: string } | undefined;
		expect(img).toMatchObject({ src: PRIMARY, alt: 'DS Email Marketing' });
	});

	it('the template editor\'s page-settings defaults and preview use the theme', async () => {
		await db.prepare(`INSERT INTO contacts (email) VALUES ('editor@kit595.test')`).run();
		await runSeed();
		const tid = (await db.prepare(`INSERT INTO templates (name, kind, blocks) VALUES ('Web 595', 'web', '[]') RETURNING id`).first<{ id: number }>())!.id;
		const url = new URL(`https://crm.test/templates/${tid}`);
		const data = (await (templateLoad as any)({ platform: { env }, params: { id: String(tid) }, url, locals: { user: admin }, request: new Request(url) })) as {
			webOptions: { defaults: { bg: string; link: string } };
		};
		expect(data.webOptions.defaults).toMatchObject({ bg: '#f5f3ed', link: '#066971' });
		const preview = renderWebTemplatePreview([], {}, await getArchiveTheme(db));
		for (const s of SEEDED_LIGHT) expect(preview).toContain(s);
	});

	it('a fresh database: the neutral colours and no logo', async () => {
		await enableArchive();
		const html = await indexHtml();
		for (const s of [...NEUTRAL_LIGHT, ...NEUTRAL_DARK]) expect(html).toContain(s);
		expect(html).not.toContain('--nl-bg:#f5f3ed');
		expect(html).not.toContain('<header class="nl-head">');
		expect((await builtInBlocks(db, ctx.origin)).some((b) => b.type === 'image')).toBe(false);
	});

	it('a malformed stored theme falls back to neutral for the bad keys, without throwing', async () => {
		await enableArchive();
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('newsletter_archive_theme', 'not json {')`).run();
		let html = await indexHtml();
		for (const s of [...NEUTRAL_LIGHT, ...NEUTRAL_DARK]) expect(html).toContain(s);

		await db
			.prepare(`UPDATE app_state SET value = ? WHERE key = 'newsletter_archive_theme'`)
			.bind(JSON.stringify({ bg: 'red', text: '#123456', surface: 42, muted: null, darkLink: '#ABC', unknown: '#000000' }))
			.run();
		html = await indexHtml();
		expect(html).toContain('--nl-bg:#f9fafb; --nl-surface:#ffffff; --nl-text:#123456; --nl-muted:#4b5563; --nl-hair:#e5e7eb;');
		expect(html).toContain('--nl-hair:#374151; --nl-link:#aabbcc; --nl-brand:#aabbcc; --nl-on-brand:#111827; }');

		const neutral = parseArchiveTheme(null);
		expect(parseArchiveTheme('[1,2]')).toEqual(neutral);
		expect(parseArchiveTheme(42)).toEqual(neutral);
		expect(parseArchiveTheme({ cta: 'nope', brand: '#00FF00' })).toEqual({ ...neutral, brand: '#00ff00' });
	});

	it('an uploaded Branding logo wins over the kit logo', async () => {
		await db.prepare(`INSERT INTO contacts (email) VALUES ('logo@kit595.test')`).run();
		await runSeed();
		await enableArchive();
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('logo_key', 'branding/logo-0123456789abcdef.png')`).run();
		const img = (await builtInBlocks(db, ctx.origin)).find((b) => b.type === 'image') as { src: string } | undefined;
		expect(img?.src).toBe('https://crm.test/img/branding/logo-0123456789abcdef.png');
		const html = await indexHtml();
		expect(html).toContain('<img src="https://crm.test/img/branding/logo-0123456789abcdef.png"');
		expect(html).not.toContain(PRIMARY);
	});
});
