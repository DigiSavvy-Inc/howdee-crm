// Scheduled assistant jobs (#303) — universal vocabulary shared by the server
// (src/lib/server/ai/jobs*.ts) and Settings → Assistant → Jobs: schedule kinds, labels,
// the one-line schedule text and the starter templates (prefill only, nothing is created).

export const SCHEDULE_KINDS = ['hourly', 'daily', 'weekly', 'monthly'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const PAYLOAD_FORMATS = ['json', 'slack'] as const;
export type PayloadFormat = (typeof PAYLOAD_FORMATS)[number];

export const SCHEDULE_LABELS: Record<ScheduleKind, string> = { hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
export const FORMAT_LABELS: Record<PayloadFormat, string> = { json: 'JSON', slack: 'Slack (incoming webhook)' };
export const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const JOB_NAME_MAX = 80;
export const JOB_PROMPT_MAX = 4000;
export const JOB_RUNS_SHOWN = 50;

export type JobSchedule = {
	kind: ScheduleKind;
	time: string; // 'HH:MM'
	dow: number | null; // weekly
	dom: number | null; // monthly
	timezone: string;
};

function ordinal(n: number): string {
	const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
	return `${n}${s}`;
}

/** "Every Monday at 08:00 (America/Los_Angeles)", "Hourly at :15", … */
export function scheduleText(s: JobSchedule): string {
	const at = `at ${s.time}`;
	switch (s.kind) {
		case 'hourly':
			return `Hourly at :${s.time.slice(3, 5)}`;
		case 'daily':
			return `Daily ${at} (${s.timezone})`;
		case 'weekly':
			return `Every ${DOW_LABELS[s.dow ?? 1]} ${at} (${s.timezone})`;
		case 'monthly':
			return `Monthly on the ${ordinal(s.dom ?? 1)} ${at} (${s.timezone})`;
	}
}

/** #390: email delivery. `REVIEW_TO_KEY` in a job's recipient list = the REVIEW_TO address. */
export const REVIEW_TO_KEY = 'review_to';
/** The emailed report is trimmed to about this many words. */
export const EMAIL_WORD_CAP = 1500;

export type JobTemplate = { key: string; name: string; prompt: string; kind: ScheduleKind; time: string; dow?: number };

/** #390: the "Weekly digest" preset — one click creates it, emailed to every admin. */
export const DIGEST_PRESET: JobTemplate = {
	key: 'weekly-digest',
	name: 'Weekly digest',
	kind: 'weekly',
	time: '07:00',
	dow: 1,
	prompt: [
		'Write the weekly digest for the people who run this CRM: what happened in the last 7 days, who to chase, and what is going stale. Use these sections, in this order, and keep each one short. Link every contact, campaign, company and conversation you mention to its page in the app.',
		'',
		'1. Replies awaiting an answer: every conversation whose last message is from the contact (list_conversations). Name, subject, how long it has waited, and a link.',
		'2. Campaigns sent last week: subject, recipients, open, click and bounce rate, each compared with the average of campaigns sent in the last 90 days (list_campaigns, get_campaign). Say plainly when there were none.',
		'3. Going cold, and who matters: contacts whose engagement dropped (get_going_cold, get_engagement_tiers) that are on the pipeline board or were hot or warm. Skip the rest.',
		'4. Stale deals: pipeline cards in an open stage for more than 14 days (get_pipeline_board), with stage, value and days in stage.',
		'5. Deliverability: any warning from get_deliverability (bounce rate, complaints, domain authentication). One line when everything is healthy.',
		'6. Integration highlights: hours by client from Timing, notable GitHub activity, and overdue invoices, from what the company tools return. Leave out anything the tools do not have.',
		'7. Three suggested actions for this week, most important first.',
		'',
		'Stay under 1,500 words. Do not invent numbers: if a tool fails or has no data, say so in that section.'
	].join('\n')
};

export const JOB_TEMPLATES: JobTemplate[] = [
	{
		key: 'weekly-recap',
		name: 'Weekly campaign recap',
		kind: 'weekly',
		time: '08:00',
		dow: 1,
		prompt:
			'Summarise the last 7 days: every campaign sent (subject, recipients, open and click rate, unsubscribes), how they compare to the previous campaigns, the bounce and spam picture, and contacts who became hot. End with three short suggestions for this week.'
	},
	{
		key: 'daily-hot-leads',
		name: 'Daily new hot leads',
		kind: 'daily',
		time: '08:00',
		prompt:
			'List the contacts who moved into the hot engagement tier or replied in the last 24 hours: name, email, company, what they did (opened, clicked, replied, visited) and a link to each contact. If there are none, say so in one line.'
	},
	{
		key: 'monday-deliverability',
		name: 'Monday deliverability check',
		kind: 'weekly',
		time: '07:30',
		dow: 1,
		prompt:
			'Check deliverability for the last 7 days: bounce rate, spam complaint rate, hard bounces, newly suppressed addresses and any campaign with an unusual bounce or complaint rate. Flag anything above 2% bounces or 0.1% complaints, and say plainly when everything looks healthy.'
	}
];
