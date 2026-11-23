// Assistant evals (#391): build a case's fixture on the freshly-restored eval D1. A fixture is
// declarative JSON (evals/fixtures.json + the case's own additions, merged by resolveFixture)
// and goes through the same server helpers the app and the tests use (syncCompanyMembership,
// addToPipeline, createSkill, saveAssistantConfig), plus raw `sql` for anything else.
// Every record can carry a `ref`; refs ("contact.dana", "list.newsletter", "stage.proposal", …)
// resolve "$ref:…" in cases, graders and recordings. Fake data only (see the hygiene test).

import { saveAssistantConfig } from '../../src/lib/server/ai/config';
import { createSkill } from '../../src/lib/server/ai/skills';
import { syncCompanyMembership } from '../../src/lib/server/companies';
import { addToPipeline, listStages } from '../../src/lib/server/pipeline';
import { resolveRefs } from '../../scripts/assistant-evals-lib.mjs';

type Row = Record<string, any>;
export type Fixture = {
	settings?: Row;
	app_state?: Record<string, string>;
	lists?: Row[];
	companies?: Row[];
	contacts?: Row[];
	campaigns?: Row[];
	replies?: Row[];
	automations?: Row[];
	pipeline?: Row[];
	skills?: Row[];
	disable_skills?: string[];
	sql?: string[];
};
export type Built = { refs: Record<string, number>; adminId: number; memberId: number };

const METRIC_COLS = new Set([
	'hours_7d', 'hours_30d', 'hours_90d', 'hours_total', 'last_tracked_at', 'issues_open', 'issues_closed_30d',
	'ar_outstanding', 'ar_overdue', 'invoiced_12m', 'paid_12m', 'last_payment_at', 'last_invoice_at', 'billing_currency'
]);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ago = (days: unknown) => `-${Number(days) || 0} days`;

