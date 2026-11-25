// #311: pre-send checks — gathers what the pure rules in $lib/presend-checks need: the
// email rendered exactly as a send would render it, the audience (recipients + health),
// R2 image sizes and Settings → General's mailing address. Used by compose (panel +
// the send action's server-side block), POST /compose/checks and
// POST /api/v1/campaigns/:id/checks. Imports nothing that can send.
import {
	summarize,
	extractLinks,
	extractImages,
	linkChecks,
	imageChecks,
	findMergeTags,
	mergeTagCoverage,
	mergeTagChecks,
	contentChecks,
	audienceChecks,
	linkProbeChecks,
	classifyProbe,
	topicSkipCheck,
	type AudienceStats,
	type Check,
	type ChecksReport,
	type CoverageRecipient,
	type Link,
	type MergeLinkSample
} from '$lib/presend-checks';
import { buildCondCtx, evaluateConditionals } from '$lib/conditionals';
import { signatureText, type EmailSignature } from '$lib/signature';
import { getSignature } from './email-signature';
import { UNSUB_PLACEHOLDER, personalize } from './email';
import { renderBody, renderBodyInTemplate, storedBlocks, type ComposeBody } from './compose-body';
import type { TemplateRow } from './templates';
import { type SendableRow } from './segments';
import { includedMemberIds, readAudience, recipientsForAudience, type Audience } from './campaign-audience';
import { companyMergeFields } from './company-metrics';
import { getSettings } from './settings';
import { checkLinks, type FetchBudget, type Fetcher, type Limiter } from './link-check';
import { listUnsubscribeHeaders } from '$lib/list-unsubscribe';
import { optedOutIds, resolveTopicId, topicLabel } from './topics';

export type PresendInput = {
	subject: string;
	preheader: string;
	body: ComposeBody;
	templateId: number | null;
	/** #332: included / excluded groups. `listId` alone = one included group. */
	audience?: Audience;
	listId?: number | null;
	/** A campaign being re-checked (API) — left out of "last send to this list". */
	campaignId?: number | null;
	/** #414: the email's topic choice — null / undefined = automatic (the first included group
	 *  when it is a topic list), 0 = none, else a list id. */
	topicId?: number | null;
};

export type PresendDeps = {
	media?: R2Bucket;
	/** Run the live link check (network). */
	checkLinks?: boolean;
	fetcher?: Fetcher;
	/** Recipients already resolved by the caller (the send action). */
	recipients?: SendableRow[];
	/** #479: link-check knobs (tests: 0 ms retry delay; the tick: its deadline and its slice of
	 *  the tick's fetch budget). Unset = the interactive defaults (LINK_CHECK_DEADLINE_MS,
	 *  LINK_CHECK_MAX_FETCHES). Schedule-time softening is applyPolicy's `scheduling` option, so
	 *  it comes after the policy's level overrides. */
	retryDelayMs?: number;
	linkDeadline?: number;
	maxFetches?: FetchBudget;
	/** #479: the probe concurrency limiter (the tick shares one between campaigns). */
	limiter?: Limiter;
	/** #479: the scheduled-send tick doesn't fill in merge-tag links (that would resolve the whole
	 *  audience before the claim, and a sample failure only ever warns): they're reported as
	 *  checked when composing. */
	skipMergeLinks?: boolean;
};

/** #479: sample recipients a merge-tag href is filled in for. */
export const MERGE_LINK_SAMPLES = 3;

