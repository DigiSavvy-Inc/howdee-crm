// #696: AI features through a provider registry — the model catalogue across providers, the
// OpenAI-compatible adapter (request body, stream assembly, errors, key handling), per-feature
// models, and the assistant's hard rules checked against every provider, not only Claude.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { MODELS, costMicros, isPriced, modelInfo, namespacedModel, supportsTools } from '../src/lib/ai-models';
import { baseUrlProblem, modelLinesText, normalizeOpenAiConfig, openAiModelInfos, parseModelLines } from '../src/lib/ai-providers';
import { featureModel, normalizeConfig } from '../src/lib/server/ai/config';
import { runTurn, type LoopEvent } from '../src/lib/server/ai/loop';
import { assembleOpenAiStream, openAiBody, openAiCompatProvider, toOpenAiMessages } from '../src/lib/server/ai/openai-compat';
import type { AiProvider, ChatMessage, ProviderEvent, StreamRequest } from '../src/lib/server/ai/provider';
import { providerFor } from '../src/lib/server/ai/providers';
import { JOB_TOOLS } from '../src/lib/server/ai/jobs';
import { TOOLS, chatTools } from '../src/lib/server/ai/tools';

const db = (env as any).DB as D1Database;
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const KEY = 'sk-test-Fake-696-key-0000';

const OPENAI = {
	baseUrl: 'https://llm.example.net/v1',
	label: 'Test',
	models: [
		{ name: 'big-model', label: 'Big', tools: true, reasoning: true, price: { input: 1, output: 4 } },
		{ name: 'tiny-model', label: 'Tiny', tools: false, reasoning: false, price: null }
	]
};

function sseResponse(chunks: unknown[], opts: { done?: boolean } = {}): Response {
	const text = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('') + (opts.done === false ? '' : 'data: [DONE]\n\n');
	return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const out: ProviderEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}

async function* msgs(chunks: unknown[], done = true) {
	for (const c of chunks) yield { event: 'message', data: typeof c === 'string' ? c : JSON.stringify(c) };
	if (done) yield { event: 'message', data: '[DONE]' };
}

afterEach(() => vi.restoreAllMocks());

describe('model registry (#696)', () => {
	it('keeps the built-in Claude ids and accepts the namespaced form', () => {
		for (const m of MODELS) {
			expect(modelInfo(m.id)).toBe(m);
			expect(modelInfo(namespacedModel(m.id))).toBe(m);
			expect(supportsTools(m)).toBe(true);
			expect(isPriced(m)).toBe(true);
		}
		expect(namespacedModel('claude-opus-5-5')).toBe('anthropic:claude-opus-5-5');
		expect(namespacedModel('openai:big-model')).toBe('openai:big-model');
	});

	it('finds an install model only when it is passed as extra', () => {
		const extra = openAiModelInfos(OPENAI);
		expect(modelInfo('openai:big-model')).toBeNull();
		const big = modelInfo('openai:big-model', extra)!;
		expect(big).toMatchObject({ provider: 'openai', apiModel: 'big-model', tools: true, efforts: ['low', 'medium', 'high'] });
		const tiny = modelInfo('openai:tiny-model', extra)!;
		expect(supportsTools(tiny)).toBe(false);
		expect(tiny.efforts).toEqual([]);
	});

	it('an unpriced model costs 0 and says it is unpriced', () => {
		const tiny = modelInfo('openai:tiny-model', openAiModelInfos(OPENAI))!;
		expect(isPriced(tiny)).toBe(false);
		expect(costMicros(tiny, { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 })).toBe(0);
		const big = modelInfo('openai:big-model', openAiModelInfos(OPENAI))!;
		expect(costMicros(big, { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 })).toBe(5000);
	});
});