async function idOf(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

export async function buildFixture(db: D1Database, fx: Fixture, settings: Row = {}): Promise<Built> {
	const refs: Record<string, number> = {};
	const adminId = await idOf(db, `INSERT INTO users (github_login, name, role) VALUES ('eval-admin', 'Eval Admin', 'admin') RETURNING id`);
	const memberId = await idOf(db, `INSERT INTO users (github_login, name, role) VALUES ('eval-member', 'Eval Member', 'member') RETURNING id`);
	refs['user.admin'] = adminId;
	refs['user.member'] = memberId;
	await saveAssistantConfig(db, { access: 'everyone', ...(fx.settings ?? {}), ...settings });
	for (const [k, v] of Object.entries(fx.app_state ?? {})) {
		await db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').bind(k, v).run();
	}
	for (const s of await listStages(db)) refs[`stage.${slug(s.name)}`] = s.id;

	const groups = new Map<string, number>();
	const group = async (name: string, kind: string, extra: Row = {}): Promise<number> => {
		const key = `${kind}:${name.toLowerCase()}`;
		const known = groups.get(key);
		if (known) return known;
		const id = await idOf(
			db,
			`INSERT INTO lists (name, kind, rules, public_topic) VALUES (?, ?, ?, ?) RETURNING id`,
			name,
			kind,
			extra.rules ? JSON.stringify(extra.rules) : null,
			extra.public_topic ? 1 : 0
		);
		groups.set(key, id);
		refs[`${kind}.${extra.ref ?? slug(name)}`] = id;
		if (kind !== 'list') refs[`list.${extra.ref ?? slug(name)}`] ??= id; // group tools take any kind's id
		return id;
	};
	for (const l of fx.lists ?? []) await group(l.name, l.kind ?? 'list', l);

	for (const c of fx.companies ?? []) {
		const id = await idOf(db, `INSERT INTO companies (name, domain, website, notes) VALUES (?, ?, ?, ?) RETURNING id`, c.name, c.domain ?? null, c.website ?? null, c.notes ?? null);
		refs[`company.${c.ref ?? slug(c.name)}`] = id;
		const metrics = Object.entries(c.metrics ?? {}).filter(([k]) => METRIC_COLS.has(k));
		if (metrics.length) {
			await db
				.prepare(`INSERT INTO company_metrics (company_id, ${metrics.map(([k]) => k).join(', ')}) VALUES (?, ${metrics.map(() => '?').join(', ')})`)
				.bind(id, ...metrics.map(([, v]) => v))
				.run();
		}
	}

	for (const c of fx.contacts ?? []) {
		const id = await idOf(
			db,
			`INSERT INTO contacts (email, name, first_name, last_name, subscribed, source, meta, archived_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END, datetime('now', ?)) RETURNING id`,
			c.email,
			c.name ?? null,
			c.first_name ?? null,
			c.last_name ?? null,
			c.subscribed === false || c.subscribed === 0 ? 0 : 1,
			c.source ?? 'csv',
			c.meta ? JSON.stringify(c.meta) : null,
			c.archived ? 1 : 0,
			ago(c.created_days_ago ?? 30)
		);
		refs[`contact.${c.ref ?? slug(c.email.split('@')[0])}`] = id;
		if (c.company) {
			await db.prepare('UPDATE contacts SET company = ? WHERE id = ?').bind(c.company, id).run();
			await syncCompanyMembership(db, id, c.company, { enroll: false });
		}
		for (const t of c.tags ?? []) await db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(await group(t, 'tag'), id).run();
		for (const l of c.lists ?? []) await db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(await group(l, 'list'), id).run();
	}

	for (const cp of fx.campaigns ?? []) {
		const status = cp.status ?? 'sent';
		const recips: Row[] = cp.recipients ?? [];
		const id = await idOf(
			db,
			`INSERT INTO campaigns (subject, preheader, body_md, body_html, body_text, from_email, status, sent_at, scheduled_at, list_id, recipient_count, created_at)
			 VALUES (?, ?, ?, ?, ?, 'news@example.com', ?, CASE WHEN ? = 'sent' THEN datetime('now', ?) END,
			         CASE WHEN ? = 'scheduled' THEN datetime('now', '+2 days') END, ?, ?, datetime('now', ?)) RETURNING id`,
			cp.subject,
			cp.preheader ?? null,
			cp.body_md ?? 'Hello {{first_name}},\n\nNews from us.',
			`<p>${cp.body_md ?? 'News from us.'}</p>`,
			cp.body_md ?? 'News from us.',
			status,
			status,
			ago(cp.sent_days_ago ?? 3),
			status,
			cp.list ? await group(cp.list, 'list') : null,
			status === 'sent' ? recips.length : 0,
			ago((cp.sent_days_ago ?? 3) + 1)
		);
		refs[`campaign.${cp.ref ?? slug(cp.subject)}`] = id;
		let n = 0;
		for (const r of recips) {
			n += 1;
			const contactId = refs[`contact.${r.contact}`];
			if (!contactId) throw new Error(`campaign ${cp.subject}: unknown contact ref ${r.contact}`);
			const email = (await db.prepare('SELECT email FROM contacts WHERE id = ?').bind(contactId).first<{ email: string }>())!.email;
			const msg = `eval-${id}-${n}`;
			const rid = await idOf(db, `INSERT INTO recipients (campaign_id, contact_id, email, status, message_id) VALUES (?, ?, ?, 'accepted', ?) RETURNING id`, id, contactId, email, msg);
			const ev = async (type: string, detail: Row) =>
				db
					.prepare(`INSERT INTO events (campaign_id, recipient_id, contact_id, type, message_id, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?, '+1 hour'))`)
					.bind(id, rid, contactId, type, msg, JSON.stringify(detail), ago(cp.sent_days_ago ?? 3))
					.run();
			await ev('delivery', {});
			if (r.opened || r.clicked) await ev('open', { FirstOpen: true, UserAgent: 'Mozilla/5.0 (Windows NT 10.0) Thunderbird/128.0' });
			if (r.clicked) await ev('click', { OriginalLink: 'https://www.example.com/pricing' });
			if (r.bounced) await ev('bounce', { Type: 'HardBounce' });
		}
	}

	for (const r of fx.replies ?? []) {
		const contactId = refs[`contact.${r.contact}`];
		const email = (await db.prepare('SELECT email FROM contacts WHERE id = ?').bind(contactId).first<{ email: string }>())!.email;
		await db
			.prepare(`INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, received_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))`)
			.bind(contactId, r.campaign ? refs[`campaign.${r.campaign}`] : null, email, r.subject ?? 'Re: hello', r.text, ago(r.days_ago ?? 1))
			.run();
	}

	for (const a of fx.automations ?? []) {
		const id = await idOf(db, `INSERT INTO automations (name, status, trigger_type) VALUES (?, ?, 'manual') RETURNING id`, a.name, a.status ?? 'active');
		refs[`automation.${a.ref ?? slug(a.name)}`] = id;
		let first: number | null = null;
		let pos = 0;
		for (const s of a.steps ?? [{ subject: 'Welcome', body_md: 'Hello' }]) {
			pos += 1;
			const sid = await idOf(
				db,
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type) VALUES (?, ?, ?, ?, ?, 'news@example.com', 'email') RETURNING id`,
				id,
				pos,
				s.wait_seconds ?? 86400,
				s.subject,
				s.body_md ?? 'Hello'
			);
			first ??= sid;
		}
		for (const ref of a.enrolled ?? []) {
			await db
				.prepare(`INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, status, next_run_at) VALUES (?, ?, ?, 'active', datetime('now', '+1 day'))`)
				.bind(id, refs[`contact.${ref}`], first)
				.run();
		}
	}

	for (const p of fx.pipeline ?? []) {
		const stageId = refs[`stage.${slug(p.stage)}`];
		if (!stageId) throw new Error(`pipeline: unknown stage ${p.stage}`);
		const r = await addToPipeline(db, refs[`contact.${p.contact}`], stageId, { kind: 'user', id: adminId }, { value: p.value ?? null, note: p.note ?? null }, { triggers: false });
		if (!r.ok) throw new Error(`pipeline: ${r.error}`);
	}

	for (const s of fx.skills ?? []) {
		const r = await createSkill(db, { name: s.name, description: s.description, body: s.body, mode: s.mode ?? 'on_demand', enabled: s.enabled !== false }, adminId);
		if (!r.ok) throw new Error(`skill ${s.name}: ${r.error}`);
	}
	for (const name of fx.disable_skills ?? []) await db.prepare('UPDATE ai_skills SET enabled = 0 WHERE name = ?').bind(name).run();

	for (const sql of fx.sql ?? []) await db.prepare(resolveRefs(sql, refs)).run();
	return { refs, adminId, memberId };
}
