/**
 * Postmark suppression sync (#285). The CRM otherwise only learns about suppressions from
 * webhooks, so addresses Postmark suppressed before the webhook pointed here (hard bounces,
 * spam complaints, manual suppressions from the FluentCRM era) still read as subscribed.
 *
 * Reads `GET /message-streams/{stream}/suppressions/dump` for the broadcast stream and the
 * transactional one, matches contacts on the lowercased email, and unsubscribes the ones still
 * subscribed through `unsubscribeIds` (contact-bulk.ts — the bulk unsubscribe write): reason
 * `postmark:<SuppressionReason>`, detail `Postmark sync (<stream>)`, active passes cancelled.
 * Never calls Postmark's `suppress` (the address is already suppressed there), never touches
 * `archived_at`. Idempotent: a contact that is already unsubscribed is left alone.
 *
 * The last run (manual or daily) is stored in `app_state.last_suppression_sync` as JSON; the
 * daily heartbeat stamp is `app_state.suppression_sync_cron_at`.
 */

import { BULK_CHUNK, unsubscribeIds, type SuppressionSource } from './contact-bulk';
import { asMailProvider } from './mail';
import { subscriptionChanged } from './subscription-trigger';
import { casAppState } from './app-state-claim';

export type SuppressionSyncResult = {
	checked: number; // distinct suppressed addresses read from Postmark
	matched: number; // contacts with one of those addresses
	unsubscribed: number;
	alreadyUnsubscribed: number;
	byReason: Record<string, number>; // unsubscribed per SuppressionReason
};

export type SuppressionSyncOutcome =
	| ({ ok: true; errors: string[] } & SuppressionSyncResult)
	| { ok: false; error: string };

/** `post_send` = the #570 safety net ~15 minutes after a broadcast went out. */
export type SuppressionSyncTrigger = 'manual' | 'cron' | 'post_send';

export type LastSuppressionSync = SuppressionSyncResult & {
	at: string; // ISO
	trigger: SuppressionSyncTrigger;
	errors: string[];
	campaignIds?: number[]; // post_send: the broadcasts that triggered it
};

const LAST_KEY = 'last_suppression_sync';
const CRON_KEY = 'suppression_sync_cron_at';
const DAY_MS = 24 * 60 * 60 * 1000;
const IDS = '(SELECT value FROM json_each(?))';

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** One sync pass. Never throws on a Postmark failure — that comes back as `ok: false`. */
export async function syncSuppressions(db: D1Database, creds: SuppressionSource): Promise<SuppressionSyncOutcome> {
	const mail = asMailProvider(creds);
	if (!mail?.suppressions) return { ok: false, error: 'Postmark is not configured (no POSTMARK_TOKEN).' };
	const { map, errors, read } = await mail.suppressions.byEmail();
	if (!read) return { ok: false, error: `${mail.label} unreachable — ${errors.join('; ')}` };

	let matched = 0;
	const toUnsub = new Map<string, number[]>(); // "<reason>\n<stream>" → still-subscribed contact ids
	for (const part of chunk([...map.keys()], BULK_CHUNK)) {
		const rows = await db
			.prepare(`SELECT id, email, subscribed FROM contacts WHERE lower(email) IN ${IDS}`)
			.bind(JSON.stringify(part))
			.all<{ id: number; email: string; subscribed: number }>();
		for (const r of rows.results) {
			matched++;
			if (r.subscribed !== 1) continue;
			const s = map.get(r.email.trim().toLowerCase());
			if (!s) continue;
			const key = `${s.reason}\n${s.stream}`;
			const ids = toUnsub.get(key) ?? [];
			ids.push(r.id);
			toUnsub.set(key, ids);
		}
	}

	let unsubscribed = 0;
	const byReason: Record<string, number> = {};
	for (const [key, ids] of toUnsub) {
		const [reason, stream] = key.split('\n');
		const { changed, changedIds } = await unsubscribeIds(db, ids, `${mail.id}:${reason}`, `${mail.label} sync (${stream})`);
		unsubscribed += changed;
		// #444: "Subscription changes" trigger + tier refresh for the newly suppressed.
		await subscriptionChanged(db, changedIds, 'unsubscribed', { source: 'postmark' });
		if (reason === 'HardBounce') await subscriptionChanged(db, changedIds, 'bounced', { source: 'postmark' });
		if (reason === 'SpamComplaint') await subscriptionChanged(db, changedIds, 'complained', { source: 'postmark' });
		if (changed) byReason[reason] = (byReason[reason] ?? 0) + changed;
	}
	return {
		ok: true,
		errors,
		checked: map.size,
		matched,
		unsubscribed,
		alreadyUnsubscribed: matched - unsubscribed,
		byReason
	};
}

