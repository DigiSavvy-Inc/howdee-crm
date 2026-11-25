// Scheduled assistant jobs (#303, part of #71): a saved prompt the heartbeat tick runs
// unattended, then POSTs to a webhook. Rules:
// - Read-tier tools only (JOB_TOOLS) — even once write/approve tools exist. The chat's hard
//   rules (system prompt) apply unchanged, plus an "unattended" preamble.
// - Results go only to the job's webhook, its run history (ai_job_runs) and — #390 — an email
//   to ADMINS of this CRM. Email recipients are active admin users (users.email) and the
//   REVIEW_TO address, nothing else: never a free-text address, a contact or a list
//   (./jobs-email.ts checks it at save and resolves addresses at send). The model never sends;
//   the runner emails the finished report through a sender the caller injects
//   (../job-email-send.ts: From REVIEW_FROM, POSTMARK_STREAM_TX, no tracking), so nothing
//   under ai/ imports a sending module.
// - Spend caps apply: a run counts against its creator's daily cap and the app's monthly
//   cap (spentMicros in ./config.ts sums ai_job_runs too). At a cap the run is recorded as
//   `skipped` and no API call is made.
// - The tick runs ≤ JOBS_PER_TICK due jobs; each is claimed by a conditional UPDATE that
//   moves next_run_at forward, so two overlapping ticks can't run the same occurrence.
// Tables: migration 0080. Webhook secret sealed with MAIL_TOKEN_KEY (../crypto-box.ts).

import {
	DIGEST_PRESET,
	EMAIL_WORD_CAP,
	JOB_NAME_MAX,
	JOB_PROMPT_MAX,
	JOB_RUNS_SHOWN,
	PAYLOAD_FORMATS,
	SCHEDULE_KINDS,
	type JobSchedule,
	type PayloadFormat,
	type ScheduleKind
} from '$lib/ai-jobs';
import { effortFor, modelInfo, supportsTools, type Effort, type Usage } from '$lib/ai-models';
import { getBranding } from '../branding';
import { sqliteUtc } from '../businessdays';
import { isValidKey, open, seal } from '../crypto-box';
import { publicBaseUrl } from '../public-url';
import { getTimezone, isValidTimezone } from '../settings';
import { findActiveUserById } from '../users';
import { availability, codeAllowedFor, configModelInfo, configModels, featureModel, getAssistantConfig, modelKeyProblem, spendCheck, type AssistantConfig } from './config';
import { providerFor } from './providers';
import { runTurn, type StopReason } from './loop';
import type { AiProvider, ContentBlock } from './provider';
import { systemPrompt } from './system';
import { TOOLS } from './tools';
import type { Tool } from './tools/types';
import { nextRunAt, parseHHMM } from './jobs-schedule';
import { buildPayload, deliverWebhook, samplePayload, webhookUrlProblem, type Delivery } from './jobs-webhook';
import {
	checkEmailSelection,
	defaultEmailSelection,
	parseEmailSelection,
	renderJobEmail,
	selectionFromValues,
	type EmailOutcome,
	type EmailSelection,
	type JobEmailSender
} from './jobs-email';

export const JOBS_PER_TICK = 2;
export const JOB_MAX_TOOL_CALLS = 15;
export const JOB_DEADLINE_MS = 2 * 60 * 1000;
export const RUN_NOW_DEADLINE_MS = 60 * 1000;
export const SECRET_MAX = 200;

/** Unattended runs get read-tier tools only — structural, not a flag (tests/ai-jobs.test.ts). */
export const JOB_TOOLS: Tool[] = TOOLS.filter((t) => t.tier === 'read');

export const JOB_PREAMBLE = [
	'You are running unattended as a scheduled job. Nobody will read your reply live or answer questions, so do not ask any.',
	'In a scheduled job you have read tools only: you cannot change any data here, whatever the abilities listed above say.',
	'Produce one self-contained report in Markdown that answers the job prompt: short headings, bullets, and links to records where the tools give them.',
	'Your final message is delivered as the report (to a webhook and/or by email to the admins) — put the whole report in it, without preambles like "Here is".',
	'If data is missing or a tool fails, say so in the report. Never claim to have sent, changed or scheduled anything.'
].join('\n');