describe('OpenAI-compatible settings (#696)', () => {
	it('parses model lines and round-trips them', () => {
		const p = parseModelLines('# comment\nbig-model | Big | tools,reasoning | 1 | 4\n\ntiny-model | Tiny | no-tools\n');
		expect(p.problems).toEqual([]);
		expect(p.models).toEqual(OPENAI.models);
		expect(parseModelLines(modelLinesText(p.models)).models).toEqual(p.models);
	});

	it('refuses bad lines with the line number', () => {
		const p = parseModelLines('has space | x\nok | Ok | magic\nok2 | Ok | tools | 1\nok3 | Ok | tools | x | 2\nok | dup');
		expect(p.problems.join(' ')).toMatch(/Line 1/);
		expect(p.problems.join(' ')).toMatch(/Line 2: unknown flag magic/);
		expect(p.problems.join(' ')).toMatch(/Line 3: give both prices/);
		expect(p.problems.join(' ')).toMatch(/Line 4: prices/);
	});

	it('checks the base URL', () => {
		expect(baseUrlProblem('')).toBe('');
		expect(baseUrlProblem('https://openrouter.example.net/api/v1')).toBe('');
		expect(baseUrlProblem('ftp://x.example.net')).not.toBe('');
		expect(baseUrlProblem('https://user:pw@x.example.net/v1')).not.toBe('');
		expect(baseUrlProblem('https://x.example.net/v1?key=1')).not.toBe('');
		expect(normalizeOpenAiConfig({ baseUrl: 'https://x.example.net/v1/' }).baseUrl).toBe('https://x.example.net/v1');
	});

	it('an assistant config saved before #696 has no other provider and no overrides', () => {
		const cfg = normalizeConfig({ access: 'everyone', allowedModels: ['claude-sonnet-5-5'] });
		expect(cfg.openai).toEqual({ baseUrl: '', label: '', models: [] });
		expect(cfg.featureModels).toEqual({});
		expect(featureModel(cfg, 'chat')?.id).toBe('claude-sonnet-5-5');
		expect(featureModel(cfg, 'editorAsk')?.id).toBe('claude-sonnet-5-5');
	});

	it('allows install models, and tool features never get a model without tools', () => {
		const cfg = normalizeConfig({
			openai: OPENAI,
			allowedModels: ['claude-sonnet-5-5', 'openai:big-model', 'openai:tiny-model'],
			defaultModel: 'openai:tiny-model',
			featureModels: { chat: 'openai:tiny-model', draftReply: 'openai:tiny-model', briefs: 'openai:big-model', jobs: 'nope' }
		});
		expect(cfg.allowedModels).toEqual(['claude-sonnet-5-5', 'openai:big-model', 'openai:tiny-model']);
		expect(cfg.defaultModel).toBe('openai:tiny-model');
		expect(cfg.featureModels).toEqual({ draftReply: 'openai:tiny-model', briefs: 'openai:big-model' });
		// The default model can't call tools, so the chat falls back to the first allowed one that can.
		expect(featureModel(cfg, 'chat')?.id).toBe('claude-sonnet-5-5');
		expect(featureModel(cfg, 'draftReply')?.id).toBe('openai:tiny-model');
		expect(featureModel(cfg, 'briefs')?.id).toBe('openai:big-model');
	});
});

describe('OpenAI-compatible adapter: request (#696)', () => {
	const history: ChatMessage[] = [
		{ role: 'user', content: [{ type: 'text', text: 'How many contacts?' }] },
		{
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'hm', signature: 'sig' },
				{ type: 'text', text: 'Let me look.' },
				{ type: 'tool_use', id: 'toolu_1', name: 'search_contacts', input: { q: 'a' } }
			]
		},
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"total":3}' }] }
	];

	it('translates the stored (provider-neutral) history', () => {
		expect(toOpenAiMessages('SYS', history)).toEqual([
			{ role: 'system', content: 'SYS' },
			{ role: 'user', content: 'How many contacts?' },
			{ role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'search_contacts', arguments: '{"q":"a"}' } }] },
			{ role: 'tool', tool_call_id: 'toolu_1', content: '{"total":3}' }
		]);
	});

	it('builds the body: model name, tools, token limit, reasoning effort', () => {
		const req: StreamRequest = {
			model: 'openai:big-model',
			effort: 'high',
			system: 'SYS',
			messages: history,
			tools: [{ name: 'search_contacts', description: 'Find contacts', input_schema: { type: 'object', properties: {} } }]
		};
		const b = openAiBody(req, 'https://llm.example.net/v1');
		expect(b).toMatchObject({ model: 'big-model', stream: true, stream_options: { include_usage: true }, max_tokens: 8192, reasoning_effort: 'high' });
		expect(b.tools).toEqual([{ type: 'function', function: { name: 'search_contacts', description: 'Find contacts', parameters: { type: 'object', properties: {} } } }]);
		const o = openAiBody({ ...req, effort: null, tools: [] }, 'https://api.openai.com/v1');
		expect(o.max_completion_tokens).toBe(8192);
		expect(o).not.toHaveProperty('max_tokens');
		expect(o).not.toHaveProperty('tools');
		expect(o).not.toHaveProperty('reasoning_effort');
	});
});

