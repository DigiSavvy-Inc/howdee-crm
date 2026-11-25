// Reply-capture tag (#743). Each send's Reply-To is `<local>+<tag>@<inbound domain>`, and the
// inbound webhook reads the tag back from Postmark's MailboxHash to file the reply under the
// right campaign and contact.
//
//   current tag  `c<campaignId>r<contactId>s<sig>` — sig = HMAC-SHA256 under SESSION_SECRET with
//                its own prefix, first 60 bits as 12 lowercase base32 characters
//   older tag    `c<campaignId>r<contactId>` — mail sent before #743; no signature
//
// Only lowercase letters and digits, so the address survives mail clients that change case, and
// short enough to keep the whole local part within 64 characters.
import { hmac, timingSafeEqual } from './token';

const REPLY_PREFIX = 'dsv-reply:';
const SIG_CHARS = 12;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** RFC 5321: a local part is at most 64 characters. */
export const MAX_LOCAL_PART = 64;

function base32(bytes: Uint8Array, chars: number): string {
	let out = '';
	let buf = 0;
	let bits = 0;
	for (const b of bytes) {
		buf = (buf << 8) | b;
		bits += 8;
		while (bits >= 5 && out.length < chars) {
			out += B32[(buf >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buf &= (1 << bits) - 1;
		if (out.length >= chars) break;
	}
	return out;
}

async function sigFor(secret: string, campaignId: number, contactId: number): Promise<string> {
	return base32(await hmac(secret, `${REPLY_PREFIX}c${campaignId}r${contactId}`), SIG_CHARS);
}

/** The signed tag for one recipient of one campaign (contactId 0 = no contact). */
export async function signReplyTag(secret: string, campaignId: number, contactId: number): Promise<string> {
	return `c${campaignId}r${contactId}s${await sigFor(secret, campaignId, contactId)}`;
}

/**
 * The tagged Reply-To address, or null when no secret is set or the local part would be longer
 * than 64 characters (the caller then uses the plain inbound address).
 */
export async function replyTagAddress(
	inbound: string,
	secret: string,
	campaignId: number,
	contactId: number
): Promise<string | null> {
	const parts = inbound.split('@');
	if (parts.length !== 2 || !parts[0] || !parts[1] || !secret) return null;
	const local = `${parts[0]}+${await signReplyTag(secret, campaignId, contactId)}`;
	if (local.length > MAX_LOCAL_PART) return null;
	return `${local}@${parts[1]}`;
}

export type ReplyTag =
	| { kind: 'signed'; campaignId: number; contactId: number }
	| { kind: 'legacy'; campaignId: number; contactId: number }
	| { kind: 'none' };

/**
 * One id in a tag: canonical decimal only (`0`, or a non-zero digit and up to 14 more), so each
 * (campaign, contact) pair has exactly one tag that verifies. `0` stays valid: send.ts signs
 * contact 0 for a recipient without a contact row, and the inbound handler never looks up id 0.
 */
const ID = '(0|[1-9]\\d{0,14})';
const SIGNED_RE = new RegExp(`^c${ID}r${ID}s([a-z2-7]+)$`);
const LEGACY_RE = new RegExp(`^c${ID}r${ID}$`);

/**
 * Reads a MailboxHash. `signed` = the signature checks out; `legacy` = the older unsigned form
 * (the caller decides how far to trust it); `none` = no tag, a tag with a non-canonical id
 * (leading zeros, more than 15 digits) or a tag whose signature fails.
 */
export async function readReplyTag(secret: string, hash: string | null | undefined): Promise<ReplyTag> {
	const h = String(hash ?? '').trim().toLowerCase();
	if (!h || h.length > MAX_LOCAL_PART) return { kind: 'none' };
	const signed = SIGNED_RE.exec(h);
	if (signed) {
		if (!secret || signed[3].length !== SIG_CHARS) return { kind: 'none' };
		const campaignId = Number(signed[1]);
		const contactId = Number(signed[2]);
		const expected = await sigFor(secret, campaignId, contactId);
		const enc = new TextEncoder();
		if (!timingSafeEqual(enc.encode(signed[3]), enc.encode(expected))) return { kind: 'none' };
		return { kind: 'signed', campaignId, contactId };
	}
	const legacy = LEGACY_RE.exec(h);
	if (legacy) return { kind: 'legacy', campaignId: Number(legacy[1]), contactId: Number(legacy[2]) };
	return { kind: 'none' };
}
