// #104: static content for the first-run product tour. Kept out of Tour.svelte so it's
// importable from tests without pulling in Svelte component machinery.

export type TourStep = {
	id: string;
	/** CSS selector for a `data-tour` attribute, or null for a centered (no-target) step. */
	target: string | null;
	title: string;
	/** Plain text or minimal inline HTML (rendered via {@html} — this array is the only
	 * source for it, never user input). */
	body: string;
	placement?: 'bottom' | 'top' | 'right';
};

export const STEPS: TourStep[] = [
	{
		id: 'welcome',
		target: null,
		title: 'Welcome to DS Email Marketing',
		body: 'This app sends campaigns, runs automations, and tracks opens and clicks — all on your own Postmark account. Takes about a minute to show you around.'
	},
	{
		id: 'dashboard',
		target: '[data-tour="nav-/"]',
		title: 'Dashboard',
		body: 'Start a campaign from here, see subscribers, sends, opens, replies and active automations at a glance, and follow a live activity feed (opens, clicks, replies, form signups, unsubscribes). Heartbeat / overdue warnings show up here too — this is the first place to check if something looks off.',
		placement: 'bottom'
	},
	{
		id: 'contacts',
		target: '[data-tour="nav-/contacts"]',
		title: 'Contacts',
		body: 'Import a CSV or add people by hand. Organize with lists, segments, tags, and companies. Search and Filters narrow the table, and ticking rows lets you bulk add to a list/tag, delete, or enroll in an automation.',
		placement: 'bottom'
	},
	{
		id: 'campaigns',
		target: '[data-tour="nav-/campaigns"]',
		title: 'Campaigns',
		body: 'Tiles up top show sends, deliveries, and your 30-day open and click rates. Upcoming lists scheduled sends and resends, and the send log below has every email with filters. Hit <strong>New campaign</strong> to send to a list or segment, or a Direct 1:1 email — with templates, merge tags like {{first_name}}, test sends, and scheduling.',
		placement: 'bottom'
	},
	{
		id: 'pipeline',
		target: '[data-tour="nav-/pipeline"]',
		title: 'Pipeline',
		body: 'Track deals as cards on a board: one card per contact, moved through stages like Lead → Proposal → Won. Drag cards between columns (or use the ⋯ menu), set a value and an owner, and switch to the list view for sorting.',
		placement: 'bottom'
	},
	{
		id: 'automations',
		target: '[data-tour="nav-/automations"]',
		title: 'Automations',
		body: 'Build a drip flow triggered manually or by someone being added to a list/tag. Steps are wait → email/tag → conditions that can branch. The engine ticks about every minute, and "once / multiple times" controls whether a contact can go through again.',
		placement: 'bottom'
	},
	{
		id: 'replies',
		target: '[data-tour="nav-/conversations"]',
		title: 'Conversations',
		body: 'Your sends and the replies they get, threaded per contact. Replies are also forwarded to your inbox, and "Awaiting my reply" shows who is waiting on you.',
		placement: 'bottom'
	},
	{
		id: 'deliverability',
		target: '[data-tour="nav-/deliverability"]',
		title: 'Deliverability',
		body: 'Keep an eye on bounce and complaint rates, see who’s suppressed, and find cold contacts worth re-engaging or trimming from your list.',
		placement: 'bottom'
	},
	{
		id: 'creative',
		target: '[data-tour="creative"]',
		title: 'Creative',
		body: 'Email templates, your global header and footer, and hosted pages all live under Creative — the building blocks you reuse across campaigns.',
		placement: 'bottom'
	},
	{
		id: 'settings',
		target: '[data-tour="user"]',
		title: 'Settings',
		body: 'Settings, the tour, and sign-out live under your avatar. Settings is where you manage approved senders, your default From address, reply forwarding, and the Luma integration. Its section list also holds Data API keys (for other apps and agents to read/write your data) and Webhooks — form webhook keys that feed contacts in from your website.',
		placement: 'bottom'
	},
	{
		id: 'help',
		target: '[data-tour="help"]',
		title: "You're set",
		body: 'This ? button opens searchable help for whatever page you’re on, and you can retake this tour from there any time.',
		placement: 'top'
	}
];
