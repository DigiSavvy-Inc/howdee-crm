// #412: the "Opens an email" / "Clicks a link in an email" triggers. Universal (no server
// imports): the config shape stored in `automations.trigger_config`, its validation, link
// matching and the one-line summary. Firing lives in `src/lib/server/engagement-trigger.ts`.
//
// The config:
//   email            'any' | { campaign_id } | { step_id }  (a spec may name one of its own
//                    email steps as { step_ref } — resolved to step_id when stored)
//   list_id          null | a list / segment / tag id: the contact must be in it when they
//                    open / click (segments resolve through their rules)
//   link             'any' | { op, value }  (clicks only)
//   exclude          up to 10 of { campaign_id } | { step_id } | { step_ref } | { link }  —
//                    how "any email but not X" stacks (link entries: clicks only)
//   ignore_proxy_opens  skip Apple Mail / prefetch auto-opens (opens only; default on)
//   once_per_email      fire at most once per email per contact (default on)

export const ENGAGEMENT_TRIGGER_KINDS = ['email_opened', 'email_clicked'] as const;
export type EngagementTriggerKind = (typeof ENGAGEMENT_TRIGGER_KINDS)[number];

export function isEngagementKind(type: unknown): type is EngagementTriggerKind {
	return type === 'email_opened' || type === 'email_clicked';
}

export const LINK_OPS = [
	{ op: 'contains', label: 'contains', verb: 'containing' },
	{ op: 'equals', label: 'equals', verb: 'exactly' },
	{ op: 'starts_with', label: 'starts with', verb: 'starting with' }
] as const;
export type LinkOp = (typeof LINK_OPS)[number]['op'];
export type LinkPattern = { op: LinkOp; value: string };

export type EmailRef = 'any' | { campaign_id: number } | { step_id: number } | { step_ref: string };
export type ExcludeEntry = { campaign_id: number } | { step_id: number } | { step_ref: string } | { link: LinkPattern };

export type EngagementTriggerConfig = {
	email: EmailRef;
	list_id: number | null;
	link: 'any' | LinkPattern;
	exclude: ExcludeEntry[];
	ignore_proxy_opens: boolean;
	once_per_email: boolean;
};

export const MAX_TRIGGER_EXCLUDES = 10;
export const LINK_VALUE_MAX = 500;

export function defaultEngagementConfig(): EngagementTriggerConfig {
	return { email: 'any', list_id: null, link: 'any', exclude: [], ignore_proxy_opens: true, once_per_email: true };
}

