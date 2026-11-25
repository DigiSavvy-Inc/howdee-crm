import { emailDocument } from './email';
import { personalize, fillRecipientTemplates } from './email';
import { signUnsub } from './token';
import { buildCondCtx, hasConditionals } from '$lib/conditionals';
import { RECIPIENT_COLS } from './segments';
import { hasCompanyTags } from '$lib/merge-tags';
import { companyMergeFields } from './company-metrics';
import { containsSql } from './sql-match';

export type RenderedEmail = {
	subject: string;
	html: string;
	text: string;
	recipient: { id: number; email: string; contact_id: number | null; name: string | null } | null;
};

type CampaignRow = {
	subject: string;
	body_html: string;
	body_text: string | null;
	from_email: string;
	status: string;
};

type RecipientRow = { id: number; email: string; contact_id: number | null };

type ContactRow = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	company: string | null;
	meta: string | null;
	tags: string | null;
};

/**
 * Render a campaign's email exactly as a given recipient received it (or, with
 * `recipientId: null`, the template as authored — no-name fallback, inert unsubscribe
 * link). Mirrors sendCampaignEmail (src/lib/server/send.ts) — do not diverge. If the
 * send path's personalization pipeline changes, update this function too.
 */
export async function renderForRecipient(
	db: D1Database,
	opts: { campaignId: number; recipientId: number | null; secret: string; baseUrl: string }
): Promise<RenderedEmail | null> {
	const { campaignId, recipientId, secret, baseUrl } = opts;

	const campaign = await db
		.prepare(`SELECT subject, body_html, body_text, from_email, status FROM campaigns WHERE id = ?`)
		.bind(campaignId)
		.first<CampaignRow>();
	if (!campaign) return null;

	if (recipientId === null) {
		return {
			subject: campaign.subject,
			html: personalize(asDocument(campaign.body_html), '#', { email: 'subscriber@example.com' }, { mode: 'html' }),
			text: personalize(campaign.body_text ?? '', '#', { email: 'subscriber@example.com' }),
			recipient: null
		};
	}

	const recipientRow = await db
		.prepare(`SELECT id, email, contact_id FROM recipients WHERE id = ? AND campaign_id = ?`)
		.bind(recipientId, campaignId)
		.first<RecipientRow>();
	if (!recipientRow) return null;

	let contact: ContactRow | null = null;
	if (recipientRow.contact_id !== null) {
		contact = await db
			.prepare(`SELECT ${RECIPIENT_COLS} FROM contacts c WHERE c.id = ?`)
			.bind(recipientRow.contact_id)
			.first<ContactRow>();
	}

	const r = {
		id: recipientRow.contact_id,
		email: recipientRow.email,
		name: contact?.name ?? null,
		first_name: contact?.first_name ?? null,
		last_name: contact?.last_name ?? null,
		company: contact?.company ?? null,
		tags: contact?.tags ?? null,
		meta: contact?.meta ?? null,
		companyFields:
			usesCompanyTags(campaign) && recipientRow.contact_id !== null
				? ((await companyMergeFields(db, [recipientRow.contact_id])).get(recipientRow.contact_id) ?? null)
				: null
	};

	const unsubUrl = `${baseUrl}/unsubscribe?t=${encodeURIComponent(
		await signUnsub(secret, { c: campaignId, k: r.id, e: r.email })
	)}`;

	const conditional =
		hasConditionals(campaign.body_html) ||
		hasConditionals(campaign.body_text ?? '') ||
		hasConditionals(campaign.subject);
	const ctx = conditional ? buildCondCtx(r.tags, r.meta) : null;

	const filled = fillRecipientTemplates(
		{ subject: campaign.subject, html: asDocument(campaign.body_html), text: campaign.body_text ?? '' },
		unsubUrl,
		r,
		ctx
	);

	return {
		...filled,
		recipient: {
			id: recipientRow.id,
			email: recipientRow.email,
			contact_id: recipientRow.contact_id,
			name: displayName(contact)
		}
	};
}