export type JobRow = {
	id: number;
	name: string;
	prompt: string;
	model: string;
	effort: string | null;
	schedule_kind: ScheduleKind;
	schedule_time: string;
	schedule_dow: number | null;
	schedule_dom: number | null;
	timezone: string;
	webhook_url: string;
	webhook_secret: string | null;
	webhook_secret_last4: string | null;
	payload_format: PayloadFormat;
	/** #390: JSON array of admin user ids + optional 'review_to'; NULL = no email. */
	email_admins: string | null;
	enabled: number;
	created_by: number | null;
	last_run_at: string | null;
	next_run_at: string | null;
	created_at: string;
	updated_at: string;
};

/** A job as a page sees it: no secret blob. */
export type JobView = Omit<JobRow, 'webhook_secret'> & {
	has_secret: boolean;
	created_by_login: string | null;
	last_status: string | null;
};

export type RunRow = {
	id: number;
	job_id: number | null;
	user_id: number | null;
	trigger: 'schedule' | 'manual';
	status: 'ok' | 'error' | 'skipped';
	model: string | null;
	started_at: string;
	finished_at: string | null;
	output_markdown: string | null;
	webhook_status: number | null;
	/** #390: 'sent' | 'partial' | 'failed', NULL = no email for this run. */
	email_status: string | null;
	error: string | null;
	input_tokens: number;
	output_tokens: number;
	cost_micros: number;
};

export function scheduleOf(j: Pick<JobRow, 'schedule_kind' | 'schedule_time' | 'schedule_dow' | 'schedule_dom' | 'timezone'>): JobSchedule {
	return { kind: j.schedule_kind, time: j.schedule_time, dow: j.schedule_dow, dom: j.schedule_dom, timezone: j.timezone };
}

// ---- input ----

export type JobInput = {
	name: string;
	prompt: string;
	model: string;
	effort: Effort | null;
	schedule: JobSchedule;
	/** '' = no webhook (email only). */
	webhookUrl: string;
	format: PayloadFormat;
	/** #390: who gets the report by email (null = nobody). Shape-checked here, admin-checked in saveJob. */
	email: EmailSelection | null;
	enabled: boolean;
	/** undefined = keep the stored secret, '' = clear it, else the new secret. */
	secret: string | undefined;
};

