import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/contacts/[id]/+page.server';
import { OPERATOR_UNSUB_REASON } from '../src/lib/unsubscribe-page';
import control from '../src/lib/components/SubscriptionControl.svelte?raw';
import contactPage from '../src/routes/contacts/[id]/+page.svelte?raw';

// #507: change a contact's subscription from the badge on their page (`?/setSubscribed`).
const db = (env as any).DB as D1Database;

type Supp = { EmailAddress: string; SuppressionReason: string };
/** Mock Postmark: `dumps[stream]` = that stream's suppression dump; anything else 200 `{}`. */
function mockPostmark(dumps: Record<string, Supp[]> = {}, opts: { down?: boolean } = {}) {
	const fetchMock = vi.fn(async (url: string) => {
		if (opts.down) throw new Error('network down');
		const m = /\/message-streams\/([^/]+)\/suppressions\/dump$/.exec(url);
		if (m) return new Response(JSON.stringify({ Suppressions: dumps[decodeURIComponent(m[1])] ?? [] }), { status: 200 });
		return new Response(JSON.stringify({ Suppressions: [] }), { status: 200 });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function ev(id: number, fields: Record<string, string>, opts: { role?: 'admin' | 'member'; token?: string } = {}) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env: { ...env, POSTMARK_TOKEN: opts.token, POSTMARK_STREAM: 'broadcast', POSTMARK_STREAM_TX: 'outbound' } },
		params: { id: String(id) },
		locals: { user: { id: 1, github_login: 'jdoe', role: opts.role ?? 'admin' } },
		request: new Request(`https://app.test/contacts/${id}?/setSubscribed`, { method: 'POST', body: fd })
	} as any;
}

async function contact(email: string, subscribed = 1, archived = false): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO contacts (email, subscribed, archived_at) VALUES (?, ?, ${archived ? "datetime('now')" : 'NULL'}) RETURNING id`
		)
		.bind(email, subscribed)
		.first<{ id: number }>())!.id;
}
async function subscribed(id: number): Promise<number> {
	return (await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())!.subscribed;
}
async function unsubRows(id: number) {
	return (await db.prepare('SELECT reason, detail FROM unsubscribes WHERE contact_id = ? ORDER BY id').bind(id).all<{ reason: string; detail: string | null }>()).results;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM contacts')
	]);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('setSubscribed', () => {
	it('unsubscribes with the chosen reason and an operator @login detail', async () => {
		const id = await contact('ann@example.com');
		const out: any = await actions.setSubscribed(ev(id, { subscribed: '0', reason: 'Too many emails', note: 'asked by phone' }));
		expect(out.subOk).toBe(true);
		expect(await subscribed(id)).toBe(0);
		expect(await unsubRows(id)).toEqual([{ reason: 'Too many emails', detail: 'operator @jdoe: asked by phone' }]);
	});

	it('defaults to "Operator request" and an unknown reason falls back to it', async () => {
		const id = await contact('bo@example.com');
		await actions.setSubscribed(ev(id, { subscribed: '0', reason: 'made up' }));
		expect(await unsubRows(id)).toEqual([{ reason: OPERATOR_UNSUB_REASON, detail: 'operator @jdoe' }]);
	});

	it('refuses a note over 200 characters', async () => {
		const id = await contact('cy@example.com');
		const out: any = await actions.setSubscribed(ev(id, { subscribed: '0', note: 'x'.repeat(201) }));
		expect(out.status).toBe(400);
		expect(await subscribed(id)).toBe(1);
	});

	it('suppresses in Postmark when asked', async () => {
		const fetchMock = mockPostmark();
		const id = await contact('di@example.com');
		await actions.setSubscribed(ev(id, { subscribed: '0', suppress: '1' }, { token: 't' }));
		expect(fetchMock.mock.calls.map((c) => c[0])).toContain('https://api.postmarkapp.com/message-streams/broadcast/suppressions');
	});

	it('resubscribes', async () => {
		mockPostmark();
		const id = await contact('ed@example.com', 0);
		const out: any = await actions.setSubscribed(ev(id, { subscribed: '1' }, { token: 't' }));
		expect(out.subOk).toBe(true);
		expect(await subscribed(id)).toBe(1);
	});

	it('refuses to resubscribe a Postmark hard bounce / spam complaint', async () => {
		mockPostmark({ broadcast: [{ EmailAddress: 'fi@example.com', SuppressionReason: 'HardBounce' }] });
		const id = await contact('fi@example.com', 0);
		const out: any = await actions.setSubscribed(ev(id, { subscribed: '1' }, { token: 't' }));
		expect(out.status).toBe(409);
		expect(out.data.subError).toBe("Can't resubscribe: Postmark has a hard bounce or spam complaint for this address.");
		expect(await subscribed(id)).toBe(0);
	});

	it('resubscribes unchecked when Postmark is unreachable, with a note', async () => {
		mockPostmark({}, { down: true });
		const id = await contact('gu@example.com', 0);
		const out: any = await actions.setSubscribed(ev(id, { subscribed: '1' }, { token: 't' }));
		expect(await subscribed(id)).toBe(1);
		expect(out.subNote).toContain('suppressions not checked');
	});

	it('works for archived contacts', async () => {
		const id = await contact('ha@example.com', 1, true);
		await actions.setSubscribed(ev(id, { subscribed: '0' }));
		expect(await subscribed(id)).toBe(0);
		await actions.setSubscribed(ev(id, { subscribed: '1' }));
		expect(await subscribed(id)).toBe(1);
	});

	it('is open to members, like the bulk bar', async () => {
		const id = await contact('io@example.com');
		const out: any = await actions.setSubscribed(ev(id, { subscribed: '0' }, { role: 'member' }));
		expect(out.subOk).toBe(true);
		expect(await subscribed(id)).toBe(0);
	});

	it('404s an unknown contact and 400s a bad value', async () => {
		expect(((await actions.setSubscribed(ev(999999, { subscribed: '0' }))) as any).status).toBe(404);
		const id = await contact('ju@example.com');
		expect(((await actions.setSubscribed(ev(id, { subscribed: 'x' }))) as any).status).toBe(400);
	});
});


describe('SubscriptionControl outside dismiss', () => {
	// A window `click` listener ran after pick() had removed the menu item, so the target looked
	// outside the control and the confirm closed as it opened; dismiss must listen on pointerdown.
	it('listens on pointerdown, not click, and ignores detached targets', () => {
		expect(control).toMatch(/<svelte:window[^>]*onpointerdown=/);
		expect(control).not.toMatch(/<svelte:window[^>]*onclick=/);
		expect(control).toContain('isConnected');
	});
});

describe('SubscriptionControl pending state (#510)', () => {
	// Double opt-in's Pending confirmation lives in this control, not in a second page widget.
	it('renders Pending confirmation and posts resend / cancel', () => {
		expect(control).toContain('Pending confirmation');
		expect(control).toContain('action="?/resendConfirmation"');
		expect(control).toContain('action="?/cancelConfirmation"');
		expect(control).toContain('Cancel the pending confirmation? Their link stops working and they stay unsubscribed.');
		expect(contactPage).toMatch(/<SubscriptionControl[\s\S]*?pending=\{!!c\.confirm_pending\}[\s\S]*?confirmation=\{data\.confirmation\}/);
		expect(contactPage).not.toContain('confirm-menu');
		expect(contactPage).not.toContain('?/resendConfirmation');
	});
});
