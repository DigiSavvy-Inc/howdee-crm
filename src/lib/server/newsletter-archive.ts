// #481: public newsletter archive — settings, publishing, and the public pages (/newsletter,
// /newsletter/[slug], /newsletter/feed.xml). An issue is a sent broadcast (a list, not a 1:1
// send, not an automation step) with archive_published_at set.
//
// The page renders the campaign's OWN content (body_blocks through the page renderer,
// else body_md as markdown, else — raw-HTML templates — the stored body_html in a sandboxed
// iframe) inside a `web` template. Never on the page: unsubscribe / preference links and
// tokens, tracking pixels or click-tracking URLs, recipient data / counts / stats, the From
// address, the list or automation name. Personal merge tags fall back ("Hi there,") or vanish.
//
// #483: an issue can have a web-only version (archive_title / archive_teaser / archive_blocks,
// set when archive_edited_at is). `webVersion` overlays it before anything renders, so the same
// scrub applies; the email columns are never written here.
//
// No send / postmark / scheduler imports: this module only reads campaigns and writes the
// archive_* columns.
import {
	CONTENT_PLACEHOLDER,
	PAGE_CSS,
	PAGE_TOC_CSS,
	inlinePlainText,
	parseBlocks,
	renderPageBlocks,
	sanitizeBlocks,
	type Block,
	type Inline,
	type ShowOn
} from '$lib/blocks';
import { publicizeHtml } from './archive-public';
import { conditionalTagResult, evaluateConditionals } from '$lib/conditionals';
import { applyMergeTokens, escapeLeftoverMergeTokens, parseCompanyToken, parseMarkdownSafe, unescapeHtmlText } from '$lib/merge-tags';
import {
	ARCHIVE_FEED_SIZE,
	ARCHIVE_KEYS,
	ARCHIVE_PAGE_SIZE,
	ARCHIVE_PATH,
	ARCHIVE_TITLE_DEFAULT,
	ARCHIVE_TITLE_MAX,
	ARCHIVE_INTRO_MAX,
	ARCHIVE_THEME_KEY,
	ISSUE_TEASER_MAX,
	ISSUE_TITLE_MAX,
	WEB_DEFAULTS,
	WEB_TEMPLATE_KIND,
	archiveSlugBase,
	cleanSubscribeUrl,
	defaultArchiveTheme,
	parseArchiveSettings,
	parseArchiveTheme,
	sanitizeWebCanvas,
	webFontStack,
	type ArchiveSettings,
	type ArchiveTheme,
	type WebCanvas
} from '$lib/newsletter-archive';
import { getBranding } from './branding';
import { getBrandKit } from './brand-kit';
import { getSettings, getTimezone } from './settings';
import { readAudience } from './campaign-audience';
import { campaignTopicId } from './topics';
import { getForm, type FormRow } from './forms';
import { PLAIN_FORM_CSS, plainFormProblem, plainFormStyle, renderPlainForm } from './form-plain';
import { ARCHIVE_SUBSCRIBE_PATH } from '$lib/newsletter-archive';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The archive settings plus its theme (#595) in one app_state read. */
export async function getArchiveSettings(db: D1Database): Promise<ArchiveSettings> {
	const keys = [...ARCHIVE_KEYS, ARCHIVE_THEME_KEY];
	const rows = await db
		.prepare(`SELECT key, value FROM app_state WHERE key IN (${keys.map(() => '?').join(', ')})`)
		.bind(...keys)
		.all<{ key: string; value: string | null }>();
	return parseArchiveSettings(new Map(rows.results.map((r) => [r.key, r.value])));
}

/** #595: the archive theme on its own (template editor defaults + preview); neutral when unset,
 *  malformed or unreadable. The public pages get it from `getArchiveSettings` instead. */
export async function getArchiveTheme(db: D1Database | null | undefined): Promise<ArchiveTheme> {
	if (!db) return defaultArchiveTheme();
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(ARCHIVE_THEME_KEY).first<{ value: string | null }>();
		return parseArchiveTheme(row?.value ?? null);
	} catch {
		return defaultArchiveTheme();
	}
}

export type ArchiveSettingsInput = {
	enabled: boolean;
	title: string;
	intro: string;
	subscribeUrl: string;
	templateId: number | null;
	indexable: boolean;
	autoGroups: number[];
	/** #587: slug of a published form for the Subscribe popup; '' = off. Omitted = unchanged. */
	signupForm?: string;
};