function positiveInt(v: unknown): number | null {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
	return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

function emailRef(raw: unknown, allowRefs: boolean): EmailRef | { campaign_id: number } | { step_id: number } | null {
	if (raw === 'any' || raw === undefined || raw === null) return 'any';
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	if (o.campaign_id !== undefined) {
		const id = positiveInt(o.campaign_id);
		return id ? { campaign_id: id } : null;
	}
	if (o.step_id !== undefined) {
		const id = positiveInt(o.step_id);
		return id ? { step_id: id } : null;
	}
	if (allowRefs && typeof o.step_ref === 'string' && o.step_ref.trim()) return { step_ref: o.step_ref.trim() };
	return null;
}

function linkPattern(raw: unknown): LinkPattern | string {
	if (!raw || typeof raw !== 'object') return 'A link condition needs an operator and a value.';
	const o = raw as Record<string, unknown>;
	const op = String(o.op ?? '');
	if (!LINK_OPS.some((l) => l.op === op)) return `Link operator must be one of ${LINK_OPS.map((l) => l.op).join(', ')}.`;
	const value = typeof o.value === 'string' ? o.value.trim() : '';
	if (!value) return 'Type the link (or part of it) to match.';
	if (value.length > LINK_VALUE_MAX) return `A link pattern can be at most ${LINK_VALUE_MAX} characters.`;
	return { op: op as LinkOp, value };
}

/**
 * Untrusted input → a clean config, or the first problem. Shape only — that a campaign /
 * step / list exists is checked by the write layer. `allowRefs` (whole-flow specs) lets an
 * `email` / `exclude` entry name one of the spec's own steps by `step_ref`.
 */
export function normalizeEngagementConfig(
	kind: EngagementTriggerKind,
	raw: Record<string, unknown> | null | undefined,
	opts: { allowRefs?: boolean } = {}
): { ok: true; config: EngagementTriggerConfig } | { ok: false; error: string } {
	const src = raw && typeof raw === 'object' ? raw : {};
	const cfg = defaultEngagementConfig();
	const allowRefs = !!opts.allowRefs;

	const email = emailRef(src.email, allowRefs);
	if (!email) return { ok: false, error: 'Choose “any email”, a campaign or an email step for the trigger.' };
	cfg.email = email;

	if (src.list_id !== undefined && src.list_id !== null && src.list_id !== '') {
		const id = positiveInt(src.list_id);
		if (!id) return { ok: false, error: 'That list is not valid.' };
		cfg.list_id = id;
	}

	if (src.link !== undefined && src.link !== null && src.link !== 'any') {
		if (kind !== 'email_clicked') return { ok: false, error: 'A link only applies to the “clicks a link” trigger.' };
		const p = linkPattern(src.link);
		if (typeof p === 'string') return { ok: false, error: p };
		cfg.link = p;
	}

	if (src.exclude !== undefined && src.exclude !== null) {
		if (!Array.isArray(src.exclude)) return { ok: false, error: 'Exclusions must be a list.' };
		if (src.exclude.length > MAX_TRIGGER_EXCLUDES) return { ok: false, error: `At most ${MAX_TRIGGER_EXCLUDES} trigger conditions.` };
		for (const [i, e] of src.exclude.entries()) {
			const n = i + 1;
			if (e && typeof e === 'object' && 'link' in e) {
				if (kind !== 'email_clicked') return { ok: false, error: `Condition ${n}: a link only applies to the “clicks a link” trigger.` };
				const p = linkPattern((e as { link: unknown }).link);
				if (typeof p === 'string') return { ok: false, error: `Condition ${n}: ${p}` };
				cfg.exclude.push({ link: p });
				continue;
			}
			const ref = emailRef(e, allowRefs);
			if (!ref || ref === 'any') return { ok: false, error: `Condition ${n}: choose a campaign or an email step.` };
			cfg.exclude.push(ref);
		}
	}

	if (src.ignore_proxy_opens !== undefined) cfg.ignore_proxy_opens = src.ignore_proxy_opens !== false && src.ignore_proxy_opens !== 'false' && src.ignore_proxy_opens !== 0;
	if (src.once_per_email !== undefined) cfg.once_per_email = src.once_per_email !== false && src.once_per_email !== 'false' && src.once_per_email !== 0;
	return { ok: true, config: cfg };
}

/** `automations.trigger_config` → config (defaults for junk / NULL). */
export function parseEngagementConfig(
	kind: EngagementTriggerKind,
	json: string | null | undefined,
	opts: { allowRefs?: boolean } = {}
): EngagementTriggerConfig {
	if (!json) return defaultEngagementConfig();
	try {
		const r = normalizeEngagementConfig(kind, JSON.parse(json), opts);
		return r.ok ? r.config : defaultEngagementConfig();
	} catch {
		return defaultEngagementConfig();
	}
}

/** Does a clicked URL match the pattern? Case-insensitive; `equals` ignores a trailing slash. */
export function linkMatches(url: string | null | undefined, p: LinkPattern): boolean {
	const u = String(url ?? '').trim().toLowerCase();
	const v = p.value.trim().toLowerCase();
	if (!u || !v) return false;
	if (p.op === 'equals') return u.replace(/\/+$/, '') === v.replace(/\/+$/, '');
	if (p.op === 'starts_with') return u.startsWith(v);
	return u.includes(v);
}

export function linkVerb(op: string): string {
	return LINK_OPS.find((l) => l.op === op)?.verb ?? 'containing';
}

/** Names the summary needs: an email (campaign subject / step title) and a list. */
export type EngagementNames = {
	campaign: (id: number) => string | null;
	step: (id: number) => string | null;
	list: (id: number) => { name: string; kind: string } | null;
};

function emailName(ref: EmailRef | ExcludeEntry, names: EngagementNames): string {
	if (ref === 'any') return 'any email';
	if ('campaign_id' in ref) {
		const n = names.campaign(ref.campaign_id);
		return n !== null ? `“${n}”` : '(deleted email)';
	}
	if ('step_id' in ref) {
		const n = names.step(ref.step_id);
		return n !== null ? `“${n}”` : '(deleted email step)';
	}
	if ('step_ref' in ref) return `step “${ref.step_ref}”`;
	return 'any email';
}

/** "When opens any email except “Spring promo”", "When clicks a link containing “/pricing”
 *  in “Onboarding #2” (list “Clients”)". */
export function engagementTriggerText(kind: EngagementTriggerKind, cfg: EngagementTriggerConfig, names: EngagementNames): string {
	const email = emailName(cfg.email, names);
	const except = cfg.exclude.map((e) => ('link' in e ? `links ${linkVerb(e.link.op)} “${e.link.value}”` : emailName(e, names)));
	const exceptText = except.length ? ` except ${except.join(', ')}` : '';
	let listText = '';
	if (cfg.list_id) {
		const l = names.list(cfg.list_id);
		listText = l ? ` (${l.kind} “${l.name}”)` : ' (deleted list)';
	}
	if (kind === 'email_opened') {
		const proxy = cfg.ignore_proxy_opens ? '' : ' · incl. auto-opens';
		return `When opens ${email}${exceptText}${listText}${proxy}`;
	}
	const link = cfg.link === 'any' ? 'any link' : `a link ${linkVerb(cfg.link.op)} “${cfg.link.value}”`;
	return `When clicks ${link} in ${email}${exceptText}${listText}`;
}

/** Campaign / step ids a config names (for loading their titles). */
export function configEmailIds(cfg: EngagementTriggerConfig): { campaigns: number[]; steps: number[] } {
	const campaigns: number[] = [];
	const steps: number[] = [];
	for (const r of [cfg.email, ...cfg.exclude]) {
		if (r === 'any' || 'link' in r) continue;
		if ('campaign_id' in r) campaigns.push(r.campaign_id);
		if ('step_id' in r) steps.push(r.step_id);
	}
	return { campaigns, steps };
}
