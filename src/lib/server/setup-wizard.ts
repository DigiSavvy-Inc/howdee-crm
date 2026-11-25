// #731: the first-run wizard on Settings → Setup (`?first=1`, later `?wizard=<step>`). Every step
// can be skipped; the checklist below the wizard stays the source of truth (docs/easy-install.md).
//
//   address  the app's public address (which one links use, and where it comes from; choose or
//            clear the recorded one) + the Default From
//   sending  pick the provider, paste its token (Settings → Sending's storage), test the connection
//   webhook  create the Postmark event webhook, report the stream and its unsubscribe handling
//   test     one test email to the signed-in admin, on the transactional stream
//   done     what's left (the optional rows of the checklist)
//
// Nothing here sends mail except `sendWizardTest`, which only runs when the admin asks for it.

import { isEmail } from '$lib/csv';
import { fromAllowed, getSettings, setSettings } from './settings';
import { mailSetup, toMailResult, type SendResult } from './mail';
import { cleanPostmarkToken, mailKeyReady, setActiveProvider, setPostmarkToken } from './mail/config';
import { ensurePostmarkWebhook, type WebhookSetup } from './mail/postmark-webhook';
import { FINISH_SETUP_FROM, FINISH_SETUP_SENDING } from '$lib/finish-setup';

export const WIZARD_STEPS = [
	{ id: 'address', title: 'Your address' },
	{ id: 'sending', title: 'Connect sending' },
	{ id: 'webhook', title: 'Postmark webhook' },
	{ id: 'test', title: 'Send yourself a test' },
	{ id: 'done', title: 'Done' }
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number]['id'];

/** The step a URL asks for: `?wizard=<step>`, `?first=1` = the first step, else none. */
export function wizardStepFrom(url: URL): WizardStep | null {
	const w = url.searchParams.get('wizard');
	if (w !== null) return (WIZARD_STEPS.find((s) => s.id === w)?.id ?? 'address') as WizardStep;
	return url.searchParams.get('first') === '1' ? 'address' : null;
}

/** The step after `step` ('done' stays 'done'). */
export function nextStep(step: WizardStep): WizardStep {
	const i = WIZARD_STEPS.findIndex((s) => s.id === step);
	return WIZARD_STEPS[Math.min(i + 1, WIZARD_STEPS.length - 1)].id;
}

type By = { id: number; github_login?: string | null } | null;
type AnyEnv = Record<string, unknown> | Partial<Env> | null | undefined;

/** Save the Default From (step "Your address"). Same rule as Settings → General. */
export async function saveWizardFrom(db: D1Database, raw: string): Promise<{ ok: true; from: string } | { ok: false; error: string }> {
	const from = raw.trim();
	if (!from) return { ok: false, error: 'Enter the address your email comes from.' };
	if (!isEmail(from)) return { ok: false, error: "That doesn't look like an email address." };
	const settings = await getSettings(db);
	if (!fromAllowed(from, settings.approved_senders)) {
		return { ok: false, error: `“${from}” isn't covered by the approved senders list (Settings → General). Add its domain there first.` };
	}
	await setSettings(db, { default_from: from });
	return { ok: true, from };
}

/** Pick the provider and store its token (step "Connect sending"), then check it. Sends nothing. */
export async function saveWizardSending(
	db: D1Database,
	env: AnyEnv,
	input: { provider: string; token: string },
	by: By
): Promise<{ ok: true; check: { ok: boolean; summary: string } | null } | { ok: false; error: string }> {
	if (input.provider !== 'postmark') return { ok: false, error: 'Only Postmark can be connected in this version.' };
	const picked = await setActiveProvider(db, 'postmark', by);
	if (!picked.ok) return { ok: false, error: picked.error };
	if (input.token.trim()) {
		if (!mailKeyReady(env)) {
			return { ok: false, error: 'MAIL_TOKEN_KEY is not set, so the token can’t be stored in the app. Set the Worker secret POSTMARK_TOKEN instead, or set MAIL_TOKEN_KEY and try again.' };
		}
		const cleaned = cleanPostmarkToken(input.token);
		if (!cleaned.ok) return { ok: false, error: cleaned.error };
		await setPostmarkToken(db, env, cleaned.token, by);
	}
	const { provider, creds } = await mailSetup(db, env);
	if (!provider) return { ok: false, error: creds.postmark.tokenError ?? 'Paste the Postmark Server API token.' };
	const check = await provider.check();
	return { ok: true, check: { ok: check.ok, summary: check.summary } };
}

/** Step "Postmark webhook": create it (or find it), or with `update` move a webhook of this
 *  install that points at another host to `baseUrl`, and report the stream. */
export async function wizardWebhook(
	db: D1Database,
	env: AnyEnv,
	baseUrl: string,
	opts: { create: boolean; update?: boolean },
	fetchFn: typeof fetch = fetch
): Promise<WebhookSetup> {
	const { creds } = await mailSetup(db, env);
	if (creds.postmark.tokenError) return { ok: false, error: creds.postmark.tokenError };
	return await ensurePostmarkWebhook(
		{
			token: creds.postmark.token,
			broadcast: creds.postmark.stream,
			transactional: creds.postmark.txStream,
			webhookKey: creds.postmark.webhookKey,
			baseUrl,
			create: opts.create,
			update: opts.update ?? false
		},
		fetchFn
	);
}

/** Step "Send yourself a test": one email to the admin's own address, transactional stream. */
export async function sendWizardTest(
	db: D1Database,
	env: AnyEnv,
	userId: number
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
	const { provider, creds } = await mailSetup(db, env);
	if (!provider) return { ok: false, error: creds.postmark.tokenError ?? FINISH_SETUP_SENDING };
	const me = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string | null }>();
	const to = (me?.email ?? '').trim();
	if (!to) return { ok: false, error: 'Your user record has no email address (Account → Email).' };
	const envFrom = String((env as Record<string, unknown> | null | undefined)?.POSTMARK_FROM ?? '').trim();
	const from = ((await getSettings(db)).default_from?.trim() || envFrom).trim();
	if (!from) return { ok: false, error: FINISH_SETUP_FROM };
	let res: SendResult | undefined;
	try {
		[res] = await provider.sendBatch([
			{
				from,
				to,
				subject: `[TEST] ${provider.label} is sending for this CRM`,
				text: `This test was sent through ${provider.label} from the setup wizard.\n\nIf it arrived, sending works.`,
				html: `<p>This test was sent through ${provider.label} from the setup wizard.</p><p>If it arrived, sending works.</p>`,
				stream: 'transactional',
				tracking: { opens: false, links: 'none' }
			}
		]);
	} catch (e) {
		return { ok: false, error: `${provider.label} request failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
	}
	const r = toMailResult(res);
	if (!r || r.ErrorCode !== 0) return { ok: false, error: `${provider.label} refused it: ${r?.Message ?? 'no response'}` };
	return { ok: true, to };
}

/** The webhook URL as shown on the page: the key is never printed, only dots. */
export function maskedWebhookUrl(baseUrl: string): string {
	return `${baseUrl}/api/webhook?key=••••••••`;
}