const MERGE_HREF = /\{\{|%7B%7B/i;

/** #479: does the email have merge-tag hrefs (then the link check needs sample recipients)? */
export function hasMergeLinks(links: Link[]): boolean {
	return links.some((l) => MERGE_HREF.test(l.href));
}

/** A merge-tag href filled in for one recipient, the way the send path fills it. */
export function fillHref(href: string, r: SendableRow): string {
	const raw = href.replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}').replace(/%7C/gi, '|');
	return personalize(evaluateConditionals(raw, buildCondCtx(r.tags, r.meta)), '', r).trim();
}

/** #479: the live link check over the email's links. Plain http(s) links are probed once;
 *  merge-tag hrefs ({{field:website}}, https://site.com/{{first_name}}) are probed filled in for
 *  up to 3 sample recipients and can only ever warn. Results live for this call only. */
export async function liveLinkChecks(
	links: Link[],
	samples: SendableRow[],
	deps: Pick<PresendDeps, 'fetcher' | 'retryDelayMs' | 'linkDeadline' | 'maxFetches' | 'limiter' | 'skipMergeLinks'> = {}
): Promise<Check[]> {
	const where = new Map<string, string>();
	for (const l of links) if (l.text && !where.has(l.href)) where.set(l.href, l.text);
	const plain = [...new Set(links.filter((l) => !MERGE_HREF.test(l.href)).map((l) => l.href))];
	const sampleRows = samples.slice(0, MERGE_LINK_SAMPLES);
	const mergeHrefs = [...new Set(links.filter((l) => MERGE_HREF.test(l.href)).map((l) => l.href))];
	const atCompose = deps.skipMergeLinks ? mergeHrefs.length : 0;
	const merged = (deps.skipMergeLinks ? [] : mergeHrefs).map((href) => ({
		href,
		urls: sampleRows.map((r) => fillHref(href, r)).filter((u) => /^https?:\/\//i.test(u) && !MERGE_HREF.test(u))
	}));
	const plainSet = new Set(plain);
	// Plain links first, so they win the 60-link cap and the budget over merge-tag samples.
	const { probes, unfinished } = await checkLinks([...plain, ...merged.flatMap((m) => m.urls)], deps.fetcher, {
		retryDelayMs: deps.retryDelayMs,
		deadline: deps.linkDeadline,
		maxFetches: deps.maxFetches,
		limiter: deps.limiter
	});
	const byUrl = new Map(probes.map((p) => [p.url, p]));
	const unfinishedSet = new Set(unfinished);
	// Over the cap = neither probed nor left unfinished by the budgets.
	const plainSkipped = plain.filter((u) => /^https?:\/\//i.test(u) && !byUrl.has(u) && !unfinishedSet.has(u)).length;
	// A merge-tag link none of whose samples was probed was never checked.
	const sampled = merged.filter((m) => m.urls.some((u) => byUrl.has(u)));
	const unsampled = merged.length - sampled.length;
	const merge: MergeLinkSample[] = sampled
		.map((m) => ({
			href: m.href,
			samples: m.urls.length,
			failed: m.urls.filter((u) => {
				const p = byUrl.get(u);
				return !!p && !['ok', 'login', 'refused', 'blocked'].includes(classifyProbe(p));
			}).length
		}));
	const rows = linkProbeChecks(
		probes.filter((p) => plainSet.has(p.url)),
		plainSkipped,
		{ where, unfinished: unfinished.filter((u) => plainSet.has(u)), merge, unsampled, mergeAtCompose: atCompose }
	);
	return rows;
}

const CHUNK = 500;

/** #594: the text before the signature (all of it with no signature — splitting on ''
 *  would keep only the first character). */
export function beforeSignature(text: string, signature: EmailSignature | null): string {
	const sig = signatureText(signature);
	if (!sig) return text;
	const at = text.indexOf(sig);
	return at === -1 ? text : text.slice(0, at);
}

/** The email as the send path builds it (broadcast: unsubscribe footer on). */
export async function renderForChecks(db: D1Database, input: PresendInput): Promise<{ html: string; text: string; contentText: string }> {
	const tpl = input.templateId
		? await db
				.prepare('SELECT name, kind, blocks, html, use_global_header, use_global_footer, canvas FROM templates WHERE id = ?')
				.bind(input.templateId)
				.first<TemplateRow>()
		: null;
	const signature = await getSignature(db);
	let html: string;
	let text: string;
	if (tpl?.kind === 'builder') {
		({ html, text } = await renderBodyInTemplate(db, tpl, input.body, { preheader: input.preheader, signature }));
	} else if (tpl?.kind === 'html') {
		html = tpl.html ?? '';
		// The send path appends the standard footer when the placeholder is missing.
		if (!html.includes(UNSUB_PLACEHOLDER)) html += `<a href="${UNSUB_PLACEHOLDER}">Unsubscribe</a>`;
		const stripped = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
		// #373: the send path's text version ends with the unsubscribe line.
		return { html, text: `${stripped}\n\nUnsubscribe: ${UNSUB_PLACEHOLDER}`, contentText: beforeSignature(stripped, signature) };
	} else {
		({ html, text } = renderBody(input.body, { preheader: input.preheader, signature }));
	}
	// Without a signature, the unsubscribe trailer (renderEmailText's last lines) isn't content either.
	const contentText = beforeSignature(text, signature).replace(/\n\n—\n(?:You're receiving this email because: [^\n]*\n)?Unsubscribe: %%UNSUB_URL%%\s*$/, '');
	return { html, text, contentText };
}

async function inChunks<T>(ids: number[], fn: (json: string) => Promise<T>): Promise<T[]> {
	const out: T[] = [];
	for (let i = 0; i < ids.length; i += CHUNK) out.push(await fn(JSON.stringify(ids.slice(i, i + CHUNK))));
	return out;
}

async function countWhere(db: D1Database, ids: number[], where: string): Promise<number> {
	const parts = await inChunks(ids, async (json) =>
		(await db.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE c.id IN (SELECT value FROM json_each(?)) AND ${where}`).bind(json).first<{ n: number }>())?.n ?? 0
	);
	return parts.reduce((a, b) => a + b, 0);
}

const BOUNCED = `EXISTS (SELECT 1 FROM events x WHERE x.contact_id = c.id AND x.type = 'bounce')`;
const SUPPRESSED = `EXISTS (SELECT 1 FROM unsubscribes u WHERE (u.contact_id = c.id OR u.email = c.email)
	AND (u.reason = 'HardBounce' OR u.reason LIKE 'postmark:%' OR u.reason = 'Marked as spam'))`;
const NEVER_ENGAGED = `EXISTS (SELECT 1 FROM recipients r WHERE r.contact_id = c.id AND r.status = 'accepted')
	AND NOT EXISTS (SELECT 1 FROM events e WHERE e.contact_id = c.id AND e.type IN ('open', 'click') AND e.recorded_at >= datetime('now', '-365 days'))`;

function inputAudience(input: { audience?: Audience; listId?: number | null }): Audience {
	return input.audience ?? { include: input.listId ? [input.listId] : [], exclude: [] };
}

export async function audienceStats(db: D1Database, audienceOrListId: Audience | number, recipients: SendableRow[], excludeCampaignId?: number | null): Promise<AudienceStats> {
	const audience = typeof audienceOrListId === 'number' ? { include: [audienceOrListId], exclude: [] } : audienceOrListId;
	const ids = recipients.map((r) => r.id);
	const recipientSet = new Set(ids);
	// Members of the included groups the send leaves out (unsubscribed, archived or excluded).
	const left = (await includedMemberIds(db, audience)).filter((id) => !recipientSet.has(id));
	const last = await db
		.prepare(
			`SELECT c.id, c.subject,
			        (SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = c.id AND r.status = 'accepted') AS sent,
			        (SELECT COUNT(DISTINCT COALESCE(e.recipient_id, e.contact_id)) FROM events e WHERE e.campaign_id = c.id AND e.type = 'bounce') AS bounced
			 FROM campaigns c
			 WHERE c.list_id IN (SELECT value FROM json_each(?)) AND c.status = 'sent' AND c.id != ?
			 ORDER BY COALESCE(c.sent_at, c.created_at) DESC, c.id DESC LIMIT 1`
		)
		.bind(JSON.stringify(audience.include), excludeCampaignId ?? 0)
		.first<{ id: number; subject: string; sent: number; bounced: number }>();
	return {
		recipients: recipients.length,
		excludedBounced: await countWhere(db, left, `c.subscribed = 0 AND (${BOUNCED} OR ${SUPPRESSED})`),
		pastBounce: await countWhere(db, ids, BOUNCED),
		lastSend: last ? { campaignId: last.id, subject: last.subject, sent: last.sent, bounced: last.bounced } : null,
		neverEngaged: await countWhere(db, ids, NEVER_ENGAGED)
	};
}

/** Byte sizes of uploaded images (`/img/<key>`) from R2 metadata, keyed by src. */
export async function imageSizes(media: R2Bucket | undefined, srcs: string[]): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (!media) return out;
	for (const src of [...new Set(srcs)].slice(0, 20)) {
		const key = /\/img\/([a-f0-9-]{36}\.(?:png|jpg|gif|webp))(?:[?#]|$)/.exec(src)?.[1];
		if (!key) continue;
		try {
			const head = await media.head(key);
			if (head) out.set(src, head.size);
		} catch {
			// a missing object / R2 hiccup just means "size unknown"
		}
	}
	return out;
}

export async function runPresendChecks(db: D1Database, input: PresendInput, deps: PresendDeps = {}): Promise<ChecksReport> {
	const { html, text, contentText } = await renderForChecks(db, input);
	const settings = await getSettings(db);
	const links = extractLinks(html);
	const images = extractImages(html);
	const checks: Check[] = [];

	checks.push(...linkChecks(links));
	// #479: the live link rows go right after these, once the audience (merge-link samples) is known.
	const liveAt = checks.length;
	checks.push(...imageChecks(images, contentText, await imageSizes(deps.media, images.map((i) => i.src))));

	// #373: the headers a broadcast send adds (send.ts), checked with the HTML and text.
	const headers = listUnsubscribeHeaders('%%UNSUB_URL%%/one-click');
	checks.push(...contentChecks({ subject: input.subject, preheader: input.preheader, html, text, headers, contentText, mailingAddress: settings.mailing_address }));

	const audience = inputAudience(input);
	const topicId = audience.include.length ? await resolveTopicId(db, input.topicId, audience) : null;
	const recipients = audience.include.length ? (deps.recipients ?? (await recipientsForAudience(db, audience, { topicId }))) : null;
	const tags = findMergeTags(input.subject, input.preheader, html);
	let coverageRecipients: CoverageRecipient[] | null = null;
	if (recipients) {
		const needsCompany = tags.used.some((u) => u.key.startsWith('company.'));
		const companies = needsCompany ? await companyMergeFields(db, recipients.map((r) => r.id)) : null;
		coverageRecipients = recipients.map((r) => ({ ...r, companyFields: companies?.get(r.id) ?? null }));
	}
	checks.push(...mergeTagChecks(tags.unknown, coverageRecipients ? mergeTagCoverage(tags.used, coverageRecipients) : null));

	if (audience.include.length && recipients) checks.push(...audienceChecks(await audienceStats(db, audience, recipients, input.campaignId)));
	else checks.push({ id: 'audience.count', category: 'audience', level: 'block', title: 'No list or segment chosen' });
	// #414: who the topic's opt-outs leave out (counted against the audience without them).
	if (topicId && recipients) {
		const base = await recipientsForAudience(db, audience);
		const skipped = (await optedOutIds(db, base.map((r) => r.id), topicId)).size;
		if (skipped) checks.push(topicSkipCheck(skipped, (await topicLabel(db, topicId)) ?? 'this topic'));
	}

	if (deps.checkLinks) checks.splice(liveAt, 0, ...(await liveLinkChecks(links, recipients ?? [], deps)));
	return { ...summarize(checks, !!deps.checkLinks), checkedAt: new Date().toISOString() };
}

/** A stored campaign as check input (API). */
export async function presendInputForCampaign(db: D1Database, id: number): Promise<PresendInput | null> {
	const c = await db
		.prepare('SELECT id, subject, preheader, body_md, body_blocks, template_id, list_id, topic_list_id FROM campaigns WHERE id = ?')
		.bind(id)
		.first<{ id: number; subject: string; preheader: string | null; body_md: string; body_blocks: string | null; template_id: number | null; list_id: number | null; topic_list_id: number | null }>();
	if (!c) return null;
	const blocks = storedBlocks(c.body_blocks);
	// Template-only sends store a placeholder body (body_md is NOT NULL).
	const md = c.template_id && /^\[(HTML )?[Tt]emplate: .*\]$/.test(c.body_md) ? '' : c.body_md;
	return {
		subject: c.subject,
		preheader: c.preheader ?? '',
		body: blocks ? { blocks, md } : { blocks: null, md },
		templateId: c.template_id,
		audience: await readAudience(db, c.id, c.list_id),
		campaignId: c.id,
		topicId: c.topic_list_id
	};
}
