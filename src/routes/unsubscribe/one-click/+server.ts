import type { RequestHandler } from './$types';
import { verifyUnsub } from '$lib/server/token';
import { unsubscribeAll } from '$lib/server/unsubscribe';
import { getMailProvider } from '$lib/server/mail';

// RFC 8058 one-click unsubscribe (#264): the `List-Unsubscribe` header URL on broadcast
// sends. Mailbox providers POST `List-Unsubscribe=One-Click` here cross-site with no
// Origin, so the path is in hooks.server.ts's CSRF_EXEMPT; the signed token is the gate.
export const POST: RequestHandler = async (event) => {
	const plain = { 'content-type': 'text/plain; charset=utf-8' };
	try {
		const secret = event.platform?.env?.SESSION_SECRET ?? '';
		const payload = await verifyUnsub(secret, event.url.searchParams.get('t') ?? undefined);
		if (!payload || typeof payload.e !== 'string' || !payload.e) {
			return new Response('Invalid or expired unsubscribe link.', { status: 400, headers: plain });
		}
		const db = event.platform?.env?.DB;
		if (!db) return new Response('Unavailable.', { status: 503, headers: plain });
		await unsubscribeAll(
			db,
			await getMailProvider(db, event.platform?.env),
			payload,
			'one-click',
			null,
			{ onlyOnce: true }
		);
		return new Response('Unsubscribed.', { status: 200, headers: plain });
	} catch (e) {
		console.error('one-click unsubscribe failed:', e);
		return new Response('Unavailable, try again later.', { status: 503, headers: plain });
	}
};
