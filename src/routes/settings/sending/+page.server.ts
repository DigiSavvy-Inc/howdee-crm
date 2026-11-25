import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { capabilityLines, isMailProviderId, mailSetup, MAIL_PROVIDERS, toMailResult, type SendResult } from '$lib/server/mail';
import {
	campaignSending,
	cleanPostmarkToken,
	mailKeyReady,
	mailSettingsEvents,
	postmarkTokenInfo,
	readMailSettings,
	removePostmarkToken,
	setActiveProvider,
	setPostmarkStreams,
	setPostmarkToken,
	setTrackingMode
} from '$lib/server/mail/config';
import { isTrackingMode } from '$lib/server/mail/provider';

// Settings → Sending (#700, 1/5 of #699; docs/sending-providers.md). Admin-only (load + every
// action): the sending provider, its credentials (the server token sealed with MAIL_TOKEN_KEY,
// shown only as set / not set), Test connection (sends nothing), Send a test to me and what the
// provider supports. Only Postmark can be made active until the other adapters exist.

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

function by(event: { locals: App.Locals }) {
	const u = event.locals.user;
	return u ? { id: u.id, github_login: u.github_login } : null;
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const db = getDB(event);
	const env = event.platform?.env;
	const [{ provider, creds }, stored, token, events, sending, lastEvent, baseUrl] = await Promise.all([
		mailSetup(db, env),
		readMailSettings(db),
		postmarkTokenInfo(db, env),
		mailSettingsEvents(db),
		campaignSending(db),
		db.prepare(`SELECT recorded_at FROM events ORDER BY id DESC LIMIT 1`).first<{ recorded_at: string }>(),
		publicBaseUrlFor(event)
	]);
	const e = (env ?? {}) as unknown as Record<string, unknown>;
	const envStr = (k: string) => (typeof e[k] === 'string' ? (e[k] as string).trim() : '');
	return {
		providers: MAIL_PROVIDERS.map((p) => ({ ...p })),
		active: creds.provider,
		activeFrom: creds.providerFrom,
		configured: !!provider,
		capabilities: provider ? capabilityLines(provider.id, provider.capabilities, provider.trackingBy) : [],
		// #701: who tracks opens and clicks. `canChoose` = the provider can track itself (SMTP can't).
		tracking: {
			saved: stored.tracking ?? null,
			env: envStr('MAIL_TRACKING'),
			mode: creds.tracking,
			from: creds.trackingFrom,
			effective: provider?.trackingBy ?? creds.tracking,
			canChoose: provider ? provider.capabilities.tracking : true
		},
		keyReady: mailKeyReady(env),
		sending,
		postmark: {
			token,
			stream: { saved: stored.postmark?.stream ?? '', env: envStr('POSTMARK_STREAM'), effective: creds.postmark.stream },
			txStream: { saved: stored.postmark?.txStream ?? '', env: envStr('POSTMARK_STREAM_TX'), effective: creds.postmark.txStream },
			webhookKeySet: !!creds.postmark.webhookKey,
			accountTokenSet: !!creds.postmark.accountToken
		},
		// The key itself never reaches the page: the URL shows where it goes.
		webhookUrl: `${baseUrl}/api/webhook?key=<WEBHOOK_KEY>`,
		lastEventAt: lastEvent?.recorded_at ?? null,
		events
	};
};

export const actions: Actions = {
	setProvider: async (event) => {
		requireAdmin(event);
		const id = String((await event.request.formData()).get('provider') ?? '');
		if (!isMailProviderId(id)) return fail(400, { providerError: 'Pick a provider.' });
		const res = await setActiveProvider(getDB(event), id, by(event));
		if (!res.ok) return fail(409, { providerError: res.error });
		return { providerSaved: true };
	},

	// #701: by the provider (default) or by the CRM. Only mail sent afterwards changes.
	setTracking: async (event) => {
		requireAdmin(event);
		const mode = String((await event.request.formData()).get('tracking') ?? '');
		if (!isTrackingMode(mode)) return fail(400, { trackingError: 'Choose by the provider or by the CRM.' });
		const res = await setTrackingMode(getDB(event), mode, by(event));
		if (!res.ok) return fail(400, { trackingError: res.error });
		return { trackingSaved: true };
	},

	saveToken: async (event) => {
		requireAdmin(event);
		const env = event.platform?.env;
		if (!mailKeyReady(env)) return fail(400, { tokenError: 'MAIL_TOKEN_KEY is not set, so secrets can’t be stored in the app. Use the Worker secret POSTMARK_TOKEN instead.' });
		const cleaned = cleanPostmarkToken(String((await event.request.formData()).get('token') ?? ''));
		if (!cleaned.ok) return fail(400, { tokenError: cleaned.error });
		await setPostmarkToken(getDB(event), env, cleaned.token, by(event));
		return { tokenSaved: true };
	},

	removeToken: async (event) => {
		requireAdmin(event);
		const removed = await removePostmarkToken(getDB(event), by(event));
		return { tokenRemoved: removed };
	},

	saveStreams: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const res = await setPostmarkStreams(
			getDB(event),
			{ stream: String(data.get('stream') ?? ''), txStream: String(data.get('tx_stream') ?? '') },
			by(event)
		);
		if (!res.ok) return fail(400, { streamsError: res.error });
		return { streamsSaved: true };
	},

	// Checks the credentials and streams; sends nothing.
	test: async (event) => {
		requireAdmin(event);
		const { provider, creds } = await mailSetup(getDB(event), event.platform?.env);
		if (!provider) return fail(400, { testError: creds.postmark.tokenError ?? 'The provider isn’t configured yet: set its credentials first.' });
		const check = await provider.check();
		return { check: { ok: check.ok, summary: check.summary, rows: check.rows } };
	},

	// One real email to the signed-in admin's own address, transactional stream, default From.
	sendTest: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const env = event.platform?.env;
		const { provider, creds } = await mailSetup(db, env);
		if (!provider) return fail(400, { sendError: creds.postmark.tokenError ?? 'The provider isn’t configured yet: set its credentials first.' });
		const me = await db.prepare('SELECT email FROM users WHERE id = ?').bind(event.locals.user!.id).first<{ email: string | null }>();
		const to = (me?.email ?? '').trim();
		if (!to) return fail(400, { sendError: 'Your user record has no email address (Account → Email).' });
		const from = ((await getSettings(db)).default_from?.trim() || String(env?.POSTMARK_FROM ?? '')).trim();
		if (!from) return fail(400, { sendError: 'No From address (Settings → General → Default From, or POSTMARK_FROM).' });
		let res: SendResult | undefined;
		try {
			[res] = await provider.sendBatch([
				{
					from,
					to,
					subject: `[TEST] ${provider.label} is sending for this CRM`,
					text: `This test was sent through ${provider.label} from Settings → Sending.\n\nIf it arrived, sending works.`,
					html: `<p>This test was sent through ${provider.label} from Settings → Sending.</p><p>If it arrived, sending works.</p>`,
					stream: 'transactional',
					tracking: { opens: false, links: 'none' }
				}
			]);
		} catch (e) {
			return fail(502, { sendError: `${provider.label} request failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` });
		}
		const r = toMailResult(res);
		if (!r || r.ErrorCode !== 0) return fail(502, { sendError: `${provider.label} refused it: ${r?.Message ?? 'no response'}` });
		return { testSent: { to, messageId: r.MessageID ?? null } };
	}
};
