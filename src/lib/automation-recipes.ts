// #398: starter flows ("recipes") shown on /automations as "Start from a recipe". Each one is
// an `AutomationSpec` (the same vocabulary the assistant and the API build with), so creating
// from a recipe is just `createFromSpec` → a draft. Recipes live in code, not the database.
//
// A recipe may need one thing from the operator: a list / segment / tag (`needs: 'list'`) or a
// pipeline stage (`needs: 'stage'`). Without it the draft starts on the Manual trigger, so it
// can still be created and the trigger set in the editor. Email copy is a starting point —
// every email is meant to be rewritten before the flow is activated.

import type { AutomationSpec, StepSpec } from './automation-spec';

export type RecipeNeed = 'list' | 'stage' | null;
export type RecipeParams = { list_id?: number | null; stage_id?: number | null };

export type Recipe = {
	key: string;
	name: string;
	description: string;
	/** What the picker on the card asks for (null = nothing). */
	needs: RecipeNeed;
	/** The picker's label, e.g. "Who joins (list)". */
	needsLabel?: string;
	spec: (p: RecipeParams) => AutomationSpec;
};

const DAY = 86400;
const HOUR = 3600;

function email(subject: string, body: string, extra: Partial<StepSpec> = {}): StepSpec {
	return { type: 'email', subject, body_md: body, ...extra };
}

function listTrigger(p: RecipeParams): AutomationSpec['trigger'] {
	return p.list_id ? { type: 'list_added', list_id: p.list_id } : { type: 'manual' };
}

function stageTrigger(p: RecipeParams): AutomationSpec['trigger'] {
	return p.stage_id ? { type: 'pipeline_stage_entered', stage_id: p.stage_id } : { type: 'manual' };
}