describe('OpenAI-compatible adapter: stream (#696)', () => {
	it('assembles text, a streamed tool call and usage', async () => {
		const events = await collect(
			assembleOpenAiStream(
				msgs([
					{ choices: [{ delta: { content: 'Hi ' } }] },
					{ choices: [{ delta: { content: 'there' } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'search_contacts', arguments: '{"q":' } }] } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
					{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }
				]),
				{ toolInputDeltas: true }
			)
		);
		expect(events.filter((e) => e.type === 'text').map((e: any) => e.text).join('')).toBe('Hi there');
		expect(events).toContainEqual({ type: 'tool_use_start', id: 'call_a', name: 'search_contacts' });
		expect(events.filter((e) => e.type === 'tool_input').map((e: any) => e.json).join('')).toBe('{"q":"x"}');
		const done = events.at(-1) as Extract<ProviderEvent, { type: 'done' }>;
		expect(done.type).toBe('done');
		expect(done.stopReason).toBe('tool_use');
		expect(done.usage).toEqual({ input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
		expect(done.content).toEqual([
			{ type: 'text', text: 'Hi there' },
			{ type: 'tool_use', id: 'call_a', name: 'search_contacts', input: { q: 'x' } }
		]);
	});

	it('maps stop reasons, reports bad tool JSON, and errors on a cut stream', async () => {
		const ok = await collect(assembleOpenAiStream(msgs([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }], false)));
		expect(ok.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
		const bad = await collect(assembleOpenAiStream(msgs([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: '{nope' } }] }, finish_reason: 'tool_calls' }] }])));
		expect(bad.at(-1)).toMatchObject({ type: 'done', invalidToolInput: ['c1'], content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] });
		const cut = await collect(assembleOpenAiStream(msgs([{ choices: [{ delta: { content: 'x' } }] }], false)));
		expect(cut.at(-1)).toMatchObject({ type: 'error' });
		const err = await collect(assembleOpenAiStream(msgs([{ error: { message: 'overloaded' } }])));
		expect(err.at(-1)).toEqual({ type: 'error', message: 'overloaded' });
	});

	it('sends the key only as a header, and never logs it or echoes it in an error', async () => {
		const logs: string[] = [];
		for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
		}
		const seen: { url: string; init: RequestInit }[] = [];
		const fetchMock = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response(JSON.stringify({ error: { message: `Invalid key ${KEY}` } }), { status: 401 });
		}) as unknown as typeof fetch;
		const p = openAiCompatProvider({ apiKey: KEY, baseUrl: 'https://llm.example.net/v1/' }, fetchMock);
		const events = await collect(p.stream({ model: 'openai:big-model', effort: null, system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'secret prompt' }] }], tools: [] }));
		expect(seen[0].url).toBe('https://llm.example.net/v1/chat/completions');
		expect((seen[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
		expect(String(seen[0].init.body)).not.toContain(KEY);
		const e = events.at(-1) as Extract<ProviderEvent, { type: 'error' }>;
		expect(e).toMatchObject({ type: 'error', status: 401 });
		expect(e.message).not.toContain(KEY);
		expect(logs.join('\n')).not.toContain(KEY);
		expect(logs.join('\n')).not.toContain('secret prompt');
	});

	it('refuses to call without a key', async () => {
		const fetchMock = vi.fn();
		const events = await collect(openAiCompatProvider({ apiKey: '', baseUrl: 'https://llm.example.net/v1' }, fetchMock as any).stream({ model: 'm', effort: null, system: '', messages: [], tools: [] }));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(events.at(-1)).toMatchObject({ type: 'error' });
	});

	it('providerFor picks the adapter by the model\'s provider', async () => {
		const urls: string[] = [];
		const fetchMock = (async (url: string) => {
			urls.push(url);
			return new Response('{}', { status: 500 });
		}) as unknown as typeof fetch;
		const envKeys = { ANTHROPIC_API_KEY: 'sk-ant-test-696', OPENAI_API_KEY: 'sk-test-696' };
		const cfg = normalizeConfig({ openai: OPENAI });
		const req = { effort: null, system: '', messages: [], tools: [] };
		await collect((await providerFor(db, envKeys, cfg, { provider: 'openai' }, fetchMock)).stream({ ...req, model: 'openai:big-model' }));
		await collect((await providerFor(db, envKeys, cfg, {}, fetchMock)).stream({ ...req, model: 'claude-sonnet-5-5' }));
		expect(urls[0]).toBe('https://llm.example.net/v1/chat/completions');
		expect(urls[1]).toContain('api.anthropic.com');
	});
});

