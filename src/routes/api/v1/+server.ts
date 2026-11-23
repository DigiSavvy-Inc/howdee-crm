import { json, type RequestHandler } from '@sveltejs/kit';
import { requireKey } from '$lib/server/api-v1';
import { AUTOMATION_VOCABULARY } from '$lib/server/automations-api';

// GET /api/v1 — discovery + key check. Returns the authenticated key's scope and the
// available resources. Any valid (read) key works, so clients can use it to verify a key.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	return json({
		version: 'v1',
		scope: gate.key.scope,
		resources: {
			// #214: `bulk` = POST /api/v1/contacts/bulk; `bulk_actions` lists its actions (#280 added
			// archive / restore, #279 unsubscribe / resubscribe). #280: `archived` = the list filter
			// values (default active only).
			contacts: {
				read: true,
				write: gate.key.scope === 'read_write',
				bulk: gate.key.scope === 'read_write',
				bulk_actions: [
					'add_list',
					'remove_list',
					'exclude_segment',
					'add_tag',
					'remove_tag',
					'delete',
					'archive',
					'restore',
					'unsubscribe',
					'resubscribe'
				],
				archived: ['1', 'all']
			},
			companies: { read: true, write: gate.key.scope === 'read_write' },
			// #472: GET /api/v1/lists — lists + segments with archived_at; archived left out unless
			// ?include_archived=1.
			lists: { read: true, write: false, include_archived: ['1'] },
			events: { read: true, write: false },
			// #154: GET /api/v1/site-events, /contacts/:id/site-activity; writes via POST /api/track/server
			site_events: { read: true, write: gate.key.scope === 'read_write' },
			engagement: { read: true, write: false },
			// #467: GET /api/v1/scores, GET /contacts/:id/scores; POST /contacts/:id/scores/:scoreId/adjust (read_write)
			scores: { read: true, adjust: gate.key.scope === 'read_write' },
			// #347: drafts only — POST (whole-flow spec), PATCH, PUT :id/spec, steps, duplicate.
			// Activation stays a human click in the app; enroll (POST :id/enroll) needs read_write.
			automations: {
				read: true,
				write: gate.key.scope === 'read_write' || gate.key.scope === 'automations:draft' ? 'draft' : false,
				activate: false,
				enroll: gate.key.scope === 'read_write',
				delete: gate.key.scope === 'read_write',
				note: 'Drafts only. Activate in the app (open editor_url).',
				vocabulary: AUTOMATION_VOCABULARY
			},
			// #207: GET /api/v1/pipeline/stages, /pipeline/cards; GET/POST/DELETE /contacts/:id/pipeline
			pipeline: { read: true, write: gate.key.scope === 'read_write' },
			// #238/#252: GET list/one; POST/PATCH drafts only (DELETE needs read_write)
			campaigns: {
				read: true,
				write: gate.key.scope === 'read_write' || gate.key.scope === 'campaigns:draft',
				send: false,
				// #311: POST /api/v1/campaigns/:id/checks (read) — the pre-send checks
				checks: true,
				note: 'Drafts only. Scheduling and sending happen in the app UI (open compose_url).'
			},
			// #358: GET /reports, GET /reports/{id|builtin:key}/run, POST /reports/run (spec body).
			// Keys carry no role, so reports run as a member: hours, billing and pipeline value → 403.
			reports: { read: true, run: true, write: false, admin_only_metrics: false },
			// #481: GET /api/v1/newsletter — published newsletter archive issues. Publishing is admin-UI only.
			newsletter: { read: true, write: false },
			// #620: GET /api/v1/forms, GET /api/v1/forms/:id/submissions?since=&limit= (≤ 200). Read-only.
			forms: { read: true, write: false, submissions: { since: true, max_limit: 200 } }
		}
	});
};
