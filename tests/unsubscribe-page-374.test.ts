import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #374: customizable unsubscribe page — video URL parsing, the stored config, the opt-in
// Resubscribe (with the #285 bounce / spam guard), upload limits, the admin settings action,
// the preview's admin gate, the page CSP and the compliance order of the page.
import {
	DEFAULT_UNSUB_PAGE,
	EMBED_ORIGINS,
	VIDEO_MAX_BYTES,
	embedSrc,
	normalizeUnsubPage,
	parseVideoUrl,
	unsubscribeCsp,
	validatePosterFile,
	validateUnsubPageText,
	validateVideoFile,
	videoForState,
	type UnsubPageConfig
} from '../src/lib/unsubscribe-page';
import { renderAssistantMarkdown } from '../src/lib/assistant-markdown';
import { getUnsubPage, saveUnsubPage, selfResubscribe } from '../src/lib/server/unsubscribe-page';
import { signUnsub } from '../src/lib/server/token';
import { actions as pageActions, load as pageLoad } from '../src/routes/unsubscribe/+page.server';
import { load as previewLoad } from '../src/routes/unsubscribe/preview/+page.server';
import { actions as settingsActions, load as settingsLoad } from '../src/routes/settings/unsubscribe/+page.server';
import { GET as mediaGet } from '../src/routes/img/unsubscribe/[file]/+server';

const viewSource = (
	import.meta.glob('../src/lib/components/UnsubscribeView.svelte', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
)['../src/lib/components/UnsubscribeView.svelte'];

const db = (env as any).DB as D1Database;
const SECRET = 'unsub-page-secret';
const YT = 'dQw4w9WgXcQ';
const LOOM = '0123456789abcdef0123456789abcdef';

async function reset() {
	await db.batch([
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key = 'unsubscribe_page'")
	]);
}

async function contact(email: string, subscribed = 0): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id').bind(email, subscribed).first<{ id: number }>())!.id;
}