describe('hard rules hold for every provider (#696)', () => {
	const FORBIDDEN = /^(send|schedule|activate|enroll|publish)_/;
	const ctx = () => ({ db, user: { id: 1, github_login: 'ourco-admin', role: 'admin' } as any, baseUrl: 'https://crm.myapp.example', now: new Date() });

	it('no registered tool sends, schedules, activates or enrolls; jobs stay read-only', () => {
		for (const t of TOOLS) expect(t.name, t.name).not.toMatch(FORBIDDEN);
		for (const t of chatTools({ allowDelete: true })) expect(t.name).not.toMatch(FORBIDDEN);
		expect(JOB_TOOLS.every((t) => t.tier === 'read')).toBe(true);
	});

	/** A provider that asks for a forbidden tool, then ends its turn — the same script for any adapter. */
	function scripted(adapter: 'fake' | 'openai'): AiProvider {
		const call = { name: 'send_campaign', input: { campaign_id: 1 } };
		if (adapter === 'fake') {
			let n = 0;
			return {
				async *stream() {
					n += 1;
					if (n === 1) yield { type: 'done', content: [{ type: 'tool_use', id: 'call_1', ...call }], stopReason: 'tool_use', usage: ZERO };
					else yield { type: 'done', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: ZERO };
				}
			};
		}
		let n = 0;
		const fetchMock = (async () => {
			n += 1;
			return n === 1
				? sseResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: call.name, arguments: JSON.stringify(call.input) } }] }, finish_reason: 'tool_calls' }] }])
				: sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
		}) as unknown as typeof fetch;
		return openAiCompatProvider({ apiKey: KEY, baseUrl: 'https://llm.example.net/v1' }, fetchMock);
	}

	for (const adapter of ['fake', 'openai'] as const) {
		it(`an invented send tool is refused, not run (${adapter})`, async () => {
			const events: LoopEvent[] = [];
			const stored: unknown[] = [];
			const r = await runTurn({
				provider: scripted(adapter),
				model: { id: 'openai:big-model', label: 'Big', provider: 'openai', efforts: [] },
				effort: null,
				system: 'SYS',
				messages: [{ role: 'user', content: [{ type: 'text', text: 'Send the newsletter now.' }] }],
				tools: TOOLS,
				ctx: ctx(),
				emit: (e) => events.push(e),
				persist: async (m) => void stored.push(m)
			});
			expect(r.stopReason).toBe('end_turn');
			const done = events.find((e) => e.type === 'tool_done') as Extract<LoopEvent, { type: 'tool_done' }>;
			expect(done).toMatchObject({ name: 'send_campaign', ok: false });
			expect(JSON.stringify(stored)).toContain('Unknown tool');
			expect(events.some((e) => e.type === 'action' || e.type === 'pending')).toBe(false);
		});
	}
});