/** Validate + store. Returns an error message, or null when saved. */
export async function saveArchiveSettings(db: D1Database, s: ArchiveSettingsInput): Promise<string | null> {
	const title = s.title.trim();
	if ([...title].length > ARCHIVE_TITLE_MAX) return `Title must be ${ARCHIVE_TITLE_MAX} characters or fewer.`;
	const intro = s.intro.trim();
	if ([...intro].length > ARCHIVE_INTRO_MAX) return `Intro must be ${ARCHIVE_INTRO_MAX} characters or fewer.`;
	const subscribe = s.subscribeUrl.trim();
	if (subscribe && !cleanSubscribeUrl(subscribe)) return 'Subscribe URL must be an https:// link or an app path like /p/subscribe.';
	if (s.templateId !== null) {
		const t = await db.prepare('SELECT id FROM templates WHERE id = ? AND kind = ?').bind(s.templateId, WEB_TEMPLATE_KIND).first();
		if (!t) return 'Pick a web template (or the built-in default).';
	}
	const groups = [...new Set(s.autoGroups.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
	if (groups.length) {
		const found = await db
			.prepare(`SELECT COUNT(*) AS n FROM lists WHERE id IN (SELECT value FROM json_each(?)) AND kind IN ('list', 'segment')`)
			.bind(JSON.stringify(groups))
			.first<{ n: number }>();
		if ((found?.n ?? 0) !== groups.length) return 'One of the auto-publish lists no longer exists.';
	}
	let signup: string | null | undefined;
	if (s.signupForm !== undefined) {
		const slug = s.signupForm.trim().toLowerCase();
		if (slug) {
			const form = await getForm(db, slug);
			if (!form || form.slug !== slug) return 'That sign-up form no longer exists.';
			const problem = plainFormProblem(form);
			if (problem) return problem;
		}
		signup = slug || null;
	}
	const values: Record<(typeof ARCHIVE_KEYS)[number], string | null> = {
		archive_enabled: s.enabled ? '1' : '0',
		archive_title: title || null,
		archive_intro: intro || null,
		archive_subscribe_url: cleanSubscribeUrl(subscribe) || null,
		archive_template_id: s.templateId ? String(s.templateId) : null,
		archive_indexable: s.indexable ? '1' : '0',
		archive_auto_groups: JSON.stringify(groups),
		archive_signup_form: signup ?? null
	};
	await db.batch(
		ARCHIVE_KEYS.filter((k) => k !== 'archive_signup_form' || signup !== undefined).map((k) =>
			db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, values[k])
		)
	);
	return null;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** SQL for "a sent broadcast" (alias c): a list send, not 1:1, not an automation step. */
export const BROADCAST_SENT_SQL = `c.status = 'sent' AND c.list_id IS NOT NULL AND c.automation_id IS NULL AND c.automation_step_id IS NULL`;
/** …and published (what the public pages show). */
export const PUBLISHED_SQL = `${BROADCAST_SENT_SQL} AND c.archive_published_at IS NOT NULL AND c.archive_slug IS NOT NULL`;

type PubRow = {
	id: number;
	subject: string;
	status: string;
	list_id: number | null;
	automation_id: number | null;
	automation_step_id: number | null;
	sent_at: string | null;
	archive_slug: string | null;
	archive_published_at: string | null;
	archive_after_send: number;
	archive_number: number | null;
};

export function isArchivable(r: Pick<PubRow, 'status' | 'list_id' | 'automation_id' | 'automation_step_id'>): boolean {
	return r.status === 'sent' && r.list_id != null && r.automation_id == null && r.automation_step_id == null;
}

async function pubRow(db: D1Database, id: number): Promise<PubRow | null> {
	return db
		.prepare(
			`SELECT id, subject, status, list_id, automation_id, automation_step_id, sent_at, archive_slug, archive_published_at, archive_after_send, archive_number
			 FROM campaigns WHERE id = ?`
		)
		.bind(id)
		.first<PubRow>();
}

/**
 * The first free slug: base, base-2, base-3, …
 * No LIKE here: D1 refuses LIKE / GLOB patterns over 50 bytes (#484), and a base is
 * `YYYY-MM-DD-` plus up to 60 characters. A prefix compare with substr has no such cap.
 */
export async function freeSlug(db: D1Database, base: string): Promise<string> {
	const taken = await db
		.prepare('SELECT archive_slug FROM campaigns WHERE archive_slug = ?1 OR substr(archive_slug, 1, length(?2)) = ?2')
		.bind(base, `${base}-`)
		.all<{ archive_slug: string }>();
	const set = new Set(taken.results.map((r) => r.archive_slug));
	if (!set.has(base)) return base;
	for (let n = 2; ; n++) if (!set.has(`${base}-${n}`)) return `${base}-${n}`;
}

export type PublishResult = { ok: true; slug: string; already: boolean } | { ok: false; error: string };

/** Publish one sent broadcast. The slug is set once (first publish) and never changed. */
export async function publishIssue(db: D1Database, id: number): Promise<PublishResult> {
	const r = await pubRow(db, id);
	if (!r) return { ok: false, error: 'Campaign not found.' };
	if (!isArchivable(r)) return { ok: false, error: 'Only sent broadcasts can be published to the newsletter archive.' };
	if (r.archive_published_at && r.archive_slug) return { ok: true, slug: r.archive_slug, already: true };
	let slug = r.archive_slug;
	for (let attempt = 0; !slug && attempt < 5; attempt++) {
		const candidate = await freeSlug(db, archiveSlugBase(r.sent_at, r.subject));
		try {
			const res = await db
				.prepare('UPDATE campaigns SET archive_slug = ? WHERE id = ? AND archive_slug IS NULL')
				.bind(candidate, id)
				.run();
			if (res.meta.changes) slug = candidate;
			else slug = (await pubRow(db, id))?.archive_slug ?? null; // someone else set it
		} catch {
			// UNIQUE race with another publish: pick again.
		}
	}
	if (!slug) return { ok: false, error: 'Could not pick a URL for this issue. Try again.' };
	// #499: the issue number is set on first publish (MAX + 1) in the same statement, so two
	// publishes can't take the same one; an issue that already has one (re-publish) keeps it.
	for (let attempt = 0; ; attempt++) {
		try {
			await db
				.prepare(
					`UPDATE campaigns SET archive_published_at = COALESCE(archive_published_at, datetime('now')),
					   archive_number = COALESCE(archive_number, (SELECT COALESCE(MAX(archive_number), 0) + 1 FROM campaigns))
					 WHERE id = ?`
				)
				.bind(id)
				.run();
			break;
		} catch (e) {
			if (attempt >= 3) throw e; // UNIQUE race on the number: read MAX again
		}
	}
	return { ok: true, slug, already: false };
}

/** #499: bulk publish — oldest sent first, so new issue numbers follow the sent order. */
export async function publishIssues(db: D1Database, ids: number[]): Promise<PublishResult[]> {
	if (!ids.length) return [];
	const order = await db
		.prepare('SELECT id FROM campaigns WHERE id IN (SELECT value FROM json_each(?)) ORDER BY sent_at ASC, id ASC')
		.bind(JSON.stringify(ids))
		.all<{ id: number }>();
	const found = order.results.map((r) => r.id);
	const sorted = [...found, ...ids.filter((id) => !found.includes(id))];
	const out: PublishResult[] = [];
	for (const id of sorted) out.push(await publishIssue(db, id));
	return out;
}

/** #499: the issue-number field. '' = no number, else a positive whole number. */
export function parseIssueNumber(raw: string): { ok: true; number: number | null } | { ok: false; error: string } {
	const s = raw.trim();
	if (!s) return { ok: true, number: null };
	const n = Number(s);
	if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < 1) return { ok: false, error: 'Issue number must be a positive whole number.' };
	return { ok: true, number: n };
}

/** #499: set (null = clear) a sent broadcast's issue number; unique among campaigns. */
export async function setIssueNumber(
	db: D1Database,
	id: number,
	number: number | null
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
	const r = await pubRow(db, id);
	if (!r || !isArchivable(r)) return { ok: false, error: 'Only sent broadcasts have an issue number.', status: 404 };
	if (number === r.archive_number) return { ok: true };
	if (number !== null) {
		const other = await db
			.prepare('SELECT subject FROM campaigns WHERE archive_number = ? AND id != ?')
			.bind(number, id)
			.first<{ subject: string }>();
		if (other) return { ok: false, error: `Issue ${number} is already used by '${other.subject}'.`, status: 400 };
	}
	try {
		await db.prepare('UPDATE campaigns SET archive_number = ? WHERE id = ?').bind(number, id).run();
	} catch {
		return { ok: false, error: `Issue ${number} is already used by another campaign.`, status: 400 };
	}
	return { ok: true };
}

/** Remove from the archive (the slug is kept, so re-publishing restores the same URL). */
export async function unpublishIssue(db: D1Database, id: number): Promise<boolean> {
	const res = await db.prepare('UPDATE campaigns SET archive_published_at = NULL WHERE id = ? AND archive_published_at IS NOT NULL').bind(id).run();
	return res.meta.changes > 0;
}

/** Compose's "Publish to newsletter archive after sending". */
export async function setArchiveAfterSend(db: D1Database, id: number, on: boolean): Promise<void> {
	await db.prepare('UPDATE campaigns SET archive_after_send = ? WHERE id = ?').bind(on ? 1 : 0, id).run();
}

/** Called when a campaign becomes 'sent' (compose send, scheduler, best-time drain). Publishes
 *  when Compose's checkbox was ticked or the audience / topic is an auto-publish group.
 *  Best-effort: never throws (a send must never fail on the archive). */
export async function autoPublishOnSent(db: D1Database, id: number): Promise<boolean> {
	try {
		const r = await pubRow(db, id);
		if (!r || !isArchivable(r) || r.archive_published_at) return false;
		let want = r.archive_after_send === 1;
		if (!want) {
			const { autoGroups } = await getArchiveSettings(db);
			if (autoGroups.length) {
				const audience = await readAudience(db, id, r.list_id);
				const topic = await campaignTopicId(db, id);
				want = audience.include.some((g) => autoGroups.includes(g)) || (topic != null && autoGroups.includes(topic));
			}
		}
		if (!want) return false;
		return (await publishIssue(db, id)).ok;
	} catch (e) {
		console.error('newsletter archive auto-publish failed', id, e);
		return false;
	}
}

/** Admin list (Settings → Newsletter archive). */
export type PublishedAdminRow = { id: number; subject: string; sent_at: string | null; slug: string; published_at: string; number: number | null };
export async function publishedForAdmin(db: D1Database): Promise<PublishedAdminRow[]> {
	const rows = await db
		.prepare(
			`SELECT c.id, c.subject, c.sent_at, c.archive_slug AS slug, c.archive_published_at AS published_at, c.archive_number AS number
			 FROM campaigns c WHERE ${PUBLISHED_SQL} ORDER BY c.sent_at DESC, c.id DESC LIMIT 500`
		)
		.all<PublishedAdminRow>();
	return rows.results;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export type IssueSummary = {
	id: number;
	slug: string;
	/** The page title: the web version's title (#483), else the subject. */
	subject: string;
	/** The email's own subject, resolved the public way. */
	email_subject: string;
	/** Has a web-only version (#483). */
	edited: boolean;
	/** The preheader, else the opening of the issue's text (issueTeaser). */
	teaser: string | null;
	sent_at: string;
	thumb: string | null;
	/** #499: the issue number, null = none. */
	number: number | null;
};

type IssueListRow = {
	id: number;
	archive_slug: string;
	subject: string;
	preheader: string | null;
	sent_at: string | null;
	body_blocks: string | null;
	body_md: string | null;
	from_email: string | null;
	template_kind: string | null;
	archive_number?: number | null;
} & WebColumns;

/** #483: the web-only version's columns (all NULL = none). */
export type WebColumns = {
	archive_title?: string | null;
	archive_teaser?: string | null;
	archive_blocks?: string | null;
	archive_edited_at?: string | null;
};
const WEB_COLS = 'c.archive_title, c.archive_teaser, c.archive_blocks, c.archive_edited_at';

/** #483: the row as the archive shows it — the web version's title, teaser and body when one
 *  was saved, else the email's. `web_only` = the body is the web version's blocks (possibly
 *  empty: a raw-HTML campaign started from blank), never the email's markdown / HTML. */
export function webVersion<T extends Omit<IssueListRow, 'id' | 'archive_slug' | 'sent_at'> & { body_html?: string | null }>(r: T): T & { web_only: boolean } {
	if (!r.archive_edited_at) return { ...r, web_only: false };
	const title = (r.archive_title ?? '').trim();
	const teaser = (r.archive_teaser ?? '').trim();
	const out = { ...r, subject: title || r.subject, preheader: teaser || r.preheader, web_only: r.archive_blocks != null };
	if (r.archive_blocks != null) Object.assign(out, { body_blocks: r.archive_blocks, body_md: '', body_html: '', template_kind: null });
	return out;
}

const ORDER = 'ORDER BY c.sent_at DESC, c.id DESC';

export async function countIssues(db: D1Database): Promise<number> {
	return (await db.prepare(`SELECT COUNT(*) AS n FROM campaigns c WHERE ${PUBLISHED_SQL}`).first<{ n: number }>())?.n ?? 0;
}

/** Published issues, newest first. Subjects keep merge tags resolved the public way. */
export async function listIssues(db: D1Database, opts: { limit: number; offset: number }): Promise<IssueSummary[]> {
	const rows = await db
		.prepare(
			`SELECT c.id, c.archive_slug, c.subject, c.preheader, c.sent_at, c.body_blocks, c.body_md, c.from_email,
			        t.kind AS template_kind, c.archive_number, ${WEB_COLS}
			 FROM campaigns c LEFT JOIN templates t ON t.id = c.template_id
			 WHERE ${PUBLISHED_SQL} ${ORDER} LIMIT ? OFFSET ?`
		)
		.bind(opts.limit, opts.offset)
		.all<IssueListRow>();
	return rows.results.map((row) => {
		const r = webVersion(row);
		return {
			id: r.id,
			slug: r.archive_slug,
			subject: publicText(r.subject),
			email_subject: publicText(row.subject),
			edited: !!row.archive_edited_at,
			teaser: (r.preheader ? publicText(r.preheader) : '') || issueTeaser(r) || null,
			sent_at: r.sent_at ?? '',
			thumb: firstImage(r.body_blocks, r.body_md),
			number: row.archive_number ?? null
		};
	});
}

/** Tracking pixels / click-tracking hosts — never shown, never a thumbnail. */
const TRACKING_URL = /pstmrk\.it|\/track\/|open\.gif|pixel/i;

/** A site icon rather than content: an /icons/ path, or "favicon" / "logo" in the file name. */
function iconSrc(src: string): boolean {
	let path = src;
	try {
		path = new URL(src).pathname;
	} catch {
		// relative or junk: test it as-is
	}
	return /\/icons?\//i.test(path) || /favicon|logo/i.test(path.slice(path.lastIndexOf('/') + 1));
}

/** The first image of an issue that looks like content (blocks, else markdown), for
 *  thumbnails and og:image. Logo chips, wordmarks, small images (under ~200px: a pixel width,
 *  or a share of the 600px email column) and site icons are skipped. None → null. */
export function firstImage(blocksJson: string | null, md: string | null): string | null {
	const content = (b: Extract<Block, { type: 'image' }>) =>
		/^https?:\/\//i.test(b.src) &&
		!TRACKING_URL.test(b.src) &&
		!iconSrc(b.src) &&
		!b.visibility &&
		b.style !== 'chip' &&
		!b.beside &&
		!(b.widthPct ? b.widthPct < 34 : b.width && b.width < 200);
	const walk = (bs: Block[]): string | null => {
		for (const b of bs) {
			if (b.type === 'image' && content(b)) return b.src;
			if (b.type === 'section') {
				const s = walk(b.blocks);
				if (s) return s;
			}
			if (b.type === 'columns') for (const cell of b.cells) {
				const s = walk(cell);
				if (s) return s;
			}
		}
		return null;
	};
	const blocks = blocksJson ? sanitizeBlocks(parseBlocks(blocksJson), { allowContent: false }) : [];
	if (blocks.length) return walk(blocks);
	for (const m of (md ?? '').matchAll(/!\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?/gi)) if (!TRACKING_URL.test(m[1]) && !iconSrc(m[1])) return m[1];
	return null;
}

const TEASER_MAX = 160;
/** Links the page drops (unsubscribe / preferences / click tracking): their text goes too. */
const PRIVATE_LINK = /%%UNSUB_URL%%|unsubscribe|preferences|pstmrk\.it|\/track\/|[?&]dsv=/i;
/** #560: an href that is only an in-page fragment (leading `#`, e.g. a table of contents entry
 *  `#manage-preferences`) never leaves the page, so it is never a private link. Only a leading
 *  `#` counts: `/preferences#top` or `https://x/unsubscribe#a` stay private. */
const FRAGMENT_HREF = /^\s*#/;
const privateHref = (href: string) => !FRAGMENT_HREF.test(href) && PRIVATE_LINK.test(href);

/** A heading or list item reads as its own sentence once the text is run together. */
const sentence = (s: string) => (!s.trim() || /[.!?:;…]$/.test(s.trim()) ? s : `${s.trimEnd()}.`);

function markdownPlainText(md: string): string {
	return md
		.replace(/^\s*```.*$/gm, '')
		.replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, t: string, u: string) => (privateHref(u) ? '' : t))
		.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, (_m, h: string) => sentence(h))
		.replace(/^\s{0,3}(?:>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
		.replace(/\*\*|__|~~|`/g, '')
		.replace(/(^|\W)[*_](?=\S)([^*_\n]+?)[*_](?=\W|$)/g, '$1$2');
}

/** The teaser when an issue has no preheader: the opening ~160 characters of its text
 *  (paragraphs, headings, lists — or the markdown), with merge tags and conditionals
 *  resolved the way the page resolves them, cut on a word boundary with an ellipsis.
 *  Raw-HTML template campaigns have no teaser (their markdown is a placeholder). */
export function issueTeaser(r: Pick<IssueListRow, 'body_blocks' | 'body_md' | 'from_email' | 'template_kind'>): string {
	const inline = (nodes: Inline[]) =>
		inlinePlainText(nodes.filter((n) => !(n.type !== 'hardBreak' && n.marks?.some((m) => m.type === 'link' && privateHref(m.href)))));
	const text = (bs: Block[]): string[] =>
		bs.flatMap((b) => {
			switch (b.type) {
				case 'heading':
					return [sentence(b.content ? inline(b.content) : b.text)];
				case 'paragraph':
				case 'quote':
				case 'callout':
					return [inline(b.content)];
				case 'list':
					return b.items.map((it) => sentence(inline(it)));
				case 'text':
					return [markdownPlainText(b.md)];
				case 'section':
					return text(b.blocks);
				case 'columns':
					return b.cells.flatMap(text);
				default:
					return [];
			}
		});
	const blocks = r.body_blocks ? sanitizeBlocks(parseBlocks(r.body_blocks), { allowContent: false }) : [];
	let raw = '';
	if (blocks.length) raw = text(publicBlocks(blocks)).filter((t) => t.trim()).join('\n');
	else if (r.template_kind !== 'html') raw = markdownPlainText(r.body_md ?? '');
	let s = publicText(raw);
	if (r.from_email && r.from_email.includes('@')) s = s.replace(new RegExp(escRe(r.from_email.trim()), 'gi'), '');
	s = s.replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
	const chars = [...s];
	if (chars.length <= TEASER_MAX) return s;
	const cut = chars.slice(0, TEASER_MAX + 1).join('');
	const at = cut.lastIndexOf(' ');
	return `${(at > TEASER_MAX / 2 ? cut.slice(0, at) : chars.slice(0, TEASER_MAX).join('')).replace(/[\s.,;:!?…—–-]+$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Public content: merge tags, conditionals, scrubbing
// ---------------------------------------------------------------------------

const ANON = { tags: new Set<string>(), fields: {} as Record<string, unknown> };
// Personal tags without a fallback: drop the space before them so "Hi {{last_name}}," → "Hi,".
const VANISHING = /[ \t]+(?=\{\{(?:last_name|company|email|field:[\w\- ]+|company\.[a-z0-9_]+)\}\})/g;

function publicResolve(token: string): string | null {
	if (token === 'first_name' || token === 'name') return 'there'; // the send path's fallback
	if (token === 'last_name' || token === 'company' || token === 'email') return '';
	if (token.startsWith('field:')) return '';
	const ct = parseCompanyToken(token);
	return ct ? ct.fallback : null;
}

/** Subject / preheader: conditionals for an anonymous reader, then the public merge values. */
export function publicText(s: string): string {
	const evaluated = evaluateConditionals(String(s ?? ''), ANON);
	return applyMergeTokens(evaluated.replace(VANISHING, ''), 'text', publicResolve).trim();
}

/** #531: the page renderers escape token text, so a company fallback arrives as
 *  `&quot;your team&quot;`; unescape it once here and applyMergeTokens escapes it once. */
function publicResolveHtml(token: string): string | null {
	const ct = parseCompanyToken(token);
	return ct ? unescapeHtmlText(ct.fallback) : publicResolve(token);
}

// #531: evaluateConditionals entity-decodes every `{{#if …}}` tag before reading it, and a
// malformed or unclosed one stays in the output — decoded, so escaped text came out as live
// markup. Each tag is swapped for an inert stand-in that evaluates the same for an anonymous
// reader; stand-ins still there afterwards get the tag's original (escaped) bytes back.
const IF_TAG = /\{\{#if\s+[^}]+\}\}/g; // = restoreConditionalPunctuation's
const IF_STANDIN = /\{\{#if (?:!?tag:)?pmk531-(\d+)\}\}/g;

function shieldIfTags(html: string): { html: string; restore: (s: string) => string } {
	const tags: string[] = [];
	const out = html.replace(IF_TAG, (tag) => {
		const r = conditionalTagResult(tag, ANON);
		const n = tags.push(tag) - 1;
		return `{{#if ${r === null ? '' : r ? '!tag:' : 'tag:'}pmk531-${n}}}`;
	});
	const restore = (s: string) => (tags.length ? s.replace(IF_STANDIN, (_, n: string) => tags[Number(n)] ?? '') : s);
	return { html: out, restore };
}

// #531: applyMergeTokens turns `%7B%7B…%7D%7D` in an href / src back into `{{…}}` (marked's old
// link encoding). Decoded quotes or brackets there would end the attribute early, so those stay
// encoded (`%257B`) and the URL stays inert. Done over the whole HTML: attribute boundaries
// can move once conditionals are resolved.
function inertEncodedTokens(html: string): string {
	return html.replace(/%7B%7B([\w:%#.\- ]*?)%7D%7D/gi, (enc, inner: string) => {
		let text = inner;
		try {
			text = decodeURIComponent(inner);
		} catch {
			/* undecodable: applyMergeTokens keeps it encoded too */
		}
		return /["'<>{}`]/.test(text) ? enc.replace(/%7B/gi, '%257B') : enc;
	});
}

/** HTML: conditionals (anonymous: no tags, no fields), merge tags, then scrubbing. #531: no
 *  `{{#if}}` is decoded into markup, and any `{{…}}` left over is shown as text. */
export function publicHtml(html: string, fromEmail: string | null): string {
	const shield = shieldIfTags(inertEncodedTokens(html));
	const evaluated = evaluateConditionals(shield.html, ANON, { mode: 'html' });
	const merged = applyMergeTokens(evaluated.replace(VANISHING, ''), 'html', publicResolveHtml);
	return scrubPublicHtml(escapeLeftoverMergeTokens(shield.restore(merged)), fromEmail);
}

/** #594: drop every `<div class="signature">` the email shell wrapped around the signature,
 *  with its whole content (nested divs balanced), so a campaign sent with any signature —
 *  before or after the setting changed — shows none. A bare `missive_signature` block too. */
export function stripSignatureBlocks(html: string): string {
	const open = /<div\b[^>]*\bclass\s*=\s*(["'])(?:signature|missive_signature)\1[^>]*>/i;
	let out = html;
	for (let guard = 0; guard < 50; guard++) {
		const m = open.exec(out);
		if (!m) break;
		const tag = /<(\/?)div\b[^>]*>/gi;
		tag.lastIndex = m.index + m[0].length;
		let depth = 1;
		let end = out.length;
		let t: RegExpExecArray | null;
		while ((t = tag.exec(out))) {
			depth += t[1] ? -1 : 1;
			if (depth === 0) {
				end = t.index + t[0].length;
				break;
			}
		}
		out = out.slice(0, m.index) + out.slice(end);
	}
	return out;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip what must never be public: unsubscribe / preference links and the placeholder,
 *  tracking pixels and click-tracking URLs, scripts, the email footer (permission reminder =
 *  the list's origin note) and signature, and the From address. */
export function scrubPublicHtml(html: string, fromEmail: string | null): string {
	let out = html;
	out = out.replace(/<script\b[\s\S]*?<\/script>/gi, '');
	out = out.replace(/<div class="footer"[^>]*>[\s\S]*?<\/div>/gi, '');
	out = stripSignatureBlocks(out);
	const bad = '(?:%%UNSUB_URL%%|unsubscribe|preferences|pstmrk\\.it|click\\.pstmrk|/track/|[?&]dsv=)';
	// #560: `(?!\s*#)` exempts an href that is only an in-page fragment (a table of contents entry
	// such as `#manage-preferences`); anything with a scheme, path, query or placeholder stays matched.
	out = out.replace(new RegExp(`<a\\b[^>]*\\bhref\\s*=\\s*(["'])(?!\\s*#)[^"']*${bad}[^"']*\\1[^>]*>[\\s\\S]*?<\\/a>`, 'gi'), '');
	out = out.replace(new RegExp(`<a\\b[^>]*\\bhref\\s*=\\s*(["'])(?!\\s*#)[^"']*${bad}[^"']*\\1[^>]*>`, 'gi'), '<a>');
	out = out.replace(/<img\b[^>]*\b(?:width|height)\s*=\s*["']?(?:0|1)(?:px)?["']?(?=[\s/>])[^>]*>/gi, '');
	out = out.replace(/<img\b[^>]*>/gi, (tag) => (TRACKING_URL.test(tag) ? '' : tag));
	out = out.replaceAll('%%UNSUB_URL%%', '');
	out = out.replace(/You(?:'|&#39;|’)re receiving this email because:[^<]*(<br\s*\/?>)?/gi, '');
	if (fromEmail && fromEmail.includes('@')) {
		const addr = escRe(fromEmail.trim());
		out = out.replace(new RegExp(`<a\\b[^>]*href\\s*=\\s*(["'])mailto:${addr}[^"']*\\1[^>]*>[\\s\\S]*?<\\/a>`, 'gi'), '');
		out = out.replace(new RegExp(addr, 'gi'), '');
	}
	return out;
}

/** Drop blocks only some readers would see (per-recipient visibility): an anonymous reader
 *  has no tags or fields, so only "doesn't have tag" rules pass. */
export function publicBlocks(blocks: Block[]): Block[] {
	const keep = (b: Block) => !b.visibility || b.visibility.kind === 'no-tag';
	return blocks.filter(keep).map((b) => {
		if (b.type === 'section') return { ...b, blocks: publicBlocks(b.blocks) };
		if (b.type === 'columns') return { ...b, cells: b.cells.map((c) => publicBlocks(c)) };
		return b;
	});
}

const escHtml = (s: string) =>
	String(s ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

type IssueRow = IssueListRow & { body_html: string | null };

/** The issue's own content as page HTML (blocks → page renderer; markdown; raw HTML → iframe).
 *  `web_only` (#483): the web version's blocks, even when empty. */
export function issueContentHtml(r: Pick<IssueRow, 'body_blocks' | 'body_md' | 'body_html' | 'from_email' | 'template_kind'> & { web_only?: boolean }): string {
	const blocks = r.body_blocks ? sanitizeBlocks(parseBlocks(r.body_blocks), { allowContent: false }) : [];
	if (blocks.length || r.web_only) return publicHtml(renderPageBlocks(publicBlocks(blocks)), r.from_email);
	// #531: the safe page parser (raw HTML shown as text), not the email one.
	if (r.template_kind !== 'html' && (r.body_md ?? '').trim()) return publicHtml(parseMarkdownSafe(r.body_md ?? ''), r.from_email);
	// Raw-HTML template campaigns: the stored email, scrubbed, in a sandboxed frame (no scripts,
	// no same-origin). It looks like the email, not like the web template.
	const doc = publicHtml(r.body_html ?? '', r.from_email);
	return `<iframe class="nl-frame" title="Newsletter content" sandbox="" loading="lazy" referrerpolicy="no-referrer" srcdoc="${escHtml(doc)}"></iframe>`;
}

// ---------------------------------------------------------------------------
// Web template
// ---------------------------------------------------------------------------

/** `theme` (#595): the install's archive colours, under the template's own bg / link. */
export type WebTemplate = { blocks: Block[]; canvas: WebCanvas; theme: ArchiveTheme };

/** The built-in default (also "Start from default"): the logo (`brandLogo`) linking to the
 *  archive (left out when there is none, #595), the content area, then the mailing address
 *  and "← All newsletters". */
export function defaultWebTemplateBlocks(opts: { logoUrl: string | null; logoAlt: string; mailingAddress: string | null; archiveUrl: string }): Block[] {
	const id = () => crypto.randomUUID();
	const blocks: Block[] = [];
	if (opts.logoUrl) blocks.push({ id: id(), type: 'image', src: opts.logoUrl, alt: opts.logoAlt, href: opts.archiveUrl, widthPct: 30, align: 'left' } as Block);
	blocks.push({ id: id(), type: 'content' });
	const addr = (opts.mailingAddress ?? '').trim();
	if (addr) {
		const lines = addr.split(/\r?\n/).filter((l) => l.trim());
		const content = lines.flatMap((l, i) => (i ? [{ type: 'hardBreak' }, { type: 'text', text: l.trim() }] : [{ type: 'text', text: l.trim() }]));
		blocks.push({ id: id(), type: 'paragraph', content } as Block);
	}
	blocks.push({
		id: id(),
		type: 'paragraph',
		content: [{ type: 'text', text: '← All newsletters', marks: [{ type: 'link', href: opts.archiveUrl }] }],
		showOn: 'issue' // #498: the archive list doesn't need a link to itself
	} as Block);
	return blocks;
}

/** Absolute logo URL: Settings → Branding's upload on this install, else the brand kit's
 *  `primary` logo, else its first logo made for a light background, else none (#595: an empty
 *  kit — a fresh install — has no logo; migration 0122 seeded the former bundled logos). The kit
 *  is read only when no Branding logo is uploaded. */
async function brandLogo(db: D1Database, origin: string): Promise<{ url: string | null; alt: string }> {
	const b = await getBranding(db);
	if (b.logoUrl) return { url: `${trim(origin)}${b.logoUrl}`, alt: b.appName };
	const logos = (await getBrandKit(db)).logos;
	const kit = logos.find((l) => l.key === 'primary') ?? logos.find((l) => l.background === 'light');
	return { url: kit?.src ?? null, alt: b.appName };
}

/** The archive's template: the chosen web template, else the built-in default. */
export async function archiveTemplate(db: D1Database, settings: ArchiveSettings, origin: string): Promise<WebTemplate> {
	if (settings.templateId) {
		const t = await db
			.prepare('SELECT blocks, canvas FROM templates WHERE id = ? AND kind = ?')
			.bind(settings.templateId, WEB_TEMPLATE_KIND)
			.first<{ blocks: string | null; canvas: string | null }>();
		if (t) return { blocks: sanitizeBlocks(parseBlocks(t.blocks), { allowContent: true }), canvas: sanitizeWebCanvas(t.canvas), theme: settings.theme };
	}
	return { blocks: await builtInBlocks(db, origin), canvas: {}, theme: settings.theme };
}

export async function builtInBlocks(db: D1Database, origin: string): Promise<Block[]> {
	const logo = await brandLogo(db, origin);
	const { mailing_address } = await getSettings(db);
	return defaultWebTemplateBlocks({ logoUrl: logo.url, logoAlt: logo.alt, mailingAddress: mailing_address, archiveUrl: `${trim(origin)}${ARCHIVE_PATH}` });
}

/** Template blocks around `main`: top-level blocks before the content area are the header,
 *  after it the footer (each in the article column); a content area inside a section stays
 *  where it is. No content area = main after the blocks. */
function frame(blocks: Block[], main: string, page: ShowOn): string {
	const top = blocks.findIndex((b) => b.type === 'content');
	if (top >= 0) {
		const head = renderPageBlocks(blocks.slice(0, top), undefined, { page });
		const foot = renderPageBlocks(blocks.slice(top + 1), undefined, { page });
		return `${head ? `<header class="nl-head"><div class="nl-col">${head}</div></header>\n` : ''}<main class="nl-main"><div class="nl-col">${main}</div></main>\n${foot ? `<footer class="nl-foot"><div class="nl-col">${foot}</div></footer>` : ''}`;
	}
	const html = renderPageBlocks(blocks, CONTENT_PLACEHOLDER, { page });
	if (html.includes(CONTENT_PLACEHOLDER)) return `<div class="nl-col">${html.replaceAll(CONTENT_PLACEHOLDER, main)}</div>`;
	return `<header class="nl-head"><div class="nl-col">${html}</div></header>\n<main class="nl-main"><div class="nl-col">${main}</div></main>`;
}

/** `t` = the archive theme's colours (#595); the template's canvas overrides bg / link. */
function themeCss(c: WebCanvas, t: ArchiveTheme): string {
	const D = { ...WEB_DEFAULTS, ...t };
	const width = c.width ?? D.width;
	const size = c.fontSize ?? D.fontSize;
	const link = c.link ?? D.link;
	const bg = c.bg ?? D.bg;
	return `
  :root { color-scheme: light dark;
    --nl-bg:${bg}; --nl-surface:${D.surface}; --nl-text:${D.text}; --nl-muted:${D.muted}; --nl-hair:${D.hairline};
    --nl-link:${link}; --nl-brand:${link}; --nl-on-brand:${D.onBrand};
    --nl-width:${width}px; --nl-size:${size}px; --nl-font:${webFontStack(c.font)}; }
  @media (prefers-color-scheme: dark) {
    :root { --nl-bg:${D.darkBg}; --nl-surface:${D.darkSurface}; --nl-text:${D.darkText}; --nl-muted:${D.darkMuted};
      --nl-hair:${D.darkHairline}; --nl-link:${D.darkLink}; --nl-brand:${D.darkLink}; --nl-on-brand:${D.darkOnBrand}; }
    .nl-head img { background:#ffffff; padding:8px 12px; border-radius:10px; box-sizing:content-box; }
    .b-callout { background:var(--nl-surface) !important; }
  }
  body { margin:0; background:var(--nl-bg); color:var(--nl-text); font-family:var(--nl-font);
    font-size:var(--nl-size); line-height:${D.lineHeight}; -webkit-font-smoothing:antialiased; }
  a { color:var(--nl-link); text-underline-offset:2px; }
  .nl-col { max-width:var(--nl-width); margin:0 auto; padding:0 24px; box-sizing:border-box; }
  .nl-head { padding:28px 0 20px; border-bottom:1px solid var(--nl-hair); }
  .nl-head .b-img, .nl-head p { margin:0; }
  .nl-head img { max-height:44px; width:auto !important; border-radius:0; }
  .nl-main { padding:48px 0 64px; }
  .nl-foot { padding:32px 0 56px; border-top:1px solid var(--nl-hair); color:var(--nl-muted); font-size:15px; line-height:1.6; }
  .nl-foot p { margin:0 0 10px; }
  .nl-foot a { color:var(--nl-muted); }
  .nl-kicker { margin:0 0 12px; font-size:14px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:var(--nl-muted); }
  .nl-kicker a { color:inherit; text-decoration:none; }
  .nl-title { font-size:clamp(32px, 5vw, 46px); line-height:1.12; letter-spacing:-0.02em; margin:0 0 12px; font-weight:750; }
  .nl-date { margin:0 0 36px; color:var(--nl-muted); font-size:16px; }
  .nl-body h1 { font-size:32px; } .nl-body h2 { font-size:26px; } .nl-body h3 { font-size:21px; }
  .nl-body blockquote { border-left-color:var(--nl-brand); color:var(--nl-muted); }
  .nl-body hr { border-top-color:var(--nl-hair); }
  .nl-body .b-img img:not([style*="width"]) { width:100%; }
  .nl-body img { border-radius:12px; }
  .nl-body .btn { background:var(--nl-brand); color:var(--nl-on-brand); }
  .nl-body .b-callout { background:var(--nl-surface); border:1px solid var(--nl-hair); }
  .nl-frame { display:block; width:100%; min-height:80vh; height:1400px; border:0; border-radius:12px; background:#ffffff; }
  .nl-sub { margin:56px 0 0; padding:32px; border-radius:16px; background:var(--nl-brand); color:var(--nl-on-brand); }
  .nl-sub h2 { margin:0 0 8px; font-size:24px; line-height:1.25; }
  .nl-sub p { margin:0 0 20px; opacity:0.9; font-size:16px; }
  .nl-sub a.nl-sub-btn { display:inline-block; padding:12px 24px; border-radius:999px; background:var(--nl-on-brand); color:var(--nl-brand);
    font-weight:700; text-decoration:none; font-size:16px; }
  .nl-pn { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:48px 0 0; }
  .nl-pn a { display:block; padding:18px 20px; border:1px solid var(--nl-hair); border-radius:12px; background:var(--nl-surface);
    color:var(--nl-text); text-decoration:none; font-size:16px; line-height:1.4; }
  .nl-pn a:hover { border-color:var(--nl-link); }
  .nl-pn small { display:block; color:var(--nl-muted); font-size:13px; margin:0 0 4px; }
  .nl-pn .next { grid-column:2; text-align:right; }
  .nl-intro { margin:0 0 12px; color:var(--nl-muted); font-size:calc(var(--nl-size) + 1px); }
  .nl-year { margin:48px 0 16px; font-size:15px; letter-spacing:0.08em; text-transform:uppercase; color:var(--nl-muted); }
  .nl-list { list-style:none; margin:0; padding:0; display:grid; gap:14px; }
  .nl-card a { display:flex; gap:20px; align-items:center; padding:20px; border:1px solid var(--nl-hair); border-radius:14px;
    background:var(--nl-surface); color:var(--nl-text); text-decoration:none; }
  .nl-card a:hover { border-color:var(--nl-link); }
  .nl-card-text { flex:1; min-width:0; }
  .nl-card time { display:block; font-size:14px; color:var(--nl-muted); margin:0 0 4px; }
  .nl-card h3 { margin:0 0 4px; font-size:21px; line-height:1.3; }
  .nl-card p { margin:0; color:var(--nl-muted); font-size:16px; line-height:1.5; }
  .nl-card img { flex:0 0 120px; width:120px; height:84px; object-fit:cover; border-radius:10px; }
  .nl-pages { display:flex; justify-content:space-between; margin:40px 0 0; font-size:16px; }
  .nl-empty { color:var(--nl-muted); }
  @media (max-width:600px) {
    .nl-main { padding:32px 0 48px; }
    .nl-pn { grid-template-columns:1fr; }
    .nl-pn .next { grid-column:1; }
    .nl-card a { flex-direction:column-reverse; align-items:stretch; }
    .nl-card img { width:100%; height:auto; aspect-ratio:16 / 9; flex-basis:auto; }
    .nl-sub { padding:24px; }
  }`;
}

type Meta = {
	title: string;
	description: string;
	canonical: string;
	image: string | null;
	indexable: boolean;
	feedUrl: string;
	type: 'website' | 'article';
};

/** #560: a table of contents in the page (the issue's own blocks or the web template's): only
 *  the package renderer writes this tag (block text is escaped, raw-HTML issues sit escaped in
 *  an iframe's srcdoc), so pages without one keep exactly their old CSS. */
const hasTocNav = (html: string) => html.includes('<nav class="b-toc"');

/** #498: `meta.type` 'article' = an issue page, 'website' = the archive list (Show on). */
function documentHtml(meta: Meta, tpl: WebTemplate, main: string, extra: { css?: string; head?: string } = {}): string {
	const e = escHtml;
	const desc = meta.description.slice(0, 300);
	const body = frame(tpl.blocks, main, meta.type === 'website' ? 'index' : 'issue');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(meta.title)}</title>
${desc ? `<meta name="description" content="${e(desc)}">\n` : ''}${meta.indexable ? '' : '<meta name="robots" content="noindex">\n'}<link rel="canonical" href="${e(meta.canonical)}">
<link rel="alternate" type="application/rss+xml" title="RSS" href="${e(meta.feedUrl)}">
<meta property="og:type" content="${meta.type}">
<meta property="og:title" content="${e(meta.title)}">
${desc ? `<meta property="og:description" content="${e(desc)}">\n` : ''}<meta property="og:url" content="${e(meta.canonical)}">
${meta.image ? `<meta property="og:image" content="${e(meta.image)}">\n` : ''}<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${e(meta.title)}">
${desc ? `<meta name="twitter:description" content="${e(desc)}">\n` : ''}${meta.image ? `<meta name="twitter:image" content="${e(meta.image)}">\n` : ''}${extra.head ?? ''}<style>
${PAGE_CSS}${hasTocNav(body) ? PAGE_TOC_CSS : ''}${themeCss(tpl.canvas, tpl.theme)}${extra.css ?? ''}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function formatDate(sentAt: string, tz: string): string {
	const d = new Date(`${sentAt.replace(' ', 'T').slice(0, 19)}Z`);
	if (Number.isNaN(d.getTime())) return sentAt.slice(0, 10);
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' }).format(d);
	} catch {
		return sentAt.slice(0, 10);
	}
}

function yearOf(sentAt: string, tz: string): string {
	const d = new Date(`${sentAt.replace(' ', 'T').slice(0, 19)}Z`);
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(d);
	} catch {
		return sentAt.slice(0, 4);
	}
}

/** #499: "Issue 12". */
export const issueLabel = (n: number) => `Issue ${n}`;
/** #499: "Issue 12 · <title>" when numbered, else the title. */
export const numbered = (n: number | null | undefined, title: string) => (n != null ? `${issueLabel(n)} · ${title}` : title);

function subscribeBox(url: string, signup = false): string {
	if (signup) {
		// #587: the button opens the popup; browsers without popover get the plain link instead.
		return `<aside class="nl-sub"><h2>Get the next one in your inbox</h2><p>One email when there's something worth sharing. Unsubscribe anytime.</p><button type="button" class="nl-sub-open" popovertarget="${SIGNUP_POPOVER_ID}">Subscribe</button><a class="nl-sub-btn nl-sub-link" href="${ARCHIVE_SUBSCRIBE_PATH}">Subscribe</a></aside>`;
	}
	if (!url) return '';
	return `<aside class="nl-sub"><h2>Get the next one in your inbox</h2><p>One email when there's something worth sharing. Unsubscribe anytime.</p><a class="nl-sub-btn" href="${escHtml(url)}">Subscribe</a></aside>`;
}

export type PageCtx = {
	/** Public origin for canonical / og URLs (Settings → Domain, else the request's). */
	base: string;
	/** The request's origin (relative links stay relative; images need absolute). */
	origin: string;
	/** #491: rendering for the public host — `base` / `origin` are that host and every CRM
	 *  URL left in the output (`crmBase`) is rewritten by `publicizeHtml`. */
	publicMode?: boolean;
	crmBase?: string | string[];
};

/** #491: the public-host rewrite, only in public mode. */
const finish = (out: string, ctx: PageCtx) => (ctx.publicMode ? publicizeHtml(out, ctx.crmBase ?? [], ctx.base) : out);

const trim = (s: string) => s.replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Sign-up form (#587): a chosen published form, rendered as plain HTML (no script: the pages run
// under PUBLIC_PAGE_CSP) in a popover on the index and issue pages, and on /newsletter/subscribe.
// Every URL here is root-relative, so the public host never shows the CRM host.
// ---------------------------------------------------------------------------

export const SIGNUP_POPOVER_ID = 'nl-signup';

/** The chosen sign-up form while it is still published and plain-renderable; else null (the
 *  pages then fall back to the Subscribe URL link, and /newsletter/subscribe is a 404). */
export async function signupFormFor(db: D1Database, settings: ArchiveSettings): Promise<FormRow | null> {
	if (!settings.signupForm) return null;
	const form = await getForm(db, settings.signupForm);
	if (!form || form.slug !== settings.signupForm || plainFormProblem(form)) return null;
	return form;
}

/** The Subscribe button near the top of a page (popup, plus the no-popover fallback link). */
function topSubscribe(): string {
	return `<p class="nl-top-sub"><button type="button" class="nl-sub-open" popovertarget="${SIGNUP_POPOVER_ID}">Subscribe</button><a class="nl-sub-link" href="${ARCHIVE_SUBSCRIBE_PATH}">Subscribe</a></p>\n`;
}

/** The popup: a visible Close button, then the form (its first field gets `autofocus`, which the
 *  browser focuses when the popover opens). */
function signupPopover(form: FormRow): string {
	return `<div id="${SIGNUP_POPOVER_ID}" class="nl-pop" popover style="${plainFormStyle(form.spec)}" aria-labelledby="${SIGNUP_POPOVER_ID}-title"><button type="button" class="nl-pop-close" popovertarget="${SIGNUP_POPOVER_ID}" popovertargetaction="hide">Close</button>${renderPlainForm(form.spec, { action: ARCHIVE_SUBSCRIBE_PATH, idPrefix: SIGNUP_POPOVER_ID, heading: 'h2', autofocus: true })}</div>`;
}

/** Native-post failures come back to /newsletter/subscribe as `?error=<code>`, like /f/<slug>. */
export const SIGNUP_ERRORS: Record<string, string> = {
	invalid: 'Please check your answers and try again.',
	rate_limit: 'Too many submissions. Please try again in a few minutes.',
	origin: 'This form can’t be submitted from here.',
	failed: 'Something went wrong. Please try again.'
};

/** /newsletter/subscribe — the form on its own page in the archive chrome. null when the archive
 *  is off or no usable form is chosen. */
export async function renderSubscribePage(db: D1Database, ctx: PageCtx, errorCode: string | null = null): Promise<string | null> {
	const settings = await getArchiveSettings(db);
	if (!settings.enabled) return null;
	const form = await signupFormFor(db, settings);
	if (!form) return null;
	const error = errorCode ? (Object.prototype.hasOwnProperty.call(SIGNUP_ERRORS, errorCode) ? SIGNUP_ERRORS[errorCode] : SIGNUP_ERRORS.failed) : null;
	const main = `<div class="nl-signup-page">
${renderPlainForm(form.spec, { action: ARCHIVE_SUBSCRIBE_PATH, idPrefix: 'nl-signup-page', heading: 'h1', error })}
<p class="nl-back"><a href="${ARCHIVE_PATH}">← ${escHtml(settings.title)}</a></p>
</div>`;
	const tpl = await archiveTemplate(db, settings, ctx.origin);
	const base = trim(ctx.base);
	const html = documentHtml(
		{
			title: `${form.spec.title} | ${settings.title}`,
			description: settings.intro.replace(/\s+/g, ' ').trim(),
			canonical: `${base}${ARCHIVE_SUBSCRIBE_PATH}`,
			image: null,
			indexable: settings.indexable && !errorCode,
			feedUrl: `${base}${ARCHIVE_PATH}/feed.xml`,
			type: 'website'
		},
		tpl,
		main,
		{ css: PLAIN_FORM_CSS }
	);
	return finish(html, ctx);
}

/** /newsletter/subscribe/thanks — the form's thank-you message and a link back. When the form's
 *  outcome is a redirect, the page forwards there with a meta refresh (and a Continue link): a 303
 *  from the POST straight to another site is blocked by `form-action 'self'` in browsers that
 *  check redirects. `done` is form-submit's `finishFor`, passed in so this module never imports
 *  form-submit (it reaches Postmark). */
export async function renderSubscribeThanks(
	db: D1Database,
	ctx: PageCtx,
	finishFor: (form: FormRow) => { redirect?: string; message_html?: string }
): Promise<string | null> {
	const settings = await getArchiveSettings(db);
	if (!settings.enabled) return null;
	const form = await signupFormFor(db, settings);
	if (!form) return null;
	const done = finishFor(form);
	const main = done.redirect
		? `<div class="nl-thanks" role="status"><p>Thanks! Taking you to the next step…</p><p><a href="${escHtml(done.redirect)}">Continue</a></p></div>`
		: `<div class="nl-thanks" role="status">${done.message_html ?? ''}</div>
<p class="nl-back"><a href="${ARCHIVE_PATH}">← Back to ${escHtml(settings.title)}</a></p>`;
	const tpl = await archiveTemplate(db, settings, ctx.origin);
	const base = trim(ctx.base);
	const html = documentHtml(
		{
			title: `Thanks | ${settings.title}`,
			description: '',
			canonical: `${base}${ARCHIVE_SUBSCRIBE_PATH}/thanks`,
			image: null,
			indexable: false,
			feedUrl: `${base}${ARCHIVE_PATH}/feed.xml`,
			type: 'website'
		},
		tpl,
		main,
		{ css: PLAIN_FORM_CSS, head: done.redirect ? `<meta http-equiv="refresh" content="0; url=${escHtml(done.redirect)}">\n` : '' }
	);
	return finish(html, ctx);
}

const ISSUE_SELECT = `SELECT c.id, c.archive_slug, c.subject, c.preheader, c.sent_at, c.body_blocks, c.body_md, c.body_html, c.from_email,
	        t.kind AS template_kind, c.archive_number, ${WEB_COLS}
	 FROM campaigns c LEFT JOIN templates t ON t.id = c.template_id`;
/** Prev / next titles: the web version's title when there is one (#483). */
const PN_SELECT = `SELECT c.archive_slug AS slug, CASE WHEN c.archive_edited_at IS NOT NULL THEN COALESCE(NULLIF(TRIM(c.archive_title), ''), c.subject) ELSE c.subject END AS subject FROM campaigns c`;

/** /newsletter/[slug] — null when the archive is off or the issue isn't published. */
export async function renderIssuePage(db: D1Database, slug: string, ctx: PageCtx): Promise<string | null> {
	const settings = await getArchiveSettings(db);
	if (!settings.enabled) return null;
	const r = await db.prepare(`${ISSUE_SELECT} WHERE c.archive_slug = ? AND ${PUBLISHED_SQL}`).bind(slug).first<IssueRow>();
	if (!r) return null;
	return finish(await issueDocument(db, r, settings, ctx, false), ctx);
}

/** #483: the web-version editor's Preview — the issue page for any sent broadcast, whether or
 *  not it's published or the archive is on; always `noindex`. `draft` = unsaved edits (title,
 *  teaser, blocks; blocks null = the email body). null when not a sent broadcast. */
export async function renderIssuePreview(
	db: D1Database,
	id: number,
	ctx: PageCtx,
	draft?: WebVersionInput
): Promise<string | null> {
	const row = await db.prepare(`${ISSUE_SELECT} WHERE c.id = ? AND ${BROADCAST_SENT_SQL}`).bind(id).first<IssueRow>();
	if (!row) return null;
	const r: IssueRow = draft
		? {
				...row,
				archive_title: draft.title.trim() || null,
				archive_teaser: draft.teaser.trim() || null,
				archive_blocks: draft.blocks ? JSON.stringify(sanitizeBlocks(draft.blocks, { allowContent: false })) : null,
				archive_edited_at: 'preview'
			}
		: row;
	return issueDocument(db, r, await getArchiveSettings(db), ctx, true);
}

async function issueDocument(db: D1Database, row: IssueRow, settings: ArchiveSettings, ctx: PageCtx, preview: boolean): Promise<string> {
	const r = webVersion(row);
	const tz = await getTimezone(db);
	const signup = await signupFormFor(db, settings);
	const sentAt = r.sent_at ?? '';
	const [newer, older] = await Promise.all([
		db
			.prepare(`${PN_SELECT} WHERE ${PUBLISHED_SQL} AND (c.sent_at > ? OR (c.sent_at = ? AND c.id > ?)) ORDER BY c.sent_at ASC, c.id ASC LIMIT 1`)
			.bind(sentAt, sentAt, r.id)
			.first<{ slug: string; subject: string }>(),
		db
			.prepare(`${PN_SELECT} WHERE ${PUBLISHED_SQL} AND (c.sent_at < ? OR (c.sent_at = ? AND c.id < ?)) ${ORDER} LIMIT 1`)
			.bind(sentAt, sentAt, r.id)
			.first<{ slug: string; subject: string }>()
	]);
	const subject = publicText(r.subject);
	const teaser = (r.preheader ? publicText(r.preheader) : '') || issueTeaser(r);
	const num = r.archive_number ?? null;
	const pn =
		newer || older
			? `<nav class="nl-pn" aria-label="More issues">${older ? `<a class="prev" href="${ARCHIVE_PATH}/${escHtml(older.slug)}"><small>← Previous issue</small>${escHtml(publicText(older.subject))}</a>` : ''}${newer ? `<a class="next" href="${ARCHIVE_PATH}/${escHtml(newer.slug)}"><small>Next issue →</small>${escHtml(publicText(newer.subject))}</a>` : ''}</nav>`
			: '';
	const main = `<article class="nl-article">
<p class="nl-kicker"><a href="${ARCHIVE_PATH}">${escHtml(settings.title)}</a>${num != null ? ` · <span class="nl-num">${issueLabel(num)}</span>` : ''}</p>
<h1 class="nl-title">${escHtml(subject)}</h1>
<p class="nl-date"><time datetime="${escHtml(sentAt.slice(0, 10))}">${escHtml(formatDate(sentAt, tz))}</time></p>
${signup ? topSubscribe() : ''}<div class="nl-body">
${issueContentHtml(r)}
</div>
${subscribeBox(settings.subscribeUrl, !!signup)}
${pn}
</article>${signup ? `\n${signupPopover(signup)}` : ''}`;
	const tpl = await archiveTemplate(db, settings, ctx.origin);
	const base = trim(ctx.base);
	const image = firstImage(r.body_blocks, r.body_md);
	return documentHtml(
		{
			title: `${numbered(num, subject)} | ${settings.title}`,
			description: teaser,
			canonical: `${base}${ARCHIVE_PATH}/${r.archive_slug ?? ''}`,
			image: image ? new URL(image, ctx.origin).toString() : null,
			indexable: settings.indexable && !preview,
			feedUrl: `${base}${ARCHIVE_PATH}/feed.xml`,
			type: 'article'
		},
		tpl,
		main,
		signup ? { css: PLAIN_FORM_CSS } : {}
	);
}

// ---------------------------------------------------------------------------
// Web-only version (#483)
// ---------------------------------------------------------------------------

export type WebVersionInput = {
	title: string;
	teaser: string;
	/** null = keep the email body (raw-HTML template campaigns not started from blank). */
	blocks: Block[] | null;
};

/** The editor's form: `title`, `teaser`, `body_mode` (`original` = keep the email body, only
 *  for raw-HTML campaigns; else blocks) and `body_blocks` (JSON). */
export function webVersionFromForm(data: FormData): WebVersionInput {
	const original = String(data.get('body_mode') ?? '') === 'original';
	let blocks: Block[] = [];
	if (!original) {
		try {
			const parsed = JSON.parse(String(data.get('body_blocks') ?? '[]'));
			blocks = Array.isArray(parsed) ? sanitizeBlocks(parsed, { allowContent: false }) : [];
		} catch {
			blocks = [];
		}
	}
	return { title: String(data.get('title') ?? ''), teaser: String(data.get('teaser') ?? ''), blocks: original ? null : blocks };
}

/** Validate the editor's fields. Returns an error message, or null. */
export function webVersionProblem(v: WebVersionInput): string | null {
	if ([...v.title.trim()].length > ISSUE_TITLE_MAX) return `Title must be ${ISSUE_TITLE_MAX} characters or fewer.`;
	if ([...v.teaser.trim()].length > ISSUE_TEASER_MAX) return `Teaser must be ${ISSUE_TEASER_MAX} characters or fewer.`;
	return null;
}

/** Save the web version of a sent broadcast. A blank title falls back to the subject, a blank
 *  teaser to the preheader / opening text. Only the archive_* columns are written. */
export async function saveWebVersion(
	db: D1Database,
	id: number,
	v: WebVersionInput
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
	const r = await pubRow(db, id);
	if (!r || !isArchivable(r)) return { ok: false, error: 'Only sent broadcasts have a newsletter archive version.', status: 404 };
	const problem = webVersionProblem(v);
	if (problem) return { ok: false, error: problem, status: 400 };
	const blocks = v.blocks ? JSON.stringify(sanitizeBlocks(v.blocks, { allowContent: false })) : null;
	await db
		.prepare("UPDATE campaigns SET archive_title = ?, archive_teaser = ?, archive_blocks = ?, archive_edited_at = datetime('now') WHERE id = ?")
		.bind(v.title.trim() || null, v.teaser.trim() || null, blocks, id)
		.run();
	return { ok: true };
}

/** Reset to the email version: clears every override. */
export async function resetWebVersion(db: D1Database, id: number): Promise<boolean> {
	const res = await db
		.prepare('UPDATE campaigns SET archive_title = NULL, archive_teaser = NULL, archive_blocks = NULL, archive_edited_at = NULL WHERE id = ?')
		.bind(id)
		.run();
	return res.meta.changes > 0;
}

/** What the editor needs: the email (defaults, seeding) and the saved web version. null when
 *  the campaign isn't a sent broadcast. */
export async function webVersionForEditor(db: D1Database, id: number) {
	const row = await db
		.prepare(`${ISSUE_SELECT.replace('t.kind AS template_kind,', 't.kind AS template_kind, c.archive_published_at,')} WHERE c.id = ? AND ${BROADCAST_SENT_SQL}`)
		.bind(id)
		.first<IssueRow & { archive_published_at: string | null }>();
	if (!row) return null;
	const saved = row.archive_blocks != null ? sanitizeBlocks(parseBlocks(row.archive_blocks), { allowContent: false }) : null;
	const email = row.body_blocks ? sanitizeBlocks(parseBlocks(row.body_blocks), { allowContent: false }) : [];
	const htmlOnly = !email.length && row.template_kind === 'html';
	return {
		id: row.id,
		subject: row.subject,
		slug: row.archive_slug,
		published: !!row.archive_published_at,
		/** A raw-HTML template campaign: no blocks to edit, only "Start from blank". */
		htmlOnly,
		editedAt: row.archive_edited_at ?? null,
		/** #499: the issue number, null = none. */
		number: row.archive_number ?? null,
		title: row.archive_title ?? '',
		teaser: row.archive_teaser ?? '',
		/** What a blank field falls back to on the page. */
		defaultTeaser: (row.preheader ?? '').trim() || issueTeaser(row),
		/** The saved web blocks, else the email's blocks; null = convert `bodyMd` (or raw HTML). */
		blocks: saved ?? (email.length ? email : null),
		bodyMd: htmlOnly ? '' : (row.body_md ?? ''),
		/** A raw-HTML campaign whose saved web version was started from blank. */
		blank: htmlOnly && saved != null
	};
}

/** /newsletter?page=N — null when the archive is off or the page is past the end. */
export async function renderIndexPage(db: D1Database, page: number, ctx: PageCtx): Promise<string | null> {
	const settings = await getArchiveSettings(db);
	if (!settings.enabled) return null;
	const total = await countIssues(db);
	const pages = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));
	if (!Number.isInteger(page) || page < 1 || page > pages) return null;
	const issues = await listIssues(db, { limit: ARCHIVE_PAGE_SIZE, offset: (page - 1) * ARCHIVE_PAGE_SIZE });
	const tz = await getTimezone(db);
	const signup = await signupFormFor(db, settings);

	let list = '';
	let year = '';
	for (const i of issues) {
		const y = yearOf(i.sent_at, tz);
		if (y !== year) {
			list += `${year ? '</ul>\n' : ''}<h2 class="nl-year">${escHtml(y)}</h2>\n<ul class="nl-list">`;
			year = y;
		}
		list += `<li class="nl-card"><a href="${ARCHIVE_PATH}/${escHtml(i.slug)}"><div class="nl-card-text"><time datetime="${escHtml(i.sent_at.slice(0, 10))}">${i.number != null ? `${issueLabel(i.number)} · ` : ''}${escHtml(formatDate(i.sent_at, tz))}</time><h3>${escHtml(i.subject)}</h3>${i.teaser ? `<p>${escHtml(i.teaser)}</p>` : ''}</div>${i.thumb ? `<img src="${escHtml(i.thumb)}" alt="" loading="lazy">` : ''}</a></li>`;
	}
	if (year) list += '</ul>';
	const intro = settings.intro
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => `<p class="nl-intro">${escHtml(p).replace(/\n/g, '<br>')}</p>`)
		.join('\n');
	const nav =
		pages > 1
			? `<nav class="nl-pages" aria-label="Pages">${page > 1 ? `<a href="${ARCHIVE_PATH}${page === 2 ? '' : `?page=${page - 1}`}">← Newer issues</a>` : '<span></span>'}${page < pages ? `<a href="${ARCHIVE_PATH}?page=${page + 1}">Older issues →</a>` : ''}</nav>`
			: '';
	const main = `<div class="nl-index">
<h1 class="nl-title">${escHtml(settings.title)}</h1>
${intro}
${signup ? topSubscribe() : ''}${issues.length ? list : '<p class="nl-empty">No issues yet. Check back soon.</p>'}
${nav}
${page === 1 ? subscribeBox(settings.subscribeUrl, !!signup) : ''}
</div>${signup ? `\n${signupPopover(signup)}` : ''}`;
	const tpl = await archiveTemplate(db, settings, ctx.origin);
	const base = trim(ctx.base);
	const html = documentHtml(
		{
			title: page > 1 ? `${settings.title} (page ${page})` : settings.title,
			description: settings.intro.replace(/\s+/g, ' ').trim(),
			canonical: `${base}${ARCHIVE_PATH}${page > 1 ? `?page=${page}` : ''}`,
			image: issues.find((i) => i.thumb)?.thumb ?? null,
			indexable: settings.indexable,
			feedUrl: `${base}${ARCHIVE_PATH}/feed.xml`,
			type: 'website'
		},
		tpl,
		main,
		signup ? { css: PLAIN_FORM_CSS } : {}
	);
	return finish(html, ctx);
}

const xml = (s: string) =>
	String(s ?? '')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');

function rfc822(sentAt: string): string {
	const d = new Date(`${sentAt.replace(' ', 'T').slice(0, 19)}Z`);
	return Number.isNaN(d.getTime()) ? new Date(0).toUTCString() : d.toUTCString();
}

/** /newsletter/feed.xml — RSS 2.0 of the latest issues. null when the archive is off. */
export async function renderFeed(db: D1Database, ctx: PageCtx): Promise<string | null> {
	const settings = await getArchiveSettings(db);
	if (!settings.enabled) return null;
	const base = trim(ctx.base);
	const issues = await listIssues(db, { limit: ARCHIVE_FEED_SIZE, offset: 0 });
	const items = issues
		.map((i) => {
			const link = `${base}${ARCHIVE_PATH}/${i.slug}`;
			return `<item><title>${xml(numbered(i.number, i.subject))}</title><link>${xml(link)}</link><guid isPermaLink="true">${xml(link)}</guid><pubDate>${rfc822(i.sent_at)}</pubDate>${i.teaser ? `<description>${xml(i.teaser)}</description>` : ''}</item>`;
		})
		.join('\n');
	return finish(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(settings.title)}</title>
<link>${xml(`${base}${ARCHIVE_PATH}`)}</link>
<atom:link href="${xml(`${base}${ARCHIVE_PATH}/feed.xml`)}" rel="self" type="application/rss+xml"/>
<description>${xml(settings.intro.replace(/\s+/g, ' ').trim() || settings.title || ARCHIVE_TITLE_DEFAULT)}</description>
<language>en</language>
${issues[0] ? `<lastBuildDate>${rfc822(issues[0].sent_at)}</lastBuildDate>\n` : ''}${items}
</channel>
</rss>`, ctx);
}

/** Template editor preview: the unsaved web template around a sample issue, in the install's
 *  archive theme (#595; neutral when not passed). */
export function renderWebTemplatePreview(blocks: Block[], canvas: WebCanvas, theme: ArchiveTheme = defaultArchiveTheme()): string {
	const sample = `<article class="nl-article">
<p class="nl-kicker"><a href="${ARCHIVE_PATH}">Newsletter</a></p>
<h1 class="nl-title">A sample issue title</h1>
<p class="nl-date"><time>October 14, 2026</time></p>
<div class="nl-body"><p>Hi there, this is where an issue's content lands. Text, images, buttons, sections and columns all render as a web page.</p><blockquote>Quotes, callouts and dividers too.</blockquote><div class="b-btn" style="text-align:left"><a class="btn" href="#">A button</a></div></div>
${subscribeBox('#')}
<nav class="nl-pn"><a class="prev" href="#"><small>← Previous issue</small>The issue before</a><a class="next" href="#"><small>Next issue →</small>The issue after</a></nav>
</article>`;
	return documentHtml(
		{ title: 'Preview', description: '', canonical: ARCHIVE_PATH, image: null, indexable: false, feedUrl: `${ARCHIVE_PATH}/feed.xml`, type: 'article' },
		{ blocks: sanitizeBlocks(blocks, { allowContent: true }), canvas, theme },
		sample
	);
}