/** #170: {{company.*}} render with the company's CURRENT values (they aren't stored per send). */
function usesCompanyTags(c: CampaignRow): boolean {
	return hasCompanyTags(c.subject) || hasCompanyTags(c.body_html) || hasCompanyTags(c.body_text ?? '');
}

/** Legacy/operator bodies stored as bare fragments (no <html>) get the app's email styles. */
function asDocument(html: string): string {
	return /<html[\s>]/i.test(html) ? html : emailDocument(html);
}

/** Display name for "Viewing as" (#155): `name`, else first + last, else null. */
function displayName(c: { name: string | null; first_name: string | null; last_name: string | null } | null): string | null {
	if (!c) return null;
	const full = c.name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
	return full || null;
}

export type PreviewTarget = { recipientId: number | null; notice: string | null };

/**
 * #155: resolve the View email deep-link params to a recipient row of this campaign.
 * `as` (a recipient id, or 'template') wins over `as_contact` (a contact id — their most
 * recent accepted row, else their most recent row). No param → the template as authored.
 * Anything that doesn't resolve also falls back to the template, with a notice (not a 404).
 */
export async function resolvePreviewTarget(
	db: D1Database,
	campaignId: number,
	params: { as: string | null; asContact: string | null }
): Promise<PreviewTarget> {
	const { as, asContact } = params;
	if (as === 'template') return { recipientId: null, notice: null };
	if (as) {
		const n = Number(as);
		if (Number.isInteger(n) && n > 0) {
			const row = await db
				.prepare(`SELECT id FROM recipients WHERE id = ? AND campaign_id = ?`)
				.bind(n, campaignId)
				.first<{ id: number }>();
			if (row) return { recipientId: row.id, notice: null };
		}
		return { recipientId: null, notice: "That recipient isn't on this campaign — showing the template as authored." };
	}
	if (asContact) {
		const n = Number(asContact);
		if (Number.isInteger(n) && n > 0) {
			const row = await db
				.prepare(
					`SELECT id FROM recipients WHERE campaign_id = ? AND contact_id = ?
					 ORDER BY (status = 'accepted') DESC, id DESC LIMIT 1`
				)
				.bind(campaignId, n)
				.first<{ id: number }>();
			if (row) return { recipientId: row.id, notice: null };
		}
		return { recipientId: null, notice: "That contact didn't receive this campaign — showing the template as authored." };
	}
	return { recipientId: null, notice: null };
}

export type RecipientMatch = { id: number; email: string; name: string | null; contact_id: number | null };

/**
 * #155: "Viewing as" search — this campaign's recipients whose email or contact name
 * contains `q` (`%` / `_` literal; instr, not LIKE — #485). One row per email (its latest
 * recipient row, so a resend doesn't list the same person twice). Callers enforce the 2-char
 * minimum.
 */
export async function searchCampaignRecipients(
	db: D1Database,
	campaignId: number,
	q: string,
	limit = 10
): Promise<RecipientMatch[]> {
	const text = q.trim();
	const fields = ['r.email', 'c.name', "TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))"];
	const where = fields.map((f) => containsSql(f)).join(' OR ');
	const rows = await db
		.prepare(
			`SELECT MAX(r.id) AS id, r.email AS email, r.contact_id AS contact_id,
			        COALESCE(NULLIF(TRIM(c.name), ''),
			                 NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '')) AS name
			 FROM recipients r
			 LEFT JOIN contacts c ON c.id = r.contact_id
			 WHERE r.campaign_id = ? AND (${where})
			 GROUP BY r.email
			 ORDER BY r.email COLLATE NOCASE
			 LIMIT ?`
		)
		.bind(campaignId, ...fields.map(() => text), limit)
		.all<RecipientMatch>();
	return rows.results;
}