async function putState(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value)
		.run();
}

/** Run a sync and, when it read Postmark, store it as the last sync. */
export async function runSuppressionSync(
	db: D1Database,
	creds: SuppressionSource,
	trigger: SuppressionSyncTrigger,
	extra: { campaignIds?: number[] } = {}
): Promise<SuppressionSyncOutcome> {
	const out = await syncSuppressions(db, creds);
	if (out.ok) {
		const { ok: _ok, ...rest } = out;
		const last: LastSuppressionSync = { ...rest, at: new Date().toISOString(), trigger, ...extra };
		await putState(db, LAST_KEY, JSON.stringify(last));
	}
	return out;
}

/** The stored last sync, or null (none yet / unreadable). */
export async function lastSuppressionSync(db: D1Database): Promise<LastSuppressionSync | null> {
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(LAST_KEY).first<{ value: string | null }>();
		const v = row?.value ? (JSON.parse(row.value) as LastSuppressionSync) : null;
		return v && typeof v.at === 'string' ? v : null;
	} catch {
		return null;
	}
}

/** #570: how long after a broadcast's `sent_at` the post-send sync runs. */
export const POST_SEND_DELAY_MS = 15 * 60 * 1000;

/** UTC `YYYY-MM-DD HH:MM:SS`, the format of `campaigns.sent_at`. */
function sqlTime(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * #570 safety net: a webhook that failed during a large send can leave a hard-bounced contact
 * subscribed until the daily run. So ~15 minutes after a broadcast's `sent_at` (sent within the
 * last 24 h — older ones are the daily run's), the heartbeat runs the sync once, on top of the
 * daily one. Each campaign is claimed by stamping `campaigns.post_send_sync_at` before the run,
 * so it happens at most once per campaign; one sync covers every campaign due in that tick.
 * Stored as the last sync with trigger `post_send`. Never throws.
 */
export async function runSuppressionSyncAfterSend(
	db: D1Database,
	creds: SuppressionSource,
	now = Date.now()
): Promise<{ skipped: string } | (SuppressionSyncOutcome & { campaignIds: number[] })> {
	try {
		if (!asMailProvider(creds)?.suppressions) return { skipped: 'not configured' };
		const claimed = await db
			.prepare(
				`UPDATE campaigns SET post_send_sync_at = ?
				 WHERE status = 'sent' AND post_send_sync_at IS NULL
				   AND list_id IS NOT NULL AND automation_id IS NULL AND automation_step_id IS NULL
				   AND sent_at IS NOT NULL AND sent_at <= ? AND sent_at > ?
				 RETURNING id`
			)
			.bind(sqlTime(now), sqlTime(now - POST_SEND_DELAY_MS), sqlTime(now - DAY_MS))
			.all<{ id: number }>();
		const campaignIds = claimed.results.map((r) => r.id).sort((a, b) => a - b);
		if (!campaignIds.length) return { skipped: 'no send due' };
		const out = await runSuppressionSync(db, creds, 'post_send', { campaignIds });
		if (!out.ok) console.error('post-send suppression sync failed:', out.error.slice(0, 200));
		return { ...out, campaignIds };
	} catch (e) {
		const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		console.error('post-send suppression sync failed:', error);
		return { ok: false, error, campaignIds: [] };
	}
}

/**
 * The heartbeat's daily run: at most once per 24 h, stamped before the run (like the
 * integrations cron) so a failing Postmark isn't hit every minute. Never throws.
 */
export async function runSuppressionSyncDaily(
	db: D1Database,
	creds: SuppressionSource,
	now = Date.now()
): Promise<{ skipped: string } | SuppressionSyncOutcome> {
	try {
		if (!asMailProvider(creds)?.suppressions) return { skipped: 'not configured' };
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(CRON_KEY).first<{ value: string | null }>();
		const last = row?.value ? Date.parse(row.value) : NaN;
		if (Number.isFinite(last) && now - last < DAY_MS) return { skipped: 'ran in the last 24h' };
		// #729: compare-and-set on the stamp we just read, so two clocks ticking at once can't both run it.
		if (!(await casAppState(db, CRON_KEY, row?.value ?? null, new Date(now).toISOString()))) return { skipped: 'ran in the last 24h' };
		const out = await runSuppressionSync(db, creds, 'cron');
		if (!out.ok) console.error('suppression sync failed:', out.error.slice(0, 200));
		return out;
	} catch (e) {
		const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		console.error('suppression sync failed:', error);
		return { ok: false, error };
	}
}