/** Postmark stub: suppression dumps per stream; records every call. */
function mockPostmark(dumps: Record<string, { EmailAddress: string; SuppressionReason: string }[]>) {
	const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
		const m = /message-streams\/([^/]+)\/suppressions\/dump/.exec(url);
		if (m) return new Response(JSON.stringify({ Suppressions: dumps[decodeURIComponent(m[1])] ?? [] }), { status: 200 });
		return new Response(JSON.stringify({ Suppressions: [] }), { status: 200 });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const PM = { token: 'pm-token', stream: 'broadcast', txStream: 'outbound' };
const ON: UnsubPageConfig = { ...DEFAULT_UNSUB_PAGE, resubscribe: true };

function memBucket() {
	const store = new Map<string, { bytes: ArrayBuffer; type: string }>();
	return {
		store,
		async put(key: string, bytes: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
			store.set(key, { bytes, type: opts?.httpMetadata?.contentType ?? '' });
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
		},
		async head(key: string) {
			const o = store.get(key);
			return o ? { size: o.bytes.byteLength } : null;
		},
		async get(key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) {
			const o = store.get(key);
			if (!o) return null;
			const size = o.bytes.byteLength;
			let offset = 0;
			let length = size;
			const r = opts?.range;
			if (r && 'suffix' in r && r.suffix !== undefined) {
				length = Math.min(r.suffix, size);
				offset = size - length;
			} else if (r) {
				offset = r.offset ?? 0;
				length = r.length ?? size - offset;
			}
			return {
				size,
				range: r,
				body: o.bytes.slice(offset, offset + length),
				httpEtag: '"e"',
				httpMetadata: { contentType: o.type }
			};
		}
	};
}

afterEach(() => vi.unstubAllGlobals());

describe('video URL parsing', () => {
	it('accepts YouTube watch, youtu.be, shorts, embed and live links', () => {
		for (const u of [
			`https://www.youtube.com/watch?v=${YT}`,
			`https://youtube.com/watch?v=${YT}&t=42s`,
			`https://m.youtube.com/watch?v=${YT}`,
			`https://youtu.be/${YT}?si=abc`,
			`https://www.youtube.com/shorts/${YT}`,
			`https://www.youtube.com/embed/${YT}`,
			`https://www.youtube-nocookie.com/embed/${YT}`,
			`youtube.com/live/${YT}`
		]) {
			expect(parseVideoUrl(u), u).toEqual({ provider: 'youtube', id: YT });
		}
	});

	it('accepts Vimeo (plain, unlisted hash, channel, player) and Loom (share, embed, slug) links', () => {
		expect(parseVideoUrl('https://vimeo.com/76979871')).toEqual({ provider: 'vimeo', id: '76979871' });
		expect(parseVideoUrl('https://vimeo.com/76979871/abc123def0')).toEqual({ provider: 'vimeo', id: '76979871', hash: 'abc123def0' });
		expect(parseVideoUrl('https://vimeo.com/channels/staffpicks/76979871')).toEqual({ provider: 'vimeo', id: '76979871' });
		expect(parseVideoUrl('https://player.vimeo.com/video/76979871?h=abc123def0&autoplay=1')).toEqual({
			provider: 'vimeo',
			id: '76979871',
			hash: 'abc123def0'
		});
		expect(parseVideoUrl(`https://www.loom.com/share/${LOOM}`)).toEqual({ provider: 'loom', id: LOOM });
		expect(parseVideoUrl(`https://loom.com/embed/${LOOM}`)).toEqual({ provider: 'loom', id: LOOM });
		expect(parseVideoUrl(`https://www.loom.com/share/my-demo-${LOOM}?sid=1`)).toEqual({ provider: 'loom', id: LOOM });
	});

	it('rejects everything else', () => {
		for (const u of [
			'',
			'not a url',
			'javascript:alert(1)',
			`data:text/html,<script>alert(1)</script>`,
			`https://evil.example/watch?v=${YT}`,
			`https://youtube.com.evil.example/watch?v=${YT}`,
			`https://evil.example/youtube.com/watch?v=${YT}`,
			`https://www.youtube.com/watch?v=short`,
			`https://www.youtube.com/watch?v=${YT}"><script>`,
			`https://www.youtube.com/playlist?list=PL123`,
			`https://user:x@www.youtube.com/watch?v=${YT}`,
			`https://www.youtube.com:8443/watch?v=${YT}`,
			`ftp://youtu.be/${YT}`,
			'https://vimeo.com/about',
			'https://vimeo.com/76979871/not-a-hash!',
			'https://player.vimeo.com/76979871',
			'https://www.loom.com/share/123',
			`https://www.loom.com/looms/${LOOM}`,
			`https://www.dailymotion.com/video/x7xxxx`
		]) {
			expect(parseVideoUrl(u), u).toBeNull();
		}
	});

	it('builds the iframe src from the id only — never the pasted URL, never autoplay', () => {
		const yt = parseVideoUrl(`https://www.youtube.com/watch?v=${YT}&autoplay=1&mute=0&origin=https://evil.example`)!;
		expect(embedSrc(yt)).toBe(`https://www.youtube-nocookie.com/embed/${YT}?rel=0`);
		const vm = parseVideoUrl('https://player.vimeo.com/video/76979871?h=abc123def0&autoplay=1')!;
		expect(embedSrc(vm)).toBe('https://player.vimeo.com/video/76979871?dnt=1&h=abc123def0');
		expect(embedSrc(parseVideoUrl('https://vimeo.com/76979871')!)).toBe('https://player.vimeo.com/video/76979871?dnt=1');
		expect(embedSrc(parseVideoUrl(`https://www.loom.com/share/${LOOM}`)!)).toBe(`https://www.loom.com/embed/${LOOM}`);
		for (const p of [yt, vm]) expect(embedSrc(p)).not.toMatch(/autoplay/);
		// A tampered stored id never reaches the src.
		expect(embedSrc({ provider: 'youtube', id: 'x"><script>' })).toBeNull();
		expect(embedSrc({ provider: 'vimeo', id: '1', hash: 'zz"' })).toBe('https://player.vimeo.com/video/1?dnt=1');
	});

	it('the page CSP allows frames only from the three player hosts and media only from self', () => {
		const csp = unsubscribeCsp();
		expect(csp).toContain(`frame-src ${EMBED_ORIGINS.join(' ')};`);
		expect(EMBED_ORIGINS).toEqual(['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://www.loom.com']);
		expect(csp).toContain("media-src 'self'");
	});
});

describe('markdown', () => {
	it('strips script, event handlers and javascript: links', () => {
		const html = renderAssistantMarkdown(
			'Hi **there**\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1)) [ok](https://ourco.example)'
		);
		expect(html).toContain('<strong>there</strong>');
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<img/i);
		expect(html).not.toMatch(/<[^>]+\sonerror=/i);
		expect(html).not.toMatch(/href="javascript:/i);
		expect(html).toContain('href="https://ourco.example/"');
	});
});

describe('config', () => {
	it('defaults: today’s headings, no video, Resubscribe off', () => {
		const cfg = normalizeUnsubPage(null);
		expect(cfg).toEqual(DEFAULT_UNSUB_PAGE);
		expect(cfg.heading).toBe('Email preferences');
		expect(cfg.afterHeading).toBe("You're unsubscribed");
		expect(cfg.resubscribe).toBe(false);
		expect(cfg.placement).toBe('below');
	});

	it('a stored embed is re-parsed; junk falls back to defaults', () => {
		const cfg = normalizeUnsubPage(
			JSON.stringify({
				heading: '',
				video: { kind: 'embed', url: 'https://evil.example/x', provider: 'youtube', id: YT },
				afterVideo: { kind: 'upload', key: '../secret', type: 'video/mp4' },
				placement: 'above',
				resubscribe: 'yes',
				accent: 'red',
				links: [{ label: 'Site', url: 'javascript:alert(1)' }, { label: 'Ok', url: 'https://ourco.example' }]
			})
		);
		expect(cfg.heading).toBe('Email preferences');
		expect(cfg.video).toBeNull();
		expect(cfg.afterVideo).toBeNull();
		expect(cfg.placement).toBe('below');
		expect(cfg.resubscribe).toBe(false);
		expect(cfg.accent).toBeNull();
		expect(cfg.links).toEqual([{ label: 'Ok', url: 'https://ourco.example/' }]);
		expect(normalizeUnsubPage('{not json')).toEqual(DEFAULT_UNSUB_PAGE);
	});

	it('validates text fields on save', () => {
		expect(validateUnsubPageText({ intro: 'x'.repeat(1001) })).toMatchObject({ ok: false });
		expect(validateUnsubPageText({ heading: 'x'.repeat(81) })).toMatchObject({ ok: false });
		expect(validateUnsubPageText({ links: [{ label: 'Site', url: 'javascript:alert(1)' }] })).toMatchObject({ ok: false });
		expect(validateUnsubPageText({ links: [{ label: '', url: 'https://a.test' }] })).toMatchObject({ ok: false });
		expect(validateUnsubPageText({ accent: 'blue' })).toMatchObject({ ok: false });
		expect(validateUnsubPageText({ placement: 'above' })).toMatchObject({ ok: false });
		const ok = validateUnsubPageText({ heading: ' ', accent: '#ABC', intro: 'x'.repeat(1000), links: [{ label: '', url: '' }] });
		expect(ok).toMatchObject({ ok: true, value: { heading: 'Email preferences', accent: '#aabbcc', links: [] } });
	});

	it('upload limits: MP4 / WebM ≤ 50 MB; poster PNG / JPEG / WebP ≤ 2 MB', () => {
		expect(validateVideoFile({ type: 'video/mp4', size: 1000 })).toEqual({ ok: true, ext: 'mp4' });
		expect(validateVideoFile({ type: 'video/webm', size: VIDEO_MAX_BYTES })).toEqual({ ok: true, ext: 'webm' });
		expect(validateVideoFile({ type: 'video/mp4', size: VIDEO_MAX_BYTES + 1 })).toMatchObject({ ok: false, status: 413 });
		expect(validateVideoFile({ type: 'video/quicktime', size: 1000 })).toMatchObject({ ok: false, status: 415 });
		expect(validateVideoFile({ type: 'image/svg+xml', size: 1000 })).toMatchObject({ ok: false, status: 415 });
		expect(validateVideoFile({ type: 'video/mp4', size: 0 })).toMatchObject({ ok: false, status: 400 });
		expect(validatePosterFile({ type: 'image/jpeg', size: 1000 })).toEqual({ ok: true, ext: 'jpg' });
		expect(validatePosterFile({ type: 'image/svg+xml', size: 1000 })).toMatchObject({ ok: false, status: 415 });
		expect(validatePosterFile({ type: 'image/png', size: 2 * 1024 * 1024 + 1 })).toMatchObject({ ok: false, status: 413 });
	});
});

describe('page order (compliance)', () => {
	it('the unsubscribe button and topics render before the custom text and the video in the DOM', () => {
		const heading = viewSource.indexOf('<h1>{cfg.heading}</h1>');
		const button = viewSource.indexOf('data-unsub-button');
		const topics = viewSource.indexOf('action="?/preferences"');
		const email = viewSource.indexOf('Manage what <strong>{email}</strong>');
		expect(heading).toBeGreaterThan(-1);
		expect(email).toBeGreaterThan(heading);
		expect(button).toBeGreaterThan(email);
		expect(topics).toBeGreaterThan(button);
		expect(viewSource.indexOf('md(cfg.intro)')).toBeGreaterThan(topics);
		expect(viewSource.indexOf('<UnsubVideo')).toBeGreaterThan(viewSource.indexOf('md(cfg.intro)'));
		// The video is always after the main column (beside on wide screens, below otherwise).
		expect(viewSource.indexOf('<div class="media">')).toBeGreaterThan(viewSource.indexOf('<div class="main">'));
	});

	it('the after state renders the configured message and the after video', () => {
		const embed = { kind: 'embed' as const, url: `https://youtu.be/${YT}`, provider: 'youtube' as const, id: YT };
		const after = { kind: 'embed' as const, url: `https://www.loom.com/share/${LOOM}`, provider: 'loom' as const, id: LOOM };
		const cfg: UnsubPageConfig = { ...DEFAULT_UNSUB_PAGE, video: embed, caption: 'Hi', afterVideo: after, afterCaption: 'Bye', afterMessage: 'Thanks' };
		expect(videoForState(cfg, 'before')).toEqual({ video: embed, caption: 'Hi' });
		expect(videoForState(cfg, 'after')).toEqual({ video: after, caption: 'Bye' });
		expect(videoForState(cfg, 'invalid').video).toBeNull();
		expect(viewSource).toContain('{@html md(cfg.afterMessage)}');
		expect(viewSource).toContain('<h1>{cfg.afterHeading}</h1>');
	});
});

describe('resubscribe', () => {
	beforeEach(reset);

	it('is off by default', async () => {
		mockPostmark({});
		await contact('ann@example.com');
		const res = await selfResubscribe(db, PM, { e: 'ann@example.com', c: 0, k: 0 } as any, DEFAULT_UNSUB_PAGE);
		expect(res).toMatchObject({ ok: false, reason: 'off' });
		expect((await db.prepare("SELECT subscribed FROM contacts WHERE email = 'ann@example.com'").first<{ subscribed: number }>())!.subscribed).toBe(0);
	});

	for (const reason of ['HardBounce', 'SpamComplaint']) {
		it(`is refused for a ${reason} suppression`, async () => {
			mockPostmark({ outbound: [{ EmailAddress: 'Ann@Example.com', SuppressionReason: reason }] });
			await contact('ann@example.com');
			const res = await selfResubscribe(db, PM, { e: 'ann@example.com', c: 0, k: 0 } as any, ON);
			expect(res).toMatchObject({ ok: false, reason: 'suppressed' });
			expect((await db.prepare("SELECT subscribed FROM contacts WHERE email = 'ann@example.com'").first<{ subscribed: number }>())!.subscribed).toBe(0);
		});
	}

	it('works for a ManualSuppression: subscribed again, suppression lifted, recorded on the unsubscribe row', async () => {
		const fetchMock = mockPostmark({ broadcast: [{ EmailAddress: 'ann@example.com', SuppressionReason: 'ManualSuppression' }] });
		const id = await contact('ann@example.com');
		await db.prepare("INSERT INTO unsubscribes (contact_id, email, reason, detail) VALUES (?, 'ann@example.com', 'Too many emails', NULL)").bind(id).run();
		const res = await selfResubscribe(db, PM, { e: 'ann@example.com', c: 0, k: id } as any, ON, new Date('2026-10-20T12:34:00Z'));
		expect(res).toEqual({ ok: true });
		expect((await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())!.subscribed).toBe(1);
		const row = await db.prepare("SELECT reason, detail FROM unsubscribes WHERE email = 'ann@example.com'").first<{ reason: string; detail: string }>();
		expect(row).toEqual({ reason: 'Too many emails', detail: 'Resubscribed via the unsubscribe page 2026-10-20 12:34 UTC' });
		const del = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/message-streams/broadcast/suppressions/delete'));
		expect(del).toBeTruthy();
		expect(JSON.parse(String(del![1]!.body))).toEqual({ Suppressions: [{ EmailAddress: 'ann@example.com' }] });
	});

	it('works with no suppression (and appends to an existing detail)', async () => {
		const fetchMock = mockPostmark({});
		const id = await contact('bob@example.com');
		await db.prepare("INSERT INTO unsubscribes (contact_id, email, reason, detail) VALUES (?, 'bob@example.com', NULL, 'bye')").bind(id).run();
		const res = await selfResubscribe(db, PM, { e: 'bob@example.com', c: 0, k: id } as any, ON, new Date('2026-10-20T01:02:00Z'));
		expect(res).toEqual({ ok: true });
		expect((await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())!.subscribed).toBe(1);
		expect((await db.prepare('SELECT detail FROM unsubscribes WHERE contact_id = ?').bind(id).first<{ detail: string }>())!.detail).toBe(
			'bye · Resubscribed via the unsubscribe page 2026-10-20 01:02 UTC'
		);
		expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/suppressions/delete'))).toBe(false);
	});

	it('the page action uses the signed token, honours the setting and refuses a hard bounce', async () => {
		mockPostmark({ broadcast: [{ EmailAddress: 'cat@example.com', SuppressionReason: 'HardBounce' }] });
		const ok = await contact('dan@example.com');
		await contact('cat@example.com');
		const ev = (token: string) => {
			const fd = new FormData();
			fd.set('token', token);
			return {
				request: new Request('https://app.test/unsubscribe?/resubscribe', { method: 'POST', body: fd }),
				platform: { env: { DB: db, SESSION_SECRET: SECRET, POSTMARK_TOKEN: 'pm', POSTMARK_STREAM: 'broadcast' } }
			} as any;
		};
		const tDan = await signUnsub(SECRET, { e: 'dan@example.com', c: 0, k: ok } as any);
		const tCat = await signUnsub(SECRET, { e: 'cat@example.com', c: 0, k: 0 } as any);

		// Off by default.
		let res: any = await pageActions.resubscribe(ev(tDan));
		expect(res.status).toBe(400);
		await saveUnsubPage(db, ON);
		res = await pageActions.resubscribe(ev(tDan));
		expect(res).toEqual({ resubscribed: true, email: 'dan@example.com' });
		res = await pageActions.resubscribe(ev(tCat));
		expect(res.status).toBe(409);
		expect(res.data.resubError).toMatch(/bounced or were reported as spam/);
		res = await pageActions.resubscribe(ev('forged.token'));
		expect(res.status).toBe(400);
	});
});

describe('routes', () => {
	beforeEach(reset);

	it('the page load sends the CSP and the saved config, even for a bad token', async () => {
		await saveUnsubPage(db, { ...DEFAULT_UNSUB_PAGE, heading: 'Before you go' });
		const headers: Record<string, string> = {};
		const data: any = await pageLoad({
			url: new URL('https://app.test/unsubscribe?t=bad'),
			platform: { env: { DB: db, SESSION_SECRET: SECRET } },
			setHeaders: (h: Record<string, string>) => Object.assign(headers, h)
		} as any);
		expect(data.invalid).toBe(true);
		expect(data.page.heading).toBe('Before you go');
		expect(headers['Content-Security-Policy']).toBe(unsubscribeCsp());
	});

	it('preview: admins only (signed out → /login, member → 403)', async () => {
		const ev = (user: any) =>
			({ locals: { user }, platform: { env: { DB: db } }, setHeaders: () => undefined }) as any;
		await expect(previewLoad(ev(null))).rejects.toMatchObject({ status: 303, location: '/login' });
		await expect(previewLoad(ev({ id: 2, role: 'member' }))).rejects.toMatchObject({ status: 403 });
		const data: any = await previewLoad(ev({ id: 1, role: 'admin' }));
		expect(data.email).toBe('someone@example.com');
		expect(data.page).toEqual(DEFAULT_UNSUB_PAGE);
	});

	it('settings: admin-only; saves an embed, refuses an arbitrary URL, stores an upload and drops the old one', async () => {
		const bucket = memBucket();
		const ev = (user: any, fd?: FormData) =>
			({
				locals: { user },
				platform: { env: { DB: db, MEDIA: bucket } },
				request: new Request('https://app.test/settings/unsubscribe?/save', { method: 'POST', body: fd ?? new FormData() })
			}) as any;
		const admin = { id: 1, role: 'admin' };
		await expect(settingsLoad(ev({ id: 2, role: 'member' }))).rejects.toMatchObject({ status: 403 });
		await expect(settingsActions.save(ev({ id: 2, role: 'member' }))).rejects.toMatchObject({ status: 403 });

		let fd = new FormData();
		fd.set('heading', 'Before you go');
		fd.set('video_kind', 'embed');
		fd.set('video_url', 'https://evil.example/video.mp4');
		let res: any = await settingsActions.save(ev(admin, fd));
		expect(res.status).toBe(400);
		expect((await getUnsubPage(db)).heading).toBe('Email preferences');

		fd.set('video_url', `https://youtu.be/${YT}`);
		fd.set('placement', 'beside');
		fd.set('resubscribe', '1');
		fd.set('after_message', 'Thanks for reading.');
		fd.set('link_label_0', 'Visit our website');
		fd.set('link_url_0', 'https://ourco.example');
		res = await settingsActions.save(ev(admin, fd));
		expect(res).toEqual({ saved: true });
		let cfg = await getUnsubPage(db);
		expect(cfg).toMatchObject({
			heading: 'Before you go',
			video: { kind: 'embed', provider: 'youtube', id: YT },
			placement: 'beside',
			resubscribe: true,
			afterMessage: 'Thanks for reading.',
			links: [{ label: 'Visit our website', url: 'https://ourco.example/' }]
		});

		// Upload: wrong type refused, nothing stored.
		fd = new FormData();
		fd.set('after_video_kind', 'upload');
		fd.set('after_video_file', new File([new Uint8Array(10)], 'clip.mov', { type: 'video/quicktime' }));
		res = await settingsActions.save(ev(admin, fd));
		expect(res.status).toBe(400);
		expect(bucket.store.size).toBe(0);

		fd.set('after_video_file', new File([new Uint8Array(10)], 'clip.mp4', { type: 'video/mp4' }));
		fd.set('after_poster_file', new File([new Uint8Array(5)], 'p.png', { type: 'image/png' }));
		res = await settingsActions.save(ev(admin, fd));
		expect(res).toEqual({ saved: true });
		cfg = await getUnsubPage(db);
		expect(cfg.video).toBeNull();
		expect(cfg.afterVideo).toMatchObject({ kind: 'upload', type: 'video/mp4' });
		const first = cfg.afterVideo!.kind === 'upload' ? cfg.afterVideo! : null;
		expect(first!.key).toMatch(/^unsubscribe\/video-[a-f0-9-]{36}\.mp4$/);
		expect(first!.posterKey).toMatch(/^unsubscribe\/poster-[a-f0-9-]{36}\.png$/);
		expect([...bucket.store.keys()].sort()).toEqual([first!.key, first!.posterKey].sort());

		// Saving again without a file keeps it; switching to none deletes the objects.
		fd = new FormData();
		fd.set('after_video_kind', 'upload');
		res = await settingsActions.save(ev(admin, fd));
		expect(res).toEqual({ saved: true });
		expect((await getUnsubPage(db)).afterVideo).toEqual(first);
		fd.set('after_video_kind', 'none');
		await settingsActions.save(ev(admin, fd));
		expect(bucket.store.size).toBe(0);
	});

	it('serves uploaded media with byte ranges; other keys 404', async () => {
		const bucket = memBucket();
		const key = 'unsubscribe/video-11111111-2222-3333-4444-555555555555.mp4';
		await bucket.put(key, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer, { httpMetadata: { contentType: 'video/mp4' } });
		const get = (file: string, range?: string) =>
			mediaGet({
				params: { file },
				platform: { env: { MEDIA: bucket } },
				request: new Request(`https://app.test/img/unsubscribe/${file}`, { headers: range ? { range } : {} })
			} as any);
		const full = await get(key.slice('unsubscribe/'.length));
		expect(full.status).toBe(200);
		expect(full.headers.get('accept-ranges')).toBe('bytes');
		expect(new Uint8Array(await full.arrayBuffer()).length).toBe(10);
		const part = await get(key.slice('unsubscribe/'.length), 'bytes=2-4');
		expect(part.status).toBe(206);
		expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
		expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 3, 4]);
		await expect(get('../secret.mp4')).rejects.toMatchObject({ status: 404 });
	});
});
