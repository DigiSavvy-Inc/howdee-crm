import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { webhookUrlProblem } from '$lib/server/ai/jobs-webhook';
import { getAlertConfig, saveAlertConfig, sampleAlertPayload, sendAlertWebhook } from '$lib/server/deliverability-alerts';
import { DEFAULT_ALERT_CONFIG, thresholdsProblem, type AlertConfig } from '$lib/deliverability-alerts';

// Settings → Deliverability (#305), admin-only (load + every action): the post-send alert
// thresholds, the optional webhook (the #303 delivery + SSRF guard) and the off-by-default
// "hold queued scheduled broadcasts to the same list on critical".

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return { config: await getAlertConfig(getDB(event)), defaults: DEFAULT_ALERT_CONFIG };
};

/** "2" / "0.05" (percent) → 0.02 / 0.0005; NaN when blank or not a number. */
function pct(v: FormDataEntryValue | null): number {
	const s = String(v ?? '').trim().replace(/%$/, '');
	return s === '' ? NaN : Number(s) / 100;
}

export const actions: Actions = {
	save: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const webhookUrl = String(data.get('webhook_url') ?? '').trim();
		const cfg: AlertConfig = {
			hardWarn: pct(data.get('hard_warn')),
			hardCrit: pct(data.get('hard_crit')),
			complaintWarn: pct(data.get('complaint_warn')),
			complaintCrit: pct(data.get('complaint_crit')),
			webhookUrl,
			webhookFormat: data.get('webhook_format') === 'slack' ? 'slack' : 'json',
			holdOnCritical: data.get('hold_on_critical') === '1'
		};
		const problem = thresholdsProblem(cfg) ?? (webhookUrl ? webhookUrlProblem(webhookUrl) : null);
		if (problem) return fail(400, { action: 'save', error: problem });
		await saveAlertConfig(getDB(event), cfg);
		return { action: 'save', saved: true };
	},

	reset: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const cur = await getAlertConfig(db);
		// Thresholds only — the webhook and the hold switch are kept.
		const { hardWarn, hardCrit, complaintWarn, complaintCrit } = DEFAULT_ALERT_CONFIG;
		await saveAlertConfig(db, { ...cur, hardWarn, hardCrit, complaintWarn, complaintCrit });
		return { action: 'save', saved: true };
	},

	testWebhook: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const cfg = await getAlertConfig(db);
		if (!cfg.webhookUrl) return fail(400, { action: 'test', error: 'Save a webhook URL first.' });
		const appUrl = await publicBaseUrlFor(event);
		const res = await sendAlertWebhook(cfg, sampleAlertPayload(cfg, appUrl, new Date()));
		if (res.error) return fail(502, { action: 'test', error: res.error, status: res.status });
		return { action: 'test', status: res.status };
	}
};
