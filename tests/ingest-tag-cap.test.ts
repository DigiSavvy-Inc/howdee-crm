import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { POST as ingest } from '../src/routes/api/ingest/+server';

// Ingest applies up to 25 distinct tags per request (key defaults count toward it).
// The pasadena /feedback form sends ~10 existing tags plus `[Interest] <topic>` tags;
// at the old cap of 10 the interest tags were silently dropped (issue #351 in the operations tracker).
const db = (env as any).DB as D1Database;

async function post(token: string, body: Record<string, unknown>) {
	const url = 'https://crm.test/api/ingest';
	return ingest({
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify(body)
		}),
		url: new URL(url),
		platform: { env }
	} as any);
}

async function tagsOf(email: string): Promise<string[]> {
	const r = await db
		.prepare(
			`SELECT l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id JOIN contacts c ON c.id = lm.contact_id
			 WHERE l.kind = 'tag' AND c.email = ? ORDER BY l.name`
		)
		.bind(email)
		.all<{ name: string }>();
	return r.results.map((x) => x.name);
}

describe('/api/ingest tag cap', () => {
	it('keeps key defaults plus payload tags up to 25, including `[Interest] …` names verbatim', async () => {
		await db
			.prepare("INSERT INTO webhook_keys (label, token, default_list, default_tags, trust_body) VALUES ('Form', 'wk_cap1', 'Cap list', 'source:page,event:meetup', 1)")
			.run();
		const payload = [
			'pasadena-feedback', 'priority:high', 'workshop:yes', 'team-training', 'level:building-with-claude-code',
			'learn:mcp-servers', 'learn:subagents-and-workflows', 'learn:content-and-marketing-workflows',
			'[Interest] MCP servers', '[Interest] Subagents and workflows',
			'[Interest] Content and marketing workflows', '[Interest] Team training for my company'
		];
		const res = await post('wk_cap1', { email: 'cap1@example.com', tags: payload });
		expect(res.status).toBe(200);
		const got = await tagsOf('cap1@example.com');
		expect(got).toHaveLength(14); // 2 key defaults + 12 payload — over the old cap of 10
		expect(got).toContain('[Interest] Team training for my company');
		expect(got).toContain('source:page');
	});

	it('drops tags past the 25th, keeping the earliest (defaults first)', async () => {
		await db
			.prepare("INSERT INTO webhook_keys (label, token, default_list, default_tags, trust_body) VALUES ('Form', 'wk_cap2', 'Cap list', 'k1,k2', 1)")
			.run();
		const payload = Array.from({ length: 30 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
		const res = await post('wk_cap2', { email: 'cap2@example.com', tags: payload });
		expect(res.status).toBe(200);
		const got = await tagsOf('cap2@example.com');
		expect(got).toHaveLength(25);
		expect(got).toContain('k1');
		expect(got).toContain('t23');
		expect(got).not.toContain('t24');
	});
});
