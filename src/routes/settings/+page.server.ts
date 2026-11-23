import { defaultListName } from '$lib/server/default-list';
import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { getSettings, setSettings, parseEmailList, fromAllowed, isValidTimezone, timezoneOptions, DEFAULT_TIMEZONE } from '$lib/server/settings';
import {
	engagementStatus,
	computeEngagement,
	getEngagementConfig,
	setEngagementConfig,
	validateEngagementConfig,
	tunableValues,
	TUNABLE_FIELDS,
	ENGAGEMENT_DEFAULTS,
	ENGAGEMENT_CONFIG_KEY,
	type TunableKey
} from '$lib/server/engagement';
import { setNavLayout } from '$lib/server/users';
import { modelKeyProblem } from '$lib/server/ai/config';
import { resendSubjectModel } from '$lib/server/ai-subject';
import { isNavLayout } from '$lib/nav-layout';
import { forwardSenderAddress } from '$lib/server/reply-forward';
import { validateBrandingText, validateLogoFile, unsafeSvg, saveBrandingText, saveLogo, removeLogo } from '$lib/server/branding';

/** #246 / #696: the resend-subject model's provider has a key (Claude Haiku unless overridden). */
async function subjectKeySet(db: D1Database, platformEnv: unknown): Promise<boolean> {
	const model = await resendSubjectModel(db);
	return !!model && !(await modelKeyProblem(db, platformEnv, model));
}

export const load: PageServerLoad = async (event) => {
	event.depends('app:user'); // #134: `me.navLayout` refreshes after the header's nav toggle
	// #532: a member only gets the Navigation layout section — no settings, secrets, forwarding
	// addresses, approved senders or engagement config in their page data.
	if (event.locals.user?.role !== 'admin') return { isAdmin: false as const, me: event.locals.user };
	const db = getDB(event);
	const settings = await getSettings(db);
	return {
		isAdmin: true as const,
		settings,
		// #661: String() keeps this `string` when the generated Env types the var as the literal "".
		envForwardTo: String(event.platform?.env?.INBOUND_FORWARD_TO ?? ''),
		// #605: reply capture needs both the inbound address (var) and INBOUND_KEY (secret).
		replyCapture: !!event.platform?.env?.POSTMARK_INBOUND_ADDRESS && !!event.platform?.env?.INBOUND_KEY,
		// #381: the forward's sender (INBOUND_FORWARD_FROM → REVIEW_FROM → POSTMARK_FROM).
		forwardFrom: forwardSenderAddress((event.platform?.env ?? {}) as Record<string, string | undefined>),
		envFrom: event.platform?.env?.POSTMARK_FROM ?? '',
		defaultListName: defaultListName(event.platform?.env),
		aiKeyConfigured: await subjectKeySet(db, event.platform?.env),
		lumaSecretFromEnv:!settings.luma_webhook_secret && !!event.platform?.env?.LUMA_WEBHOOK_SECRET,
		lumaWebhookUrl: `${await publicBaseUrlFor(event)}/api/luma`,
		engagement: await engagementStatus(db),
		// Tunable score weights / half-life / tier thresholds (#116).
		engagementConfig: tunableValues(await getEngagementConfig(db)),
		engagementDefaults: tunableValues(ENGAGEMENT_DEFAULTS),
		engagementFields: TUNABLE_FIELDS.map((f) => ({ ...f })),
		engagementCustom: !!(await db
			.prepare(`SELECT 1 AS x FROM app_state WHERE key = ?`)
			.bind(ENGAGEMENT_CONFIG_KEY)
			.first()),
		me: event.locals.user,
		timezoneOptions: timezoneOptions(settings.timezone),
		defaultTimezone: DEFAULT_TIMEZONE
	};
};

const ADMINS_ONLY = 'Admins only.';
const isAdmin = (event: { locals: App.Locals }) => event.locals.user?.role === 'admin';

