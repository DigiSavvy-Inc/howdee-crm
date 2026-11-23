// #444: the "Subscription changes" trigger (`subscription_changed`). Universal (no server
// imports): the config stored in `automations.trigger_config`, its validation and the one-line
// summary. Firing lives in `src/lib/server/subscription-trigger.ts`.
//
// The config:
//   events         non-empty subset of SUBSCRIPTION_EVENTS (default ['unsubscribed'])
//   topic_list_id  topic_optout / topic_optin only: one topic list; null = any topic
//   sources        unsubscribed only: where it came from (SUBSCRIPTION_SOURCES); [] = any
//
// These automations may run for unsubscribed contacts, but the engine never emails them: an
// email step ends the pass (SKIPPED_EMAIL_UNSUBSCRIBED).

export const SUBSCRIPTION_KIND = 'subscription_changed';

export function isSubscriptionKind(type: unknown): type is 'subscription_changed' {
	return type === SUBSCRIPTION_KIND;
}

export const SUBSCRIPTION_EVENTS = ['subscribed', 'unsubscribed', 'resubscribed', 'bounced', 'complained', 'topic_optout', 'topic_optin'] as const;
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number];

export const SUBSCRIPTION_EVENT_LABELS: Record<SubscriptionEvent, string> = {
	subscribed: 'Confirms a subscription (double opt-in)',
	unsubscribed: 'Unsubscribes',
	resubscribed: 'Resubscribes',
	bounced: 'Hard-bounces',
	complained: 'Marks an email as spam',
	topic_optout: 'Opts out of a topic',
	topic_optin: 'Opts in to a topic'
};

/** Where an unsubscribe came from. `link` = the email's unsubscribe link / one-click header.
 *  `double_optin` (#510) = a confirmed subscription (the `subscribed` event); not an unsubscribe source. */
export const SUBSCRIPTION_SOURCES = ['link', 'preference_center', 'manual', 'api', 'postmark', 'form', 'double_optin'] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

export const SUBSCRIPTION_SOURCE_LABELS: Record<SubscriptionSource, string> = {
	link: 'Unsubscribe link',
	preference_center: 'Preference page',
	manual: 'In the app (bulk action, assistant)',
	api: 'API / MCP',
	postmark: 'Postmark (email client, bounce, spam, sync)',
	form: 'A form',
	double_optin: 'Double opt-in confirmation'
};

/** The sources an unsubscribe can come from (the trigger drawer's picker). */
export const UNSUBSCRIBE_SOURCES = SUBSCRIPTION_SOURCES.filter((s) => s !== 'double_optin');

/** The pass's timeline line when an email step is reached by an unsubscribed contact. */
export const SKIPPED_EMAIL_UNSUBSCRIBED = 'skipped email: unsubscribed';

export type SubscriptionTriggerConfig = {
	events: SubscriptionEvent[];
	topic_list_id: number | null;
	sources: SubscriptionSource[];
};

export function defaultSubscriptionConfig(): SubscriptionTriggerConfig {
	return { events: ['unsubscribed'], topic_list_id: null, sources: [] };
}

const isEvent = (v: unknown): v is SubscriptionEvent => (SUBSCRIPTION_EVENTS as readonly unknown[]).includes(v);
const isSource = (v: unknown): v is SubscriptionSource => (SUBSCRIPTION_SOURCES as readonly unknown[]).includes(v);

/** Canonical order, no duplicates. */
function ordered<T extends string>(all: readonly T[], picked: Set<T>): T[] {
	return all.filter((x) => picked.has(x));
}

/**
 * Untrusted input → a clean config, or the first problem. Shape only — that the topic list
 * exists is checked by the write layer. A missing `events` takes the default.
 */
