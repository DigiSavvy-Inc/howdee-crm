import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { addTag } from '$lib/server/automations';
import { bouncedCounts, deliverabilityRates, suppressedTotal } from '$lib/server/deliverability';
import { lastSuppressionSync, runSuppressionSync } from '$lib/server/suppression-sync';
import { authBounces, checkSummary, domainAuthAlert, lastDomainAuth, runDomainAuthCheck, statusChanges, switchToCustomUnsubscribe, type DomainAuthEnv } from '$lib/server/domain-auth';
import { backfillState, hygieneCounts, runHygieneBackfill, startHygieneBackfill } from '$lib/server/hygiene';
import { activeAlerts, dismissAlert, getAlertConfig, heldCampaigns, releaseHeldCampaign } from '$lib/server/deliverability-alerts';

// Where the alert banner's forms return to (#305): a same-site path, else /deliverability.
function backTo(data: FormData): string {
	const back = String(data.get('back') ?? '');
	return back.startsWith('/') && !back.startsWith('//') ? back : '/deliverability';
}

const COLD_OPTIONS = [3, 6, 12]; // months

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);

	// Rates over the last 90 days of activity (#67).
	const rates = await deliverabilityRates(db);

	// Suppressed contacts (unsubscribed / bounced / complained), most recent first.
	const suppressed = await db
		.prepare(
			`SELECT c.id, c.email,
			        COALESCE((SELECT u.reason FROM unsubscribes u WHERE u.contact_id = c.id ORDER BY u.created_at DESC LIMIT 1),
			                 (SELECT CASE WHEN ev.type='bounce' THEN 'Bounced' WHEN ev.type='spam' THEN 'Spam complaint' END
			                  FROM events ev WHERE ev.contact_id = c.id AND ev.type IN ('bounce','spam') ORDER BY ev.recorded_at DESC LIMIT 1),
			                 'Unsubscribed') AS reason
			 FROM contacts c WHERE c.subscribed = 0
			 ORDER BY c.id DESC LIMIT 100`
		)
		.all<{ id: number; email: string; reason: string }>();
	const [suppressedCount, bounced] = await Promise.all([suppressedTotal(db), bouncedCounts(db)]);

	// Cold contacts: subscribed, but no open/click in the selected window.
	let months = Number(event.url.searchParams.get('months')) || 6;
	if (!COLD_OPTIONS.includes(months)) months = 6;
	const cold = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM contacts c
			 WHERE c.subscribed = 1
			   AND NOT EXISTS (SELECT 1 FROM events ev WHERE ev.contact_id = c.id AND ev.type IN ('open','click')
			                     AND ev.recorded_at >= datetime('now', ?))`
		)
		.bind(`-${months} months`)
		.first<{ n: number }>();

	// Domain authentication (#304): the stored result (no DNS in load), banner, bounce watch.
	const [domainAuth, domainAlert, authBounceRows] = await Promise.all([lastDomainAuth(db), domainAuthAlert(db), authBounces(db)]);

	// #306: address hygiene backfill progress + counts (subscribed, active contacts).
	const hygieneRun = await backfillState(db);
	const hygiene = await hygieneCounts(db, hygieneRun);

	const [alerts, held, alertConfig] = await Promise.all([activeAlerts(db), heldCampaigns(db), getAlertConfig(db)]);

	return {
		domainAuth,
		domainChanges: statusChanges(domainAuth), // #363: checks whose status moved since the run before
		domainAlert,
		authBounces: authBounceRows,
		hygieneRun,
		hygiene,
		alerts, // #305: post-send alert banner
		held,
		thresholds: { hardWarn: alertConfig.hardWarn, hardCrit: alertConfig.hardCrit, complaintWarn: alertConfig.complaintWarn, complaintCrit: alertConfig.complaintCrit },
		lastSync: await lastSuppressionSync(db),
		...rates,
		suppressed: suppressed.results,
		suppressedTotal: suppressedCount,
		bouncedTotal: bounced.total,
		bouncedSubscribed: bounced.subscribed,
		months,
		coldOptions: COLD_OPTIONS,
		coldCount: cold?.n ?? 0
	};
};

export const actions: Actions = {
	// #304: re-run the DMARC/SPF/DKIM/Return-Path checks now (also runs daily).
	checkDomainAuth: async (event) => {
		const { result } = await runDomainAuthCheck(getDB(event), (event.platform?.env ?? {}) as DomainAuthEnv, 'manual');
		return { domainChecked: checkSummary(result) }; // #363: the inline confirmation's counts
	},
	// #373: switch the broadcast stream's unsubscribe handling to Custom in Postmark (admins
	// only; the page confirms first), then re-run the checks so the row turns to Pass.
	switchUnsubscribeHandling: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { unsubSwitchError: 'Only an admin can change the stream setting.' });
		const env = (event.platform?.env ?? {}) as DomainAuthEnv;
		const out = await switchToCustomUnsubscribe(env);
		if (!out.ok) return fail(502, { unsubSwitchError: out.error });
		const { result } = await runDomainAuthCheck(getDB(event), env, 'manual');
		return { unsubSwitched: out.stream, domainChecked: checkSummary(result) };
	},
	// #306: "Check existing contacts" — (re)start the hygiene pass over subscribed contacts and
	// run its first batch now; the heartbeat does the rest (≤ 25 new domains per tick). Tags
	// `hygiene:invalid`, never unsubscribes.
	checkHygiene: async (event) => {
		const db = getDB(event);
		await startHygieneBackfill(db);
		const step = await runHygieneBackfill(db);
		return { hygieneStarted: true, hygieneStep: step };
	},
	// #305: hide an alert from the banners (anyone signed in). Held sends stay held.
	dismissAlert: async (event) => {
		const data = await event.request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { alertError: 'Unknown alert.' });
		await dismissAlert(getDB(event), id, event.locals.user?.id ?? null);
		throw redirect(303, backTo(data));
	},
	// #305: release a scheduled broadcast held by a critical alert (admins only). It goes back
	// to its schedule — a time already past fires on the next tick.
	releaseHold: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { alertError: 'Only an admin can release a held send.' });
		const data = await event.request.formData();
		const id = Number(data.get('campaign_id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { alertError: 'Unknown campaign.' });
		if (!(await releaseHeldCampaign(getDB(event), id))) return fail(400, { alertError: 'That send is not held any more.' });
		throw redirect(303, backTo(data));
	},
	// #285: unsubscribe contacts Postmark already suppresses (both streams' dumps).
	syncSuppressions: async (event) => {
		const env = event.platform?.env;
		const out = await runSuppressionSync(
			getDB(event),
			{ token: env?.POSTMARK_TOKEN, stream: env?.POSTMARK_STREAM, txStream: env?.POSTMARK_STREAM_TX },
			'manual'
		);
		if (!out.ok) return fail(502, { syncError: out.error });
		const { ok: _ok, ...sync } = out;
		return { sync };
	},
	// Tag cold contacts so a re-engagement / sunset automation can take over (#67).
	tagCold: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		let months = Number(data.get('months')) || 6;
		if (!COLD_OPTIONS.includes(months)) months = 6;
		const tag = String(data.get('tag') ?? '').trim().slice(0, 60);
		if (!tag) return fail(400, { coldError: 'Enter a tag name.' });

		const rows = await db
			.prepare(
				`SELECT c.id FROM contacts c
				 WHERE c.subscribed = 1
				   AND NOT EXISTS (SELECT 1 FROM events ev WHERE ev.contact_id = c.id AND ev.type IN ('open','click')
				                     AND ev.recorded_at >= datetime('now', ?))`
			)
			.bind(`-${months} months`)
			.all<{ id: number }>();

		for (const r of rows.results) await addTag(db, tag, r.id);
		return { coldTagged: rows.results.length, coldTag: tag };
	}
};
