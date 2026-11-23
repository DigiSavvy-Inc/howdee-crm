// Insights read tools (#287): dashboard tiles, engagement tiers + trend, going cold,
// deliverability.

import { loadPipelineTile, loadTiles } from '../../dashboard';
import { engagementSummary } from '../../engagement-query';
import { goingCold, tierTrend } from '../../engagement-insights';
import { bouncedCounts, deliverabilityRates, suppressedTotal } from '../../deliverability';
import { LIMIT_PROP, limitArg, type Tool } from './types';

export const insightTools: Tool[] = [
	{
		name: 'get_dashboard',
		tier: 'read',
		description:
			'Dashboard tiles: subscribers and 30-day change, sent and unique opens in the last 7 days, conversations awaiting reply, active automations/enrollments, pipeline open cards/value and won this month.',
		input_schema: { type: 'object', properties: {} },
		summarize: () => 'dashboard tiles',
		handler: async (ctx) => {
			const [tiles, pipeline] = await Promise.all([loadTiles(ctx.db), loadPipelineTile(ctx.db)]);
			return { ...tiles, pipeline };
		}
	},
	{
		name: 'get_engagement_tiers',
		tier: 'read',
		description:
			'Contacts per engagement tier (hot/warm/cool/cold/never/new), average score, opened/clicked in 30 days, plus the daily tier counts of the last N days (first and latest snapshot only when long).',
		input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 90 } } },
		summarize: () => 'tier counts + trend',
		handler: async (ctx, input) => {
			const days = typeof input.days === 'number' ? Math.max(7, Math.min(90, Math.floor(input.days))) : 30;
			const [summary, trend] = await Promise.all([engagementSummary(ctx.db), tierTrend(ctx.db, ctx.now, days)]);
			// The model doesn't need every dense day: keep the days that have a snapshot.
			const points = trend.days
				.map((day, i) => ({ day, ...Object.fromEntries(Object.entries(trend.series).map(([t, s]) => [t, s[i]])) }))
				.filter((p) => Object.entries(p).some(([k, v]) => k !== 'day' && v !== null));
			return { summary, trend: { days, snapshots: trend.snapshots, points } };
		}
	},
	{
		name: 'get_going_cold',
		tier: 'read',
		description: 'Subscribed contacts whose engagement tier dropped into cool or cold in the last 30 days (total + the top ones).',
		input_schema: { type: 'object', properties: { limit: LIMIT_PROP } },
		summarize: () => 'going cold this month',
		handler: async (ctx, input) => {
			const res = await goingCold(ctx.db, { limit: limitArg(input), now: ctx.now });
			return { total: res.total, contacts: res.contacts.map((c) => ({ ...c, url: `${ctx.baseUrl}/contacts/${c.id}` })) };
		}
	},
	{
		name: 'get_deliverability',
		tier: 'read',
		description:
			'Deliverability over the last 90 days: accepted sends, bounces, spam complaints, unsubscribes, bounce and complaint rates (warn above 5% / 0.1%), suppressed and bounced contact counts.',
		input_schema: { type: 'object', properties: {} },
		summarize: () => 'last 90 days',
		handler: async (ctx) => {
			const [rates, suppressed, bounced] = await Promise.all([
				deliverabilityRates(ctx.db),
				suppressedTotal(ctx.db),
				bouncedCounts(ctx.db)
			]);
			return { ...rates, suppressed_contacts: suppressed, bounced_contacts: bounced, url: `${ctx.baseUrl}/deliverability` };
		}
	}
];
