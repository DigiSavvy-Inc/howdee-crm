import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB, env, FINISH_SETUP_SENDING, mailToken, sendingUnconfigured } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { safeEqual } from '$lib/server/auth';
import { tick } from '$lib/server/automations';
import { providerFor, resolveMailCredentials } from '$lib/server/mail';
import { processEnrollQueue } from '$lib/server/automation-enroll';
import { processSegmentTriggers } from '$lib/server/segment-trigger';
import { processScheduledCampaigns, processScheduledResends } from '$lib/server/scheduled';
import { snapshot } from '$lib/server/snapshot';
import { runEngagementJob } from '$lib/server/engagement';
import { runScoringJob } from '$lib/server/scoring/engine';
import { processScoreTriggers } from '$lib/server/score-trigger';
import { pruneSiteEvents } from '$lib/server/site-tracking';
import { pruneLoginAttempts } from '$lib/server/login-attempts';
import { pruneBreakGlassEvents } from '$lib/server/break-glass';
import { pruneSubmissions } from '$lib/server/forms';
import { expireConfirmations } from '$lib/server/double-optin';
import { runIntegrationsTick } from '$lib/server/integrations';
import { runMailTick } from '$lib/server/mail-sync';
import { processBestTimeQueue } from '$lib/server/best-time';
import { runSuppressionSyncAfterSend, runSuppressionSyncDaily } from '$lib/server/suppression-sync';
import { runDueJobs } from '$lib/server/ai/jobs';
import { jobEmailSender } from '$lib/server/job-email-send';
import { holdNotifier } from '$lib/server/preflight';
import { pruneAssistantHistory } from '$lib/server/ai/prune';
import { runAccountBriefs } from '$lib/server/ai/account-brief';
import { runDomainAuthDaily, type DomainAuthEnv } from '$lib/server/domain-auth';
import { runHygieneBackfill } from '$lib/server/hygiene';
import { runBackupTick } from '$lib/server/backups';
import { runDeliverabilityChecks } from '$lib/server/deliverability-alerts';
import { snapshotReportHistory } from '$lib/server/reports/history';
import { runSuggestions } from '$lib/server/suggestions/engine';
import { CLOCK_KEY, SENDS_SKIPPED_KEY, SKIP_KEY, TICK_SKIPPED_NO_PUBLIC_URL, TICK_SKIPPED_NO_SENDING, isInternalOrigin, isInternalTick } from '$lib/server/internal-tick';

/**
 * Heartbeat entrypoint for the automation engine (#5). The external heartbeat Worker
 * (#7) POSTs here on a schedule; one call runs a single `tick()` pass.
 *
 * Auth: a shared `CRON_KEY` secret, supplied as `Authorization: Bearer <key>` or
 * `?key=<key>` (mirrors the webhook's key gate). JSON response, so SvelteKit's CSRF
 * origin check doesn't apply. Route is in PUBLIC_PREFIXES (machine-called, not session-authed).
 *
 * #729: the app's own Cron Trigger (the wrapped Worker entry, scripts/wrap-worker.mjs) calls this
 * route in-process with a Symbol marker on the env (`isInternalTick`), which no HTTP request can
 * carry; that call skips the key. Every other request goes through the CRON_KEY check exactly as
 * before. An internal tick with no public address (no Settings → Domain value, no PUBLIC_BASE_URL)
 * runs nothing: its links would point at the internal origin (see below).
 */
