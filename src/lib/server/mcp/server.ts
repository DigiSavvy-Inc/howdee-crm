// #348: a remote MCP server on the Worker — `POST /mcp`, Streamable HTTP transport answered
// as plain JSON (no SSE: every request gets one JSON-RPC response, so the spec lets us skip
// the stream), stateless (no Mcp-Session-Id). The protocol surface we need is small, so it is
// hand-written: initialize, ping, tools/list, tools/call (+ notifications, answered 202).
// Auth = `Authorization: Bearer <Data API key>`; the key's scope decides which tools are
// listed and callable (tools.ts). 60 tool calls per minute per key, per isolate.

import type { RequestEvent } from '@sveltejs/kit';
import { bumpApiKeyUsage, findApiKey, type ApiKeyRow } from '$lib/server/api-keys';
import { getBranding } from '$lib/server/branding';
import { MCP_TOOLS, McpToolError, countsItself, toolAllowed, type McpToolDef } from './tools';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'dscrm';
export const MCP_RATE_PER_MINUTE = 60;

/** #596: the server describes itself with Settings → Branding's app name. */
export const mcpInstructions = (appName: string) =>
	`${appName} (contacts, lists, campaigns, automations). Writes are drafts only — ` +
	'nothing here sends, schedules, activates an automation or enrolls a contact; a human does that in the app ' +
	'(open the returned compose_url / editor_url). The key decides the tools: read keys read, draft keys only ' +
	'draft (no CRM reads), read_write keys both. To build an automation: get_automation_spec_format, ' +
	'list_groups (for list ids, read keys), then build_automation with a spec.';

// ---- rate limit (sliding minute per key, per isolate — like site tracking, approximate) ----

const calls = new Map<number, number[]>();

export function takeMcpCall(keyId: number, now = Date.now()): boolean {
	const recent = (calls.get(keyId) ?? []).filter((t) => now - t < 60_000);
	if (recent.length >= MCP_RATE_PER_MINUTE) {
		calls.set(keyId, recent);
		return false;
	}
	recent.push(now);
	calls.set(keyId, recent);
	if (calls.size > 1000) calls.delete(calls.keys().next().value as number);
	return true;
}

export function resetMcpRateLimits(): void {
	calls.clear();
}

// ---- JSON-RPC -------------------------------------------------------------------------

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function textResult(data: unknown, isError = false) {
	const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
	const structured = !isError && data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {};
	return { content: [{ type: 'text', text }], ...structured, isError };
}

function toolList(key: ApiKeyRow) {
	return MCP_TOOLS.filter((t) => toolAllowed(key.scope, t)).map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
		annotations: { readOnlyHint: t.group === 'read', destructiveHint: t.name === 'delete_automation_step', openWorldHint: false }
	}));
}

function unknownArgs(tool: McpToolDef, args: Record<string, unknown>): string[] {
	const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
	return Object.keys(args).filter((k) => !(k in props));
}

async function callTool(event: RequestEvent, key: ApiKeyRow, params: Record<string, unknown>) {
	const name = typeof params.name === 'string' ? params.name : '';
	const tool = MCP_TOOLS.find((t) => t.name === name);
	if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name || '(none)'}` } };
	if (!toolAllowed(key.scope, tool)) {
		return {
			result: textResult(`This key's scope (${key.scope}) does not allow ${name}. It needs a ${tool.group} or read_write key.`, true)
		};
	}
	if (!takeMcpCall(key.id)) {
		return { result: textResult(`Rate limit: ${MCP_RATE_PER_MINUTE} tool calls per minute per key. Wait a moment and try again.`, true) };
	}
	const rawArgs = params.arguments ?? {};
	if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return { result: textResult('arguments must be an object.', true) };
	const args = rawArgs as Record<string, unknown>;
	const extra = unknownArgs(tool, args);
	if (extra.length) return { result: textResult(`Unknown argument${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}.`, true) };

	if (!countsItself(tool)) await bumpApiKeyUsage(event.platform!.env.DB, key.id);
	try {
		return { result: textResult(await tool.run({ event, args })) };
	} catch (e) {
		if (e instanceof McpToolError) {
			return { result: textResult(e.detail ? `${e.message}\n${JSON.stringify(e.detail, null, 2)}` : e.message, true) };
		}
		console.error('mcp tool failed', name, e instanceof Error ? e.message : e);
		return { result: textResult(`${name} failed unexpectedly.`, true) };
	}
}

/** One JSON-RPC message → its response object, or null for a notification / response. */
async function handleMessage(event: RequestEvent, key: ApiKeyRow, msg: unknown): Promise<object | null> {
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
	const m = msg as JsonRpcMessage;
	const isRequest = typeof m.method === 'string' && m.id !== undefined;
	if (!isRequest) {
		// A notification (no id) or a response from the client: nothing to answer.
		if (typeof m.method === 'string' || 'result' in m || 'error' in m) return null;
		return rpcError(m.id ?? null, -32600, 'Invalid Request');
	}
	const id = m.id as JsonRpcId;
	if (m.jsonrpc !== '2.0') return rpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0".');
	const params = m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? (m.params as Record<string, unknown>) : {};

	if (m.method === 'tools/call') {
		const r = await callTool(event, key, params);
		return 'error' in r ? { jsonrpc: '2.0', id, error: r.error } : rpcResult(id, r.result);
	}
	await bumpApiKeyUsage(event.platform!.env.DB, key.id);
	switch (m.method) {
		case 'initialize': {
			const appName = (await getBranding(event.platform?.env?.DB)).appName;
			const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
			return rpcResult(id, {
				protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: MCP_SERVER_NAME, title: appName, version: '1.0.0' },
				instructions: mcpInstructions(appName)
			});
		}
		case 'ping':
			return rpcResult(id, {});
		case 'tools/list':
			return rpcResult(id, { tools: toolList(key) });
		default:
			return rpcError(id, -32601, `Method not found: ${String(m.method)}`);
	}
}

/** `POST /mcp`. */
export async function handleMcpPost(event: RequestEvent): Promise<Response> {
	const auth = await findApiKey(event);
	if (!auth.ok) {
		return jsonResponse({ error: auth.error }, auth.status, { 'www-authenticate': 'Bearer realm="dscrm"' });
	}
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return jsonResponse(rpcError(null, -32700, 'Parse error: body must be JSON.'), 400);
	}
	if (Array.isArray(body)) {
		// Batches (protocol 2025-03-26) — answered as an array; all notifications → 202.
		if (body.length === 0) return jsonResponse(rpcError(null, -32600, 'Invalid Request: empty batch.'), 400);
		const out: object[] = [];
		for (const msg of body) {
			const r = await handleMessage(event, auth.key, msg);
			if (r) out.push(r);
		}
		return out.length ? jsonResponse(out) : new Response(null, { status: 202 });
	}
	const r = await handleMessage(event, auth.key, body);
	return r ? jsonResponse(r) : new Response(null, { status: 202 });
}
