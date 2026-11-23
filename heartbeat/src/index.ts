// Heartbeat Worker (#7): on a cron schedule, POST the app's automation tick endpoint.
// Authenticates with a shared CRON_KEY (identical to the app's secret). Kept dead
// simple — all engine logic lives in the app; this only provides the clock.

export interface Env {
	TICK_PATH: string;
	TICK_URL: string; // local-dev fallback only
	CRON_KEY: string;
	// Service binding to the app Worker (prod). Absent in local dev → fall back to TICK_URL.
	APP?: { fetch: (req: Request) => Promise<Response> };
}

async function runTick(env: Env): Promise<{ status: number; body: string }> {
	const headers = { Authorization: `Bearer ${env.CRON_KEY}` };
	// Prefer the service binding (same-zone Worker→Worker over a public URL is blocked,
	// Cloudflare error 1042). Host in the URL is arbitrary — the app routes by pathname.
	const res = env.APP
		? await env.APP.fetch(new Request(`https://app${env.TICK_PATH}`, { method: 'POST', headers }))
		: await fetch(env.TICK_URL, { method: 'POST', headers });

	const body = await res.text();
	if (!res.ok) console.error(`automation tick failed: ${res.status} ${body}`);
	else console.log(`automation tick ok: ${body}`);
	return { status: res.status, body };
}

export default {
	// Cron entrypoint.
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(runTick(env).then(() => undefined));
	},

	// Manual trigger for testing the wiring without waiting for cron. Gated by CRON_KEY
	// so the heartbeat can't be used as an open proxy to the tick endpoint.
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const provided =
			(req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') ||
			(url.searchParams.get('key') ?? '');
		if (!env.CRON_KEY || provided !== env.CRON_KEY) {
			return new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' }
			});
		}
		const r = await runTick(env);
		return new Response(r.body || JSON.stringify({ status: r.status }), {
			status: r.status,
			headers: { 'content-type': 'application/json' }
		});
	}
};