/** Validate a submitted job (a form's fields as strings). */
export function validateJobInput(
	f: Record<string, string | undefined>,
	cfg: Pick<AssistantConfig, 'allowedModels'> & Partial<Pick<AssistantConfig, 'openai'>>
): { ok: true; value: JobInput } | { ok: false; error: string } {
	const name = (f.name ?? '').trim();
	const prompt = (f.prompt ?? '').trim();
	if (!name) return { ok: false, error: 'Give the job a name.' };
	if (name.length > JOB_NAME_MAX) return { ok: false, error: `Names are limited to ${JOB_NAME_MAX} characters.` };
	if (!prompt) return { ok: false, error: 'Write the prompt the job runs.' };
	if (prompt.length > JOB_PROMPT_MAX) return { ok: false, error: `Prompts are limited to ${JOB_PROMPT_MAX} characters.` };
	const model = modelInfo(f.model, cfg.openai ? configModels({ openai: cfg.openai }) : []);
	if (!model || !cfg.allowedModels.includes(model.id)) return { ok: false, error: 'Choose one of the allowed models.' };
	// #696: a job runs the read tools, so the model must support tool use.
	if (!supportsTools(model)) return { ok: false, error: "That model can't use tools, which a job needs. Pick another." };
	const kind = f.schedule_kind as ScheduleKind;
	if (!(SCHEDULE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: 'Choose how often the job runs.' };
	const hm = parseHHMM(kind === 'hourly' ? `00:${(f.schedule_minute ?? '').padStart(2, '0')}` : (f.schedule_time ?? ''));
	if (!hm) return { ok: false, error: kind === 'hourly' ? 'Choose the minute past the hour (0–59).' : 'Choose a time (HH:MM).' };
	const time = `${String(hm.hour).padStart(2, '0')}:${String(hm.minute).padStart(2, '0')}`;
	let dow: number | null = null;
	let dom: number | null = null;
	if (kind === 'weekly') {
		dow = Number(f.schedule_dow);
		if (!Number.isInteger(dow) || dow < 0 || dow > 6) return { ok: false, error: 'Choose a day of the week.' };
	}
	if (kind === 'monthly') {
		dom = Number(f.schedule_dom);
		if (!Number.isInteger(dom) || dom < 1 || dom > 31) return { ok: false, error: 'Choose a day of the month (1–31).' };
	}
	const timezone = (f.timezone ?? '').trim();
	if (kind !== 'hourly' && !isValidTimezone(timezone)) return { ok: false, error: 'Choose a valid timezone.' };
	// Delivery (#390): webhook, email to admins, or both. A form without the delivery
	// checkboxes (older clients, the API of this function) means "webhook".
	const useWebhook = f.deliver_webhook === undefined ? true : f.deliver_webhook === '1' || f.deliver_webhook === 'on';
	const useEmail = f.deliver_email === '1' || f.deliver_email === 'on';
	if (!useWebhook && !useEmail) return { ok: false, error: 'Choose where the report goes: a webhook, email to admins, or both.' };
	const webhookUrl = useWebhook ? (f.webhook_url ?? '').trim() : '';
	if (useWebhook) {
		const urlProblem = webhookUrlProblem(webhookUrl);
		if (urlProblem) return { ok: false, error: urlProblem };
	}
	let email: EmailSelection | null = null;
	if (useEmail) {
		const sel = selectionFromValues((f.email_to ?? '').split(','));
		if (!sel.ok) return sel;
		email = sel.value;
	}
	const format = f.payload_format as PayloadFormat;
	if (!(PAYLOAD_FORMATS as readonly string[]).includes(format)) return { ok: false, error: 'Choose a payload format.' };
	let secret: string | undefined;
	if (f.clear_secret === '1') secret = '';
	else if ((f.webhook_secret ?? '').trim()) {
		secret = (f.webhook_secret ?? '').trim();
		if (secret.length > SECRET_MAX) return { ok: false, error: `Secrets are limited to ${SECRET_MAX} characters.` };
		if (/\s/.test(secret)) return { ok: false, error: "A secret can't contain spaces." };
	}
	return {
		ok: true,
		value: {
			name,
			prompt,
			model: model.id,
			effort: effortFor(model, f.effort),
			schedule: { kind, time, dow, dom, timezone: isValidTimezone(timezone) ? timezone : 'UTC' },
			webhookUrl,
			format,
			email,
			enabled: f.enabled === '1' || f.enabled === 'on',
			secret
		}
	};
}

// ---- CRUD ----

const VIEW_SQL = `SELECT j.id, j.name, j.prompt, j.model, j.effort, j.schedule_kind, j.schedule_time, j.schedule_dow,
	       j.schedule_dom, j.timezone, j.webhook_url, j.webhook_secret_last4, j.payload_format, j.email_admins, j.enabled,
	       j.created_by, j.last_run_at, j.next_run_at, j.created_at, j.updated_at,
	       (j.webhook_secret IS NOT NULL) AS has_secret, u.github_login AS created_by_login,
	       (SELECT r.status FROM ai_job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_status
	FROM ai_jobs j LEFT JOIN users u ON u.id = j.created_by`;

function toView(r: Omit<JobView, 'has_secret'> & { has_secret: number | boolean }): JobView {
	return { ...r, has_secret: !!r.has_secret };
}

export async function listJobs(db: D1Database): Promise<JobView[]> {
	const rows = await db.prepare(`${VIEW_SQL} ORDER BY j.name COLLATE NOCASE, j.id`).all<JobView & { has_secret: number }>();
	return rows.results.map(toView);
}

export async function jobView(db: D1Database, id: number): Promise<JobView | null> {
	const r = await db.prepare(`${VIEW_SQL} WHERE j.id = ?`).bind(id).first<JobView & { has_secret: number }>();
	return r ? toView(r) : null;
}

export async function getJob(db: D1Database, id: number): Promise<JobRow | null> {
	return db.prepare('SELECT * FROM ai_jobs WHERE id = ?').bind(id).first<JobRow>();
}

export async function jobRuns(db: D1Database, jobId: number, limit = JOB_RUNS_SHOWN): Promise<RunRow[]> {
	const rows = await db.prepare('SELECT * FROM ai_job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?').bind(jobId, limit).all<RunRow>();
	return rows.results;
}

function mailTokenKey(platformEnv: unknown): string | undefined {
	const v = (platformEnv as { MAIL_TOKEN_KEY?: unknown } | undefined)?.MAIL_TOKEN_KEY;
	return typeof v === 'string' ? v : undefined;
}

export const SECRET_STORE_MISSING = 'Signing secrets need the MAIL_TOKEN_KEY Worker secret. Leave the secret empty, or ask your operator to set it.';

/** Create (id null) or update a job; saving recomputes next_run_at. An update keeps the
 *  creator, unless they're disabled or deleted — then the saving admin takes the job over. */
export async function saveJob(
	db: D1Database,
	platformEnv: unknown,
	id: number | null,
	v: JobInput,
	userId: number,
	now = new Date()
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
	if (v.email) {
		const problem = await checkEmailSelection(db, v.email);
		if (problem) return { ok: false, error: problem };
	}
	let secretSql = '';
	const secretBinds: (string | null)[] = [];
	if (v.secret !== undefined) {
		if (v.secret) {
			const key = mailTokenKey(platformEnv);
			if (!isValidKey(key)) return { ok: false, error: SECRET_STORE_MISSING };
			secretBinds.push(await seal(key, v.secret), v.secret.slice(-4));
		} else secretBinds.push(null, null);
		secretSql = ', webhook_secret = ?, webhook_secret_last4 = ?';
	}
	const next = v.enabled ? nextRunAt(v.schedule, now) : null;
	const s = v.schedule;
	const cols = [
		v.name,
		v.prompt,
		v.model,
		v.effort,
		s.kind,
		s.time,
		s.dow,
		s.dom,
		s.timezone,
		v.webhookUrl,
		v.format,
		v.email ? JSON.stringify(v.email) : null,
		v.enabled ? 1 : 0,
		next ? sqliteUtc(next) : null
	];
	if (id === null) {
		const row = await db
			.prepare(
				`INSERT INTO ai_jobs (name, prompt, model, effort, schedule_kind, schedule_time, schedule_dow, schedule_dom, timezone,
				   webhook_url, payload_format, email_admins, enabled, next_run_at, created_by, webhook_secret, webhook_secret_last4)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
			)
			.bind(...cols, userId, secretBinds[0] ?? null, secretBinds[1] ?? null)
			.first<{ id: number }>();
		return { ok: true, id: row!.id };
	}
	const res = await db
		.prepare(
			`UPDATE ai_jobs SET name = ?, prompt = ?, model = ?, effort = ?, schedule_kind = ?, schedule_time = ?, schedule_dow = ?,
			   schedule_dom = ?, timezone = ?, webhook_url = ?, payload_format = ?, email_admins = ?, enabled = ?, next_run_at = ?${secretSql},
			   created_by = COALESCE((SELECT u.id FROM users u WHERE u.id = ai_jobs.created_by AND u.disabled_at IS NULL), ?),
			   updated_at = datetime('now') WHERE id = ?`
		)
		.bind(...cols, ...secretBinds, userId, id)
		.run();
	if (!res.meta.changes) return { ok: false, error: 'That job no longer exists.' };
	return { ok: true, id };
}

/** Turn a job on (next run from now) or off (no next run). */
export async function setJobEnabled(db: D1Database, id: number, enabled: boolean, now = new Date()): Promise<boolean> {
	const job = await getJob(db, id);
	if (!job) return false;
	const next = enabled ? nextRunAt(scheduleOf(job), now) : null;
	await db
		.prepare(`UPDATE ai_jobs SET enabled = ?, next_run_at = ?, updated_at = datetime('now') WHERE id = ?`)
		.bind(enabled ? 1 : 0, next ? sqliteUtc(next) : null, id)
		.run();
	return true;
}

export async function deleteJob(db: D1Database, id: number): Promise<boolean> {
	const res = await db.prepare('DELETE FROM ai_jobs WHERE id = ?').bind(id).run();
	return res.meta.changes > 0;
}

/** #390: the one-click "Weekly digest" preset — Monday 07:00 in Settings → Timezone, emailed
 *  to every admin with an address and REVIEW_TO, no webhook. */
export async function createDigestJob(db: D1Database, platformEnv: unknown, cfg: AssistantConfig, userId: number, now = new Date()) {
	const model = featureModel(cfg, 'jobs');
	const v: JobInput = {
		name: DIGEST_PRESET.name,
		prompt: DIGEST_PRESET.prompt,
		model: model?.id ?? cfg.defaultModel,
		effort: model ? effortFor(model, cfg.defaultEffort) : null,
		schedule: { kind: DIGEST_PRESET.kind, time: DIGEST_PRESET.time, dow: DIGEST_PRESET.dow ?? 1, dom: null, timezone: await getTimezone(db) },
		webhookUrl: '',
		format: 'json',
		email: await defaultEmailSelection(db),
		enabled: true,
		secret: undefined
	};
	return saveJob(db, platformEnv, null, v, userId, now);
}

/** Defaults for the New job form. */
export async function jobDefaults(db: D1Database, cfg: AssistantConfig) {
	return { model: featureModel(cfg, 'jobs')?.id ?? cfg.defaultModel, effort: cfg.defaultEffort, timezone: await getTimezone(db) };
}

// ---- running ----

export type RunOptions = {
	trigger: 'schedule' | 'manual';
	now?: Date;
	/** Global fetch by default (never SvelteKit's event.fetch — see the testKey action). */
	fetch?: typeof fetch;
	/** Tests: a scripted model instead of the Anthropic API. */
	provider?: AiProvider;
	deadlineMs?: number;
	/** #390: sends the emailed report (../job-email-send.ts). Without it, an email job's
	 *  delivery is recorded as failed. */
	emailSender?: JobEmailSender;
	/** #390 "Send me a test now": email only this admin (the clicker's id), skip the webhook. */
	testRecipient?: number;
};

export type RunResult = {
	runId: number;
	status: RunRow['status'];
	output: string;
	error: string | null;
	webhookStatus: number | null;
	emailStatus: string | null;
	costMicros: number;
};

function textOf(content: ContentBlock[]): string {
	return content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}

function todayIn(tz: string, now: Date): string {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).format(now);
	} catch {
		return now.toISOString().slice(0, 10);
	}
}

const STOP_TEXT: Record<string, string> = {
	tool_limit: `Stopped: the run reached the limit of ${JOB_MAX_TOOL_CALLS} tool calls.`,
	deadline: 'Stopped: the run took too long.',
	aborted: 'Stopped.',
	max_tokens: 'The report was cut off (output limit).'
};

async function insertRun(
	db: D1Database,
	job: JobRow,
	trigger: RunOptions['trigger'],
	startedAt: string,
	r: { status: RunRow['status']; model?: string | null; output?: string; error?: string | null; usage?: Usage; costMicros?: number; userId?: number | null }
): Promise<number> {
	const u = r.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const row = await db
		.prepare(
			`INSERT INTO ai_job_runs (job_id, user_id, trigger, status, model, started_at, finished_at, output_markdown, error,
			   input_tokens, output_tokens, cost_micros)
			 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			job.id,
			r.userId ?? job.created_by,
			trigger,
			r.status,
			r.model ?? null,
			startedAt,
			r.output ?? null,
			r.error ? r.error.slice(0, 500) : null,
			u.input + u.cacheRead + u.cacheWrite,
			u.output,
			r.costMicros ?? 0
		)
		.first<{ id: number }>();
	return row!.id;
}

async function openJobSecret(job: JobRow, platformEnv: unknown): Promise<{ ok: true; secret: string | null } | { ok: false }> {
	if (!job.webhook_secret) return { ok: true, secret: null };
	const key = mailTokenKey(platformEnv);
	if (!isValidKey(key)) return { ok: false };
	try {
		return { ok: true, secret: await open(key, job.webhook_secret) };
	} catch {
		return { ok: false };
	}
}

export function jobAppUrl(baseUrl: string, jobId: number): string {
	return `${baseUrl}/settings/assistant/jobs?job=${jobId}`;
}

/** Post a body to the job's webhook with its (opened) secret. */
async function deliverForJob(job: JobRow, platformEnv: unknown, body: string, o: { fetch?: typeof fetch; now: Date }): Promise<Delivery> {
	const secret = await openJobSecret(job, platformEnv);
	if (!secret.ok) return { status: null, error: "The signing secret couldn't be opened (MAIL_TOKEN_KEY missing or changed). Save a new secret." };
	return deliverWebhook(job.webhook_url, body, { secret: secret.secret, fetch: o.fetch, now: o.now });
}

/**
 * Run one job now: checks (creator active, assistant available, model allowed, spend caps —
 * a refusal is a `skipped` run with no API call), the read-only turn, the run row, then the
 * webhook (ok runs only). Never throws for an expected failure.
 */
export async function runJob(db: D1Database, platformEnv: unknown, job: JobRow, o: RunOptions): Promise<RunResult> {
	const now = o.now ?? new Date();
	const startedAt = sqliteUtc(now);
	const skip = async (error: string, status: RunRow['status'] = 'skipped'): Promise<RunResult> => {
		const runId = await insertRun(db, job, o.trigger, startedAt, { status, error });
		return { runId, status, output: '', error, webhookStatus: null, emailStatus: null, costMicros: 0 };
	};

	const user = job.created_by ? await findActiveUserById(db, job.created_by) : null;
	if (!user) return skip("The job's creator is disabled or deleted. Edit and save the job to take it over.");
	const cfg = await getAssistantConfig(db);
	const avail = await availability(db, cfg, platformEnv, user);
	if (!avail.available) return skip(avail.message);
	// A model no longer known (removed from the catalogue, or an openai: model removed from
	// the install's provider config) runs on the jobs' model (#695); a known one an admin no
	// longer allows, or one without tool support, still stops the job.
	const model = configModelInfo(cfg, job.model) ?? featureModel(cfg, 'jobs');
	if (!model || !cfg.allowedModels.includes(model.id) || !supportsTools(model)) return skip('The job\'s model is no longer allowed. Edit the job and pick another.', 'error');
	if (!o.provider) {
		const keyProblem = await modelKeyProblem(db, platformEnv, model);
		if (keyProblem) return skip(keyProblem);
	}
	const spend = await spendCheck(db, cfg, user.id, now);
	if (!spend.ok) return skip(`Spend cap: ${spend.message}`);

	const [tz, branding] = await Promise.all([getTimezone(db), getBranding(db)]);
	const baseUrl = await publicBaseUrl(db, platformEnv as { PUBLIC_BASE_URL?: string } | undefined);
	const emailTo: EmailSelection | null = o.testRecipient ? [o.testRecipient] : parseEmailSelection(job.email_admins);
	const useWebhook = !o.testRecipient && !!job.webhook_url;
	const emailNote = emailTo ? `\nThe report is emailed to the admins of this CRM: keep it under ${EMAIL_WORD_CAP} words.` : '';
	const system = `${systemPrompt({ appName: branding.appName, timezone: tz, today: todayIn(tz, now), userLogin: user.github_login, allowCode: codeAllowedFor(cfg, user) })}\n${JOB_PREAMBLE}\nThe job is named "${job.name}".${emailNote}`;
	const provider = o.provider ?? (await providerFor(db, platformEnv, cfg, model, o.fetch ?? fetch));

	let output = '';
	let failure: string | null = null;
	let result: { stopReason: StopReason; costMicros: number; usage: Usage } = {
		stopReason: 'error',
		costMicros: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	};
	try {
		result = await runTurn({
			provider,
			model,
			effort: effortFor(model, job.effort),
			system,
			messages: [{ role: 'user', content: [{ type: 'text', text: job.prompt }] }],
			tools: JOB_TOOLS,
			ctx: { db, user, baseUrl, now },
			emit: (e) => {
				if (e.type === 'error') failure = e.message;
			},
			persist: async (m) => {
				if (m.role !== 'assistant') return;
				const t = textOf(m.content);
				if (t) output = t; // the report = the last assistant text
			},
			maxToolCalls: JOB_MAX_TOOL_CALLS,
			deadlineMs: o.deadlineMs ?? JOB_DEADLINE_MS
		});
	} catch (e) {
		console.error(`assistant job ${job.id} failed:`, e instanceof Error ? e.message.slice(0, 200) : 'error');
		failure = 'The assistant hit an error.';
	}

	const ok = (result.stopReason === 'end_turn' || result.stopReason === 'stop_sequence') && !!output;
	const error = ok ? null : (STOP_TEXT[result.stopReason] ?? failure ?? 'The model returned no report.');
	const status: RunRow['status'] = ok ? 'ok' : 'error';
	const runId = await insertRun(db, job, o.trigger, startedAt, {
		status,
		model: model.id,
		output,
		error,
		usage: result.usage,
		costMicros: result.costMicros,
		userId: user.id
	});

	let webhookStatus: number | null = null;
	let deliveryError: string | null = null;
	let emailStatus: string | null = null;
	let emailError: string | null = null;
	if (ok && useWebhook) {
		const finishedAt = sqliteUtc(new Date());
		const body = buildPayload(job.payload_format, {
			job: { id: job.id, name: job.name },
			run: { id: runId, started_at: startedAt, finished_at: finishedAt, status },
			model: model.id,
			output_markdown: output,
			cost_micros: result.costMicros,
			app_url: jobAppUrl(baseUrl, job.id)
		});
		const d = await deliverForJob(job, platformEnv, body, { fetch: o.fetch, now: new Date() });
		webhookStatus = d.status;
		deliveryError = d.error ? `Webhook: ${d.error}` : null;
	}
	if (ok && emailTo) {
		// The runner sends the finished text — the model had no send tool. One attempt (+ the
		// sender's single retry on a network failure); a failure is recorded, never re-run.
		const msg = renderJobEmail({
			markdown: output,
			job,
			baseUrl,
			jobUrl: jobAppUrl(baseUrl, job.id),
			now,
			timezone: job.timezone || tz,
			appName: (await getBranding(db)).appName
		});
		let e: EmailOutcome;
		try {
			e = o.emailSender ? await o.emailSender(emailTo, msg) : { status: 'failed', sent: 0, error: "Email delivery isn't available here." };
		} catch (err) {
			e = { status: 'failed', sent: 0, error: (err instanceof Error ? err.message : 'send failed').slice(0, 200) };
		}
		emailStatus = e.status;
		emailError = e.error ? `Email: ${e.error}` : null;
	}
	const deliveryText = [deliveryError, emailError].filter(Boolean).join(' · ') || null;
	if (ok && (useWebhook || emailTo)) {
		await db
			.prepare('UPDATE ai_job_runs SET webhook_status = ?, email_status = ?, error = ? WHERE id = ?')
			.bind(webhookStatus, emailStatus, deliveryText ? deliveryText.slice(0, 500) : null, runId)
			.run();
	}
	return {
		runId,
		status,
		output,
		error: error ?? deliveryText,
		webhookStatus,
		emailStatus,
		costMicros: result.costMicros
	};
}

/** "Send test payload": the fixed sample in the job's format, signed like a real run. */
export async function sendTestPayload(db: D1Database, platformEnv: unknown, job: JobRow, o: { fetch?: typeof fetch; now?: Date } = {}): Promise<Delivery> {
	const now = o.now ?? new Date();
	const baseUrl = await publicBaseUrl(db, platformEnv as { PUBLIC_BASE_URL?: string } | undefined);
	const body = buildPayload(job.payload_format, samplePayload({ id: job.id, name: job.name }, jobAppUrl(baseUrl, job.id), now));
	return deliverForJob(job, platformEnv, body, { fetch: o.fetch, now });
}

export type JobsTickSummary = { due: number; ran: number; ok: number; error: number; skipped: number };

/** #731: SQL true for a job whose delivery includes email (same test as `parseEmailSelection`
 *  returning non-null: `email_admins` is a JSON array). CASE keeps json_type off invalid JSON. */
const DELIVERS_EMAIL_SQL = `CASE WHEN json_valid(email_admins) THEN json_type(email_admins) = 'array' ELSE 0 END`;

/** Heartbeat: claim and run ≤ JOBS_PER_TICK due jobs, oldest due first. Each job is isolated.
 *  #731: `emailOff` (the tick found no sending credentials) leaves every due job that delivers
 *  by email untouched: not claimed, no model call, no run row, still due for a later tick. Only
 *  webhook-only jobs run then. The flag comes from the caller, so nothing here imports send code. */
export async function runDueJobs(
	db: D1Database,
	platformEnv: unknown,
	o: Omit<RunOptions, 'trigger'> & { limit?: number; emailOff?: boolean } = {}
): Promise<JobsTickSummary> {
	const now = o.now ?? new Date();
	const summary: JobsTickSummary = { due: 0, ran: 0, ok: 0, error: 0, skipped: 0 };
	const due = await db
		.prepare(
			`SELECT * FROM ai_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?${o.emailOff ? ` AND NOT (${DELIVERS_EMAIL_SQL})` : ''}
			 ORDER BY next_run_at, id LIMIT ?`
		)
		.bind(sqliteUtc(now), o.limit ?? JOBS_PER_TICK)
		.all<JobRow>();
	summary.due = due.results.length;
	for (const job of due.results) {
		// Claim: move next_run_at past this occurrence. Only the tick whose UPDATE changed the
		// row runs it. An unusable schedule switches the job off.
		const next = nextRunAt(scheduleOf(job), now);
		const claim = await db
			.prepare(
				`UPDATE ai_jobs SET next_run_at = ?, last_run_at = ?, enabled = ?
				 WHERE id = ? AND enabled = 1 AND next_run_at = ?`
			)
			.bind(next ? sqliteUtc(next) : null, sqliteUtc(now), next ? 1 : 0, job.id, job.next_run_at)
			.run();
		if (claim.meta.changes !== 1) continue;
		summary.ran += 1;
		try {
			const r = await runJob(db, platformEnv, job, { ...o, testRecipient: undefined, trigger: 'schedule', now });
			summary[r.status] += 1;
		} catch (e) {
			console.error(`assistant job ${job.id} crashed:`, (e instanceof Error ? e.message : String(e)).slice(0, 200));
			summary.error += 1;
			try {
				await insertRun(db, job, 'schedule', sqliteUtc(now), { status: 'error', error: 'The job crashed.' });
			} catch {
				/* best-effort */
			}
		}
	}
	return summary;
}
