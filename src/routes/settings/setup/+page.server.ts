import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { runSetupChecks } from '$lib/server/setup-checks';
import { getSettings } from '$lib/server/settings';
import {
	clearSeenOrigin,
	domainConfig,
	looksLikeVersionPreview,
	publicBaseUrlFor,
	replaceSeenOrigin,
	resolveBaseUrl,
	seenOriginProblem
} from '$lib/server/public-url';
import { mailSetup, MAIL_PROVIDERS } from '$lib/server/mail';
import { mailKeyReady, postmarkTokenInfo } from '$lib/server/mail/config';
import { switchToCustomUnsubscribe, withSendingCreds, type DomainAuthEnv } from '$lib/server/domain-auth';
import { webhookUrlFor } from '$lib/server/mail/postmark-webhook';
import {
	maskedWebhookUrl,
	saveWizardFrom,
	saveWizardSending,
	sendWizardTest,
	wizardStepFrom,
	wizardWebhook,
	WIZARD_STEPS
} from '$lib/server/setup-wizard';

// Settings → Setup (#609). Admin-only: each piece a working install needs, ready or not, with
// one line on how to fix it. Secrets are reported as set / not set only — never a value.
//
// #731: `?first=1` (straight after /setup) or `?wizard=<step>` shows the first-run wizard above
// the checklist. Every step can be skipped. Admin-only, load and every action.

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

function by(event: { locals: App.Locals }) {
	const u = event.locals.user;
	return u ? { id: u.id, github_login: u.github_login } : null;
}

/** #731: which address links use, where it comes from, and whether the wizard may offer to
 *  record this request's origin or clear the recorded one. Read-only. */
async function addressInfo(db: D1Database, envBase: string, requestUrl: URL) {
	const cfg = await domainConfig(db);
	const address = resolveBaseUrl(cfg.domain, envBase, requestUrl.origin, cfg.seen);
	const current = requestUrl.origin;
	const currentProblem = seenOriginProblem(current);
	const pinned = !!cfg.domain || !!envBase; // Settings → Domain / PUBLIC_BASE_URL win anyway
	const hostOf = (u: string) => {
		try {
			return new URL(u).host;
		} catch {
			return '';
		}
	};
	return {
		url: address.url,
		source: address.source,
		host: hostOf(address.url),
		recorded: cfg.seen ?? null,
		current,
		canUse: !pinned && !currentProblem && cfg.seen !== current,
		// #731: why this page's address can't be recorded ('loopback host', 'not https', …), or null.
		currentProblem,
		// #732: never while Settings → Domain or PUBLIC_BASE_URL decides the address (the action refuses there).
		canClear: !!cfg.seen && !pinned,
		previewHint: looksLikeVersionPreview(hostOf(address.url)) || looksLikeVersionPreview(requestUrl.host),
		pinned
	};
}

const envBaseOf = (env: Record<string, unknown> | undefined) => (typeof env?.PUBLIC_BASE_URL === 'string' ? env.PUBLIC_BASE_URL.trim() : '');

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const db = getDB(event);
	const env = event.platform?.env as unknown as Record<string, unknown> | undefined;
	// #731: a page load never writes the address. It is recorded at /setup (first admin) and
	// otherwise only by the wizard's explicit "Use this address for links".
	const report = await runSetupChecks(db, env);
	const step = wizardStepFrom(event.url);
	if (!step) return { checks: report.checks, attention: report.attention, first: false, wizard: null };

	const [settings, { provider, creds }, token, address] = await Promise.all([
		getSettings(db),
		mailSetup(db, event.platform?.env),
		postmarkTokenInfo(db, event.platform?.env),
		addressInfo(db, envBaseOf(env), event.url)
	]);
	return {
		checks: report.checks,
		attention: report.attention,
		first: event.url.searchParams.get('first') === '1',
		wizard: {
			step,
			steps: WIZARD_STEPS.map((s) => ({ ...s })),
			address,
			defaultFrom: settings.default_from ?? '',
			envFrom: typeof env?.POSTMARK_FROM === 'string' ? env.POSTMARK_FROM : '',
			providers: MAIL_PROVIDERS.map((p) => ({ ...p })),
			active: creds.provider,
			configured: !!provider,
			token: { source: token.source, error: token.error },
			keyReady: mailKeyReady(event.platform?.env),
			streams: { broadcast: creds.postmark.stream, transactional: creds.postmark.txStream },
			webhookKeySet: !!creds.postmark.webhookKey,
			webhookUrl: maskedWebhookUrl(address.url)
		}
	};
};

