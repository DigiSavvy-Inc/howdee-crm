import { describe, it, expect } from 'vitest';

// #287 structural no-send test (hard rule 1 of #71): the assistant cannot send, schedule or
// enroll because the capability is not wired in at all. Fails if any file under
// src/lib/server/ai/ imports send.ts, postmark.ts, scheduled.ts, resend.ts, the automation
// engine (automations.ts — home of enroll / enrollContactsInAutomation / tick), or names an
// enroll* / processScheduled* function. Sources are bundled at build time (no fs in workerd).

const all = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const aiFiles = Object.keys(all).filter((f) => f.startsWith('../src/lib/server/ai/'));

// Function names that enroll, send or schedule (readers like enrollmentCounts are fine).
const ENROLL_OR_SEND = /\b(enroll|enrollContacts\w*|autoEnroll\w*|addTagAndEnroll|processScheduled\w*|sendCampaignEmail|sendBatch|tick)\b/;
const BANNED_MODULES = ['send', 'postmark', 'scheduled', 'resend', 'automations', 'best-time', 'conversation-reply'];

function importSpecs(text: string): { spec: string; names: string }[] {
	const out: { spec: string; names: string }[] = [];
	for (const m of text.matchAll(/(?:import|export)\s([^;]*?)\sfrom\s+['"]([^'"]+)['"]/g)) out.push({ names: m[1], spec: m[2] });
	for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ names: '', spec: m[1] });
	return out;
}

/** The module a spec points at, as a path under src/lib/server ('' when elsewhere). */
function serverModule(from: string, spec: string): string {
	let path: string;
	if (spec.startsWith('$lib/')) path = `../src/lib/${spec.slice(5)}`;
	else if (spec.startsWith('.')) {
		const parts = from.split('/').slice(0, -1);
		for (const seg of spec.split('/')) {
			if (seg === '..') parts.pop();
			else if (seg !== '.') parts.push(seg);
		}
		path = parts.join('/');
	} else return '';
	path = path.replace(/\.ts$/, '');
	return path.startsWith('../src/lib/server/') ? path.slice('../src/lib/server/'.length) : '';
}