export const POST: RequestHandler = async (event) => {
	const internal = isInternalTick(event.platform?.env);
	if (!internal) {
		const key = env(event, 'CRON_KEY');
		const provided =
			(event.request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') ||
			(event.url.searchParams.get('key') ?? '');
		if (!safeEqual(provided, key)) {
			return json({ error: 'unauthorized' }, { status: 401 });
		}
	}

	const db = getDB(event);

	const recordSkip = (reason: string) =>
		db
			.prepare(
				`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(SKIP_KEY, reason)
			.run();

	// #729: fail closed on links. The internal request's origin is https://scheduled.invalid. #731:
	// `publicBaseUrlFor` now resolves Settings → Domain, PUBLIC_BASE_URL, then the origin stored at
	// first-run setup (`public_base_url_seen`), so the built-in clock builds real links on a fresh
	// install. Only with none of the three does it still land on the internal origin: run no job
	// then, say why (Settings → Setup shows it).
	const baseUrl = await publicBaseUrlFor(event);
	if (internal && isInternalOrigin(baseUrl)) {
		console.error('automation tick (cron) skipped: no public URL (open Settings → Setup, or set Settings → Domain or PUBLIC_BASE_URL)');
		await recordSkip(TICK_SKIPPED_NO_PUBLIC_URL);
		return json({ ok: false, skipped: TICK_SKIPPED_NO_PUBLIC_URL });
	}

	// #700: every send in this tick goes through the active sending provider (Settings →
	// Sending, else the Worker env). A token saved in Settings that can't be read 500s the tick
	// (mailToken), instead of sending with the env token.
	// #731: with no sending credentials at all (the provider resolution finds no provider and
	// nothing saved is unreadable: a fresh install before the wizard's Connect step), every job
	// that sends email is skipped — scheduled campaigns stay `scheduled` and unclaimed, best-time,
	// resends and snapshot reports wait, automation email steps hold ("Finish setup", attempts
	// untouched), job reports aren't emailed — while every housekeeping job runs and `last_tick`
	// is stamped. The answer is a 200 with `skipped_sends`, so the heartbeat Worker logs it as ok;
	// Settings → Setup shows a "Scheduled work" row. With credentials, nothing here changes.
	const mailCreds = await resolveMailCredentials(db, event.platform?.env);
	const mailProvider = providerFor(event.platform?.env, mailCreds);
	const sendsOff = sendingUnconfigured(mailProvider, mailCreds);
	const cfg = {
		token: sendsOff ? '' : mailToken(event, mailCreds),
		provider: mailProvider,
		secret: env(event, 'SESSION_SECRET'),
		baseUrl,
		stream: mailCreds.postmark.stream,
		inboundAddress: event.platform?.env?.POSTMARK_INBOUND_ADDRESS || undefined,
		envFrom: event.platform?.env?.POSTMARK_FROM || undefined
	};
	const skippedSend = { skipped: TICK_SKIPPED_NO_SENDING };

	// Optional batch override (?batch=N), otherwise the engine default.
	const batchParam = Number(event.url.searchParams.get('batch'));
	const batchSize = Number.isFinite(batchParam) && batchParam > 0 ? batchParam : undefined;

	// #537: stamp the attempt first, so a job that throws (or a request cut short) still shows the
	// heartbeat reached us. `jobErrors` collects every guarded job's failure for the summary.
	const jobErrors: Record<string, string> = {};
	try {
		await db
			.prepare(
				`INSERT INTO app_state (key, value, updated_at) VALUES ('last_tick_attempt', datetime('now'), datetime('now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.run();
	} catch (e) {
		console.error('tick attempt stamp failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
	}
	/** Run one job; a throw is logged and recorded, and the next job still runs. */
	const guard = async <T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
		try {
			return await fn();
		} catch (e) {
			const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
			console.error(`${name} failed:`, msg);
			jobErrors[name] = msg;
			return { error: `${name} failed` };
		}
	};

	const summary = await guard('automation tick', () => tick(db, cfg, { batchSize }));

	// #395: list / segment enrollments over the per-request cap, drained a batch per tick.
	let enrollQueue;
	try {
		enrollQueue = await processEnrollQueue(db);
	} catch (e) {
		console.error('enroll queue failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		enrollQueue = { error: 'enroll queue failed' };
	}

	// #413: "Added to segment" for rule-based segments — poll membership, enroll new entrants.
	let segmentTriggers;
	try {
		segmentTriggers = await processSegmentTriggers(db);
	} catch (e) {
		console.error('segment triggers failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		segmentTriggers = { error: 'segment triggers failed' };
	}

	// Scheduled broadcasts (#35) ride the same heartbeat.
	// #479: links are checked again when a scheduled send fires; a held send notifies the alert
	// webhook and (when set) emails the admins, from the notice pass after the send loop.
	const scheduled = sendsOff
		? skippedSend
		: await guard('scheduled campaigns', async () =>
				await processScheduledCampaigns(db, cfg, {
					onHold: holdNotifier(db, cfg.baseUrl, jobEmailSender(db, event.platform?.env ?? {}, cfg.baseUrl))
				})
			);

	// Best-time sends (#115): due queued recipients go out each minute. Runs right after
	// the scheduled pass so a just-fired campaign's default cohort sends this tick.
	let bestTime;
	try {
		bestTime = sendsOff ? skippedSend : await processBestTimeQueue(db, cfg);
	} catch (e) {
		console.error('best-time queue failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		bestTime = { error: 'best-time queue failed' };
	}

	// Scheduled auto-resends to non-openers (#82) ride the same heartbeat.
	const resends = sendsOff ? skippedSend : await guard('scheduled resends', () => processScheduledResends(db, cfg));

	// Snapshot jobs (#95) ride the same heartbeat. The heartbeat Worker is unchanged.
	// #604: SNAPSHOT_MODE unset / off = the snapshot pipeline does nothing at all.
	const snapshots = sendsOff
		? skippedSend
		: snapshot.enabled(event.platform?.env)
			? await guard('snapshots', () =>
					snapshot.tick(db, event.platform?.env, { postmarkToken: cfg.token, sessionSecret: cfg.secret, baseUrl: cfg.baseUrl })
				)
			: { off: true };

	// Contact engagement rollup (#111/#113): full recompute once/24h (also the first-run
	// backfill), draining up to 150 dirty contacts per tick otherwise. Isolated so a
	// failure here can never stall automations/scheduled sends.
	let engagement;
	try {
		engagement = await runEngagementJob(db);
	} catch (e) {
		console.error('engagement job failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		engagement = { error: 'engagement job failed' };
	}

	// Contact scoring (#466): ingest new source rows into the ledger, sweep expiries, one
	// chunk of condition rules, then drain ≤ 300 dirty contact × score rows. Isolated like engagement.
	let scoring;
	try {
		scoring = await runScoringJob(db);
	} catch (e) {
		console.error('scoring job failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		scoring = { error: 'scoring job failed' };
	}
	// #467: score changes the engine recorded for `score_changed` automations → enroll().
	let scoreTriggers;
	try {
		scoreTriggers = await processScoreTriggers(db);
	} catch (e) {
		console.error('score triggers failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		scoreTriggers = { error: 'score triggers failed' };
	}

	// Site tracking prune (#151): nightly, ≤2,000 rows per tick while over (180 days /
	// 5,000 per contact). Isolated like engagement.
	let siteEvents;
	try {
		siteEvents = await pruneSiteEvents(db);
	} catch (e) {
		console.error('site events prune failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		siteEvents = { error: 'site events prune failed' };
	}

	// Sign-in attempt log (#211): drop rows older than 30 days; break-glass audit (#533) after
	// 365 days. Isolated like the rest.
	let loginAttempts;
	try {
		loginAttempts = { ...(await pruneLoginAttempts(db)), breakGlass: await pruneBreakGlassEvents(db) };
	} catch (e) {
		console.error('login attempts prune failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		loginAttempts = { error: 'login attempts prune failed' };
	}

	// Form submissions (#509): each form's retention (default 365 days) + stale rate-limit
	// windows. ≤ 5,000 rows per tick. Isolated like the rest.
	let formSubmissions;
	try {
		formSubmissions = await pruneSubmissions(db);
	} catch (e) {
		console.error('form submissions prune failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		formSubmissions = { error: 'form submissions prune failed' };
	}

	// Double opt-in (#510): stamp links past their expiry (the contacts stay pending; an expired
	// link offers "Send a new link"). Isolated like the rest.
	let doubleOptin;
	try {
		doubleOptin = await expireConfirmations(db);
	} catch (e) {
		console.error('double opt-in expiry failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		doubleOptin = { error: 'double opt-in expiry failed' };
	}

	// Integrations (#167): each configured provider syncs at most once per 6h, never
	// overlapping. Every run is logged to integration_syncs; isolated like the rest.
	let integrations;
	try {
		integrations = await runIntegrationsTick(db, event.platform?.env ?? {});
	} catch (e) {
		console.error('integrations tick failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		integrations = { error: 'integrations tick failed' };
	}

	// Gmail sync (#158): every tick, ≤200 messages looked at across mailboxes. Isolated too.
	let mail;
	try {
		mail = await runMailTick(db, event.platform?.env ?? {});
	} catch (e) {
		console.error('mail sync failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		mail = { error: 'mail sync failed' };
	}

	// Postmark suppression sync (#285): once per 24h. Logs and never throws.
	const suppressionCreds = mailProvider ?? {
		token: cfg.token,
		stream: cfg.stream,
		txStream: mailCreds.postmark.txStream || undefined
	};
	const suppressions = await guard('suppression sync', () => runSuppressionSyncDaily(db, suppressionCreds));
	// #570: plus once per broadcast, ~15 minutes after it was sent. Logs and never throws.
	const suppressionsAfterSend = await guard('suppression sync after send', () => runSuppressionSyncAfterSend(db, suppressionCreds));

	// Scheduled assistant jobs (#303): ≤2 due jobs per tick, read-only tools, results only to
	// each job's webhook + run history. Isolated like the rest.
	let aiJobs;
	try {
		// #390: an email job's report goes to admins through the injected sender (never a tool).
		// #731: with no sending credentials a job that delivers by email doesn't run at all (no
		// model spend, stays due); webhook-only jobs run as usual. The sender below is only a
		// backstop and never reached for an email job then.
		aiJobs = await runDueJobs(db, event.platform?.env ?? {}, {
			emailOff: sendsOff,
			emailSender: sendsOff
				? async () => ({ status: 'failed' as const, sent: 0, error: FINISH_SETUP_SENDING })
				: jobEmailSender(db, event.platform?.env ?? {}, await publicBaseUrlFor(event))
		});
	} catch (e) {
		console.error('assistant jobs failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		aiJobs = { error: 'assistant jobs failed' };
	}

	// Assistant history retention (#310): once per 24 h, batched — threads + messages and job
	// runs past Settings → Assistant → History, write-audit rows after 365 days.
	let aiPrune;
	try {
		aiPrune = await pruneAssistantHistory(db);
	} catch (e) {
		console.error('assistant prune failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		aiPrune = { error: 'assistant prune failed' };
	}

	// Account briefs (#388): ≤2 companies with activity in the last 7 days per tick, each at
	// most once a day, within the assistant's spend caps. Isolated like the rest.
	let accountBriefs;
	try {
		accountBriefs = await runAccountBriefs(db, event.platform?.env ?? {});
	} catch (e) {
		console.error('account briefs failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		accountBriefs = { error: 'account briefs failed' };
	}

	// Domain authentication (#304): DMARC/SPF/DKIM/Return-Path once per 24h. Never throws.
	const domainAuth = await guard('domain auth', () => runDomainAuthDaily(db, (event.platform?.env ?? {}) as DomainAuthEnv));

	// Address hygiene backfill (#306): one batch of a running "Check existing contacts"
	// pass (≤ 25 new domains). Never throws.
	const hygiene = await guard('hygiene backfill', () => runHygieneBackfill(db));

	// D1 backups to R2 (#308): one run per local day after 03:00, spread over ticks. Never throws.
	const backup = await guard('backup', () => runBackupTick(db, event.platform?.env?.MEDIA));

	// Deliverability alerts (#305): each broadcast once 2h and once 24h after sending, each
	// automation once a day over 7 days. Isolated like the rest.
	let deliverability;
	try {
		deliverability = await runDeliverabilityChecks(db, { appUrl: cfg.baseUrl });
	} catch (e) {
		console.error('deliverability checks failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		deliverability = { error: 'deliverability checks failed' };
	}

	// Report history (#358): company metrics + list sizes, once per UTC day, kept 3 years.
	let reportHistory;
	try {
		reportHistory = await snapshotReportHistory(db);
	} catch (e) {
		console.error('report history failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		reportHistory = { error: 'report history failed' };
	}

	// Suggestions (#712): the rules pass, at most hourly, ≤ 200 writes per tick. Off = no work.
	// Rules only — no model call, nothing sent, scheduled, activated or enrolled.
	const suggestions = await guard('suggestions', () => runSuggestions(db));

	// Record the tick for liveness detection (#26) — the dashboard warns when this goes stale.
	// #729: which clock ran it goes under its own key (`cron` = the app's own Cron Trigger, `http` =
	// the CRON_KEY endpoint), since the summary is cut at 500 chars. Same batch, same moment; the
	// skip marker of an earlier no-public-URL tick goes with it.
	// #731: `skipped_sends` leads the stored summary (so the 500-char cut never drops it) and has
	// its own key, which Settings → Setup reads; a tick with credentials clears that key.
	const upsert = `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
	const sendsNote = sendsOff ? { skipped_sends: TICK_SKIPPED_NO_SENDING } : {};
	await db.batch([
		db.prepare(upsert).bind('last_tick', JSON.stringify({ ...sendsNote, ...(Object.keys(jobErrors).length ? { errors: jobErrors } : {}), ...summary, scheduled, resends, snapshots, engagement }).slice(0, 500)),
		db.prepare(upsert).bind(CLOCK_KEY, internal ? 'cron' : 'http'),
		db.prepare(`DELETE FROM app_state WHERE key = ?`).bind(SKIP_KEY),
		sendsOff ? db.prepare(upsert).bind(SENDS_SKIPPED_KEY, TICK_SKIPPED_NO_SENDING) : db.prepare(`DELETE FROM app_state WHERE key = ?`).bind(SENDS_SKIPPED_KEY)
	]);

	return json({ ok: true, ...sendsNote, errors: jobErrors, ...summary, enrollQueue, segmentTriggers, scheduled, bestTime, resends, snapshots, engagement, scoring, scoreTriggers, siteEvents, loginAttempts, formSubmissions, doubleOptin, integrations, mail, suppressions, suppressionsAfterSend, aiJobs, aiPrune, accountBriefs, domainAuth, hygiene, backup, deliverability, reportHistory, suggestions });
};