/** #731: why the address step refuses to record or clear an address. */
const ADDRESS_PINNED = 'Links already use Settings → Domain or PUBLIC_BASE_URL, which win over a recorded address.';

export const actions: Actions = {
	// Step 1: the address this page was opened on (when nothing else is set) and the Default From.
	address: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const data = await event.request.formData();
		const res = await saveWizardFrom(db, String(data.get('default_from') ?? ''));
		if (!res.ok) return fail(400, { step: 'address', error: res.error });
		return { step: 'address', saved: `Default From set to ${res.from}.` };
	},

	// Step 1: links use this request's origin from now on (replaces the recorded one). Never while
	// Settings → Domain or PUBLIC_BASE_URL is set: those win anyway.
	useAddress: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const env = event.platform?.env as unknown as Record<string, unknown> | undefined;
		const cfg = await domainConfig(db);
		if (cfg.domain || envBaseOf(env)) return fail(409, { step: 'address', error: ADDRESS_PINNED });
		const problem = await replaceSeenOrigin(db, event.url);
		if (problem) return fail(400, { step: 'address', error: `This address can't be used for links (${problem}). Open the app at its public https address.` });
		return { step: 'address', saved: `Links now use ${event.url.origin}.` };
	},

	// Step 1: forget the recorded address (links follow the address each page is opened on).
	// #731: refused like useAddress while Settings → Domain or PUBLIC_BASE_URL decides the links.
	clearAddress: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const env = event.platform?.env as unknown as Record<string, unknown> | undefined;
		if ((await domainConfig(db)).domain || envBaseOf(env)) return fail(409, { step: 'address', error: ADDRESS_PINNED });
		await clearSeenOrigin(db);
		return { step: 'address', saved: 'The recorded address was cleared.' };
	},

	// Step 2: the provider and its token. Checks the connection; sends nothing.
	sending: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const res = await saveWizardSending(
			getDB(event),
			event.platform?.env,
			{ provider: String(data.get('provider') ?? 'postmark'), token: String(data.get('token') ?? '') },
			by(event)
		);
		if (!res.ok) return fail(400, { step: 'sending', error: res.error });
		return { step: 'sending', saved: res.check?.ok ? `Connected: ${res.check.summary}` : `Saved. ${res.check?.summary ?? ''}`.trim(), checkOk: !!res.check?.ok };
	},

	// Step 3: create the Postmark webhook (or find the one that's there). Sends nothing.
	webhook: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const res = await wizardWebhook(db, event.platform?.env, await publicBaseUrlFor(event), { create: true });
		if (!res.ok) return fail(400, { step: 'webhook', error: res.error });
		return { step: 'webhook', webhook: res };
	},

	// Step 3: a webhook of this install that points at another host → this address (PUT). Sends nothing.
	updateWebhook: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const res = await wizardWebhook(db, event.platform?.env, await publicBaseUrlFor(event), { create: false, update: true });
		if (!res.ok) return fail(400, { step: 'webhook', error: res.error });
		return { step: 'webhook', webhook: res };
	},

	// Step 3, by hand: the full webhook URL, once, for an admin who'd rather paste it in Postmark.
	revealWebhook: async (event) => {
		requireAdmin(event);
		const { creds } = await mailSetup(getDB(event), event.platform?.env);
		const key = creds.postmark.webhookKey;
		if (!key) return fail(400, { step: 'webhook', error: 'WEBHOOK_KEY is not set. Run `npx wrangler secret put WEBHOOK_KEY` first.' });
		return { step: 'webhook', revealed: webhookUrlFor(await publicBaseUrlFor(event), key) };
	},

	// Step 3: unsubscribe handling on the broadcast stream → Custom (#373). Sends nothing.
	switchUnsubscribe: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const out = await switchToCustomUnsubscribe(await withSendingCreds(db, (event.platform?.env ?? {}) as DomainAuthEnv));
		if (!out.ok) return fail(502, { step: 'webhook', error: out.error });
		return { step: 'webhook', saved: `Unsubscribe handling on "${out.stream}" is now Custom.` };
	},

	// Step 4: the one email this wizard ever sends, and only when asked.
	test: async (event) => {
		requireAdmin(event);
		const res = await sendWizardTest(getDB(event), event.platform?.env, event.locals.user!.id);
		if (!res.ok) return fail(400, { step: 'test', error: res.error });
		return { step: 'test', saved: `Test sent to ${res.to}. Check that inbox.` };
	}
};
