import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #254: automation email steps use the visual editor — updateStep stores sanitised
// body_blocks + the markdown export, the engine sends from the blocks, and a markdown
// step (body_blocks NULL) sends exactly as before.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { actions } from '../src/routes/automations/[id]/+page.server';
import { enroll, tick } from '../src/lib/server/automations';
import { blocksToMarkdown } from '../src/lib/blocks-markdown';
import type { Block } from '../src/lib/blocks';

const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };

const blocks: Block[] = [
	{ id: 'h', type: 'heading', level: 2, text: 'Hi {{first_name}}', content: [{ type: 'text', text: 'Hi ' }, { type: 'mergeTag', tag: 'first_name' }] },
	{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Read ' }, { type: 'text', text: 'this', marks: [{ type: 'link', href: 'https://example.com/x' }] }] },
	{ id: 'b', type: 'button', label: 'Go', href: 'https://example.com/go', align: 'center' }
];

function stepEvent(automationId: number, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env: { ...(env as any), POSTMARK_FROM: 'alan@ourco.example' } },
		params: { id: String(automationId) },
		request: new Request('https://app.test/automations/x?/updateStep', { method: 'POST', body: fd })
	} as any;
}

const emailFields = (stepId: number, extra: Record<string, string>) => ({
	step_id: String(stepId),
	subject: 'Welcome',
	from_email: 'alan@ourco.example',
	delay_value: '0',
	delay_unit: 'days',
	...extra
});

const stepRow = (id: number) =>
	db.prepare('SELECT body_md, body_blocks FROM automation_steps WHERE id = ?').bind(id).first<{ body_md: string; body_blocks: string | null }>();

let automationId: number;
let stepId: number;
let contactId: number;

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) => msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Date.now()}-${i}` })));
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
	automationId = (await db.prepare("INSERT INTO automations (name, status) VALUES ('Drip', 'active') RETURNING id").first<{ id: number }>())!.id;
	stepId = (await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email)
			 VALUES (?, 0, 0, 'email', 'Welcome', 'Hello **{{first_name}}**', 'alan@ourco.example') RETURNING id`
		)
		.bind(automationId)
		.first<{ id: number }>())!.id;
	contactId = (await db.prepare("INSERT INTO contacts (email, first_name, subscribed) VALUES ('ann@example.com', 'Ann', 1) RETURNING id").first<{ id: number }>())!.id;
});

async function sendStep(): Promise<{ HtmlBody: string; TextBody: string }> {
	await enroll(db, automationId, [contactId]);
	await tick(db, cfg);
	expect(spies.sendBatch).toHaveBeenCalledTimes(1);
	return spies.sendBatch.mock.calls[0][1][0];
}

describe('automation email step with body_blocks (#254)', () => {
	it('saves sanitised blocks + markdown export, then sends the blocks', async () => {
		const r: any = await actions.updateStep(stepEvent(automationId, emailFields(stepId, { body_blocks: JSON.stringify(blocks) })));
		expect(r?.ok).toBe(true);
		const row = await stepRow(stepId);
		expect(JSON.parse(row!.body_blocks!)).toEqual(blocks);
		expect(row!.body_md).toBe(blocksToMarkdown(blocks));

		const msg = await sendStep();
		expect(msg.HtmlBody).toContain('Hi Ann');
		expect(msg.HtmlBody).toContain('https://example.com/go');
		// Email headings render as a styled div (not <h2>) for client safety; the merge tag resolves inside it.
		expect(msg.HtmlBody).toMatch(/<div style="[^"]*font-size:20px;font-weight:700;[^"]*">Hi Ann<\/div>/);
		expect(msg.TextBody).toContain('Hi Ann');
	});

	it('runs the sanitiser on step saves', async () => {
		const evil = JSON.stringify([
			{ id: 'x', type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'link', href: 'javascript:alert(1)' }] }] },
			{ id: 'y', type: 'html', html: '<script>alert(1)</script>' }
		]);
		const r: any = await actions.updateStep(stepEvent(automationId, emailFields(stepId, { body_blocks: evil })));
		expect(r?.ok).toBe(true);
		const row = await stepRow(stepId);
		expect(row!.body_blocks).toBe(JSON.stringify([{ id: 'x', type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }]));
		expect(row!.body_blocks).not.toContain('javascript:');
		expect(row!.body_blocks).not.toContain('script');
	});

	it('refuses an empty block body', async () => {
		const empty = JSON.stringify([{ id: 'e', type: 'paragraph', content: [] }]);
		const r: any = await actions.updateStep(stepEvent(automationId, emailFields(stepId, { body_blocks: empty })));
		expect(r?.status).toBe(400);
		expect(r?.data?.error).toBe('Step body is empty.');
		expect((await stepRow(stepId))!.body_blocks).toBeNull();
	});

	it('a legacy markdown step (body_blocks NULL) sends exactly as before', async () => {
		const msg = await sendStep();
		expect(msg.HtmlBody).toContain('Hello <strong>Ann</strong>');
		expect((await stepRow(stepId))!.body_blocks).toBeNull();
	});

	it('a markdown-only body write clears body_blocks so markdown wins', async () => {
		await actions.updateStep(stepEvent(automationId, emailFields(stepId, { body_blocks: JSON.stringify(blocks) })));
		expect((await stepRow(stepId))!.body_blocks).not.toBeNull();

		const r: any = await actions.updateStep(stepEvent(automationId, emailFields(stepId, { body_md: 'Plain **markdown**' })));
		expect(r?.ok).toBe(true);
		const row = await stepRow(stepId);
		expect(row!.body_blocks).toBeNull();
		expect(row!.body_md).toBe('Plain **markdown**');

		const msg = await sendStep();
		expect(msg.HtmlBody).toContain('Plain <strong>markdown</strong>');
		expect(msg.HtmlBody).not.toContain('https://example.com/go');
	});

	it('duplicateStep keeps the blocks', async () => {
		await actions.updateStep(stepEvent(automationId, emailFields(stepId, { body_blocks: JSON.stringify(blocks) })));
		const fd = new FormData();
		fd.append('step_id', String(stepId));
		await actions.duplicateStep({ platform: { env }, params: { id: String(automationId) }, request: new Request('https://app.test/x', { method: 'POST', body: fd }) } as any);
		const copy = await db
			.prepare('SELECT body_blocks FROM automation_steps WHERE automation_id = ? AND id != ?')
			.bind(automationId, stepId)
			.first<{ body_blocks: string | null }>();
		expect(JSON.parse(copy!.body_blocks!)).toEqual(blocks);
	});
});