export const actions: Actions = {
	save: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: ADMINS_ONLY });
		const db = getDB(event);
		const data = await event.request.formData();

		const forwardRaw = String(data.get('inbound_forward_to') ?? '');
		const forwards = parseEmailList(forwardRaw);
		if (forwardRaw.trim() && forwards.length === 0) {
			return fail(400, { error: 'No valid email addresses in the forward-to list.' });
		}

		const approved = String(data.get('approved_senders') ?? '').trim();
		const defaultFrom = String(data.get('default_from') ?? '').trim();
		if (defaultFrom && !fromAllowed(defaultFrom, approved)) {
			return fail(400, {
				error: `Default From “${defaultFrom}” isn't covered by the approved senders list — add its domain (or the full address) first.`
			});
		}

		// Luma integration (#70). Secret left blank = leave the stored value untouched (so
		// you don't have to re-paste it on every save); send a single space to clear it.
		const lumaSecretRaw = String(data.get('luma_webhook_secret') ?? '');
		const lumaList = String(data.get('luma_list') ?? '').trim();

		// Operator timezone (#119) — "weekend" for weekday-only scheduling is relative to
		// this. Blank keeps the current value (defaults to DEFAULT_TIMEZONE unset).
		const timezoneRaw = String(data.get('timezone') ?? '').trim();
		if (timezoneRaw && !isValidTimezone(timezoneRaw)) {
			return fail(400, { error: `"${timezoneRaw}" isn't a recognized timezone.` });
		}

		const values: Parameters<typeof setSettings>[1] = {
			inbound_forward_to: forwards.join(', '),
			approved_senders: approved,
			default_from: defaultFrom,
			luma_list: lumaList,
			reply_bcc_operator: data.get('reply_bcc_operator') ? '1' : '',
			// #311: the CAN-SPAM postal address the pre-send checks look for.
			mailing_address: String(data.get('mailing_address') ?? '').trim().slice(0, 300)
		};
		// #246: the toggle is disabled (so not posted) without the key — leave it alone then.
		if (await subjectKeySet(db, event.platform?.env)) values.ai_resend_subject = data.get('ai_resend_subject') ? 'on' : 'off';
		if (lumaSecretRaw.trim() || lumaSecretRaw === ' ') values.luma_webhook_secret = lumaSecretRaw.trim();
		if (timezoneRaw) values.timezone = timezoneRaw;

		await setSettings(db, values);
		return { saved: true };
	},

	// Per-user nav layout (#134) — also posted by the layout's top/left toggle button.
	setNavLayout: async (event) => {
		const user = event.locals.user;
		if (!user) return fail(401, { navError: 'Not signed in.' });
		const data = await event.request.formData();
		const layout = String(data.get('nav_layout') ?? '');
		if (!isNavLayout(layout)) return fail(400, { navError: 'Pick top or left.' });
		await setNavLayout(getDB(event), user.id, layout);
		return { navLayout: layout };
	},

	// Operator "Recompute now" (#111/#113): mark everyone dirty and drain a larger
	// batch than the heartbeat's per-tick 150, so an operator-triggered recompute
	// visibly makes progress without waiting for several ticks.
	recomputeEngagement: async (event) => {
		if (!isAdmin(event)) return fail(403, { engagementConfigError: ADMINS_ONLY });
		const db = getDB(event);
		await db
			.prepare(`INSERT OR IGNORE INTO contact_engagement (contact_id, dirty) SELECT id, 1 FROM contacts`)
			.run();
		await db.prepare(`UPDATE contact_engagement SET dirty = 1`).run();
		const { computed } = await computeEngagement(db, { limit: 300 });
		return { engagementOk: computed };
	},

	// Tunable engagement scoring (#116). Saving (or resetting) marks everyone dirty, so the
	// heartbeat re-scores all contacts with the new numbers within a few ticks.
	saveEngagementConfig: async (event) => {
		if (!isAdmin(event)) return fail(403, { engagementConfigError: ADMINS_ONLY });
		const db = getDB(event);
		const data = await event.request.formData();
		const input: Partial<Record<TunableKey, unknown>> = {};
		for (const f of TUNABLE_FIELDS) input[f.key] = data.get(f.key);
		const v = validateEngagementConfig(input);
		if (!v.ok) return fail(400, { engagementConfigError: v.error });
		await setEngagementConfig(db, v.cfg);
		return { engagementConfigSaved: true };
	},

	// Branding (#188), admins only: app name + short name, and an optional logo upload.
	// An empty file input keeps the current logo; "Remove logo" goes back to the bundled one.
	saveBranding: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { brandingError: 'Only admins can change branding.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const text = validateBrandingText(data.get('app_name'), data.get('app_short_name'));
		if (!text.ok) return fail(400, { brandingError: text.error });

		const f = data.get('logo');
		const file = f instanceof File && f.size > 0 ? f : null;
		if (file) {
			const check = validateLogoFile(file);
			if (!check.ok) return fail(check.status, { brandingError: check.error });
			if (check.ext === 'svg' && unsafeSvg(await file.text())) {
				return fail(400, { brandingError: 'That SVG contains scripts or event handlers — export a plain SVG or a PNG.' });
			}
			const bucket = event.platform?.env?.MEDIA;
			if (!bucket) return fail(500, { brandingError: 'Media storage (R2) is not configured.' });
			await saveLogo(db, bucket, file, check.ext);
		}
		await saveBrandingText(db, text.appName, text.shortName);
		return { brandingSaved: true };
	},

	removeLogo: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { brandingError: 'Only admins can change branding.' });
		await removeLogo(getDB(event), event.platform?.env?.MEDIA);
		return { brandingSaved: true };
	},

	resetEngagementConfig: async (event) => {
		if (!isAdmin(event)) return fail(403, { engagementConfigError: ADMINS_ONLY });
		await setEngagementConfig(getDB(event), null);
		return { engagementConfigSaved: true };
	}
};