export function normalizeSubscriptionConfig(
	raw: Record<string, unknown> | null | undefined
): { ok: true; config: SubscriptionTriggerConfig } | { ok: false; error: string } {
	const src = raw && typeof raw === 'object' ? raw : {};
	const cfg = defaultSubscriptionConfig();

	if (src.events !== undefined && src.events !== null) {
		if (!Array.isArray(src.events)) return { ok: false, error: 'events must be a list.' };
		const bad = src.events.find((e) => !isEvent(e));
		if (bad !== undefined) return { ok: false, error: `Unknown subscription event “${String(bad)}”.` };
		if (!src.events.length) return { ok: false, error: 'Pick at least one subscription change.' };
		cfg.events = ordered(SUBSCRIPTION_EVENTS, new Set(src.events as SubscriptionEvent[]));
	}
	const topic = src.topic_list_id ?? src.topic_id;
	if (topic !== undefined && topic !== null && topic !== '') {
		const n = typeof topic === 'string' ? Number(topic) : topic;
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return { ok: false, error: 'That topic is not valid.' };
		cfg.topic_list_id = n;
	}
	if (src.sources !== undefined && src.sources !== null) {
		if (!Array.isArray(src.sources)) return { ok: false, error: 'sources must be a list.' };
		const bad = src.sources.find((x) => !isSource(x));
		if (bad !== undefined) return { ok: false, error: `Unknown unsubscribe source “${String(bad)}”.` };
		cfg.sources = ordered(SUBSCRIPTION_SOURCES, new Set(src.sources as SubscriptionSource[]));
	}
	return { ok: true, config: cfg };
}

/** `automations.trigger_config` → config. Lenient: unknown entries are dropped, junk → defaults. */
export function parseSubscriptionConfig(json: string | null | undefined): SubscriptionTriggerConfig {
	if (!json) return defaultSubscriptionConfig();
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(json);
	} catch {
		return defaultSubscriptionConfig();
	}
	if (!raw || typeof raw !== 'object') return defaultSubscriptionConfig();
	const fixed: Record<string, unknown> = { ...raw };
	if (Array.isArray(fixed.events)) {
		fixed.events = fixed.events.filter(isEvent);
		if (!(fixed.events as unknown[]).length) delete fixed.events;
	}
	if (Array.isArray(fixed.sources)) fixed.sources = fixed.sources.filter(isSource);
	const r = normalizeSubscriptionConfig(fixed);
	return r.ok ? r.config : defaultSubscriptionConfig();
}

const usesTopic = (cfg: SubscriptionTriggerConfig) => cfg.events.includes('topic_optout') || cfg.events.includes('topic_optin');

/** Does this change match the trigger? (event in the set, the topic / source filters) */
export function subscriptionMatches(
	cfg: SubscriptionTriggerConfig,
	ev: { event: SubscriptionEvent; listId?: number | null; source?: SubscriptionSource | null }
): boolean {
	if (!cfg.events.includes(ev.event)) return false;
	if ((ev.event === 'topic_optout' || ev.event === 'topic_optin') && cfg.topic_list_id !== null) {
		return ev.listId === cfg.topic_list_id;
	}
	if (ev.event === 'unsubscribed' && cfg.sources.length) {
		return !!ev.source && cfg.sources.includes(ev.source);
	}
	return true;
}

/** "When a contact unsubscribes (unsubscribe link, preference page) or hard-bounces",
 *  "When a contact opts out of topic “Newsletter”". */
export function subscriptionTriggerText(cfg: SubscriptionTriggerConfig, topicName: (id: number) => string | null): string {
	const parts = cfg.events.map((e) => {
		switch (e) {
			case 'subscribed':
				return 'confirms a subscription';
			case 'unsubscribed':
				return cfg.sources.length
					? `unsubscribes (${cfg.sources.map((s) => SUBSCRIPTION_SOURCE_LABELS[s].split(' (')[0].toLowerCase()).join(', ')})`
					: 'unsubscribes';
			case 'resubscribed':
				return 'resubscribes';
			case 'bounced':
				return 'hard-bounces';
			case 'complained':
				return 'marks an email as spam';
			case 'topic_optout':
				return 'opts out of';
			case 'topic_optin':
				return 'opts in to';
		}
	});
	// "opts out of" / "opts in to" share one topic phrase at the end of their own part.
	const topic = usesTopic(cfg)
		? cfg.topic_list_id === null
			? 'a topic'
			: `topic “${topicName(cfg.topic_list_id) ?? '(deleted list)'}”`
		: '';
	const withTopic = parts.map((p, i) => (cfg.events[i] === 'topic_optout' || cfg.events[i] === 'topic_optin' ? `${p} ${topic}` : p));
	const list = withTopic.length <= 1 ? withTopic.join('') : `${withTopic.slice(0, -1).join(', ')} or ${withTopic[withTopic.length - 1]}`;
	return `When a contact ${list}`;
}