export const RECIPES: Recipe[] = [
	{
		key: 'welcome-series',
		name: 'Welcome series',
		description: 'Three emails over a week for new subscribers; tags the ones who open.',
		needs: 'list',
		needsLabel: 'When added to',
		spec: (p) => ({
			name: 'Welcome series',
			trigger: listTrigger(p),
			reentry: 'once',
			labels: ['recipe'],
			steps: [
				email(
					'Welcome, {{first_name}}',
					'Hi {{first_name}},\n\nThanks for signing up. Here is what to expect from us, and how often.\n\nReply to this email any time — a real person reads it.',
					{ ref: 'welcome', preheader: 'Here is what happens next' }
				),
				email(
					'The one thing to read first',
					'Hi {{first_name}},\n\nIf you only read one thing from us, make it this. Write two or three sentences about it here.',
					{ wait_seconds: 2 * DAY, preheader: 'Our most useful piece, in two minutes' }
				),
				{
					type: 'branch',
					wait_seconds: 3 * DAY,
					condition: { kind: 'opened', step_ref: 'welcome' },
					yes: [{ type: 'tag', tag_action: 'add', tag_name: 'welcome:engaged' }],
					no: [
						email(
							'Did this get buried?',
							'Hi {{first_name}},\n\nJust making sure our welcome note reached you. Here is the short version again.',
							{ preheader: 'The short version of our welcome' }
						)
					]
				}
			]
		})
	},
	{
		key: 'post-webinar',
		name: 'Post-webinar nurture',
		description: 'Recording + resources after an event, then a follow-up for the people who clicked.',
		needs: 'list',
		needsLabel: 'Attendees list',
		spec: (p) => ({
			name: 'Post-webinar nurture',
			trigger: listTrigger(p),
			reentry: 'multiple',
			labels: ['recipe', 'events'],
			steps: [
				email(
					'Thanks for joining — the recording',
					'Hi {{first_name}},\n\nThanks for coming. Add the recording link and the slides here.',
					{ wait_seconds: 2 * HOUR, preheader: 'Recording and slides inside' }
				),
				email(
					'Three resources from the session',
					'Hi {{first_name}},\n\nA few people asked for the resources we mentioned. Add them here.',
					{ ref: 'resources', wait_seconds: 2 * DAY, preheader: 'What we mentioned on the call' }
				),
				{
					type: 'branch',
					wait_seconds: 3 * DAY,
					condition: { kind: 'clicked', step_ref: 'resources' },
					yes: [
						{ type: 'tag', tag_action: 'add', tag_name: 'webinar:hot' },
						email(
							'Want to talk it through?',
							'Hi {{first_name}},\n\nYou looked at the resources — happy to walk through how it applies to you. Add a booking link here.',
							{ preheader: 'A short call, if it helps' }
						)
					],
					no: []
				}
			]
		})
	},
	{
		key: 're-engagement',
		name: 'Re-engagement',
		description: 'Asks quiet contacts if they still want email; tags who comes back and who doesn’t.',
		needs: 'list',
		needsLabel: 'Quiet contacts (segment)',
		spec: (p) => ({
			name: 'Re-engagement',
			trigger: listTrigger(p),
			reentry: 'multiple',
			labels: ['recipe'],
			steps: [
				email(
					'Still want to hear from us?',
					'Hi {{first_name}},\n\nWe haven’t heard from you in a while. If these emails are still useful, open this one and you’ll stay on the list.',
					{ ref: 'check', preheader: 'One click keeps you on the list' }
				),
				{
					type: 'branch',
					wait_seconds: 5 * DAY,
					condition: { kind: 'opened', step_ref: 'check' },
					yes: [{ type: 'tag', tag_action: 'add', tag_name: 're-engaged' }],
					no: [
						email(
							'Last one from us (unless you say otherwise)',
							'Hi {{first_name}},\n\nWe’ll stop emailing soon so we don’t clutter your inbox. Open this to stay.',
							{ ref: 'last', preheader: 'Open to stay on the list' }
						),
						{
							type: 'branch',
							wait_seconds: 5 * DAY,
							condition: { kind: 'opened', step_ref: 'last' },
							yes: [{ type: 'tag', tag_action: 'add', tag_name: 're-engaged' }],
							no: [{ type: 'tag', tag_action: 'add', tag_name: 'cold:sunset' }]
						}
					]
				}
			]
		})
	},
	{
		key: 'lead-magnet',
		name: 'Lead magnet follow-up',
		description: 'Delivers the download, sends a tip, then offers a call to the ones who opened it.',
		needs: 'list',
		needsLabel: 'Download list',
		spec: (p) => ({
			name: 'Lead magnet follow-up',
			trigger: listTrigger(p),
			reentry: 'once',
			labels: ['recipe', 'lead-magnet'],
			steps: [
				email(
					'Your download is ready',
					'Hi {{first_name}},\n\nHere it is. Add the download link here.',
					{ ref: 'deliver', preheader: 'The link is inside' }
				),
				email(
					'How to get the most out of it',
					'Hi {{first_name}},\n\nOne tip that makes the biggest difference. Write it here.',
					{ wait_seconds: 2 * DAY, preheader: 'One tip, two minutes' }
				),
				{
					type: 'branch',
					wait_seconds: 4 * DAY,
					condition: { kind: 'clicked', step_ref: 'deliver' },
					yes: [
						email(
							'Want help putting it to work?',
							'Hi {{first_name}},\n\nIf you’d like a second pair of eyes, add a booking link here.',
							{ preheader: 'A short call, if it helps' }
						)
					],
					no: [
						email(
							'In case you missed it',
							'Hi {{first_name}},\n\nThe download is still waiting for you. Add the link again here.',
							{ preheader: 'Your download is still here' }
						)
					]
				}
			]
		})
	},
	{
		key: 'pipeline-nudge',
		name: 'Pipeline stage nudge',
		description: 'A check-in when a deal sits in a stage for 3 days; tags it stalled after a week.',
		needs: 'stage',
		needsLabel: 'Stage',
		spec: (p) => {
			const still = p.stage_id ? { kind: 'pipeline-stage' as const, mode: 'in', stage_id: p.stage_id } : { kind: 'pipeline-stage' as const, mode: 'any' };
			return {
				name: 'Pipeline stage nudge',
				trigger: stageTrigger(p),
				reentry: 'multiple',
				labels: ['recipe', 'pipeline'],
				steps: [
					{
						type: 'branch',
						wait_seconds: 3 * DAY,
						condition: still,
						yes: [
							email(
								'Quick check-in',
								'Hi {{first_name}},\n\nChecking in on where things stand. Anything I can answer to help you decide?',
								{ preheader: 'Anything I can answer?' }
							),
							{
								type: 'branch',
								wait_seconds: 4 * DAY,
								condition: still,
								yes: [{ type: 'tag', tag_action: 'add', tag_name: 'pipeline:stalled' }],
								no: []
							}
						],
						no: []
					}
				]
			};
		}
	},
	{
		key: 'review-request',
		name: 'Review request',
		description: 'Asks happy clients for a review a week after a win, with one reminder.',
		needs: 'stage',
		needsLabel: 'Won stage',
		spec: (p) => ({
			name: 'Review request',
			trigger: stageTrigger(p),
			reentry: 'once',
			labels: ['recipe'],
			steps: [
				email(
					'Would you share a quick review?',
					'Hi {{first_name}},\n\nIt was great working with you. Would you leave a short review? Add the review link here.',
					{ ref: 'ask', wait_seconds: 7 * DAY, preheader: 'Two minutes, and it helps a lot' }
				),
				{
					type: 'branch',
					wait_seconds: 5 * DAY,
					condition: { kind: 'clicked', step_ref: 'ask' },
					yes: [{ type: 'tag', tag_action: 'add', tag_name: 'review:clicked' }],
					no: [
						email(
							'A gentle reminder',
							'Hi {{first_name}},\n\nNo pressure — if you have two minutes, a review would mean a lot. Add the review link here.',
							{ preheader: 'Only if you have two minutes' }
						)
					]
				}
			]
		})
	}
];

export function recipeByKey(key: string): Recipe | null {
	return RECIPES.find((r) => r.key === key) ?? null;
}

/** How many steps a recipe builds (for the card). */
export function recipeStepCount(r: Recipe): number {
	const count = (steps: StepSpec[]): number => steps.reduce((n, s) => n + 1 + count(s.yes ?? []) + count(s.no ?? []), 0);
	return count(r.spec({}).steps);
}
