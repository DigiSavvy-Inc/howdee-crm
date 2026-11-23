import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB, env } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { safeEqual } from '$lib/server/auth';
import { tick } from '$lib/server/automations';
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
import { pruneAssistantHistory } from '$lib/server/ai/prune';
import { runAccountBriefs } from '$lib/server/ai/account-brief';
import { runDomainAuthDaily, type DomainAuthEnv } from '$lib/server/domain-auth';
import { runHygieneBackfill } from '$lib/server/hygiene';
import { runBackupTick } from '$lib/server/backups';
import { runDeliverabilityChecks } from '$lib/server/deliverability-alerts';
import { snapshotReportHistory } from '$lib/server/reports/history';

/**
 * Heartbeat entrypoint for the automation engine (#5). The external heartbeat Worker
 * (#7) POSTs here on a schedule; one call runs a single `tick()` pass.
 *
 * Auth: a shared `CRON_KEY` secret, supplied as `Authorization: Bearer <key>` or
 * `?key=<key>` (mirrors the webhook's key gate). JSON response, so SvelteKit's CSRF
 * origin check doesn't apply. Route is in PUBLIC_PREFIXES (machine-called, not session-authed).
 */
export const POST: RequestHandler = async (event) => {
	const key = env(event, 'CRON_KEY');
	const provided =
		(event.request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') ||
		(event.url.searchParams.get('key') ?? '');
	if (!safeEqual(provided, key)) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const db = getDB(event);
	const cfg = {
		token: env(event, 'POSTMARK_TOKEN'),
		secret: env(event, 'SESSION_SECRET'),
		baseUrl: await publicBaseUrlFor(event),
		stream: env(event, 'POSTMARK_STREAM'),
		inboundAddress: event.platform?.env?.POSTMARK_INBOUND_ADDRESS || undefined
	};

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
	const scheduled = await guard('scheduled campaigns', () => processScheduledCampaigns(db, cfg));

	// Best-time sends (#115): due queued recipients go out each minute. Runs right after
	// the scheduled pass so a just-fired campaign's default cohort sends this tick.
	let bestTime;
	try {
		bestTime = await processBestTimeQueue(db, cfg);
	} catch (e) {
		console.error('best-time queue failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		bestTime = { error: 'best-time queue failed' };
	}

	// Scheduled auto-resends to non-openers (#82) ride the same heartbeat.
	const resends = await guard('scheduled resends', () => processScheduledResends(db, cfg));

	// SEO Snapshot jobs (#95) ride the same heartbeat. The heartbeat Worker is unchanged.
	// #604: SNAPSHOT_MODE unset / off = the snapshot pipeline does nothing at all.
	const snapshots = snapshot.enabled(event.platform?.env)
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
	const suppressionCreds = {
		token: cfg.token,
		stream: cfg.stream,
		txStream: event.platform?.env?.POSTMARK_STREAM_TX || undefined
	};
	const suppressions = await guard('suppression sync', () => runSuppressionSyncDaily(db, suppressionCreds));
	// #570: plus once per broadcast, ~15 minutes after it was sent. Logs and never throws.
	const suppressionsAfterSend = await guard('suppression sync after send', () => runSuppressionSyncAfterSend(db, suppressionCreds));

	// Scheduled assistant jobs (#303): ≤2 due jobs per tick, read-only tools, results only to
	// each job's webhook + run history. Isolated like the rest.
	let aiJobs;
	try {
		// #390: an email job's report goes to admins through the injected sender (never a tool).
		aiJobs = await runDueJobs(db, event.platform?.env ?? {}, {
			emailSender: jobEmailSender(db, event.platform?.env ?? {}, await publicBaseUrlFor(event))
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

	// Record the tick for liveness detection (#26) — the dashboard warns when this goes stale.
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES ('last_tick', ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(JSON.stringify({ ...(Object.keys(jobErrors).length ? { errors: jobErrors } : {}), ...summary, scheduled, resends, snapshots, engagement }).slice(0, 500))
		.run();

	return json({ ok: true, errors: jobErrors, ...summary, enrollQueue, segmentTriggers, scheduled, bestTime, resends, snapshots, engagement, scoring, scoreTriggers, siteEvents, loginAttempts, formSubmissions, doubleOptin, integrations, mail, suppressions, suppressionsAfterSend, aiJobs, aiPrune, accountBriefs, domainAuth, hygiene, backup, deliverability, reportHistory });
};