describe('structural: the assistant cannot send, schedule or enroll', () => {
	it('finds the assistant modules', () => {
		expect(aiFiles).toContain('../src/lib/server/ai/loop.ts');
		expect(aiFiles).toContain('../src/lib/server/ai/tools/index.ts');
		expect(aiFiles.length).toBeGreaterThanOrEqual(15);
	});

	it('no file under src/lib/server/ai/ imports a sending, scheduling or enrolling module', () => {
		const offenders: string[] = [];
		for (const f of aiFiles) {
			for (const { spec, names } of importSpecs(all[f])) {
				const mod = serverModule(f, spec);
				if (BANNED_MODULES.includes(mod)) offenders.push(`${f} imports ${spec}`);
				if (ENROLL_OR_SEND.test(names)) {
					offenders.push(`${f} imports { ${names.trim()} }`);
				}
			}
			if (/\b(processScheduled\w*|enrollContactsInAutomation|sendCampaignEmail|sendBatch)\s*\(/.test(all[f])) offenders.push(`${f} calls a send/enroll function`);
		}
		expect(offenders).toEqual([]);
	});

	// #301: the write tools import write modules (contact-bulk, contact-write, companies,
	// pipeline, groups-bulk) — never the enroll parts of them, and every call to a helper that
	// would enroll passes the opt-out. #322 (a #71 rule change, 2026-10-17) allows exactly the
	// bulk bar's unsubscribe / resubscribe / archive / restore / delete helpers, from
	// contact-bulk only; every other delete, direct Postmark suppression and enrolling stays out.
	const CONTACT_STATUS_HELPERS = ['bulkUnsubscribe', 'bulkResubscribe', 'bulkArchive', 'bulkRestore', 'bulkDelete'];

	it('no assistant file imports an enroll function or any delete other than the contact bulk delete', () => {
		const BANNED_NAMES = /\b(subscriptionChanged|fireSubscriptionTriggers|saveTopicChoicesAndFire|deleteDraft|unsubscribeIds|(?!suppressedTotal\b)suppress\w*|deleteContactsByIds|deleteCompany|deleteGroups|deleteStage|archiveContacts|restoreContacts|restoreIfArchived|bulkEnroll|runBulk|runBulkForm|mergeGroups|emptyGroup|addTag|addToList|unsubscribe\w*)\b/;
		// #309: campaign-drafts is allowed (its constants + composeUrl); its deleteDraft is not.
		const MORE_MODULES = ['contacts', 'contact-archive', 'unsubscribe', 'suppression-sync', 'automation-bulk', 'pipeline-form'];
		const offenders: string[] = [];
		for (const f of aiFiles) {
			for (const { spec, names } of importSpecs(all[f])) {
				if (MORE_MODULES.includes(serverModule(f, spec))) offenders.push(`${f} imports ${spec}`);
				if (BANNED_NAMES.test(names)) offenders.push(`${f} imports { ${names.trim()} }`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('#322: the contact-status helpers come only from contact-bulk, only into the contact-manage tools', () => {
		const users: string[] = [];
		const offenders: string[] = [];
		for (const f of aiFiles) {
			for (const { spec, names } of importSpecs(all[f])) {
				const used = CONTACT_STATUS_HELPERS.filter((h) => new RegExp(`\\b${h}\\b`).test(names));
				if (!used.length) continue;
				users.push(f);
				if (serverModule(f, spec) !== 'contact-bulk') offenders.push(`${f} imports ${used.join(', ')} from ${spec}`);
				if (f !== '../src/lib/server/ai/tools/write-contact-manage.ts') offenders.push(`${f} imports ${used.join(', ')}`);
			}
		}
		expect(offenders).toEqual([]);
		expect(users).toContain('../src/lib/server/ai/tools/write-contact-manage.ts'); // not vacuous
		// Unsubscribe never suppresses in Postmark unless the user asked: the flag comes only
		// from the tool input, default false.
		const manage = all['../src/lib/server/ai/tools/write-contact-manage.ts'];
		expect(manage).toMatch(/also_suppress_in_postmark === true/);
		expect(manage).not.toMatch(/suppress:\s*true/);
	});

	it('every enrolling write helper the assistant calls gets enroll: false / triggers: false', () => {
		const OPT_OUT: Record<string, RegExp> = {
			bulkAddTag: /enroll:\s*false/,
			bulkAddToGroup: /enroll:\s*false/,
			applyContactFields: /enroll:\s*false/,
			syncCompanyMembership: /enroll:\s*false/,
			updateCompany: /enroll:\s*false/,
			addToPipeline: /triggers:\s*false/,
			moveCard: /triggers:\s*false/,
			// #551: these fire the "Subscription changes" trigger (subscriptionChanged → enroll).
			bulkUnsubscribe: /triggers:\s*false/,
			bulkResubscribe: /triggers:\s*false/
		};
		const calls: string[] = [];
		const offenders: string[] = [];
		for (const f of aiFiles) {
			const text = all[f].replace(/^\s*import[^;]*;/gm, '');
			for (const [fn, opt] of Object.entries(OPT_OUT)) {
				for (const m of text.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))) {
					// The call's text up to its matching ')'.
					let depth = 0;
					let end = m.index! + fn.length;
					for (; end < text.length; end++) {
						if (text[end] === '(') depth++;
						else if (text[end] === ')' && --depth === 0) break;
					}
					const call = text.slice(m.index!, end + 1);
					calls.push(fn);
					if (!opt.test(call)) offenders.push(`${f}: ${call.slice(0, 120)}`);
				}
			}
		}
		expect(offenders).toEqual([]);
		// The write tools really do call them (so this check isn't vacuous).
		for (const fn of ['bulkAddTag', 'bulkAddToGroup', 'applyContactFields', 'updateCompany', 'addToPipeline', 'moveCard', 'bulkUnsubscribe', 'bulkResubscribe']) {
			expect(calls).toContain(fn);
		}
	});

	// #551: the write tools reach enrolling code transitively (contact-bulk → automations, …),
	// because the shared write helpers enroll for the bulk bar / API. Every such edge — a server
	// module the assistant's import graph reaches that imports the engine or an enroll function —
	// must be on this reviewed list, with the opt-out that keeps the assistant's calls from
	// enrolling (checked above). A new path to enroll fails until it is reviewed and gated.
	const ENROLL_GATEWAYS: Record<string, string> = {
		'contact-bulk -> automations': 'bulk adds take enroll: false; enrollContactsInAutomation is never imported by ai/',
		'contacts -> automations': 'addTag / autoEnroll reached only through contact-bulk / contact-write with enroll: false',
		'contact-write -> contacts': 'applyContactFields / applyMemberships take enroll: false',
		'companies -> automations': 'syncCompanyMembership / updateCompany take enroll: false',
		'pipeline-trigger -> automations': 'addToPipeline / moveCard take triggers: false',
		'subscription-trigger -> automations': 'bulkUnsubscribe / bulkResubscribe take triggers: false (#551)',
		'hygiene -> automations': 'checkAddress only; the tagging helper is not imported by ai/',
	};
	const ENROLLING_NAMES = /\b(enroll|enrollContacts\w*|enrollFromList|enrollPending\w*|autoEnroll\w*|addTagAndEnroll|fireSubscriptionTriggers)\b/;

	function enrollGateways(entries: string[]): Set<string> {
		const seen = new Set<string>();
		const found = new Set<string>();
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const { spec, names } of importSpecs(all[file] ?? '')) {
				if (/^type\s/.test(names.trim())) continue;
				const mod = serverModule(file, spec);
				if (!mod) continue;
				const from = file.replace('../src/lib/server/', '').replace(/\.ts$/, '');
				if (!from.startsWith('ai/') && (mod === 'automations' || ENROLLING_NAMES.test(names))) found.add(`${from} -> ${mod}`);
				const next = `../src/lib/server/${mod}.ts`;
				if (all[next]) walk(next);
				else if (all[`../src/lib/server/${mod}/index.ts`]) walk(`../src/lib/server/${mod}/index.ts`);
			}
		};
		entries.forEach(walk);
		return found;
	}

	it('#551: every transitive path from an assistant module to enrolling code is a reviewed, gated gateway', () => {
		const found = enrollGateways(aiFiles);
		const unreviewed = [...found].filter((g) => !(g in ENROLL_GATEWAYS));
		expect(unreviewed).toEqual([]);
		expect(found.has('subscription-trigger -> automations')).toBe(true); // the walk is not vacuous
	});

	it('#551: the gateway check catches a new transitive path (sanity)', () => {
		const fake = '../src/lib/server/ai/tools/__fake.ts';
		const helper = '../src/lib/server/__fake-helper.ts';
		all[fake] = "import { doThing } from '../../__fake-helper';";
		all[helper] = "import { enroll } from './automations';\nexport const doThing = () => enroll;";
		try {
			const found = enrollGateways([fake]);
			expect(found.has('__fake-helper -> automations')).toBe(true);
			expect('__fake-helper -> automations' in ENROLL_GATEWAYS).toBe(false);
		} finally {
			delete all[fake];
			delete all[helper];
		}
	});

	// #309: the drafting tools — no send, test send, schedule, activate or enroll, not even
	// transitively: walk every server module they import (and what those import).
	it('the drafting modules reach no sending, scheduling or enrolling module, even transitively', () => {
		const entries = ['../src/lib/server/ai/tools/write-campaigns.ts', '../src/lib/server/ai/tools/write-automations.ts', '../src/lib/server/ai/tools/draft-body.ts'];
		for (const f of entries) expect(Object.keys(all)).toContain(f);
		const seen = new Set<string>();
		const offenders: string[] = [];
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const { spec, names } of importSpecs(all[file] ?? '')) {
				if (/^import\s+type\b/.test(names) || /^type\s/.test(names.trim())) continue;
				const mod = serverModule(file, spec);
				if (!mod) continue;
				if (BANNED_MODULES.includes(mod) || ['automation-bulk', 'scheduled', 'snapshot-jobs'].includes(mod)) offenders.push(`${file} → ${mod}`);
				if (ENROLL_OR_SEND.test(names)) offenders.push(`${file} imports { ${names.trim()} }`);
				const next = `../src/lib/server/${mod}.ts`;
				if (all[next]) walk(next);
				else if (all[`../src/lib/server/${mod}/index.ts`]) walk(`../src/lib/server/${mod}/index.ts`);
			}
		};
		entries.forEach(walk);
		expect(offenders).toEqual([]);
		expect(seen.has('../src/lib/server/campaign-drafts.ts')).toBe(true); // the walk is not vacuous
	});

	it('campaign drafting writes drafts only; automation drafting never changes a status or enrolls', () => {
		const camp = all['../src/lib/server/ai/tools/write-campaigns.ts'];
		const auto = all['../src/lib/server/ai/tools/write-automations.ts'];
		// Every campaign UPDATE / DELETE is guarded by status = 'draft'; no status is ever set;
		// inserts are drafts; nothing writes recipients.
		const updates = [...camp.matchAll(/(UPDATE campaigns[\s\S]*?|DELETE FROM campaigns[\s\S]*?)(`)/g)].map((m) => m[1]);
		expect(updates.length).toBeGreaterThanOrEqual(2);
		for (const u of updates) expect(u).toMatch(/status = 'draft'/);
		expect(camp).not.toMatch(/SET\s+status\b|,\s*status\s*=/);
		for (const m of camp.matchAll(/INSERT INTO campaigns[\s\S]*?`/g)) expect(m[0]).toMatch(/'draft'/);
		expect(camp + auto).not.toMatch(/INSERT INTO (recipients|automation_enrollments)|UPDATE automation_enrollments/);
		// Automations: the only status written is the INSERT of a 'draft'; no UPDATE of automations at all.
		expect(auto).not.toMatch(/UPDATE automations\b/);
		for (const m of auto.matchAll(/INSERT INTO automations\b[\s\S]*?`/g)) expect(m[0]).toMatch(/'draft'/);
	});

	it('the checker does catch a banned import (sanity)', () => {
		const fake = "import { enroll } from '../automations';\nimport { sendBatch } from '$lib/server/postmark';";
		const found = importSpecs(fake).map((s) => serverModule('../src/lib/server/ai/x.ts', s.spec));
		expect(found).toEqual(['automations', 'postmark']);
		expect(ENROLL_OR_SEND.test(importSpecs(fake)[0].names)).toBe(true);
		// #322: still caught next to the newly allowed helpers.
		const mixed = "import { bulkUnsubscribe, bulkEnroll } from '../../contact-bulk';\nimport { processScheduledCampaigns } from '../../scheduled';";
		const specs = importSpecs(mixed);
		expect(specs.map((s) => serverModule('../src/lib/server/ai/tools/x.ts', s.spec))).toEqual(['contact-bulk', 'scheduled']);
		expect(BANNED_MODULES).toContain('scheduled');
		expect(/\bbulkEnroll\b/.test(specs[0].names)).toBe(true);
		expect(ENROLL_OR_SEND.test(specs[1].names)).toBe(true);
	});
});
