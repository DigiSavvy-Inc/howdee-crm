// Assistant skills (#302): universal vocabulary + validation, shared by Settings →
// Assistant → Skills (browser) and the server (ai/skills.ts, load_skill, the system prompt).

export const SKILL_MODES = ['always', 'on_demand'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];
export const SKILL_MODE_LABELS: Record<SkillMode, string> = { always: 'Always on', on_demand: 'On demand' };

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 200;
export const SKILL_BODY_MAX = 20_000;
/** Above this many estimated tokens of always-on bodies the editor shows a warning. */
export const ALWAYS_ON_TOKEN_WARN = 6_000;

/** Lowercase letters, digits and single hyphens; starts with a letter. */
export const SKILL_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Lowercased + trimmed: names are matched case-insensitively. */
export function normalizeSkillName(raw: string): string {
	return String(raw ?? '').trim().toLowerCase();
}

/** "campaign-strategy" → "Campaign strategy" (the panel's "Used skill: …" row). */
export function skillTitle(name: string): string {
	const words = normalizeSkillName(name).replace(/[-_]+/g, ' ');
	return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** Rough token estimate: characters ÷ 4, rounded up. */
export function estimateTokens(chars: number): number {
	return Math.ceil(Math.max(0, chars) / 4);
}

/** Estimated tokens of the enabled always-on bodies, and whether that passes the warning line. */
export function alwaysOnSize(skills: { mode: string; enabled: boolean | number; chars: number }[]): { chars: number; tokens: number; warn: boolean } {
	const chars = skills.filter((s) => s.mode === 'always' && !!s.enabled).reduce((n, s) => n + s.chars, 0);
	const tokens = estimateTokens(chars);
	return { chars, tokens, warn: tokens > ALWAYS_ON_TOKEN_WARN };
}

export type SkillInput = { name: string; description: string; body: string; mode: SkillMode; enabled: boolean };

/** Validate an editor submission. Errors read as one sentence each. */
export function validateSkill(raw: { name?: unknown; description?: unknown; body?: unknown; mode?: unknown; enabled?: unknown }):
	| { ok: true; skill: SkillInput }
	| { ok: false; error: string } {
	const name = normalizeSkillName(String(raw.name ?? ''));
	if (!name) return { ok: false, error: 'A name is required.' };
	if (name.length > SKILL_NAME_MAX) return { ok: false, error: `Names are limited to ${SKILL_NAME_MAX} characters.` };
	if (!SKILL_NAME_RE.test(name)) {
		return { ok: false, error: 'Use lowercase letters, digits and hyphens only, starting with a letter (e.g. campaign-strategy).' };
	}
	const description = String(raw.description ?? '').trim().replace(/\s+/g, ' ');
	if (!description) return { ok: false, error: 'A description is required.' };
	if (description.length > SKILL_DESCRIPTION_MAX) return { ok: false, error: `Descriptions are limited to ${SKILL_DESCRIPTION_MAX} characters.` };
	const body = String(raw.body ?? '').replace(/\r\n/g, '\n').trim();
	if (!body) return { ok: false, error: 'The instructions are required.' };
	if (body.length > SKILL_BODY_MAX) return { ok: false, error: `Instructions are limited to ${SKILL_BODY_MAX.toLocaleString('en-US')} characters.` };
	const mode = String(raw.mode ?? '');
	if (!(SKILL_MODES as readonly string[]).includes(mode)) return { ok: false, error: 'Choose Always on or On demand.' };
	const e = raw.enabled;
	const enabled = e === true || e === 1 || e === '1' || e === 'on' || e === 'true';
	return { ok: true, skill: { name, description, body, mode: mode as SkillMode, enabled } };
}
