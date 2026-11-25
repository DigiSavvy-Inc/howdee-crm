<script lang="ts">
	import type { IconName } from '$lib/icons/glyphs';
	import Icon from '$lib/components/Icon.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { deserialize, enhance } from '$app/forms';
	import { noImplicitSubmit } from '$lib/no-implicit-submit';
	import { beforeNavigate, goto, invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick, untrack } from 'svelte';
	import PreSendChecks from '$lib/components/PreSendChecks.svelte';
	// #398: A/B tests, pre-activation checks on every email, simulate a contact.
	import StepAbTest from '$lib/components/automations/StepAbTest.svelte';
	import AutomationChecks from '$lib/components/automations/AutomationChecks.svelte';
	import SimulateContact from '$lib/components/automations/SimulateContact.svelte';
	import { senderAllowed, senderOptions } from '$lib/approved-senders';
	import {
		LEAVE_MESSAGE,
		UNDO_MS,
		deleteMessage,
		fingerprint,
		isDirty,
		mayClose,
		reorderLane,
		splitWait,
		statusLine,
		statusTone as statusToneOf,
		waitNodeText
	} from '$lib/automation-editor';
	import { TRIGGER_TYPES, reentryText, triggerIcon, triggerText } from '$lib/automation-trigger';
	import TriggerTypePicker from '$lib/components/automations/TriggerTypePicker.svelte';
	import {
		ZOOM_MAX,
		ZOOM_MIN,
		ZOOM_PRESETS,
		clampPan,
		fitView,
		initialView,
		openSavedView,
		parseStoredView,
		serializeView,
		stepZoom,
		wheelZoomFactor,
		zoomAt,
		zoomLabel,
		type View
	} from '$lib/canvas-zoom';
	import { LAYOUT, forkPath, layoutFlow, treeFromSteps } from '$lib/canvas-layout';
	import BlockEditor from '@digisavvy/block-editor';
	import { uploadMedia } from '$lib/editor-host';
	import { editorActions, editorSlashActions } from '$lib/editor-host';
	import { editorLogos, editorSwatches } from '$lib/brand-kit';
	import type { Block } from '$lib/blocks';
	import { markdownToBlocks } from '$lib/blocks-markdown';
	import Modal from '$lib/components/Modal.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import RuleBuilder from '$lib/components/RuleBuilder.svelte';
	import EngagementTriggerFields from '$lib/components/automations/EngagementTriggerFields.svelte';
	import SiteActivityTriggerFields from '$lib/components/automations/SiteActivityTriggerFields.svelte';
	import { defaultSiteActivityConfig, parseSiteActivityConfig } from '$lib/site-activity-trigger';
	import SubscriptionTriggerFields from '$lib/components/automations/SubscriptionTriggerFields.svelte';
	import ScoreTriggerFields from '$lib/components/automations/ScoreTriggerFields.svelte';
	import FormTriggerFields from '$lib/components/automations/FormTriggerFields.svelte';
	import { parseFormTriggerConfig } from '$lib/form-trigger';
	import { adjustScoreTitle, parseAdjustScore, parseScoreTriggerConfig } from '$lib/score-trigger';
	import { SCORE_LIMITS } from '$lib/scoring';
	import { defaultSubscriptionConfig, parseSubscriptionConfig } from '$lib/subscription-trigger';
	import EntryConditions from '$lib/components/automations/EntryConditions.svelte';
	import SearchSelect from '$lib/components/SearchSelect.svelte';
	import { groupOptionsFromLists } from '$lib/search-select';
	import { defaultEngagementConfig, isEngagementKind, parseEngagementConfig } from '$lib/engagement-trigger';
	import { legacyGateToRules, parseGateRules, ruleSetProblem, type ConditionRuleSet } from '$lib/condition-rules';
	import {
		actionDecisionLabel,
		conditionLabel as ruleSetLabel,
		conditionTitle as ruleSetTitle,
		enrollmentErrorText,
		numberedStepTitle,
		pipelineActionTitle,
		stepNumbers,
		stepShortTitle,
		tierActionTitle,
		waitRulesText
	} from '$lib/automation-action-labels';
	import { TIERS, TIER_LABELS } from '$lib/engagement-view';
	import { TIER_OVERRIDE_DAYS_MAX } from '$lib/tier-override';
	import {
		BILLING_HIDDEN_LABEL,
		TRIGGER_METRICS,
		conditionLabel,
		decodeCondition,
		groupMetrics,
		isBillingMetric,
		triggerLabel,
		visibleMetrics
	} from '$lib/company-metrics';
	import { DEFAULT_COOLDOWN_HOURS, PATH_OPS, decodeVisited, siteTriggerLabel, visitedLabel } from '$lib/site-trigger';
	import {
		NO_PREVIOUS_EMAIL,
		WAIT_DAYS,
		WAIT_DELAY_DEFAULT,
		WAIT_KIND_CHOICES,
		WAIT_LANE_LABELS,
		WAIT_TIMEOUT_DEFAULT,
		completedReasonText,
		delayText,
		exitRuleText,
		parseWait,
		previousEmailStep,
		splitDelay,
		stepHasLanes,
		timelineText,
		waitModeHasLanes,
		waitText,
		waitingText,
		type ExitRule,
		type WaitMode
	} from '$lib/automation-flow';
	let { data, form } = $props();

	let enrollOpen = $state(false);

	// --- "or specific contacts" picker (#98): a typeahead chip-picker, same search
	// endpoint + keyboard handling as compose's 1:1 "To" field. Unsubscribed results
	// are shown but not pickable — enrollContactsInAutomation would just skip them,
	// but surfacing it up front avoids a confusing 0-enrolled result.
	type ContactHit = {
		id: number;
		email: string;
		name: string | null;
		first_name: string | null;
		last_name: string | null;
		subscribed: number;
	};
	let pickQuery = $state('');
	let pickResults = $state<ContactHit[]>([]);
	let showPickResults = $state(false);
	let pickActiveIdx = $state(-1);
	let pickTimer: ReturnType<typeof setTimeout> | undefined;
	let picked = $state<{ id: number; email: string }[]>([]);

	function hitName(s: ContactHit): string {
		return s.name || [s.first_name, s.last_name].filter(Boolean).join(' ');
	}

	function onPickInput() {
		const q = pickQuery.trim();
		clearTimeout(pickTimer);
		if (q.length < 2) {
			pickResults = [];
			showPickResults = false;
			pickActiveIdx = -1;
			return;
		}
		pickTimer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`);
				if (!res.ok) {
					pickResults = [];
					showPickResults = false;
					return;
				}
				pickResults = await res.json();
				showPickResults = pickResults.length > 0;
				pickActiveIdx = -1;
			} catch {
				pickResults = [];
				showPickResults = false;
			}
		}, 150);
	}

	function pickContact(s: ContactHit) {
		if (!s.subscribed) return; // greyed out — not pickable
		if (!picked.some((p) => p.id === s.id)) picked = [...picked, { id: s.id, email: s.email }];
		if (enrollPreview?.kind === 'contacts') enrollPreview = null;
		pickQuery = '';
		pickResults = [];
		showPickResults = false;
		pickActiveIdx = -1;
	}

	function unpickContact(id: number) {
		picked = picked.filter((p) => p.id !== id);
		if (enrollPreview?.kind === 'contacts') enrollPreview = null;
	}

	// #396: "This will enroll N contacts" before the confirm (?/enrollPreview). #395: a list /
	// segment preview also carries the members / subscribed / already-in / queued detail, is
	// refused unless the automation is active, and only its confirm (confirm=1) enrolls.
	type ListEnrollDetail = { list_id: number; list_name: string; members: number; eligible: number; already: number; will_enroll: number; now: number; queued: number };
	let enrollListId = $state('');
	let enrollBusy = $state(false);
	let enrollError = $state('');
	// #678: why each hand-picked contact is skipped (contacts preview only; ≤ 50 rows + `skippedMore`).
	type SkipReason = 'archived' | 'unsubscribed' | 'active' | 'once' | 'conditions';
	type SkipRow = { id: number; email: string; reason: SkipReason };
	type EnrollPreviewState = {
		kind: 'list' | 'contacts';
		eligible: number;
		total: number;
		entry_blocked: number;
		detail?: ListEnrollDetail;
		skipped?: SkipRow[];
		skippedMore?: number;
	};
	const SKIP_TEXT: Record<SkipReason, string> = {
		active: 'is already going through this automation',
		once: 'already went through this automation, which takes each contact once',
		conditions: 'does not match the contact conditions',
		unsubscribed: 'is unsubscribed. Resubscribe them on their contact page first.',
		archived: 'is archived. Restore them on their contact page first.'
	};
	let enrollPreview = $state<EnrollPreviewState | null>(null);
	// #412: the operator's "ignore entry conditions" (#448: "contact conditions") for this manual enroll.
	let ignoreEntry = $state(false);
	// #678: hand-picked contacts ticked for "Enroll again" (once) / "Restart from the first step" (active).
	let forcedIds = $state<number[]>([]);
	$effect(() => {
		if (!enrollOpen) {
			enrollPreview = null;
			enrollError = '';
			ignoreEntry = false;
		}
	});
	$effect(() => {
		if (!enrollPreview) forcedIds = [];
	});
	function toggleForced(id: number, on: boolean) {
		forcedIds = on ? [...forcedIds.filter((x) => x !== id), id] : forcedIds.filter((x) => x !== id);
	}
	/** #678: ticked overrides that count toward "This will enroll N" (only rows that offer one). */
	function forcedCountOf(p: EnrollPreviewState): number {
		if (!p.skipped) return 0;
		return p.skipped.filter((s) => (s.reason === 'active' || s.reason === 'once') && forcedIds.includes(s.id)).length;
	}
	async function previewEnroll(kind: 'list' | 'contacts') {
		enrollBusy = true;
		enrollError = '';
		const fd = new FormData();
		if (kind === 'list') fd.set('list_id', enrollListId);
		else for (const p of picked) fd.append('contact_ids', String(p.id));
		try {
			const res = await fetch(`/automations/${a.id}?/enrollPreview`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const r = deserialize(await res.text());
			if (r.type === 'failure' && typeof r.data?.error === 'string') {
				enrollError = r.data.error; // e.g. #395: not active, or no steps yet
				return;
			}
			if (r.type !== 'success' || !r.data?.preview) throw new Error('preview failed');
			const p = r.data.preview as { eligible: number; total: number; entry_blocked?: number; skipped?: SkipRow[]; skipped_more?: number };
			const detail = (r.data.enrollPreview ?? undefined) as ListEnrollDetail | undefined;
			forcedIds = [];
			enrollPreview = {
				kind,
				eligible: p.eligible,
				total: p.total,
				entry_blocked: p.entry_blocked ?? 0,
				detail,
				skipped: kind === 'contacts' ? (p.skipped ?? []) : undefined,
				skippedMore: kind === 'contacts' ? (p.skipped_more ?? 0) : undefined
			};
		} catch {
			enrollError = 'Could not count the contacts. Try again.';
		} finally {
			enrollBusy = false;
		}
	}

	function onPickKeydown(e: KeyboardEvent) {
		if (!showPickResults || pickResults.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			pickActiveIdx = (pickActiveIdx + 1) % pickResults.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			pickActiveIdx = (pickActiveIdx - 1 + pickResults.length) % pickResults.length;
		} else if (e.key === 'Enter' && pickActiveIdx >= 0) {
			e.preventDefault();
			pickContact(pickResults[pickActiveIdx]);
		} else if (e.key === 'Escape') {
			showPickResults = false;
			pickActiveIdx = -1;
		}
	}

	const a = $derived(data.automation);
	const isActive = $derived(a.status === 'active');
	// #714: a suggestion's "Move to an automation" step lands here with `?enroll_list=<group>`:
	// open Enroll contacts with that group picked and count it. The person confirms; nothing
	// is enrolled before they press Enroll.
	onMount(() => {
		const want = page.url.searchParams.get('enroll_list');
		if (!want || !data.lists.some((l: { id: number }) => String(l.id) === want)) return;
		enrollListId = want;
		enrollOpen = true;
		if (isActive) previewEnroll('list');
	});
	/** #412: what a confirmed manual enroll adds — plus the entry-condition skips when ignored. */
	function enrollCountOf(p: EnrollPreviewState): number {
		return p.eligible + (ignoreEntry ? p.entry_blocked : 0) + forcedCountOf(p);
	}
	// Structural edits are safe while contacts are mid-flow (#74: the engine pointer is a
	// step ID). Deleting a step re-points its waiting contacts — confirm when any exist.
	const waitingByStep = $derived(new Map(data.stepStats.map((st) => [st.step_id, st.waiting])));

	// Tree shape (#75/#76): trunk steps have no parent; branch steps carry labeled child
	// paths. `position` is sibling order within a (parent, label) group.
	const trunk = $derived(data.steps.filter((s) => s.parent_step_id === null));
	function childrenOf(parentId: number, label: string) {
		return data.steps.filter((s) => s.parent_step_id === parentId && s.branch_label === label);
	}
	const emailSteps = $derived(data.steps.filter((s) => s.type === 'email'));
	const memberGroups = $derived(data.lists.filter((l) => l.kind === 'list' || l.kind === 'segment'));
	// #448: the trigger drawer's "About the contact" rule builder.
	const contactConditions = $derived({
		initial: data.entryRules,
		lists: memberGroups,
		companies: data.companies,
		stages: data.pipelineStages,
		// #445: the company-metric group (Billing only with billing access).
		metrics: visibleMetrics(data.billing),
		topics: data.topics,
		tags: data.lists.filter((l) => l.kind === 'tag').map((l) => l.name),
		// #467: score_value / score_band rules.
		scores: data.scores,
		// #619: custom field rules pick defined fields by label.
		fields: data.customFields,
		// #516: the "Submitted form" rule.
		forms: data.forms
	});
	function listName(id: number | null): string {
		return data.lists.find((l) => l.id === id)?.name ?? '(deleted)';
	}
	function emailStepSubject(id: number | null): string {
		return emailSteps.find((s) => s.id === id)?.subject || '(deleted step)';
	}

	// #146 "Go to a step": steps are referenced as `n. title`, numbered in canvas order.
	const stepNo = $derived(stepNumbers(data.steps));
	function stepRef(id: number | null): string | null {
		const t = id === null ? undefined : data.steps.find((s) => s.id === id);
		return t ? numberedStepTitle(stepNo.get(t.id), stepShortTitle({ ...t, target_stage_name: stageName(t.target_stage_id) })) : null;
	}
	// Target picker groups: the main flow, then each branch lane, in canvas order.
	const gotoGroups = $derived.by(() => {
		const ordered = [...data.steps].sort((x, y) => (stepNo.get(x.id) ?? 0) - (stepNo.get(y.id) ?? 0));
		const groups: { label: string; steps: typeof data.steps }[] = [];
		const byKey = new Map<string, { label: string; steps: typeof data.steps }>();
		for (const s of ordered) {
			const key = s.parent_step_id === null ? 'trunk' : `${s.parent_step_id}:${s.branch_label}`;
			let g = byKey.get(key);
			if (!g) {
				const label =
					s.parent_step_id === null
						? 'Main flow'
						: `${s.branch_label === 'no' ? 'NO' : 'YES'} path of ${stepRef(s.parent_step_id) ?? 'condition'}`;
				g = { label, steps: [] };
				byKey.set(key, g);
				groups.push(g);
			}
			g.steps.push(s);
		}
		return groups;
	});
	// ↗ on a goto card: scroll the target card into view and highlight it briefly.
	let flashId = $state<number | null>(null);
	function showStep(id: number) {
		const el = document.getElementById(`step-node-${id}`);
		const vp = canvasScrollEl;
		if (el && vp) {
			const r = el.getBoundingClientRect();
			const v = vp.getBoundingClientRect();
			applyView(
				{ ...view, x: view.x + v.left + v.width / 2 - (r.left + r.width / 2), y: view.y + v.top + v.height / 2 - (r.top + r.height / 2) },
				{ animate: true }
			);
			vp.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
		}
		flashId = id;
		setTimeout(() => {
			if (flashId === id) flashId = null;
		}, 1600);
	}

	let triggerType = $state(data.automation.trigger_type);
	let triggerMetric = $state(data.automation.trigger_metric ?? TRIGGER_METRICS[0].key);
	// #445: the trigger's metric picker, grouped by source; Billing only with billing access.
	const triggerMetricGroups = $derived(groupMetrics(visibleMetrics(data.billing).filter((m) => m.kind === 'number')));
	const ruleMetrics = $derived(visibleMetrics(data.billing));
	let reentryChoice = $state(data.automation.reentry);
	// #414: the automation's topic ('' = none), saved with the trigger drawer.
	let topicChoice = $state('');

	// ---- Header + summary strip (#220) -------------------------------------------------
	const triggerCtx = $derived({ lists: data.lists, sites: data.trackingSites, stages: data.pipelineStages, emails: data.triggerEmails, scores: data.scores, forms: data.forms });
	const waitingSteps = $derived(data.stepStats.filter((st) => st.waiting > 0));
	const waitingTotal = $derived(waitingSteps.reduce((n, st) => n + st.waiting, 0));
	// #396: the status strip under the header — meaning, since when, who's waiting, next due.
	const status = $derived(
		statusLine({ status: a.status, since: data.statusSince, waiting: data.counts.active, nextRunAt: data.nextRunAt, now: data.now })
	);
	const statusTone = $derived(
		statusToneOf({ status: a.status, failed: data.counts.failed, pendingTriggers: data.pendingTriggers, nextRunAt: data.nextRunAt, now: data.now })
	);
	const statusHelp = $derived(`${status.title}. ${status.meaning}`);
	const sentTotal = $derived(data.stepStats.reduce((n, st) => n + (st.type === 'email' ? (st.sent ?? 0) : 0), 0));
	function fmt(n: number): string {
		return n.toLocaleString('en-US');
	}

	// Inline-editable title: click → input, Enter saves (?/rename), Esc cancels, blur saves.
	let renaming = $state(false);
	let renameForm = $state<HTMLFormElement | undefined>();
	let renameInput = $state<HTMLInputElement | undefined>();
	let renameBtn = $state<HTMLButtonElement | undefined>();
	async function startRename() {
		renaming = true;
		await tick();
		renameInput?.focus();
		renameInput?.select();
	}
	async function stopRename() {
		renaming = false;
		await tick();
		renameBtn?.focus();
	}
	function renameBlur() {
		if (!renaming) return;
		if (renameInput && renameInput.value.trim() !== a.name) renameForm?.requestSubmit();
		else renaming = false;
	}

	// Labels — shown as automation "tags" (#432): the add input sits behind a "+ Tag" button.
	let labelAddOpen = $state(false);
	let labelPicker = $state<ReturnType<typeof SearchSelect> | undefined>();
	let labelValue = $state<string | number>('');
	async function openLabelAdd() {
		labelValue = '';
		labelAddOpen = true;
		await tick();
		labelPicker?.focus();
	}

	// ⋯ menu (Duplicate / Delete).
	let moreOpen = $state(false);
	let moreEl = $state<HTMLDivElement | undefined>();

	// ---- Trigger drawer (#220) ---------------------------------------------------------
	let triggerOpen = $state(false);
	let triggerError = $state<string | null>(null);
	let triggerSaving = $state(false);
	let triggerEditBtn = $state<HTMLButtonElement | undefined>();
	let triggerDrawerEl = $state<HTMLElement | undefined>();
	async function openTrigger() {
		selectedId = null;
		triggerType = a.trigger_type;
		triggerMetric = a.trigger_metric ?? TRIGGER_METRICS[0].key;
		reentryChoice = a.reentry;
		topicChoice = a.topic_list_id ? String(a.topic_list_id) : '';
		triggerError = null;
		triggerOpen = true;
		await tick();
		triggerDrawerEl?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
	}
	function closeTrigger() {
		triggerOpen = false;
		triggerError = null;
		triggerEditBtn?.focus();
	}
	// One Save submits ?/setTrigger, then ?/setReentry when the policy changed — the two
	// actions are unchanged; a trigger validation error stops before re-entry is touched.
	const saveTrigger: import('$app/forms').SubmitFunction = () => {
		triggerSaving = true;
		triggerError = null;
		return async ({ result, update }) => {
			try {
				if (result.type === 'failure') {
					triggerError = String(result.data?.error ?? 'Could not save the trigger.');
					return;
				}
				if (result.type !== 'success') {
					await update();
					return;
				}
				if (reentryChoice !== a.reentry) {
					const fd = new FormData();
					fd.set('reentry', reentryChoice);
					const res = await fetch(`/automations/${a.id}?/setReentry`, {
						method: 'POST',
						body: fd,
						headers: { 'x-sveltekit-action': 'true' }
					});
					const r = deserialize(await res.text());
					if (r.type !== 'success') {
						triggerError = r.type === 'failure' ? String(r.data?.error ?? 'Could not save re-entry.') : 'Could not save re-entry.';
					}
				}
				// #414: the topic, only when it changed (same pattern as re-entry).
				if (!triggerError && topicChoice !== (a.topic_list_id ? String(a.topic_list_id) : '')) {
					const fd = new FormData();
					fd.set('topic_list_id', topicChoice);
					const res = await fetch(`/automations/${a.id}?/setTopic`, {
						method: 'POST',
						body: fd,
						headers: { 'x-sveltekit-action': 'true' }
					});
					const r = deserialize(await res.text());
					if (r.type !== 'success') {
						triggerError = r.type === 'failure' ? String(r.data?.error ?? 'Could not save the topic.') : 'Could not save the topic.';
					}
				}
				await update({ reset: false });
				if (!triggerError) closeTrigger();
			} finally {
				triggerSaving = false;
			}
		};
	};

	// ---- Performance / Enrollment inspector tabs (#220), persisted in the URL hash -------
	type Tab = 'performance' | 'inspector';
	const showPerf = $derived(
		data.steps.length > 0 && data.counts.active + data.counts.completed + data.counts.cancelled + data.counts.failed > 0
	);
	const showInsp = $derived(data.counts.active + data.counts.completed + data.counts.cancelled + data.counts.failed > 0);
	let tabPref = $state<Tab>('performance');
	const tab = $derived<Tab>(tabPref === 'inspector' ? (showInsp ? 'inspector' : 'performance') : showPerf ? 'performance' : 'inspector');
	$effect(() => {
		const read = () => {
			const h = location.hash.slice(1);
			if (h === 'performance' || h === 'inspector') tabPref = h;
		};
		read();
		window.addEventListener('hashchange', read);
		return () => window.removeEventListener('hashchange', read);
	});
	function setTab(t: Tab) {
		tabPref = t;
		replaceState(`#${t}`, {});
	}
	function onTabKeydown(e: KeyboardEvent) {
		if (!showPerf || !showInsp) return;
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
		e.preventDefault();
		const next: Tab = e.key === 'Home' ? 'performance' : e.key === 'End' ? 'inspector' : tab === 'performance' ? 'inspector' : 'performance';
		setTab(next);
		document.getElementById(`tab-${next}`)?.focus();
	}

	// ---- Canvas state ---------------------------------------------------------------
	// Node editing happens in a right-side drawer instead of an inline accordion.
	let selectedId = $state<number | null>(null);
	const selected = $derived(
		selectedId === null ? null : (data.steps.find((s) => s.id === selectedId) ?? null)
	);
	const selSibs = $derived(
		selected
			? selected.parent_step_id === null
				? trunk
				: childrenOf(selected.parent_step_id, selected.branch_label ?? 'yes')
			: []
	);
	const selIdx = $derived(selected ? selSibs.findIndex((x) => x.id === selected.id) : -1);

	// ＋ picker popover: a single fixed-position popup anchored to the clicked ＋ button
	// (fixed so the canvas's overflow container can't clip it). Keyed per insertion point.
	let picker = $state<{
		key: string;
		parentId: number | null;
		label: string | null;
		depth: number;
		x: number;
		y: number;
		flip: boolean;
	} | null>(null);

	function togglePicker(btn: HTMLElement, parentId: number | null, label: string | null, depth: number, key: string) {
		if (picker?.key === key) {
			picker = null;
			return;
		}
		const r = btn.getBoundingClientRect();
		const x = Math.min(Math.max(r.left + r.width / 2, 110), window.innerWidth - 110);
		const flip = r.bottom + 240 > window.innerHeight; // open upward near the bottom edge
		picker = { key, parentId, label, depth, x, y: flip ? r.top - 6 : r.bottom + 6, flip };
	}

	// ---- Canvas fullscreen (expand the whole builder to fill the page) ----------------
	// Independent of the drawer's own modes — the canvas can be expanded with the drawer
	// closed, docked, centered, or fullscreen; z-index keeps the drawer above it either way.
	const CANVAS_EXPANDED_KEY = 'automation-canvas-expanded';
	let canvasExpanded = $state(false);
	$effect(() => {
		canvasExpanded = localStorage.getItem(CANVAS_EXPANDED_KEY) === '1';
	});
	function setCanvasExpanded(v: boolean) {
		canvasExpanded = v;
		localStorage.setItem(CANVAS_EXPANDED_KEY, v ? '1' : '0');
	}
	// Lock the page scroll behind the fullscreen canvas — it has its own scroller.
	$effect(() => {
		if (!canvasExpanded) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = prev;
		};
	});

	// ---- Canvas pan + zoom (#147, #218) -----------------------------------------------
	// The viewport clips; the world inside it is drawn with translate(x, y) scale(k), so
	// hit-testing, drag/drop and getBoundingClientRect (picker anchoring) follow the
	// transform. Plain wheel / two-finger scroll pans; ⌘/Ctrl+wheel and trackpad pinch
	// (ctrl+wheel, or Safari's gesture events) zoom around the cursor. Drag on empty
	// canvas, Space+drag and one-finger touch pan; two fingers pinch. Zoom + pan persist
	// per automation; Fit clears the saved view.
	let view = $state<View>({ x: 0, y: 0, k: 1 });
	const zoom = $derived(view.k);
	let viewReady = $state(false);
	let animateView = $state(false);
	let zoomMenuOpen = $state(false);
	let canvasScrollEl = $state<HTMLDivElement | undefined>();
	let canvasEl = $state<HTMLDivElement | undefined>();
	let zoomMenuEl = $state<HTMLDivElement | undefined>();
	let isPanning = $state(false);
	let spaceDown = $state(false);
	let canvasHover = false;
	// Un-transformed flow size (offsetWidth/Height ignore the transform).
	let worldSize = { w: 0, h: 0 };
	const zoomKey = $derived(`canvas-zoom:${a.id}`);
	const layout = $derived(layoutFlow(treeFromSteps(data.steps)));

	function viewportSize() {
		const el = canvasScrollEl;
		return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 };
	}
	function reducedMotion() {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	function persistView() {
		clearTimeout(saveTimer);
		const key = zoomKey;
		saveTimer = setTimeout(() => {
			try {
				localStorage.setItem(key, serializeView(view));
			} catch {
				/* storage full / blocked — the view still applies here */
			}
		}, 250);
	}
	function applyView(v: View, opts: { animate?: boolean; persist?: boolean } = {}) {
		const vp = viewportSize();
		animateView = !!opts.animate && !reducedMotion();
		view = worldSize.w > 0 && vp.w > 0 ? clampPan(v, worldSize.w, worldSize.h, vp.w, vp.h) : v;
		if (opts.persist !== false) persistView();
	}
	/** Viewport-relative point for client coords (default: the viewport centre). */
	function viewportPoint(client?: { x: number; y: number }) {
		const el = canvasScrollEl!;
		const r = el.getBoundingClientRect();
		return client
			? { x: client.x - r.left - el.clientLeft, y: client.y - r.top - el.clientTop }
			: { x: el.clientWidth / 2, y: el.clientHeight / 2 };
	}

	/** Set the zoom, keeping the canvas point under `anchor` (client coords) in place. */
	function setZoom(z: number, anchor?: { x: number; y: number }, animate = false) {
		if (!canvasScrollEl) return;
		const p = viewportPoint(anchor);
		applyView(zoomAt(view, z, p.x, p.y), { animate });
	}
	function zoomBy(dir: 1 | -1) {
		setZoom(stepZoom(zoom, dir), undefined, true);
	}
	function fitToView() {
		const vp = viewportSize();
		if (!worldSize.w || !vp.w) return;
		clearTimeout(saveTimer);
		applyView(fitView(worldSize.w, worldSize.h, vp.w, vp.h), { animate: true, persist: false });
		try {
			localStorage.removeItem(zoomKey);
		} catch {
			/* storage blocked */
		}
	}
	function pickZoom(z: number | 'fit') {
		zoomMenuOpen = false;
		if (z === 'fit') fitToView();
		else setZoom(z, undefined, true);
	}

	/** First view for this automation: the saved one (Fit on a phone when it's too wide), else Fit when the flow is wider than the viewport. */
	function initView(): boolean {
		const vp = viewportSize();
		if (!vp.w || !worldSize.w) return false;
		let saved: ReturnType<typeof parseStoredView> = null;
		try {
			saved = parseStoredView(localStorage.getItem(zoomKey));
		} catch {
			/* storage blocked */
		}
		if (saved) applyView(openSavedView(saved, worldSize.w, worldSize.h, vp.w, vp.h), { persist: false });
		else applyView(initialView(worldSize.w, worldSize.h, vp.w, vp.h), { persist: false });
		return true;
	}
	$effect(() => {
		void zoomKey; // re-run when navigating to another automation
		viewReady = untrack(() => {
			if (canvasEl) worldSize = { w: canvasEl.offsetWidth, h: canvasEl.offsetHeight };
			return initView();
		});
	});
	$effect(() => {
		const world = canvasEl;
		const vpEl = canvasScrollEl;
		if (!world || !vpEl) return;
		const ro = new ResizeObserver(() => {
			worldSize = { w: world.offsetWidth, h: world.offsetHeight };
			if (!viewReady) viewReady = initView();
			else applyView(view, { persist: false });
		});
		ro.observe(world);
		ro.observe(vpEl);
		return () => ro.disconnect();
	});

	// Keyboard (focus in the canvas): + / − / 0 (= 100%), with or without ⌘/Ctrl;
	// arrows pan when the canvas itself has focus.
	function onCanvasKeydown(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (e.altKey || t.closest('input, textarea, select, [contenteditable]')) return;
		if (e.key === '+' || e.key === '=') zoomBy(1);
		else if (e.key === '-' || e.key === '_') zoomBy(-1);
		else if (e.key === '0') setZoom(1, undefined, true);
		else if (t === canvasScrollEl && !(e.metaKey || e.ctrlKey) && e.key.startsWith('Arrow')) {
			const d = e.shiftKey ? 200 : 60;
			const dx = e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0;
			const dy = e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0;
			applyView({ ...view, x: view.x + dx, y: view.y + dy });
		} else return;
		e.preventDefault();
	}

	// Focusing a step off-screen makes the browser scroll the (overflow: hidden)
	// viewport to reveal it — fold that scroll into the pan instead.
	function onCanvasScroll() {
		const el = canvasScrollEl;
		if (!el || (!el.scrollLeft && !el.scrollTop)) return;
		const dx = el.scrollLeft;
		const dy = el.scrollTop;
		el.scrollLeft = 0;
		el.scrollTop = 0;
		applyView({ ...view, x: view.x - dx, y: view.y - dy });
	}

	// Pointer pan / pinch. Mouse drags only pan from empty canvas (cards, buttons, links
	// and the reorder handle keep their own click/drag) unless Space is held; touch pans
	// from anywhere, and a pan never ends in a click.
	const pointers = new Map<number, { x: number; y: number }>();
	let drag: { id: number; sx: number; sy: number; view: View; moved: boolean } | null = null;
	let pinch: { dist: number; mid: { x: number; y: number }; view: View } | null = null;
	let suppressClick = false;

	function pinchState() {
		const [p, q] = [...pointers.values()];
		return {
			dist: Math.max(1, Math.hypot(p.x - q.x, p.y - q.y)),
			mid: viewportPoint({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })
		};
	}
	function onCanvasPointerDown(e: PointerEvent) {
		if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
		const t = e.target as HTMLElement;
		if (t.closest('input, select, textarea, .waiting-pop, .canvas-zoom-float, .canvas-collapse-btn')) return;
		if (e.pointerType === 'mouse' && e.button === 0 && !spaceDown && t.closest('button, a, form, .node, .handle')) return;
		if (e.pointerType === 'mouse' && (spaceDown || e.button === 1)) e.preventDefault();
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, view, moved: false };
		} else if (pointers.size === 2) {
			drag = null;
			pinch = { ...pinchState(), view };
		}
	}
	function onCanvasPointerMove(e: PointerEvent) {
		const p = pointers.get(e.pointerId);
		if (!p) return;
		p.x = e.clientX;
		p.y = e.clientY;
		if (pinch && pointers.size === 2) {
			const now = pinchState();
			const s = pinch.view;
			const shifted = { ...s, x: s.x + now.mid.x - pinch.mid.x, y: s.y + now.mid.y - pinch.mid.y };
			isPanning = true;
			applyView(zoomAt(shifted, s.k * (now.dist / pinch.dist), now.mid.x, now.mid.y));
			return;
		}
		if (!drag || drag.id !== e.pointerId) return;
		const dx = e.clientX - drag.sx;
		const dy = e.clientY - drag.sy;
		if (!drag.moved && Math.hypot(dx, dy) > 4) {
			drag.moved = true;
			isPanning = true;
			try {
				canvasScrollEl?.setPointerCapture(e.pointerId);
			} catch {
				/* pointer already gone */
			}
		}
		if (drag.moved) applyView({ k: drag.view.k, x: drag.view.x + dx, y: drag.view.y + dy });
	}
	function onCanvasPointerUp(e: PointerEvent) {
		if (!pointers.has(e.pointerId)) return;
		pointers.delete(e.pointerId);
		if (canvasScrollEl?.hasPointerCapture(e.pointerId)) canvasScrollEl.releasePointerCapture(e.pointerId);
		if ((drag?.id === e.pointerId && drag.moved) || pinch) {
			suppressClick = true;
			setTimeout(() => (suppressClick = false), 0);
		}
		if (pointers.size === 1 && pinch) {
			// Pinch → one finger left: keep panning from where it is.
			const [[id, q]] = [...pointers.entries()];
			drag = { id, sx: q.x, sy: q.y, view, moved: true };
		} else if (pointers.size === 0) {
			drag = null;
			isPanning = false;
		}
		if (pointers.size < 2) pinch = null;
	}
	function onCanvasClickCapture(e: MouseEvent) {
		if (!suppressClick) return;
		suppressClick = false;
		e.preventDefault();
		e.stopPropagation();
	}

	// Space+drag pans from anywhere while the pointer is over the canvas.
	$effect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.code !== 'Space' || !canvasHover) return;
			const t = e.target as HTMLElement;
			if (t.closest?.('input, textarea, select, button, a, [contenteditable], .node')) return;
			e.preventDefault();
			spaceDown = true;
		};
		const up = (e: KeyboardEvent) => {
			if (e.code === 'Space') spaceDown = false;
		};
		const blur = () => (spaceDown = false);
		window.addEventListener('keydown', down);
		window.addEventListener('keyup', up);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('keydown', down);
			window.removeEventListener('keyup', up);
			window.removeEventListener('blur', blur);
		};
	});

	// Wheel: ⌘/Ctrl+wheel and trackpad pinch zoom around the cursor; anything else pans.
	// Safari's trackpad pinch arrives as gesture* events instead. Non-passive so the page
	// neither scrolls nor zooms while the pointer is over the canvas.
	$effect(() => {
		const el = canvasScrollEl;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if ((e.target as HTMLElement).closest('.waiting-pop, .zoom-menu')) return;
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				setZoom(view.k * wheelZoomFactor(e.deltaY, e.deltaMode), { x: e.clientX, y: e.clientY });
				return;
			}
			const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
			let dx = e.deltaX * m;
			let dy = e.deltaY * m;
			if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
			applyView({ ...view, x: view.x - dx, y: view.y - dy });
		};
		type GestureEv = UIEvent & { scale: number; clientX: number; clientY: number };
		let gestureStart: View | null = null;
		const onGestureStart = (e: Event) => {
			e.preventDefault();
			gestureStart = view;
		};
		const onGestureChange = (e: Event) => {
			e.preventDefault();
			if (pinch || !gestureStart) return; // touch pinch is handled by the pointer code
			const g = e as GestureEv;
			const p = viewportPoint({ x: g.clientX, y: g.clientY });
			applyView(zoomAt(gestureStart, gestureStart.k * g.scale, p.x, p.y));
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		el.addEventListener('gesturestart', onGestureStart);
		el.addEventListener('gesturechange', onGestureChange);
		return () => {
			el.removeEventListener('wheel', onWheel);
			el.removeEventListener('gesturestart', onGestureStart);
			el.removeEventListener('gesturechange', onGestureChange);
		};
	});

	// ---- Editor drawer display mode (#docked / centered modal / fullscreen) -----------
	type DrawerMode = 'docked' | 'centered' | 'fullscreen';
	const DRAWER_MODE_KEY = 'automation-drawer-mode';
	let drawerMode = $state<DrawerMode>('docked');
	$effect(() => {
		const saved = localStorage.getItem(DRAWER_MODE_KEY);
		if (saved === 'docked' || saved === 'centered' || saved === 'fullscreen') drawerMode = saved;
	});
	function setDrawerMode(mode: DrawerMode) {
		drawerMode = mode;
		localStorage.setItem(DRAWER_MODE_KEY, mode);
	}

	// Drawer edit fields (prefilled from the step when it's opened).
	// #254: the email step's visual-editor blocks. A markdown step converts here and is
	// only written back (as blocks) when the drawer is saved.
	let editBlocks = $state<Block[]>([]);
	let editPreheader = $state('');
	async function renderStepPreview(blocks: Block[]): Promise<string> {
		const fd = new FormData();
		fd.set('body_blocks', JSON.stringify(blocks));
		fd.set('preheader', editPreheader);
		const res = await fetch('/compose/preview', { method: 'POST', body: fd });
		if (!res.ok) throw new Error('preview failed');
		return res.text();
	}
	let editDelayValue = $state(0);
	let editDelayUnit = $state('days');
	// #119: opt-in "weekdays only" on this step's wait.
	let editWeekdayOnly = $state(false);
	let editTagAction = $state('add');
	let editTagName = $state('');
	// Condition step (#221): a rule set (match all/any) or an A/B split. An existing single
	// gate opens as a one-rule set; saving writes gate_rules and clears the legacy columns.
	let editGateMode = $state<'rules' | 'split'>('rules');
	let editRules = $state<ConditionRuleSet>({ match: 'all', rules: [] });
	let editRulesProblem = $derived(editGateMode === 'rules' ? ruleSetProblem(editRules) : null);
	let editSplitPct = $state(50);
	// Action step (#128): which OTHER automation this step acts on, and how.
	let editActionKind = $state('enroll_automation');
	// '__all__' is the "All other automations" sentinel (End radio only) — resolved
	// server-side into action_kind `end_all_automations` with no target (#128).
	let editTargetAutomationId = $state<number | '' | '__all__'>('');
	// #146: "Go to a step" target — another step in this automation.
	let editTargetStepId = $state<number | ''>('');
	// #207: pipeline action step (destination + optional "only from") and pipeline condition.
	let editStageId = $state<number | ''>('');
	let editOnlyFromStageId = $state<number | ''>('');
	// #460: "Set engagement tier" — the tier (or 'clear') and "until cleared" / "for N days".
	let editTier = $state('hot');
	let editTierUntil = $state<'cleared' | 'days'>('cleared');
	let editTierDays = $state(30);
	// #467: "Adjust score" — the score, ± points and an optional expiry in days (blank = never).
	let editScoreId = $state<number | ''>('');
	let editScoreDelta = $state<number | ''>(5);
	let editScoreExpires = $state<number | ''>('');
	// `__all__` only makes sense under the End radio — clear it if the Start radio is
	// picked instead, so a stale selection can't silently submit as "no target" (#128).
	$effect(() => {
		if (editActionKind === 'enroll_automation' && editTargetAutomationId === '__all__') {
			editTargetAutomationId = '';
		}
	});
	// Engagement auto-tags on email steps (#42).
	let editTagOnOpenEnabled = $state(false);
	let editTagOnOpen = $state('');
	let editTagOnClickEnabled = $state(false);
	let editTagOnClick = $state('');
	// #396: subject + From are tracked so the unsaved-changes guard sees them.
	let editSubject = $state('');
	let editFrom = $state('');
	let editFromOther = $state(false);
	// #397: wait-until step.
	let editWaitMode = $state<WaitMode>('delay');
	// #625: the kind of wait is picked first; `waitChoosing` = the "The contact will wait:" screen.
	let waitChoosing = $state(false);
	let editWaitDelayValue = $state(1);
	let editWaitDelayUnit = $state('days');
	let editWaitWeekdaysOnly = $state(false);
	let editWaitEvent = $state('clicked');
	let editWaitPath = $state('');
	let editWaitTimeoutValue = $state(3);
	let editWaitTimeoutUnit = $state('days');
	let editWaitDateKind = $state<'at' | 'next'>('next');
	let editWaitAt = $state('');
	let editWaitDay = $state('weekday');
	let editWaitTime = $state('09:00');
	let editWaitStart = $state('09:00');
	let editWaitEnd = $state('17:00');
	let editWaitDays = $state<'weekdays' | 'every'>('weekdays');
	// #627: until a date custom field matches.
	let editWaitField = $state('');
	let editWaitRelation = $state<'on' | 'before' | 'after'>('on');
	let editWaitOffset = $state(1);
	let editWaitOffsetUnit = $state('days');
	let editWaitFieldTime = $state('09:00');
	let editWaitIfPassed = $state<'continue' | 'exit'>('continue');
	const dateFields = $derived(data.customFields.filter((f) => f.type === 'date'));
	// #626: "Until specific conditions are met" — a rule set + an optional time limit
	// (the limit's value / unit reuse the event wait's timeout fields).
	let editWaitRules = $state<ConditionRuleSet>({ match: 'all', rules: [{ field: 'tag', op: 'has', value: '' }] });
	let editWaitLimitOn = $state(false);
	let editWaitRulesProblem = $derived(editWaitMode === 'rules' ? ruleSetProblem(editWaitRules) : null);
	const WAIT_DAY_LABELS: Record<string, string> = {
		weekday: 'weekday (Mon–Fri)', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
	};
	const selectedHasLaneSteps = $derived(!!selected && data.steps.some((s) => s.parent_step_id === selected.id));
	// #625: the email an opened / clicked wait watches (the nearest email step before it).
	function prevEmailOf(stepId: number) {
		return previousEmailStep(data.steps, stepId);
	}
	const selectedPrevEmail = $derived(selected && selected.type === 'wait' ? prevEmailOf(selected.id) : null);
	const prevEmailName = $derived(selectedPrevEmail ? `“${selectedPrevEmail.subject || 'Untitled email'}”` : 'the previous email');
	// An event / rules wait whose lanes hold steps can only switch between those two kinds
	// (anything else would strand the steps).
	const waitKindLocked = $derived(selectedHasLaneSteps && waitModeHasLanes(editWaitMode));
	function pickWaitKind(mode: WaitMode) {
		editWaitMode = mode;
		// No email before this wait: don't land on an event that can't happen.
		if (mode === 'event' && !selectedPrevEmail && (editWaitEvent === 'opened' || editWaitEvent === 'clicked')) editWaitEvent = 'replied';
		waitChoosing = false;
	}

	// ---- Unsaved-changes guard (#396) ---------------------------------------------------
	// The drawer's state is fingerprinted when it opens; closing it (backdrop, Esc, Cancel,
	// another step) or leaving the page with a different state asks first. No autosave —
	// these flows run live. The email body is baselined once the editor has normalised it.
	function restState(): string {
		return fingerprint({
			pre: editPreheader, subject: editSubject, from: editFrom, dv: editDelayValue, du: editDelayUnit, wk: editWeekdayOnly,
			ta: editTagAction, tn: editTagName, gm: editGateMode, rules: editRules, sp: editSplitPct, ak: editActionKind,
			tai: editTargetAutomationId, tsi: editTargetStepId, st: editStageId, of: editOnlyFromStageId, tr: editTier, tu: editTierUntil, td: editTierDays, sc: editScoreId, sd: editScoreDelta, se: editScoreExpires,
			too: editTagOnOpenEnabled, to: editTagOnOpen, tce: editTagOnClickEnabled, tc: editTagOnClick,
			wm: editWaitMode, wdv: editWaitDelayValue, wdu: editWaitDelayUnit, wwo: editWaitWeekdaysOnly, we: editWaitEvent, wp: editWaitPath, wtv: editWaitTimeoutValue, wtu: editWaitTimeoutUnit, wdk: editWaitDateKind,
			wa: editWaitAt, wd: editWaitDay, wt: editWaitTime, ws: editWaitStart, wn: editWaitEnd, wds: editWaitDays,
			wf: editWaitField, wr: editWaitRelation, wo: editWaitOffset, wou: editWaitOffsetUnit, wft: editWaitFieldTime, wip: editWaitIfPassed,
			wru: editWaitRules, wlo: editWaitLimitOn
		});
	}
	let baseRest = $state<string | null>(null);
	let baseBlocks = $state<string | null>(null);
	const drawerDirty = $derived(
		selectedId !== null && (isDirty(baseRest, restState()) || isDirty(baseBlocks, fingerprint(editBlocks)))
	);
	let drawerEl = $state<HTMLElement | undefined>();
	let drawerOpener: HTMLElement | null = null;

	/** Close the step drawer, asking first when it has unsaved changes. False = stayed open. */
	function requestCloseDrawer(): boolean {
		if (!mayClose(drawerDirty, (m) => confirm(m))) return false;
		closeDrawerNow();
		return true;
	}
	/** Close without asking (after a save or delete) and give focus back to the step. */
	function closeDrawerNow() {
		const id = selectedId;
		selectedId = null;
		baseRest = null;
		baseBlocks = null;
		testResult = null;
		checksReport = null;
		const opener = drawerOpener;
		drawerOpener = null;
		tick().then(() => {
			const back = opener?.isConnected ? opener : id !== null ? document.getElementById(`step-node-${id}`) : null;
			back?.focus({ preventScroll: true });
		});
	}
	beforeNavigate((nav) => {
		if (!drawerDirty) return;
		// Closing the tab / leaving the app: the browser asks (beforeunload) — no confirm() here.
		if (nav.type === 'leave') nav.cancel();
		else if (!confirm(LEAVE_MESSAGE)) nav.cancel();
	});

	/** Keep Tab inside an open dialog (the step and trigger drawers, #396). */
	function trapFocus(e: KeyboardEvent, el: HTMLElement | undefined) {
		if (e.key !== 'Tab' || !el) return;
		const items = [
			...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])')
		].filter((x) => x.offsetParent !== null || x === document.activeElement);
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
			e.preventDefault();
			first.focus();
		}
	}

	// ---- From picker (#396): approved senders, the current value kept + flagged ----------
	const fromChoices = $derived(
		senderOptions(
			data.approvedSenders,
			[data.defaultFrom, ...data.steps.filter((s) => s.type === 'email').map((s) => s.from_email)],
			selected ? selected.from_email || data.defaultFrom : ''
		)
	);
	const fromApproved = $derived(!editFrom.trim() || senderAllowed(editFrom, data.approvedSenders));

	// ---- Test send + pre-send checks for an email step (#396) ---------------------------
	let stepFormEl = $state<HTMLFormElement | undefined>();
	let testBusy = $state(false);
	let testResult = $state<{ ok: boolean; text: string } | null>(null);
	let checksReport = $state<import('$lib/presend-checks').ChecksReport | null>(null);
	let checksFingerprint = $state('');
	const checksStale = $derived(
		!!checksReport && checksFingerprint !== fingerprint({ b: editBlocks, s: editSubject, p: editPreheader })
	);
	function stepFields(): FormData {
		return stepFormEl ? new FormData(stepFormEl) : new FormData();
	}
	async function sendStepTest() {
		if (!stepFormEl || !selected) return;
		testBusy = true;
		testResult = null;
		try {
			const res = await fetch(`/automations/${a.id}?/testStep`, {
				method: 'POST',
				body: stepFields(),
				headers: { 'x-sveltekit-action': 'true' }
			});
			const r = deserialize(await res.text());
			if (r.type === 'success') testResult = { ok: true, text: `Test sent to ${String(r.data?.testTo ?? '')}. Check your inbox.` };
			else testResult = { ok: false, text: r.type === 'failure' ? String(r.data?.testError ?? 'The test could not be sent.') : 'The test could not be sent.' };
		} catch {
			testResult = { ok: false, text: 'The test could not be sent.' };
		} finally {
			testBusy = false;
		}
	}

	// ---- Delete + 10-second Undo (#396) ------------------------------------------------
	let undo = $state<{ token: string; label: string; error: string | null; busy: boolean } | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;
	function showUndo(token: string, label: string) {
		clearTimeout(undoTimer);
		undo = { token, label, error: null, busy: false };
		undoTimer = setTimeout(() => (undo = null), UNDO_MS);
	}
	async function undoDelete() {
		const cur = undo;
		if (!cur || cur.busy) return;
		clearTimeout(undoTimer);
		undo = { ...cur, busy: true };
		const fd = new FormData();
		fd.set('token', cur.token);
		try {
			const res = await fetch(`/automations/${a.id}?/restoreStep`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const r = deserialize(await res.text());
			if (r.type === 'success') {
				await invalidateAll();
				undo = null;
				return;
			}
			undo = { ...cur, busy: false, error: r.type === 'failure' ? String(r.data?.error ?? 'Could not undo.') : 'Could not undo.' };
		} catch {
			undo = { ...cur, busy: false, error: 'Could not undo.' };
		}
		undoTimer = setTimeout(() => (undo = null), UNDO_MS);
	}
	function confirmDelete(e: SubmitEvent, s: Step) {
		if (!confirm(deleteMessage(s.type, waitingByStep.get(s.id) ?? 0))) e.preventDefault();
	}
	/** use:enhance for both delete buttons: close the drawer if it showed the step, then the toast. */
	function deleteEnhance(s: Step): import('$app/forms').SubmitFunction {
		const label = stepLabel(s);
		return () =>
			async ({ update, result }) => {
				await update();
				if (result.type !== 'success') return;
				if (selectedId === s.id) closeDrawerNow();
				const token = result.data?.undoToken;
				if (typeof token === 'string') showUndo(token, label);
			};
	}

	// ---- Reorder by drag in any lane, mouse or touch (#396) ------------------------------
	// Pointer events (HTML5 drag doesn't fire on touch). Steps only move within their own
	// lane; ↑ / ↓ stay the keyboard path.
	let dragId = $state<number | null>(null);
	let dragOverId = $state<number | null>(null);
	let laneDrag: { id: number; parentId: number | null; label: string | null; pointerId: number } | null = null;
	let reorderForm = $state<HTMLFormElement | undefined>();
	let reorderOrder = $state('');
	let reorderParent = $state('');
	let reorderLabel = $state('');
	function laneOf(parentId: number | null, label: string | null): Step[] {
		return parentId === null ? trunk : childrenOf(parentId, label ?? 'yes');
	}
	function onHandleDown(e: PointerEvent, s: Step) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation(); // not a canvas pan
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			/* pointer already gone */
		}
		laneDrag = { id: s.id, parentId: s.parent_step_id, label: s.branch_label, pointerId: e.pointerId };
		dragId = s.id;
	}
	function onHandleMove(e: PointerEvent) {
		const d = laneDrag;
		if (!d || e.pointerId !== d.pointerId) return;
		const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.node');
		const t = el ? data.steps.find((x) => x.id === Number(el.dataset.stepId)) : undefined;
		dragOverId = t && t.id !== d.id && t.parent_step_id === d.parentId && (d.parentId === null || t.branch_label === d.label) ? t.id : null;
	}
	async function onHandleUp(e: PointerEvent) {
		const d = laneDrag;
		if (!d || e.pointerId !== d.pointerId) return;
		const target = dragOverId;
		laneDrag = null;
		dragId = null;
		dragOverId = null;
		if (target === null || e.type === 'pointercancel') return;
		const next = reorderLane(laneOf(d.parentId, d.label).map((x) => x.id), d.id, target);
		if (!next) return;
		reorderOrder = next.join(',');
		reorderParent = d.parentId === null ? '' : String(d.parentId);
		reorderLabel = d.label ?? '';
		await tick();
		reorderForm?.requestSubmit();
	}

	// ---- Inline wait node (#396) --------------------------------------------------------
	let waitEdit = $state<{ step: Step; x: number; y: number; flip: boolean } | null>(null);
	let waitValue = $state(0);
	let waitUnit = $state<string>('days');
	let waitWeekday = $state(false);
	let waitPopEl = $state<HTMLDivElement | undefined>();
	let waitOpener: HTMLElement | null = null;
	async function openWait(btn: HTMLElement, s: Step) {
		const r = btn.getBoundingClientRect();
		const flip = r.bottom + 220 > window.innerHeight;
		const w = splitWait(s.delay_before_seconds);
		waitOpener = btn;
		waitValue = w.value;
		waitUnit = w.unit;
		waitWeekday = !!s.weekday_only;
		waitEdit = {
			step: s,
			x: Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150),
			y: flip ? r.top - 6 : r.bottom + 6,
			flip
		};
		await tick();
		waitPopEl?.querySelector<HTMLInputElement>('input[type="number"]')?.focus();
	}
	function closeWait() {
		waitEdit = null;
		waitOpener?.focus({ preventScroll: true });
		waitOpener = null;
	}

	// Enrollment inspector state (#80). `inspStep` (#124) is set by a waiting-popover's
	// "Show in inspector" button to jump straight to that step's parked contacts.
	// #396: filtering + paging happen in SQL (?insp_q / insp_status / insp_step / insp_page),
	// so any enrollment can be found, not only the newest 100.
	let inspEmail = $state(untrack(() => data.inspector.q));
	let inspExpanded = $state(new Set<number>());
	let inspEl = $state<HTMLElement | undefined>();
	let inspTimer: ReturnType<typeof setTimeout> | undefined;
	const inspPages = $derived(Math.max(1, Math.ceil(data.inspector.total / data.inspector.pageSize)));

	function toggleInsp(eid: number) {
		const next = new Set(inspExpanded);
		if (next.has(eid)) next.delete(eid);
		else next.add(eid);
		inspExpanded = next;
	}

	/** Move the inspector to a filter / page; a filter change goes back to page 1. */
	function inspGo(change: { q?: string; status?: string; step?: string; page?: number }) {
		const url = new URL(page.url.href);
		const set = (k: string, v: string) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
		if (change.q !== undefined) set('insp_q', change.q.trim());
		if (change.status !== undefined) set('insp_status', change.status);
		if (change.step !== undefined) set('insp_step', change.step);
		set('insp_page', change.page && change.page > 1 ? String(change.page) : '');
		url.hash = 'inspector';
		goto(url, { replace: true, reset: false });
	}
	function onInspSearch() {
		clearTimeout(inspTimer);
		inspTimer = setTimeout(() => inspGo({ q: inspEmail }), 300);
	}

	// --- Waiting-at-step popover (#124): click the "N waiting here" pill to see who's
	// parked there, with contact links. Fetched on open (not on page load) so big
	// automations stay cheap; only one popover is open at a time.
	type WaitingRow = {
		enrollment_id: number;
		contact_id: number;
		email: string;
		name: string | null;
		next_run_at: string | null;
		attempts: number;
		last_error: string | null;
	};
	type WaitingData = { total: number; rows: WaitingRow[]; limit: number; offset: number; now: string };

	let waitingOpenFor = $state<number | null>(null);
	let waitingData = $state<WaitingData | null>(null);
	let waitingLoading = $state(false);
	let waitingError = $state<string | null>(null);
	let waitingPopEl = $state<HTMLDivElement | undefined>();
	let waitingTriggerBtn: HTMLButtonElement | null = null;

	$effect(() => {
		if (waitingOpenFor !== null && waitingPopEl) waitingPopEl.focus();
	});

	function closeWaiting() {
		const btn = waitingTriggerBtn;
		waitingOpenFor = null;
		waitingData = null;
		waitingError = null;
		waitingLoading = false;
		btn?.focus();
	}

	function toggleWaiting(stepId: number) {
		if (waitingOpenFor === stepId) {
			closeWaiting();
			return;
		}
		waitingOpenFor = stepId;
		waitingData = null;
		waitingError = null;
		loadWaiting(stepId, 0);
	}

	async function loadWaiting(stepId: number, offset: number) {
		waitingLoading = true;
		waitingError = null;
		try {
			const res = await fetch(`/automations/${a.id}/waiting?step=${stepId}&limit=50&offset=${offset}`, {
				credentials: 'same-origin'
			});
			if (!res.ok) throw new Error('request failed');
			waitingData = await res.json();
		} catch {
			waitingError = 'Could not load waiting contacts.';
		} finally {
			waitingLoading = false;
		}
	}

	/** "due in 3h" / "due in 2d" / "due now" (past), or "retrying (n)" when attempts > 0. */
	function dueLabel(nextRunAt: string | null, nowIso: string, attempts: number): string {
		if (attempts > 0) return `retrying (${attempts})`;
		if (!nextRunAt) return '—';
		const due = new Date(nextRunAt.replace(' ', 'T') + 'Z').getTime();
		const now = new Date(nowIso).getTime();
		const diffMs = due - now;
		if (!Number.isFinite(diffMs) || diffMs <= 0) return 'due now';
		const mins = Math.round(diffMs / 60000);
		if (mins < 60) return `due in ${mins}m`;
		const hours = Math.round(mins / 60);
		if (hours < 24) return `due in ${hours}h`;
		const days = Math.round(hours / 24);
		return `due in ${days}d`;
	}

	/** "Show in inspector": filter the inspector to this step, scroll to it, close the popover. */
	async function showWaitingInInspector(stepId: number) {
		closeWaiting();
		inspGo({ step: String(stepId), status: 'active' });
		tabPref = 'inspector';
		await tick();
		inspEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function enrollBadge(status: string): string {
		if (status === 'active') return 'sending';
		if (status === 'completed') return 'sent';
		if (status === 'cancelled') return 'draft';
		if (status === 'failed') return 'failed';
		return 'draft';
	}

	type Step = (typeof data.steps)[number];
	type StepStat = (typeof data.stepStats)[number];

	// Existing tag names (from the trigger list payload) for the tag-step autocomplete.
	const tagNames = $derived(data.lists.filter((l) => l.kind === 'tag').map((l) => l.name));
	// #431: options for the builder's SearchSelect pickers.
	const tagOptions = $derived(tagNames.map((t) => ({ value: t, label: t })));
	const labelOptions = $derived(data.allLabels.map((l) => ({ value: l, label: l })));
	const groupOptions = $derived(groupOptionsFromLists(data.lists));
	const automationOptions = $derived([
		...(editActionKind === 'end_automation' ? [{ value: '__all__', label: 'All other automations' }] : []),
		...data.targetAutomations.map((ta) => ({ value: ta.id, label: ta.name, detail: ta.status }))
	]);

	function statFor(stepId: number): StepStat | undefined {
		return data.stepStats.find((st) => st.step_id === stepId);
	}

	function stepLabel(s: Step): string {
		if (s.type === 'tag') {
			const verb = s.tag_action === 'remove' ? 'Remove tag' : 'Add tag';
			return s.tag_name ? `${verb} “${s.tag_name}”` : `${verb} (choose one)`;
		}
		if (s.type === 'branch') {
			if (s.gate_kind === 'split') return `A/B split — ${s.split_pct ?? 50}% go YES`;
			const set = parseGateRules(s.gate_rules);
			if (set) return `Condition: ${ruleSetLabel(set, ruleNames)}`;
			if (s.gate_kind === 'list-member') return `In “${listName(s.gate_ref_id)}”?`;
			if (s.gate_kind === 'opened') return `Opened “${emailStepSubject(s.gate_ref_id)}”?`;
			if (s.gate_kind === 'clicked') return `Clicked “${emailStepSubject(s.gate_ref_id)}”?`;
			if (s.gate_kind === 'company-metric') {
				const mc = decodeCondition(`${s.gate_name ?? ''}:${s.gate_value ?? ''}`);
				return mc ? `Company: ${conditionLabel(mc, { billing: data.billing })}?` : 'Company metric: set condition…';
			}
			if (s.gate_kind === 'visited') {
				const vc = decodeVisited(s.gate_name, s.gate_value);
				return vc ? `${visitedLabel(vc)}?` : 'Site activity: set condition…';
			}
			if (s.gate_kind === 'pipeline-stage') {
				if (s.gate_value === 'none') return 'Not in the pipeline?';
				if (s.gate_value === 'any') return 'In the pipeline (any stage)?';
				return `In pipeline stage “${stageName(s.gate_ref_id) ?? '(deleted stage)'}”?`;
			}
			if (!s.gate_name) return 'Condition: set condition…';
			return `Condition: ${condPhrase(s)}?`;
		}
		if (s.type === 'end') return 'End automation';
		// #397; #625: names the email an opened / clicked wait watches.
		if (s.type === 'wait') {
			const w = parseWait(s.wait_config);
			// #627: a date-field wait names its field; #626: a rules wait names its conditions.
			return waitText(w, {
				emailSubject: prevEmailOf(s.id)?.subject || null,
				fieldLabel: data.customFields.find((f) => f.key === w?.field)?.label ?? null,
				rulesText: w?.mode === 'rules' ? waitRulesText(w.rules, ruleNames) : null
			});
		}
		if (s.type === 'action') {
			if (s.action_kind === 'goto_step') {
				const ref = stepRef(s.target_step_id);
				return ref ? `Go to «${ref}»` : 'Go to (deleted step)';
			}
			if (s.action_kind === 'end_all_automations') return 'End all other automations';
			if (s.action_kind === 'pipeline_move' || s.action_kind === 'pipeline_remove') return pipelineTitle(s);
			if (s.action_kind === 'set_tier') return s.target_tier ? tierActionTitle(s.target_tier, s.tier_days) : 'Set engagement tier (choose one)';
			if (s.action_kind === 'adjust_score') {
				const c = parseAdjustScore(s.action_config);
				return adjustScoreTitle(c, c ? (data.scores.find((x) => x.id === c.score_id)?.name ?? null) : null);
			}
			const verb = s.action_kind === 'end_automation' ? 'End' : 'Start';
			return s.target_automation_id && s.target_name ? `${verb} “${s.target_name}”` : `${verb} (deleted automation)`;
		}
		return s.subject || 'Untitled email';
	}

	// #221: names for the ids inside a rule set (card summary + tooltip).
	const ruleNames = {
		list: (id: number) => data.lists.find((l) => l.id === id)?.name ?? '(deleted)',
		step: (id: number) => emailStepSubject(id),
		stage: (id: number) => stageName(id) ?? '(deleted stage)',
		company: (id: number) => data.companies.find((c) => c.id === id)?.name ?? '(deleted company)',
		form: (id: number) => data.forms.find((f) => f.id === id)?.name ?? '(deleted form)'
	};
	/** Full rule list for a Condition card's tooltip; undefined for anything else. */
	function stepTooltip(s: Step): string | undefined {
		if (s.type === 'wait') {
			// #626: a rules wait's full rule list.
			const w = parseWait(s.wait_config);
			return w?.mode === 'rules' && w.rules ? ruleSetTitle(w.rules, ruleNames) : undefined;
		}
		if (s.type !== 'branch' || s.gate_kind === 'split') return undefined;
		const set = parseGateRules(s.gate_rules);
		return set ? ruleSetTitle(set, ruleNames) : undefined;
	}

	/** #207: a pipeline stage's name, or null when the id is unset / the stage was deleted. */
	function stageName(id: number | null): string | null {
		return id ? (data.pipelineStages.find((st) => st.id === id)?.name ?? null) : null;
	}
	function pipelineTitle(s: Step): string {
		if (s.action_kind === 'pipeline_move' && !s.target_stage_id) return 'Move to pipeline stage (choose one)';
		return pipelineActionTitle(s.action_kind, stageName(s.target_stage_id), stageName(s.only_from_stage_id), !!s.only_from_stage_id);
	}

	/** Human phrase for the contact-shaped condition kinds a branch can check. */
	function condPhrase(s: Step): string {
		return s.gate_kind === 'no-tag' ? `doesn't have tag “${s.gate_name}”`
			: s.gate_kind === 'field-exists' ? `field “${s.gate_name}” exists`
			: s.gate_kind === 'field-not-exists' ? `field “${s.gate_name}” does not exist`
			: s.gate_kind === 'field-eq' ? `field “${s.gate_name}” = “${s.gate_value ?? ''}”`
			: s.gate_kind === 'field-contains' ? `field “${s.gate_name}” contains “${s.gate_value ?? ''}”`
			: s.gate_kind === 'field-not-contains' ? `field “${s.gate_name}” doesn't contain “${s.gate_value ?? ''}”`
			: `has tag “${s.gate_name}”`;
	}

	/** Lane header text below a Condition node — always shown for both outcomes. */
	function laneLabel(parent: Step, lane: string): string {
		// #397: an event wait's lanes.
		if (parent.type === 'wait') {
			// #626: a rules wait's lanes; without a time limit "Timed out" is never taken.
			const w = parseWait(parent.wait_config);
			if (w?.mode === 'rules') {
				if (lane === 'yes') return `${WAIT_LANE_LABELS.yes} — they matched`;
				return w.timeout_seconds ? `${WAIT_LANE_LABELS.no} — no match in time` : `${WAIT_LANE_LABELS.no} — not used (no time limit)`;
			}
			return lane === 'yes' ? `${WAIT_LANE_LABELS.yes} — the event happened` : `${WAIT_LANE_LABELS.no} — no event in time`;
		}
		if (parent.gate_kind === 'split') {
			const pct = parent.split_pct ?? 50;
			return lane === 'yes' ? `A — ${pct}% go here` : `B — ${100 - pct}% go here`;
		}
		return lane === 'yes' ? 'YES — condition true' : 'NO — condition false';
	}

	function typeName(t: string): string {
		return t === 'tag' ? 'Tag' : t === 'branch' ? 'Condition' : t === 'end' ? 'End' : t === 'action' ? 'Action' : t === 'wait' ? 'Wait' : 'Email';
	}
	// #209: step kind → glyph; a split branch and each action kind get their own.
	function typeGlyph(t: string): IconName {
		return t === 'tag' ? 'tag' : t === 'branch' ? 'condition' : t === 'end' ? 'end-automation' : t === 'action' ? 'action' : t === 'wait' ? 'wait' : 'email-step';
	}
	function stepGlyph(s: { type: string; gate_kind: string | null; action_kind: string | null }): IconName {
		if (s.type === 'branch' && s.gate_kind === 'split') return 'split';
		if (s.type === 'action') {
			if (s.action_kind === 'goto_step') return 'goto';
			if (s.action_kind === 'enroll_automation') return 'start-automation';
			if (s.action_kind === 'end_automation' || s.action_kind === 'end_all_automations') return 'end-automation';
		}
		return typeGlyph(s.type);
	}

	// #398: the checks list and the simulator name steps by id.
	function openStepById(id: number) {
		const s = data.steps.find((x) => x.id === id);
		if (s) openDrawer(s);
	}

	async function openDrawer(s: Step, opener?: HTMLElement | null) {
		// Switching to another step with unsaved edits asks first (#396).
		if (selectedId !== null && selectedId !== s.id && !mayClose(drawerDirty, (m) => confirm(m))) return;
		if (selectedId !== s.id) drawerOpener = opener ?? (document.activeElement as HTMLElement | null);
		selectedId = s.id;
		testResult = null;
		checksReport = null;
		editBlocks = s.body_blocks ?? markdownToBlocks(s.body_md ?? '');
		editPreheader = s.preheader ?? '';
		editSubject = s.subject ?? '';
		editFrom = s.from_email || data.defaultFrom;
		editFromOther = false;
		const d = splitWait(s.delay_before_seconds);
		editDelayValue = d.value;
		editDelayUnit = d.unit;
		editWeekdayOnly = !!s.weekday_only;
		editTagAction = s.tag_action === 'remove' ? 'remove' : 'add';
		editTagName = s.tag_name ?? '';
		editGateMode = s.gate_kind === 'split' ? 'split' : 'rules';
		editRules = parseGateRules(s.gate_rules) ??
			legacyGateToRules(s) ?? { match: 'all', rules: [{ field: 'tag', op: 'has', value: '' }] };
		editSplitPct = s.split_pct ?? 50;
		editStageId = s.target_stage_id ?? '';
		editOnlyFromStageId = s.only_from_stage_id ?? '';
		editActionKind =
			s.action_kind === 'goto_step' || s.action_kind === 'pipeline_move' || s.action_kind === 'pipeline_remove' || s.action_kind === 'set_tier' || s.action_kind === 'adjust_score'
				? s.action_kind
				: s.action_kind === 'end_automation' || s.action_kind === 'end_all_automations'
					? 'end_automation'
					: 'enroll_automation';
		editTargetAutomationId = s.action_kind === 'end_all_automations' ? '__all__' : (s.target_automation_id ?? '');
		editTargetStepId = s.target_step_id ?? '';
		editTier = s.target_tier ?? 'hot';
		editTierUntil = s.tier_days ? 'days' : 'cleared';
		editTierDays = s.tier_days ?? 30;
		{
			const c = parseAdjustScore(s.action_config);
			editScoreId = c?.score_id ?? data.scores[0]?.id ?? '';
			editScoreDelta = c?.points ?? 5;
			editScoreExpires = c?.expires_days ?? '';
		}
		// Prefill engagement tag names from a sensible default when not yet set.
		editTagOnOpenEnabled = !!s.tag_on_open;
		editTagOnOpen = s.tag_on_open ?? `Opened — ${s.subject || 'email'}`;
		editTagOnClickEnabled = !!s.tag_on_click;
		editTagOnClick = s.tag_on_click ?? `Clicked — ${s.subject || 'email'}`;
		// #397: wait-until fields (defaults for a bare / unreadable config).
		const w = parseWait(s.wait_config);
		editWaitMode = w?.mode ?? 'delay';
		// #625: a step never saved opens on the kind chooser; a configured one on its fields.
		waitChoosing = s.type === 'wait' && (!w || s.ready === 0);
		const dw = splitDelay(w?.seconds ?? WAIT_DELAY_DEFAULT);
		editWaitDelayValue = dw.value;
		editWaitDelayUnit = dw.unit;
		editWaitWeekdaysOnly = !!w?.weekdays_only;
		editWaitEvent = w?.event ?? (s.type === 'wait' && !prevEmailOf(s.id) ? 'replied' : 'clicked');
		editWaitPath = w?.path ?? '';
		const tw = splitWait(w?.timeout_seconds ?? WAIT_TIMEOUT_DEFAULT);
		editWaitTimeoutValue = tw.value;
		editWaitTimeoutUnit = tw.unit;
		editWaitDateKind = w?.at ? 'at' : 'next';
		editWaitAt = w?.at ?? '';
		editWaitDay = w?.day ?? 'weekday';
		editWaitTime = w?.time ?? '09:00';
		editWaitStart = w?.start ?? '09:00';
		editWaitEnd = w?.end ?? '17:00';
		editWaitDays = w?.days === 'every' ? 'every' : 'weekdays';
		editWaitField = w?.field ?? '';
		editWaitRelation = w?.relation ?? 'on';
		editWaitOffset = w?.offset ?? 1;
		editWaitOffsetUnit = w?.unit ?? 'days';
		editWaitFieldTime = w?.time && w.mode === 'field_date' ? w.time : '09:00';
		editWaitIfPassed = w?.if_passed ?? 'continue';
		editWaitRules = w?.mode === 'rules' && w.rules ? w.rules : { match: 'all', rules: [{ field: 'tag', op: 'has', value: '' }] };
		editWaitLimitOn = w?.mode === 'rules' ? !!w.timeout_seconds : false;
		baseBlocks = fingerprint(editBlocks);
		baseRest = null;
		await tick(); // let the drawer's widgets settle (rule builder, effects) before the baseline
		baseRest = restState();
		await tick();
		drawerEl?.querySelector<HTMLElement>('#step-drawer-title')?.focus();
	}
	function nodeClick(s: Step, e: Event) {
		if ((e.target as HTMLElement).closest('button, a, form, input, select, .handle')) return;
		if (selectedId === s.id) requestCloseDrawer();
		else openDrawer(s, e.currentTarget as HTMLElement);
	}

	function statusBadge(status: string): string {
		if (status === 'active') return 'sent';
		if (status === 'paused') return 'sending';
		return 'draft';
	}
	function cap(s: string): string {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}
	function pctOf(n: number, d: number): string {
		if (!d) return '—';
		return `${Math.round((n / d) * 100)}%`;
	}

	// ---- #397: exit goals, pause reason, triggers while paused, funnel, timeline ----------
	let goalsOpen = $state(false);
	let goalDraft = $state<ExitRule[]>([]);
	let goalKind = $state<'reply' | 'tag' | 'segment' | 'stage'>('reply');
	let goalTag = $state('');
	let goalList = $state('');
	let goalStage = $state('');
	const goalNames = $derived({
		lists: new Map(data.lists.map((l) => [l.id, l.name])),
		stages: new Map(data.pipelineStages.map((st) => [st.id, st.name]))
	});
	function openGoals() {
		goalDraft = data.exitRules.map((r) => ({ ...r }));
		goalKind = 'reply';
		goalTag = '';
		goalList = '';
		goalStage = '';
		goalsOpen = true;
	}
	const goalAddable = $derived(
		goalKind === 'reply' ? !goalDraft.some((r) => r.kind === 'reply') : goalKind === 'tag' ? !!goalTag.trim() : goalKind === 'segment' ? !!goalList : !!goalStage
	);
	function addGoal() {
		if (!goalAddable) return;
		const rule: ExitRule =
			goalKind === 'reply'
				? { kind: 'reply' }
				: goalKind === 'tag'
					? { kind: 'tag', tag: goalTag.trim() }
					: goalKind === 'segment'
						? { kind: 'segment', list_id: Number(goalList) }
						: { kind: 'stage', stage_id: Number(goalStage) };
		goalDraft = [...goalDraft, rule];
		goalTag = '';
	}
	function removeGoal(i: number) {
		goalDraft = goalDraft.filter((_, j) => j !== i);
	}

	let pauseOpen = $state(false);

	const funnelByStep = $derived(new Map(data.funnel.steps.map((r) => [r.step_id, r])));
	function reachedOf(id: number | undefined): number {
		return id === undefined ? 0 : (funnelByStep.get(id)?.reached ?? 0);
	}
	/** Conversion from the step before (previous in its lane, else its branch / wait). */
	function fromPrevious(id: number): string {
		const prev = data.funnel.predecessors[String(id)];
		return prev === undefined ? '—' : pctOf(reachedOf(id), reachedOf(prev));
	}
	const goalExitTotal = $derived(data.funnel.goals.reduce((n, g) => n + g.n, 0));

	/** Inspector: what a pass at a wait step is waiting for ("Waiting for click (3 days left)"). */
	function passWaiting(e: (typeof data.enrollments)[number]): string | null {
		if (e.status !== 'active') return null;
		const s = data.steps.find((x) => x.id === e.current_step_id);
		if (!s || s.type !== 'wait') return null;
		return waitingText(parseWait(s.wait_config), e.wait_started_at ?? null, e.next_run_at, data.now);
	}
	function stepTitleById(id: number | null): string | null {
		if (id === null) return null;
		const s = data.steps.find((x) => x.id === id);
		return s ? stepLabel(s) : '(deleted step)';
	}
</script>

<svelte:head><title>{a.name}</title></svelte:head>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			if (zoomMenuOpen) {
				zoomMenuOpen = false;
				return;
			}
			if (moreOpen) {
				moreOpen = false;
				return;
			}
			// Waiting popover, then the picker, then the drawers, then the fullscreen
			// canvas — closest overlay first.
			if (waitingOpenFor !== null) closeWaiting();
			else if (waitEdit !== null) closeWait();
			else if (picker !== null) picker = null;
			else if (triggerOpen) closeTrigger();
			else if (selectedId !== null) requestCloseDrawer();
			else if (canvasExpanded) setCanvasExpanded(false);
		}
	}}
	onbeforeunload={(e) => {
		// #396: unsaved drawer edits — the browser shows its own "Leave site?" prompt.
		if (drawerDirty) e.preventDefault();
	}}
	onclick={(e) => {
		if (zoomMenuOpen && zoomMenuEl && !zoomMenuEl.contains(e.target as Node)) zoomMenuOpen = false;
		if (moreOpen && moreEl && !moreEl.contains(e.target as Node)) moreOpen = false;
		if (waitingOpenFor !== null && waitingPopEl && !waitingPopEl.contains(e.target as Node)) {
			closeWaiting();
		}
	}}
/>

<Breadcrumbs items={[{ label: 'Automations', href: '/automations' }, { label: a.name }]} />

<header class="head">
	<div class="title-row">
		{#if renaming}
			<form
				method="POST"
				action="?/rename"
				class="rename"
				bind:this={renameForm}
				use:enhance={() =>
					async ({ update, result }) => {
						await update({ reset: false });
						if (result.type === 'success') stopRename();
					}}
			>
				<input
					name="name"
					value={a.name}
					aria-label="Automation name"
					bind:this={renameInput}
					onblur={renameBlur}
					onkeydown={(e) => {
						if (e.key === 'Escape') {
							e.preventDefault();
							e.stopPropagation();
							stopRename();
						}
					}}
				/>
			</form>
		{:else}
			<h1 class="title">
				<button type="button" class="title-btn" bind:this={renameBtn} onclick={startRename} title="Click to rename">
					{a.name}<span class="title-edit" aria-hidden="true"><Icon name="edit" size={16} /></span>
				</button>
			</h1>
		{/if}
		<span class="badge {statusBadge(a.status)}" title={statusHelp}>{cap(a.status)}</span>
		<div class="labels-row">
			{#each data.labels as l (l)}
				<span class="label-chip">
					{l}
					<form method="POST" action="?/removeLabel" use:enhance class="label-x-form">
						<input type="hidden" name="label" value={l} />
						<button type="submit" class="label-x" title="Remove tag" aria-label="Remove automation tag {l}"><Icon name="close" size={14} /></button>
					</form>
				</span>
			{/each}
			{#if labelAddOpen}
				<form
					method="POST"
					action="?/addLabel"
					class="label-add"
					use:enhance={() =>
						async ({ update, result }) => {
							await update();
							if (result.type === 'success') labelAddOpen = false;
						}}
				>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						onkeydown={(e) => {
							if (e.key === 'Escape') {
								e.stopPropagation();
								labelAddOpen = false;
							}
						}}
					>
						<SearchSelect
							name="label"
							bind:value={labelValue}
							options={labelOptions}
							allowCreate
							maxlength={30}
							placeholder="Add tag…"
							ariaLabel="Add an automation tag"
							bind:this={labelPicker}
						/>
					</span>
					<button type="submit" class="secondary sm" disabled={labelValue === ''}>Add</button>
				</form>
			{:else}
				<button type="button" class="label-plus" onclick={openLabelAdd} title="Tag this automation to group and filter it on the Automations page"><Icon name="add" size={14} /> Tag</button>
			{/if}
		</div>
	</div>
	<div class="head-actions">
		{#if isActive}
			<!-- #397: pause asks for an optional reason (kept in the status history). -->
			{#if pauseOpen}
				<form
					method="POST"
					action="?/pause"
					class="pause-form"
					use:enhance={() =>
						async ({ update }) => {
							await update();
							pauseOpen = false;
						}}
				>
					<input name="reason" maxlength="300" placeholder="Reason (optional)" aria-label="Why are you pausing?" />
					<button type="submit" class="secondary"><Icon name="pause" size={16} /> Pause</button>
					<button type="button" class="secondary" onclick={() => (pauseOpen = false)}>Cancel</button>
				</form>
			{:else}
				<button type="button" class="secondary" onclick={() => (pauseOpen = true)}><Icon name="pause" size={16} /> Pause…</button>
			{/if}
		{:else}
			<form method="POST" action="?/activate" id="activate-form" use:enhance>
				{#if form?.activateConfirm}<input type="hidden" name="confirm" value="1" />{/if}
				{#if form?.activateChecks || form?.checksOk}<input type="hidden" name="checks_ok" value="1" />{/if}
				<button type="submit"><Icon name="activate" size={16} /> {form?.activateConfirm || form?.activateChecks ? 'Activate anyway' : 'Activate'}</button>
			</form>
		{/if}
		<div class="more" bind:this={moreEl}>
			<button
				type="button"
				class="secondary more-btn"
				aria-label="More actions"
				title="More actions"
				aria-haspopup="menu"
				aria-expanded={moreOpen}
				onclick={() => (moreOpen = !moreOpen)}><Icon name="more" size={16} /></button
			>
			{#if moreOpen}
				<div class="more-menu" role="menu">
					<form method="POST" action="?/duplicate" use:enhance>
						<button type="submit" role="menuitem" title="Creates a draft copy — steps, branches, and conditions included.">
							<Icon name="copy" size={16} /> Duplicate
						</button>
					</form>
					<form
						method="POST"
						action="?/delete"
						use:enhance={() =>
							async ({ update }) => {
								moreOpen = false;
								await update();
							}}
					>
						<button type="submit" role="menuitem" class="danger-item" title="Only possible before any emails have sent.">
							<Icon name="delete" size={16} /> Delete
						</button>
					</form>
				</div>
			{/if}
		</div>
	</div>
</header>

<!-- #396: what the status means, since when, and — when live — who's waiting and what's next.
     #427: a plain meta line unless there's something to flag (then a .notice). -->
<p class={statusTone === 'meta' ? 'muted status-meta' : `notice ${statusTone}`} role={statusTone === 'meta' ? undefined : 'status'}>
	<strong>{status.title}.</strong>
	{status.meaning}
	{#if status.detail}<span class="status-detail">{status.detail}</span>{/if}
	{#if data.counts.failed > 0}<span class="status-detail">{fmt(data.counts.failed)} failed — retry from the Enrollment inspector</span>{/if}
</p>

<!-- #397: status history (who paused / activated, when, why). -->
{#if data.statusHistory.length}
	<details class="status-history">
		<summary>Status history ({data.statusHistory.length})</summary>
		<ul>
			{#each data.statusHistory as h (h.id)}
				<li>
					<span class="muted">{h.at} UTC</span>
					{h.from_status ? `${cap(h.from_status)} → ` : ''}<strong>{cap(h.to_status)}</strong>
					{#if h.by_login}<span class="muted">by @{h.by_login}</span>{/if}
					{#if h.reason}— “{h.reason}”{/if}
				</li>
			{/each}
		</ul>
	</details>
{/if}

<!-- #397: contacts that triggered while paused — offered here, never enrolled automatically. -->
{#if data.pendingTriggers > 0}
	<div class="notice warn pending-triggers" role="status">
		<span>
			<strong>{fmt(data.pendingTriggers)}</strong> contact{data.pendingTriggers === 1 ? '' : 's'} triggered this automation while it was paused.
			{#if !isActive}Resume it to enroll them.{/if}
		</span>
		{#if isActive}
			<form method="POST" action="?/enrollPending" use:enhance class="inline">
				{#if form?.pendingPreview}
					<input type="hidden" name="confirm" value="1" />
					<span class="muted">{fmt(form.pendingPreview.eligible)} of {fmt(form.pendingPreview.total)} can be enrolled.</span>
					<button type="submit" class="sm" disabled={form.pendingPreview.eligible === 0}>Enroll {fmt(form.pendingPreview.eligible)}</button>
				{:else}
					<button type="submit" class="sm">Enroll the {fmt(data.pendingTriggers)} contacts that triggered while paused…</button>
				{/if}
			</form>
		{/if}
		<form
			method="POST"
			action="?/discardPending"
			use:enhance
			class="inline"
			onsubmit={(e) => {
				if (!confirm('Forget these contacts? They will not be enrolled.')) e.preventDefault();
			}}
		>
			<button type="submit" class="secondary sm">Dismiss</button>
		</form>
	</div>
{/if}

{#if form?.error && !triggerOpen}<p class="err">{form.error}</p>{/if}
{#if form?.activationProblems?.length}
	<!-- #395: every reason the flow can't go live; a step's row opens it in the drawer. -->
	<ul class="err activation-problems">
		{#each form.activationProblems as p, i (i)}
			{@const target = p.step_id ? data.steps.find((x) => x.id === p.step_id) : undefined}
			<li>
				{#if target}<button type="button" class="linklike" onclick={() => openDrawer(target)}>{p.message}</button>{:else}{p.message}{/if}
			</li>
		{/each}
	</ul>
{/if}
<AutomationChecks automationId={a.id} initial={form?.activateChecks ?? null} onopen={openStepById} />
{#if form?.activateConfirm}
	{#if form.activateConfirm.overdue > 0}
		<p class="notice warn">
			{fmt(form.activateConfirm.overdue)} contact{form.activateConfirm.overdue === 1 ? ' is' : 's are'} overdue and will send within
			minutes of activating. Click <strong>Activate anyway</strong> to go ahead.
		</p>
	{/if}
	{#if form.activateConfirm.segment}
		<p class="notice warn">
			This automation enrolls contacts as they enter segment “{form.activateConfirm.segment.name}” (checked every heartbeat).
			The {fmt(form.activateConfirm.segment.members)} already in it are not new entrants.
			<label><input type="checkbox" name="enroll_existing" value="1" form="activate-form" /> Also enroll the
				{fmt(form.activateConfirm.segment.members)} contact{form.activateConfirm.segment.members === 1 ? '' : 's'} already in this segment?</label>
			Click <strong>Activate anyway</strong> to go ahead.
		</p>
	{/if}
{/if}
{#if form?.labelError}<p class="err">{form.labelError}</p>{/if}

<div class="summary">
	<section class="tile" aria-labelledby="tile-trigger">
		<div class="tile-head">
			<h2 id="tile-trigger"><Icon name={triggerIcon(a.trigger_type)} size={16} /> Trigger</h2>
			<button type="button" class="secondary sm" bind:this={triggerEditBtn} onclick={openTrigger} aria-haspopup="dialog">
				<Icon name="edit" size={16} /> Edit
			</button>
		</div>
		<p class="tile-line" title="{triggerText(a, triggerCtx)} · {reentryText(a.reentry)}">
			{triggerText(a, triggerCtx)} <span class="muted">· {reentryText(a.reentry)}</span>
		</p>
		{#if a.trigger_type === 'subscription_changed'}
			<!-- #444: these passes may run for unsubscribed contacts; the engine never emails them. -->
			<p class="muted">Email steps are skipped for unsubscribed contacts; use tags, pipeline moves or other automations here.</p>
		{/if}
	</section>

	<section class="tile" aria-labelledby="tile-enroll">
		<div class="tile-head">
			<h2 id="tile-enroll"><Icon name="contacts" size={16} /> Enrollments</h2>
			<button type="button" class="secondary sm" onclick={() => (enrollOpen = true)}><Icon name="add" size={16} /> Enroll contacts</button>
		</div>
		<ul class="counts">
			<li><span class="n">{fmt(data.counts.active)}</span> active</li>
			<li><span class="n">{fmt(data.counts.completed)}</span> completed</li>
			<li><span class="n">{fmt(data.counts.cancelled)}</span> cancelled</li>
			<li><span class="n">{fmt(data.counts.failed)}</span> failed</li>
		</ul>
	</section>

	<section class="tile" aria-labelledby="tile-activity">
		<div class="tile-head">
			<h2 id="tile-activity"><Icon name="wait" size={16} /> Activity</h2>
		</div>
		<ul class="counts">
			<li>
				<span class="n">{fmt(waitingTotal)}</span>
				waiting{waitingSteps.length ? ` at ${waitingSteps.length} step${waitingSteps.length === 1 ? '' : 's'}` : ''}
			</li>
			<li><span class="n">{fmt(sentTotal)}</span> email{sentTotal === 1 ? '' : 's'} sent</li>
		</ul>
	</section>

	<!-- #397: exit conditions (goals), checked before every step. -->
	<section class="tile" aria-labelledby="tile-goals">
		<div class="tile-head">
			<h2 id="tile-goals"><Icon name="end-automation" size={16} /> Goals</h2>
			<button type="button" class="secondary sm" onclick={openGoals} aria-haspopup="dialog"><Icon name="edit" size={16} /> Edit</button>
		</div>
		{#if data.exitRules.length}
			<p class="tile-line">
				Exit when: {data.exitRules.map((r) => exitRuleText(r, goalNames)).join(' · ')}
			</p>
		{:else}
			<p class="tile-line muted">No exit goals — contacts run to the end (unsubscribes always leave).</p>
		{/if}
	</section>
</div>

<Modal title="Exit goals" bind:open={goalsOpen}>
	<p class="muted">
		Checked before every step for each contact in the flow. The first goal a contact meets ends their pass early
		(“exited by goal”). Unsubscribes and hard bounces always cancel the pass.
	</p>
	{#if goalDraft.length}
		<ul class="goal-list">
			{#each goalDraft as r, i (i)}
				<li>
					{exitRuleText(r, goalNames)}
					<button type="button" class="iconbtn" aria-label="Remove goal" onclick={() => removeGoal(i)}><Icon name="close" size={14} /></button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">No goals yet.</p>
	{/if}
	<div class="goal-add">
		<select bind:value={goalKind} aria-label="Goal type">
			<option value="reply">Replies to an email</option>
			<option value="tag">Tag is added</option>
			<option value="segment">Matches a list / segment</option>
			<option value="stage">Enters a pipeline stage</option>
		</select>
		{#if goalKind === 'tag'}
			<SearchSelect bind:value={() => goalTag, (v) => (goalTag = String(v))} options={tagOptions} allowCreate maxlength={60} placeholder="tag name" ariaLabel="Tag" />
		{:else if goalKind === 'segment'}
			<SearchSelect
				bind:value={() => goalList, (v) => (goalList = String(v))}
				options={groupOptionsFromLists(data.lists, String)}
				placeholder="Choose…"
				ariaLabel="List or segment"
			/>
		{:else if goalKind === 'stage'}
			<select bind:value={goalStage} aria-label="Pipeline stage">
				<option value="">Choose…</option>
				{#each data.pipelineStages as st (st.id)}<option value={String(st.id)}>{st.name}</option>{/each}
			</select>
		{/if}
		<button type="button" class="secondary sm" disabled={!goalAddable} onclick={addGoal}>Add</button>
	</div>
	<p class="hint muted">Replies and stage moves count only after the contact enrolled; a tag or segment counts as soon as the contact has it. “Tag is added” means a contact tag, not an automation tag.</p>
	<form
		method="POST"
		action="?/setExitRules"
		use:enhance={() =>
			async ({ update, result }) => {
				await update({ reset: false });
				if (result.type === 'success') goalsOpen = false;
			}}
	>
		<input type="hidden" name="exit_rules" value={JSON.stringify(goalDraft)} />
		{#if form?.exitError}<p class="err" role="alert">{form.exitError}</p>{/if}
		<div class="edit-actions">
			<button type="submit">Save goals</button>
			<button type="button" class="secondary" onclick={() => (goalsOpen = false)}>Cancel</button>
		</div>
	</form>
</Modal>

{#if form?.enrollDone}
	<p class="ok enroll-banner">
		Enrolled <strong>{form.enrolled}</strong>
		{#if 'restarted' in form && form.restarted}
			· restarted <strong>{form.restarted}</strong> <span class="muted">(from the first step)</span>
		{/if}
		{#if 'skipText' in form && form.skipText}
			<!-- #705: each skip reason on its own: unsubscribed · archived · already in it · … -->
			· <span class="muted">skipped: {form.skipText}</span>
		{:else if form.skipped}
			· skipped <strong>{form.skipped}</strong> <span class="muted">(unsubscribed, archived, already going through it, or already went through it once)</span>
		{/if}
		{#if 'queued' in form && form.queued}
			· <strong>{fmt(form.queued)}</strong> more queued <span class="muted">(enrolled in batches over the next few minutes)</span>
		{/if}
	</p>
{/if}

{#if form?.retried !== undefined}
	<p class="ok enroll-banner" role="status">
		Retried <strong>{form.retried}</strong> failed enrollment{form.retried === 1 ? '' : 's'}{#if form.stillFailed}
			· <strong>{form.stillFailed}</strong> still failed <span class="muted">(the contact already has an active pass, or the step is gone)</span>{/if}
	</p>
{/if}

<Modal title="Enroll contacts" bind:open={enrollOpen}>
	{#if isActive}
		<p class="muted">
			Add a list or segment's contacts, or specific contacts, to this automation. They start at the first step
			right away. Before you confirm, skipped contacts are listed with the reason.
		</p>
	{:else}
		<p class="enroll-inactive" role="note">
			This automation is {a.status}. Activate it before you enroll contacts — nobody can be added while it's
			{a.status === 'paused' ? 'paused' : 'a draft'}.
		</p>
	{/if}
	<form
		method="POST"
		action="?/enrollList"
		use:enhance={() =>
			async ({ update, result }) => {
				await update();
				// #395: an unconfirmed submit only returns a preview (kept open); the confirmed one enrolls.
				if (result.type === 'success' && !result.data?.enrollPreview) {
					enrollOpen = false; // counts show in the page banner
					enrollPreview = null;
					enrollListId = '';
				}
			}}
		class="enrollform"
	>
		<select
			name="list_id"
			aria-label="List or segment to enroll"
			bind:value={enrollListId}
			onchange={() => (enrollPreview = null)}
			disabled={!isActive}
		>
			<option value="">Choose a list/segment…</option>
			{#each data.lists as l (l.id)}
				<option value={String(l.id)}>{l.name}{l.kind === 'segment' ? ' (segment)' : l.kind === 'tag' ? ' (tag)' : l.kind === 'company' ? ' (company)' : ''}</option>
			{/each}
		</select>
		{#if enrollPreview?.kind === 'list'}
			<input type="hidden" name="confirm" value="1" />
			{#if ignoreEntry}<input type="hidden" name="ignore_entry" value="1" />{/if}
			<button type="submit" disabled={enrollCountOf(enrollPreview) === 0}>Enroll {fmt(enrollCountOf(enrollPreview))}</button>
			<button type="button" class="secondary" onclick={() => (enrollPreview = null)}>Cancel</button>
		{:else}
			<button type="button" disabled={!isActive || !enrollListId || enrollBusy} onclick={() => previewEnroll('list')}>
				{enrollBusy ? 'Counting…' : 'Enroll…'}
			</button>
		{/if}
	</form>
	{#if enrollPreview?.kind === 'list'}
		{@render enrollCount(enrollPreview)}
		{#if enrollPreview.detail}
			{@const d = enrollPreview.detail}
			<p class="muted enroll-preview">
				{fmt(d.members)} in “{d.list_name}” · {fmt(d.eligible)} subscribed · {fmt(d.already)} already in this automation
				→ <strong>{fmt(d.will_enroll)}</strong> will be enrolled{d.queued > 0 ? ` (${fmt(d.now)} now, the rest in batches over the next few minutes)` : ''}.
			</p>
		{/if}
	{/if}

	<hr class="pick-divider" />
	<p class="muted pick-divider-label">or specific contacts</p>

	<form
		method="POST"
		action="?/enrollContacts"
		class="pickform"
		use:enhance={() =>
			async ({ update, result }) => {
				await update();
				if (result.type === 'success') {
					picked = [];
					enrollPreview = null;
					enrollOpen = false; // counts show in the page banner
				}
			}}
	>
		{#each picked as p (p.id)}<input type="hidden" name="contact_ids" value={p.id} />{/each}
		<label class="pick-typeahead">
			<input
				bind:value={pickQuery}
				type="text"
				placeholder="Start typing a name or email…"
				autocomplete="off"
				role="combobox"
				aria-expanded={showPickResults}
				aria-autocomplete="list"
				aria-controls="pick-contacts-listbox"
				oninput={onPickInput}
				onkeydown={onPickKeydown}
				onblur={() => setTimeout(() => (showPickResults = false), 120)}
			/>
			{#if showPickResults}
				<ul class="pick-suggestions" role="listbox" id="pick-contacts-listbox">
					{#each pickResults as s, i (s.id)}
						<li>
							<button
								type="button"
								class="pick-sug"
								class:active={i === pickActiveIdx}
								class:unsubscribed={!s.subscribed}
								role="option"
								aria-selected={i === pickActiveIdx}
								disabled={!s.subscribed}
								onmousedown={(e) => {
									e.preventDefault();
									pickContact(s);
								}}
							>
								<span class="pick-sug-email">{s.email}</span>
								{#if hitName(s)}<span class="pick-sug-name muted">{hitName(s)}</span>{/if}
								{#if !s.subscribed}<span class="pick-sug-unsub">unsubscribed</span>{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</label>
		{#if picked.length > 0}
			<ul class="pick-chips">
				{#each picked as p (p.id)}
					<li class="pick-chip">
						{p.email}
						<button type="button" class="pick-chip-x" aria-label="Remove {p.email}" onclick={() => unpickContact(p.id)}><Icon name="close" size={14} /></button>
					</li>
				{/each}
			</ul>
		{/if}
		{#if enrollPreview?.kind === 'contacts'}
			{@render enrollCount(enrollPreview)}
			<span class="pick-confirm">
				{#if ignoreEntry}<input type="hidden" name="ignore_entry" value="1" />{/if}
				<button type="submit" disabled={enrollCountOf(enrollPreview) === 0}>Enroll {fmt(enrollCountOf(enrollPreview))}</button>
				<button type="button" class="secondary" onclick={() => (enrollPreview = null)}>Cancel</button>
			</span>
		{:else}
			<button type="button" disabled={!isActive || picked.length === 0 || enrollBusy} onclick={() => previewEnroll('contacts')}>
				{enrollBusy ? 'Counting…' : `Enroll ${picked.length}…`}
			</button>
		{/if}
	</form>
	{#if enrollError}<p class="err" role="alert">{enrollError}</p>{/if}
</Modal>

{#snippet enrollCount(p: EnrollPreviewState)}
	{@const n = enrollCountOf(p)}
	{@const otherSkips = p.total - p.eligible - p.entry_blocked}
	<p class="enroll-preview" role="status">
		This will enroll <strong>{fmt(n)}</strong> contact{n === 1 ? '' : 's'}.
		{#if !p.skipped && otherSkips > 0}
			<span class="muted">{fmt(otherSkips)} of {fmt(p.total)} skipped: unsubscribed, archived, already going through it, or already went through it once.</span>
		{/if}
		{#if !p.skipped && p.entry_blocked > 0 && !ignoreEntry}
			<span class="muted">{fmt(p.entry_blocked)} of {fmt(p.total)} don’t match the contact conditions.</span>
		{/if}
		{#if n > 0}Confirm to start them at the first step now.{/if}
	</p>
	{#if p.skipped && p.skipped.length > 0}
		<!-- #678: one row per skipped hand-picked contact; checkboxes post again_ids / restart_ids. -->
		<ul class="enroll-preview enroll-skips">
			{#each p.skipped as s (s.id)}
				<li>
					<span class="skip-email">{s.email}</span> <span class="muted">{SKIP_TEXT[s.reason]}</span>
					{#if s.reason === 'active' || s.reason === 'once'}
						<label class="skip-force">
							<input
								type="checkbox"
								name={s.reason === 'active' ? 'restart_ids' : 'again_ids'}
								value={s.id}
								checked={forcedIds.includes(s.id)}
								onchange={(e) => toggleForced(s.id, e.currentTarget.checked)}
							/>
							{s.reason === 'active' ? 'Restart from the first step' : 'Enroll again'}<span class="sr-only"> for {s.email}</span>
						</label>
					{/if}
				</li>
			{/each}
		</ul>
		{#if p.skippedMore}<p class="enroll-preview muted">and {fmt(p.skippedMore)} more skipped.</p>{/if}
	{/if}
	{#if p.entry_blocked > 0}
		<label class="enroll-preview"><input type="checkbox" bind:checked={ignoreEntry} /> Ignore contact conditions for this enroll</label>
	{/if}
{/snippet}

<section class="card steps">
	<div class="steps-head">
		<h2>Steps</h2>
		<span class="muted">{data.steps.length} step{data.steps.length === 1 ? '' : 's'}</span>
		{#if data.activeEnrollments > 0}
			<span
				class="lock-note"
				title="Adding and reordering steps is safe — each contact continues from the step they're waiting on. Deleting a step moves its waiting contacts to the following step."
			>
				{fmt(data.activeEnrollments)} contact{data.activeEnrollments === 1 ? '' : 's'} mid-flow — editing is safe; deleting a step moves its waiting contacts on
			</span>
		{/if}
		{#if !canvasExpanded}{@render zoomControls()}{/if}
		<button
			type="button"
			class="canvas-expand-btn"
			class:active={canvasExpanded}
			title={canvasExpanded ? 'Exit fullscreen canvas' : 'Expand canvas to fill the page'}
			aria-label={canvasExpanded ? 'Exit fullscreen canvas' : 'Expand canvas to fill the page'}
			aria-pressed={canvasExpanded}
			onclick={() => setCanvasExpanded(!canvasExpanded)}
		>
			<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
				<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</button>
	</div>

	<!-- hidden form used by drag reorder — one lane at a time (#396: branch lanes too) -->
	<form bind:this={reorderForm} method="POST" action="?/reorderSteps" use:enhance class="hidden-form">
		<input type="hidden" name="order" bind:value={reorderOrder} />
		<input type="hidden" name="parent_step_id" value={reorderParent} />
		<input type="hidden" name="branch_label" value={reorderLabel} />
	</form>

	<!--
	  ＋ insertion points: ?/addStep only APPENDS to the containing sibling group (trunk or
	  one branch path), so every ＋ within a group creates the step at that group's END.
	  True mid-insertion would need a chain of ?/moveStep posts after the add — deliberately
	  skipped in v1; use the ↑/↓ controls (node toolbar or the drawer) to slot a new step in.
	-->
	<!-- Zoom −/%/+ (#147). Rendered in the card header, or floating in fullscreen mode. -->
	{#snippet zoomControls()}
		<div class="zoom-ctl" role="group" aria-label="Canvas zoom" bind:this={zoomMenuEl}>
			{#if zoom !== 1}
				<button type="button" class="zoom-chip" title="Reset zoom to 100%" onclick={() => setZoom(1, undefined, true)}>Zoom {zoomLabel(zoom)}</button>
			{/if}
			<button type="button" class="zoom-btn" title="Zoom out (−)" aria-label="Zoom out" disabled={zoom <= ZOOM_MIN} onclick={() => zoomBy(-1)}>−</button>
			<button
				type="button"
				class="zoom-pct"
				title="Zoom level"
				aria-label="Zoom level {zoomLabel(zoom)} — choose a preset"
				aria-haspopup="menu"
				aria-expanded={zoomMenuOpen}
				onclick={() => (zoomMenuOpen = !zoomMenuOpen)}>{zoomLabel(zoom)}</button
			>
			<button type="button" class="zoom-btn" title="Zoom in (+)" aria-label="Zoom in" disabled={zoom >= ZOOM_MAX} onclick={() => zoomBy(1)}>+</button>
			{#if zoomMenuOpen}
				<div class="zoom-menu" role="menu">
					{#each ZOOM_PRESETS as p (p)}
						<button type="button" role="menuitemradio" aria-checked={zoom === p} class:active={zoom === p} onclick={() => pickZoom(p)}>{zoomLabel(p)}</button>
					{/each}
					<button type="button" role="menuitem" onclick={() => pickZoom('fit')}>Fit</button>
				</div>
			{/if}
		</div>
	{/snippet}

	{#snippet insertPoint(parentId: number | null, pathLabel: string | null, depth: number, key: string)}
		<div class="connector" role="presentation">
			<span class="cline"></span>
			<button
				type="button"
				class="plus"
				class:open={picker?.key === key}
				title="Add a step here"
				aria-label="Add a step"
				aria-expanded={picker?.key === key}
				onclick={(e) => togglePicker(e.currentTarget, parentId, pathLabel, depth, key)}>＋</button
			>
			<span class="cline"></span>
		</div>
	{/snippet}

	{#snippet nodeCard(s: Step, depth: number, idx: number, sibCount: number)}
		{@const st = statFor(s.id)}
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div
			id="step-node-{s.id}"
			class="node t-{s.type}"
			class:selected={selectedId === s.id}
			class:dragover={dragOverId === s.id}
			class:dragging={dragId === s.id}
			class:flash={flashId === s.id}
			data-step-id={s.id}
			role="button"
			tabindex="0"
			aria-label="Edit step: {stepLabel(s)}"
			aria-haspopup="dialog"
			onclick={(e) => nodeClick(s, e)}
			onkeydown={(e) => {
				if ((e.target as HTMLElement).closest('button, a, form, input, select, .handle')) return;
				if (e.key === 'Enter' || e.key === ' ') {
					if (e.key === ' ') e.preventDefault();
					nodeClick(s, e);
				}
			}}
		>
			<div class="node-main">
				<span class="glyph t-{s.type}"><Icon name={stepGlyph(s)} size={16} /></span>
				<div class="node-text">
					<span class="node-type"
						>{typeName(s.type)}{#if s.ready === 0}<span
								class="unfinished-badge"
								title="Never saved — contacts who reach it wait here until you finish it">Unfinished</span
							>{/if}</span
					>
					{#if s.type === 'action'}
						<span class="node-title">
							{#if s.action_kind === 'goto_step'}
								{#if stepRef(s.target_step_id)}
									Go to «{stepRef(s.target_step_id)}»
									<a
										href="#step-node-{s.target_step_id}"
										class="goto-link"
										title="Show the target step"
										aria-label="Show the target step"
										onclick={(e) => {
											e.preventDefault();
											showStep(s.target_step_id!);
										}}>↗</a
									>
								{:else}
									Go to <span class="muted">(deleted step)</span>
								{/if}
							{:else if s.action_kind === 'end_all_automations'}
								End all other automations
							{:else if s.action_kind === 'pipeline_move' || s.action_kind === 'pipeline_remove'}
								{pipelineTitle(s)}
							{:else}
								{s.action_kind === 'end_automation' ? 'End' : 'Start'}
								{#if s.target_automation_id && s.target_name}
									«<a href="/automations/{s.target_automation_id}">{s.target_name}</a>»
									{#if s.target_status !== 'active'}
										<span class="target-status-badge" title="Targets aren't run while paused/draft — this step is a no-op until it is.">{s.target_status}</span>
									{/if}
								{:else}
									<span class="muted">(deleted automation)</span>
								{/if}
							{/if}
						</span>
					{:else}
						<span class="node-title" title={stepTooltip(s)}>{stepLabel(s)}</span>
					{/if}
				</div>
			</div>
			{#if (st && (st.waiting > 0 || (s.type === 'email' && st.campaign_id && st.sent))) || (s.type !== 'tag' && (s.tag_on_open || s.tag_on_click))}
				<div class="node-chips">
					{#if st && st.waiting > 0}
						<button
							type="button"
							class="chip waiting"
							title="Active contacts currently parked at this step"
							aria-haspopup="dialog"
							aria-expanded={waitingOpenFor === s.id}
							onclick={(e) => {
								e.stopPropagation();
								waitingTriggerBtn = e.currentTarget as HTMLButtonElement;
								toggleWaiting(s.id);
							}}><Icon name="wait" size={14} /> {st.waiting} waiting here</button
						>
					{/if}
					{#if st && s.type === 'email' && st.campaign_id && st.sent}
						<span class="chip">{st.sent} sent</span>
						<span class="chip">{pctOf(st.opens ?? 0, st.sent ?? 0)} open</span>
						<span class="chip">{pctOf(st.clicks ?? 0, st.sent ?? 0)} click</span>
					{/if}
					{#if s.type !== 'tag' && (s.tag_on_open || s.tag_on_click)}
						<span class="chip" title={[s.tag_on_open && `opens → “${s.tag_on_open}”`, s.tag_on_click && `clicks → “${s.tag_on_click}”`].filter(Boolean).join(' · ')}><Icon name="tag" size={14} /> auto-tag</span>
					{/if}
				</div>
			{/if}
			{#if waitingOpenFor === s.id}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div
					class="waiting-pop"
					role="dialog"
					aria-label="Contacts waiting at this step"
					tabindex="-1"
					bind:this={waitingPopEl}
					style={zoom === 1 ? undefined : `transform: scale(${1 / zoom}); transform-origin: 0 0;`}
					onclick={(e) => e.stopPropagation()}
				>
					<div class="waiting-pop-head">
						<strong>Waiting at this step{waitingData ? ` · ${waitingData.total}` : ''}</strong>
						<button type="button" class="iconbtn" onclick={closeWaiting} aria-label="Close"><Icon name="close" size={14} /></button>
					</div>
					{#if waitingLoading && !waitingData}
						<p class="muted waiting-pop-msg">Loading…</p>
					{:else if waitingError}
						<p class="waiting-pop-msg error">{waitingError}</p>
					{:else if waitingData && waitingData.rows.length === 0}
						<p class="muted waiting-pop-msg">No contacts are waiting here.</p>
					{:else if waitingData}
						<ul class="waiting-pop-list">
							{#each waitingData.rows as r (r.enrollment_id)}
								<li>
									<Avatar contactId={r.contact_id} name={r.name ?? ''} size={20} />
									<span class="waiting-pop-who">
										<a href="/contacts/{r.contact_id}">{r.email}</a>
										{#if r.name}<span class="muted waiting-pop-name">{r.name}</span>{/if}
									</span>
									<span class="muted waiting-pop-due" title={r.last_error ?? undefined}>
										{dueLabel(r.next_run_at, waitingData.now, r.attempts)}
									</span>
								</li>
							{/each}
						</ul>
						<div class="waiting-pop-foot">
							<span class="muted">
								Showing {waitingData.offset + 1}–{waitingData.offset + waitingData.rows.length} of {waitingData.total}
							</span>
							<span class="waiting-pop-actions">
								{#if waitingData.total > waitingData.limit}
									<button
										type="button"
										class="iconbtn"
										disabled={waitingData.offset === 0 || waitingLoading}
										onclick={() => loadWaiting(s.id, Math.max(0, waitingData!.offset - waitingData!.limit))}>Prev</button
									>
									<button
										type="button"
										class="iconbtn"
										disabled={waitingData.offset + waitingData.rows.length >= waitingData.total || waitingLoading}
										onclick={() => loadWaiting(s.id, waitingData!.offset + waitingData!.limit)}>Next</button
									>
								{/if}
								<button type="button" class="secondary sm" onclick={() => showWaitingInInspector(s.id)}>Show in inspector</button>
							</span>
						</div>
					{/if}
				</div>
			{/if}
			<span class="node-tools">
				{#if sibCount > 1}
					<!-- #396: pointer-event drag (mouse + touch) in any lane; ↑ / ↓ are the keyboard path. -->
					<span
						class="handle"
						title="Drag to reorder within this {depth === 0 ? 'flow' : 'lane'}"
						onpointerdown={(e) => onHandleDown(e, s)}
						onpointermove={onHandleMove}
						onpointerup={onHandleUp}
						onpointercancel={onHandleUp}
						role="presentation"
						aria-hidden="true"><Icon name="drag-handle" size={14} /></span
					>
				{/if}
				<form method="POST" action="?/moveStep" use:enhance class="inline">
					<input type="hidden" name="step_id" value={s.id} />
					<input type="hidden" name="dir" value="up" />
					<button type="submit" class="iconbtn" disabled={idx === 0} title="Move up" aria-label="Move up">↑</button>
				</form>
				<form method="POST" action="?/moveStep" use:enhance class="inline">
					<input type="hidden" name="step_id" value={s.id} />
					<input type="hidden" name="dir" value="down" />
					<button type="submit" class="iconbtn" disabled={idx === sibCount - 1} title="Move down" aria-label="Move down">↓</button>
				</form>
				<form method="POST" action="?/deleteStep" use:enhance={deleteEnhance(s)} class="inline" onsubmit={(e) => confirmDelete(e, s)}>
					<input type="hidden" name="step_id" value={s.id} />
					<button type="submit" class="iconbtn del" title="Delete step" aria-label="Delete step"><Icon name="close" size={14} /></button>
				</form>
			</span>
		</div>
	{/snippet}

	{#snippet flowGroup(parentId: number | null, pathLabel: string | null, depth: number)}
		{@const sibs = parentId === null ? trunk : childrenOf(parentId, pathLabel ?? 'yes')}
		{@const gkey = `${parentId ?? 'trunk'}:${pathLabel ?? ''}`}
		{#each sibs as s, i (s.id)}
			{@render insertPoint(parentId, pathLabel, depth, `${gkey}:${i}`)}
			<!-- #396: the wait before a step is its own node on the connector, edited in place.
			     #625: not on a wait step (its timing is its own kind) unless an older one still stores a delay. -->
			{#if s.type !== 'wait' || s.delay_before_seconds}
			<button
				type="button"
				class="wait-chip"
				class:zero={!s.delay_before_seconds}
				class:open={waitEdit?.step.id === s.id}
				title={s.type === 'branch'
					? 'Wait before the condition is checked — click to change'
					: 'Wait before this step — click to change'}
				aria-haspopup="dialog"
				aria-expanded={waitEdit?.step.id === s.id}
				onclick={(e) => openWait(e.currentTarget, s)}
			>
				<Icon name="wait" size={14} /> {waitNodeText(s.delay_before_seconds, !!s.weekday_only, s.type)}
			</button>
			<span class="cline"></span>
			{/if}
			{@render nodeCard(s, depth, i, sibs.length)}
			{#if stepHasLanes(s)}
				{@render branchLanes(s, depth)}
			{/if}
		{/each}
		{@render insertPoint(parentId, pathLabel, depth, `${gkey}:end`)}
	{/snippet}

	{#snippet branchLanes(parent: Step, depth: number)}
		{@const st = statFor(parent.id)}
		{@const yes = st?.went_yes ?? 0}
		{@const no = st?.went_no ?? 0}
		{@const bl = layout.branches.get(parent.id)}
		{@const bw = bl?.width ?? 0}
		<!-- #218: widths come from the subtree layout, so nested branches widen their lane. -->
		<div class="branch-block" style={bl ? `width: ${bw}px;` : undefined}>
			<span class="cline"></span>
			{#if bl}
				<svg class="fork" width={bw} height="24" viewBox="0 0 {bw} 24" aria-hidden="true">
					{#each bl.lanes as ln, i (i)}<path d={forkPath(bw / 2, ln.center, 24)} />{/each}
				</svg>
			{/if}
			<div
				class="lanes"
				style={bl ? `grid-template-columns: ${bl.lanes.map((l) => `${l.width}px`).join(' ')}; column-gap: ${LAYOUT.laneGap}px;` : undefined}
			>
				{#each ['yes', 'no'] as lane (lane)}
					{@const kids = childrenOf(parent.id, lane)}
					<div class="lane {lane}" class:nested={depth > 0} class:empty={kids.length === 0}>
						<div class="lane-head">
							<span class="path-label {lane}">{laneLabel(parent, lane)}</span>
							{#if yes + no > 0}
								<span class="pct-pill {lane}">{pctOf(lane === 'yes' ? yes : no, yes + no)} · {lane === 'yes' ? yes : no}</span>
							{/if}
						</div>
						<div class="lane-flow">
							{#if kids.length === 0}
								<span class="lane-empty muted">empty — skips ahead</span>
							{/if}
							{@render flowGroup(parent.id, lane, depth + 1)}
						</div>
					</div>
				{/each}
			</div>
			{#if bl}
				<svg class="fork" width={bw} height="24" viewBox="0 0 {bw} 24" aria-hidden="true">
					{#each bl.lanes as ln, i (i)}<path d={forkPath(ln.center, bw / 2, 24)} />{/each}
				</svg>
			{/if}
			<span class="rejoin-text muted">paths re-join</span>
		</div>
	{/snippet}

	<span class="sr-only" aria-live="polite">Zoom {zoomLabel(zoom)}</span>
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		class="canvas-scroll"
		class:panning={isPanning}
		class:space-pan={spaceDown}
		class:expanded={canvasExpanded}
		bind:this={canvasScrollEl}
		role="region"
		aria-label="Automation canvas"
		tabindex="0"
		onkeydown={onCanvasKeydown}
		onpointerdown={onCanvasPointerDown}
		onpointermove={onCanvasPointerMove}
		onpointerup={onCanvasPointerUp}
		onpointercancel={onCanvasPointerUp}
		onpointerenter={() => (canvasHover = true)}
		onpointerleave={() => (canvasHover = false)}
		onscroll={onCanvasScroll}
		onclickcapture={onCanvasClickCapture}
	>
		{#if canvasExpanded}
			<div class="canvas-zoom-float">{@render zoomControls()}</div>
			<button
				type="button"
				class="canvas-collapse-btn"
				onclick={() => setCanvasExpanded(false)}
				title="Exit fullscreen (Esc)"
				aria-label="Exit fullscreen canvas"
			>
				<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
					<path
						d="M6 2v2.5A1.5 1.5 0 0 1 4.5 6H2M10 2v2.5A1.5 1.5 0 0 0 11.5 6H14M6 14v-2.5A1.5 1.5 0 0 0 4.5 10H2M10 14v-2.5A1.5 1.5 0 0 1 11.5 10H14"
						fill="none"
						stroke="currentColor"
						stroke-width="1.3"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				Collapse
			</button>
		{/if}
		<div
			class="canvas-world"
			class:ready={viewReady}
			class:animating={animateView}
			style="transform: translate({view.x}px, {view.y}px) scale({view.k});"
		>
			<div class="canvas" bind:this={canvasEl}>
				{#if trunk.length === 0}
					<p class="muted empty">No steps yet. Use ＋ to add an email step and start the sequence.</p>
				{/if}
				<div class="flow-start" aria-hidden="true">Start</div>
				{@render flowGroup(null, null, 0)}
				{#if trunk.length > 0}
					<div class="terminal" aria-hidden="true"><Icon name="end-automation" size={16} /> End of automation</div>
				{/if}
			</div>
		</div>
	</div>
</section>

{#if picker}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="scrim" onclick={() => (picker = null)} aria-hidden="true"></div>
	<div class="picker" class:flip={picker.flip} style="left: {picker.x}px; top: {picker.y}px;" role="menu">
		{#each [['email', 'Email'], ['tag', 'Add / remove tag'], ['branch', 'Condition (Yes / No)'], ['wait', 'Wait'], ['action', 'Action'], ['end', 'End automation']] as [t, label] (t)}
			{#if !((t === 'branch' || t === 'wait') && picker.depth >= 3)}
				<form
					method="POST"
					action="?/addStep"
					use:enhance={() =>
						async ({ update, result }) => {
							await update();
							picker = null;
							// Action steps (#128) aren't useful until a kind + target are chosen —
							// open the drawer straight away instead of leaving a bare node.
							// #397: a new wait step opens too — it isn't ready until saved.
							if ((t === 'action' || t === 'wait') && result.type === 'success' && result.data?.newStepId) {
								const created = data.steps.find((s) => s.id === result.data!.newStepId);
								if (created) openDrawer(created);
							}
						}}
					class="picker-form"
				>
					<input type="hidden" name="type" value={t} />
					{#if picker.parentId !== null}
						<input type="hidden" name="parent_step_id" value={picker.parentId} />
						<input type="hidden" name="branch_label" value={picker.label} />
					{/if}
					<button
						type="submit"
						class="picker-item"
						title={t === 'action' ? 'Start or end another automation, or go to a step' : t === 'wait' ? 'Wait a set time, until a day or time, until they do something, or for a send window' : undefined}
					>
						<span class="picker-glyph t-{t}"><Icon name={typeGlyph(t)} size={16} /></span>{label}
					</button>
				</form>
			{/if}
		{/each}
	</div>
{/if}

{#if waitEdit}
	{@const we = waitEdit}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="scrim" onclick={closeWait} aria-hidden="true"></div>
	<div
		class="picker wait-pop"
		class:flip={we.flip}
		style="left: {we.x}px; top: {we.y}px;"
		role="dialog"
		aria-label={we.step.type === 'branch' ? 'Wait before the condition is checked' : 'Wait before this step'}
		bind:this={waitPopEl}
	>
	<form
		method="POST"
		action="?/setWait"
		class="wait-form"
		use:enhance={() =>
			async ({ update, result }) => {
				await update({ reset: false });
				if (result.type === 'success') closeWait();
			}}
	>
		<input type="hidden" name="step_id" value={we.step.id} />
		<strong class="wait-pop-title">{we.step.type === 'branch' ? 'Wait, then check the condition' : 'Wait before this step'}</strong>
		<span class="delay-inputs">
			<input type="number" name="delay_value" min="0" bind:value={waitValue} aria-label="Wait length" />
			<select name="delay_unit" bind:value={waitUnit} aria-label="Wait unit">
				<option value="minutes">minutes</option>
				<option value="hours">hours</option>
				<option value="days">days</option>
			</select>
		</span>
		<label class="check">
			<input type="checkbox" name="weekday_only" value="1" bind:checked={waitWeekday} />
			Weekdays only
		</label>
		<span class="hint muted">
			{we.step.type === 'branch'
				? 'Contacts wait here first; the condition is checked when the wait ends.'
				: '0 = run as soon as the contact gets here. Weekdays only moves a weekend landing to Monday.'}
		</span>
		<span class="wait-pop-actions">
			<button type="submit" class="sm">Save wait</button>
			<button type="button" class="secondary sm" onclick={closeWait}>Cancel</button>
		</span>
	</form>
	</div>
{/if}

{#if undo}
	<div class="undo-toast" role="status" aria-live="polite">
		{#if undo.error}
			<span>{undo.error}</span>
		{:else}
			<span>Deleted “{undo.label}”.</span>
			<button type="button" class="secondary sm" onclick={undoDelete} disabled={undo.busy}>{undo.busy ? 'Restoring…' : 'Undo'}</button>
		{/if}
		<button type="button" class="iconbtn" aria-label="Dismiss" onclick={() => (undo = null)}><Icon name="close" size={14} /></button>
	</div>
{/if}

{#snippet drawerModeButtons()}
	<span class="drawer-modebtns" role="group" aria-label="Editor width">
				<button
					type="button"
					class="mode-btn"
					class:active={drawerMode === 'docked'}
					title="Dock to the right"
					aria-label="Dock to the right"
					aria-pressed={drawerMode === 'docked'}
					onclick={() => setDrawerMode('docked')}
				>
					<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
						<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" />
						<rect x="9.5" y="2.5" width="5" height="11" rx="1" fill="currentColor" />
					</svg>
				</button>
				<button
					type="button"
					class="mode-btn"
					class:active={drawerMode === 'centered'}
					title="Center as a modal"
					aria-label="Center as a modal"
					aria-pressed={drawerMode === 'centered'}
					onclick={() => setDrawerMode('centered')}
				>
					<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
						<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" />
						<rect x="5" y="4.5" width="6" height="7" rx="1" fill="currentColor" />
					</svg>
				</button>
				<button
					type="button"
					class="mode-btn"
					class:active={drawerMode === 'fullscreen'}
					title="Fill the screen"
					aria-label="Fill the screen"
					aria-pressed={drawerMode === 'fullscreen'}
					onclick={() => setDrawerMode('fullscreen')}
				>
					<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
						<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
				</button>
	</span>
{/snippet}

{#if triggerOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="drawer-backdrop" onclick={closeTrigger} aria-hidden="true"></div>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="drawer mode-{drawerMode}"
		role="dialog"
		aria-modal="true"
		aria-labelledby="trigger-drawer-title"
		tabindex="-1"
		bind:this={triggerDrawerEl}
		onkeydown={(e) => trapFocus(e, triggerDrawerEl)}
	>
		<header class="drawer-head">
			<span class="glyph"><Icon name={triggerIcon(triggerType)} size={16} /></span>
			<h3 id="trigger-drawer-title">Trigger</h3>
			{@render drawerModeButtons()}
			<button type="button" class="iconbtn drawer-close" onclick={closeTrigger} aria-label="Close trigger editor"><Icon name="close" size={16} /></button>
		</header>

		<form method="POST" action="?/setTrigger" use:enhance={saveTrigger} class="trigger step-edit">
			<TriggerTypePicker options={TRIGGER_TYPES} bind:value={triggerType} />

			{#if triggerType === 'manual'}
				<p class="hint muted">Contacts join only when you enroll them — the Enroll contacts button, a bulk bar, the API, or another automation's action step.</p>
			{:else if triggerType === 'list_added'}
				<div class="field">
					<span>When a contact is added to</span>
					<SearchSelect
						name="trigger_list_id"
						value={a.trigger_list_id ?? ''}
						options={groupOptions}
						placeholder="Choose a list/segment/tag…"
						ariaLabel="Trigger list"
					/>
				</div>
			{:else if triggerType === 'company_metric'}
				{#if !data.billing && isBillingMetric(triggerMetric)}
					<!-- #445: a billing trigger seen without billing access — kept as saved, read-only. -->
					<div class="metric-trigger">
						<input type="hidden" name="trigger_metric" value={triggerMetric} />
						<input type="hidden" name="trigger_direction" value={a.trigger_direction === 'below' ? 'below' : 'above'} />
						<input type="hidden" name="trigger_threshold" value={a.trigger_threshold ?? ''} />
						<span class="muted">{BILLING_HIDDEN_LABEL}</span>
					</div>
				{:else}
					<div class="metric-trigger">
						<select name="trigger_metric" bind:value={triggerMetric} aria-label="Company metric">
							{#each triggerMetricGroups as g (g.group)}
								<optgroup label={g.label}>{#each g.metrics as m (m.key)}<option value={m.key}>{m.label}</option>{/each}</optgroup>
							{/each}
						</select>
						<select name="trigger_direction" aria-label="Direction">
							<option value="above" selected={a.trigger_direction !== 'below'}>crosses above</option>
							<option value="below" selected={a.trigger_direction === 'below'}>crosses below</option>
						</select>
						<input name="trigger_threshold" type="number" step="any" value={a.trigger_threshold ?? ''} placeholder="e.g. 10" aria-label="Threshold" />
					</div>
				{/if}
				<p class="hint muted">
					Checked after each Timing / GitHub / Zoho Books sync: when a company's value crosses the threshold
					since the previous sync, all of that company's contacts are enrolled (once — not on every sync). The
					first sync after a company is attached only records a baseline.
					{#if a.trigger_type === 'company_metric'}Now: {triggerLabel(a.trigger_metric, a.trigger_direction, a.trigger_threshold, { billing: data.billing })}.{/if}
				</p>
			{:else if triggerType === 'site_visit'}
				<div class="metric-trigger">
					<select name="trigger_site_id" aria-label="Tracking site">
						<option value="" selected={a.trigger_site_id === null}>on any site</option>
						{#each data.trackingSites as ts (ts.id)}
							<option value={ts.id} selected={ts.id === a.trigger_site_id}>on {ts.name}{ts.enabled ? '' : ' (disabled)'}</option>
						{/each}
					</select>
					<select name="trigger_path_op" aria-label="Path match">
						{#each PATH_OPS as o (o.op)}
							<option value={o.op} selected={(a.trigger_path_op ?? 'contains') === o.op}>{o.label}</option>
						{/each}
					</select>
					<input class="path-input" name="trigger_path" value={a.trigger_path ?? ''} placeholder="/pricing" maxlength="300" aria-label="Page path" />
					<label class="cooldown">
						cooldown
						<input name="trigger_cooldown_hours" type="number" min="0" step="1" value={a.trigger_cooldown_hours ?? DEFAULT_COOLDOWN_HOURS} aria-label="Cooldown (hours)" />
						h
					</label>
				</div>
				<p class="hint muted">
					Checked as each page view arrives from the tracking snippet (known contacts only). After the trigger
					enrolls a contact it waits out the cooldown before it can fire for them again, so a refresh doesn't
					re-trigger; the re-entry setting below still applies. <code>*</code> matches anything, e.g.
					<code>/blog/*</code>.
					{#if !data.trackingSites.length}No tracking sites yet — add one in Settings → Tracking.{/if}
					{#if a.trigger_type === 'site_visit'}Now: {siteTriggerLabel(a.trigger_path_op, a.trigger_path, data.trackingSites.find((ts) => ts.id === a.trigger_site_id)?.name ?? (a.trigger_site_id ? '(deleted site)' : null), a.trigger_cooldown_hours)}.{/if}
				</p>
			{:else if triggerType === 'pipeline_stage_entered'}
				<label class="field">
					<span>When a contact enters the stage</span>
					<select name="trigger_stage_id" aria-label="Pipeline stage">
						<option value="">Choose a stage…</option>
						{#each data.pipelineStages as st (st.id)}
							<option value={st.id} selected={st.id === a.trigger_stage_id}>{st.name}</option>
						{/each}
					</select>
				</label>
				<p class="hint muted">
					Fires when a card is added to the stage or moved into it — by anyone: a drag on the board, the
					contact page, the API, or another automation. A move made by this automation's own steps never
					re-triggers it. The re-entry setting below still applies.
					{#if a.trigger_type === 'pipeline_stage_entered'}Now: enters “{stageName(a.trigger_stage_id) ?? '(deleted stage)'}”.{/if}
				</p>
			{:else if isEngagementKind(triggerType)}
				<!-- #412: opens / clicks — one component, its config posted as trigger_config JSON. -->
				<EngagementTriggerFields
					automationId={a.id}
					kind={triggerType}
					config={isEngagementKind(a.trigger_type) ? parseEngagementConfig(a.trigger_type, a.trigger_config) : defaultEngagementConfig()}
					names={data.triggerEmails}
					lists={data.lists.filter((l) => l.kind !== 'company')}
					entry={contactConditions}
				/>
			{:else if triggerType === 'site_activity'}
				<!-- #434: "Visits the site often" — its config posted as trigger_config JSON. -->
				<SiteActivityTriggerFields
					config={a.trigger_type === 'site_activity' ? parseSiteActivityConfig(a.trigger_config) : defaultSiteActivityConfig()}
					sites={data.trackingSites}
				/>
			{:else if triggerType === 'subscription_changed'}
				<!-- #444: "Subscription changes" — its config posted as trigger_config JSON. -->
				<SubscriptionTriggerFields
					config={a.trigger_type === 'subscription_changed' ? parseSubscriptionConfig(a.trigger_config) : defaultSubscriptionConfig()}
					topics={data.lists.filter((l) => l.kind === 'list')}
				/>
			{:else if triggerType === 'score_changed'}
				<!-- #467: "Score changes" — its config posted as trigger_config JSON. -->
				<ScoreTriggerFields
					config={a.trigger_type === 'score_changed' ? parseScoreTriggerConfig(a.trigger_config) : null}
					scores={data.scores}
				/>
			{:else if triggerType === 'form_submitted'}
				<!-- #516: "Form submitted" — its config posted as trigger_config JSON. -->
				<FormTriggerFields config={parseFormTriggerConfig(a.trigger_type === 'form_submitted' ? a.trigger_config : null)} forms={data.forms} />
			{/if}

			{#if !isEngagementKind(triggerType)}
				<!-- #448: one Conditions area; the engagement fields render it with their "About this event" rows. -->
				<EntryConditions {...contactConditions} />
			{/if}

			<fieldset class="reentry">
				<legend class="reentry-label">Contacts can go through this automation</legend>
				<label class="radio">
					<input type="radio" name="reentry" value="once" bind:group={reentryChoice} />
					Once only
				</label>
				<label class="radio">
					<input type="radio" name="reentry" value="multiple" bind:group={reentryChoice} />
					Multiple times <span class="muted">(re-enter after a pass ends; one active pass at a time)</span>
				</label>
			</fieldset>

			{#if data.topics.length || a.topic_list_id}
				<div class="topic-field">
					<span class="reentry-label">Emails belong to topic <span class="muted">(optional)</span></span>
					<SearchSelect
						bind:value={() => topicChoice, (v) => (topicChoice = String(v))}
						options={data.topics.map((t) => ({ value: String(t.id), label: t.label }))}
						allowEmpty={{ label: 'No topic' }}
						ariaLabel="Topic"
					/>
					<span class="muted">Contacts who opted out of this topic on the preference page skip its emails; the flow continues.</span>
				</div>
			{/if}

			{#if triggerError}<p class="err drawer-err" role="alert">{triggerError}</p>{/if}

			<div class="edit-actions">
				<button type="submit" disabled={triggerSaving}>{triggerSaving ? 'Saving…' : 'Save'}</button>
				<button type="button" class="secondary" onclick={closeTrigger}>Cancel</button>
			</div>
		</form>
	</div>
{/if}

{#if selected}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="drawer-backdrop" onclick={requestCloseDrawer} aria-hidden="true"></div>
	<!-- #396: a real dialog — labelled, focus kept inside, Esc / close respect unsaved changes,
	     focus goes back to the step that opened it. -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="drawer mode-{drawerMode}"
		role="dialog"
		aria-modal="true"
		aria-labelledby="step-drawer-title"
		tabindex="-1"
		bind:this={drawerEl}
		onkeydown={(e) => trapFocus(e, drawerEl)}
	>
		<header class="drawer-head">
			<span class="glyph t-{selected.type}"><Icon name={stepGlyph(selected)} size={16} /></span>
			<h3 id="step-drawer-title" tabindex="-1">{typeName(selected.type)} step</h3>
			{#if drawerDirty}<span class="dirty-dot" title="Unsaved changes">Unsaved</span>{/if}
			{@render drawerModeButtons()}
			<button type="button" class="iconbtn drawer-close" onclick={requestCloseDrawer} aria-label="Close editor"><Icon name="close" size={16} /></button>
		</header>

		<div class="drawer-tools">
			<form method="POST" action="?/moveStep" use:enhance class="inline">
				<input type="hidden" name="step_id" value={selected.id} />
				<input type="hidden" name="dir" value="up" />
				<button type="submit" class="secondary sm" disabled={selIdx === 0}>↑ Move up</button>
			</form>
			<form method="POST" action="?/moveStep" use:enhance class="inline">
				<input type="hidden" name="step_id" value={selected.id} />
				<input type="hidden" name="dir" value="down" />
				<button type="submit" class="secondary sm" disabled={selIdx === selSibs.length - 1}>↓ Move down</button>
			</form>
			<form method="POST" action="?/duplicateStep" use:enhance class="inline">
				<input type="hidden" name="step_id" value={selected.id} />
				<button
					type="submit"
					class="secondary sm"
					title={selected.type === 'branch' ? 'Copies this condition with both lanes and every step in them' : 'Copies this step right after itself'}
					>{selected.type === 'branch' ? 'Duplicate with lanes' : 'Duplicate'}</button
				>
			</form>
			<form
				method="POST"
				action="?/deleteStep"
				use:enhance={deleteEnhance(selected)}
				class="inline push-right"
				onsubmit={(e) => confirmDelete(e, selected!)}
			>
				<input type="hidden" name="step_id" value={selected.id} />
				<button type="submit" class="secondary sm del-btn">Delete</button>
			</form>
		</div>

		{#if form?.error && 'stepId' in form && form.stepId === selected.id}
			<p class="err drawer-err">{form.error}</p>
		{/if}

		{#if selected.type === 'end'}
			<p class="muted drawer-note">
				Contacts reaching this step stop here — the enrollment completes. Nothing to configure.
			</p>
		{:else}
			<form
				method="POST"
				action="?/updateStep"
				use:noImplicitSubmit
				bind:this={stepFormEl}
				use:enhance={() =>
					async ({ update, result }) => {
						await update({ reset: false });
						if (result.type === 'success') closeDrawerNow();
					}}
				class="step-edit"
			>
				<input type="hidden" name="step_id" value={selected.id} />

				{#if selected.type === 'wait'}
					<!-- #625: a wait step's timing is its own kind ("A set period of time"); the generic delay
					     is hidden. An older step that still stores one keeps it, shown on one line. -->
					<input type="hidden" name="delay_value" value={editDelayValue} />
					<input type="hidden" name="delay_unit" value={editDelayUnit} />
					{#if editWeekdayOnly && editDelayValue > 0}<input type="hidden" name="weekday_only" value="1" />{/if}
					{#if editDelayValue > 0}
						<p class="hint muted also-waits">
							Also waits {delayText(editDelayValue * (editDelayUnit === 'days' ? 86400 : editDelayUnit === 'hours' ? 3600 : 60))}{editWeekdayOnly
								? ' (weekdays only)'
								: ''} before this starts.
							<button type="button" class="secondary sm" onclick={() => (editDelayValue = 0)}>Remove the extra wait</button>
						</p>
					{/if}
				{:else}
				<div class="row">
					<label class="field delay-field">
						<span>{selected.type === 'branch' ? 'Wait before the condition is checked' : 'Wait before this step'}</span>
						<span class="delay-inputs">
							<input type="number" name="delay_value" min="0" bind:value={editDelayValue} />
							<select name="delay_unit" bind:value={editDelayUnit}>
								<option value="minutes">minutes</option>
								<option value="hours">hours</option>
								<option value="days">days</option>
							</select>
						</span>
						<span class="hint muted">0 = run as soon as the contact reaches this step.</span>
					</label>
				</div>

				<div class="row">
					<label class="check">
						<input type="checkbox" name="weekday_only" value="1" bind:checked={editWeekdayOnly} />
						Weekdays only
					</label>
					<span class="hint muted">If this would land on a weekend, send Monday at the same time instead.</span>
				</div>
				{/if}

				{#if selected.type === 'branch'}
					<div class="row two">
						<label class="field">
							<span>Condition type</span>
							<select name="gate_mode" bind:value={editGateMode}>
								<option value="rules">Rules: match contacts on one or more conditions</option>
								<option value="split">A/B split (random %)</option>
							</select>
						</label>
						{#if editGateMode === 'split'}
							<input type="hidden" name="gate_kind" value="split" />
							<label class="field">
								<span>% of contacts going YES</span>
								<input type="number" name="split_pct" min="0" max="100" bind:value={editSplitPct} />
							</label>
						{/if}
					</div>
					{#if editGateMode === 'rules'}
						<input type="hidden" name="gate_rules" value={JSON.stringify(editRules)} />
						<div class="rule-set">
							<RuleBuilder
								bind:rules={editRules}
								noun="rule"
								metrics={ruleMetrics}
								companies={data.companies}
								stages={data.pipelineStages}
								topics={contactConditions.topics}
								tags={contactConditions.tags}
								scores={data.scores}
								fields={data.customFields}
								forms={data.forms}
								automation={{
									lists: memberGroups,
									emailSteps: emailSteps
										.filter((es) => es.id !== selected!.id)
										.map((es) => ({ id: es.id, label: es.subject || 'Untitled email' }))
								}}
							/>
						</div>
						{#if editRulesProblem}<p class="err rule-err">{editRulesProblem}</p>{/if}
						<p class="hint muted">
							Contacts that match continue down YES; the rest go down NO. To stop them, put an End step in the NO lane.
						</p>
						<p class="hint muted">
							Rules are checked when the contact reaches this step, so an email-step rule only sees engagement
							recorded <em>by then</em> — put a wait before it.
						</p>
					{:else}
						<p class="hint muted">
							Contacts are split at random: this share runs the YES path, the rest run NO. Both paths re-join the
							main flow below the branch.
						</p>
					{/if}
				{:else if selected.type === 'wait'}
					<!-- #625: pick the kind of wait first — a set period (the default), a day or time, an event
					     (with a timeout and two lanes), or a send window — then only that kind's fields. -->
					<input type="hidden" name="wait_mode" value={editWaitMode} />
					{#if waitChoosing}
						<fieldset class="wait-kinds">
							<legend>The contact will wait:</legend>
							{#each WAIT_KIND_CHOICES as k (k.mode)}
								<button
									type="button"
									class="wait-kind"
									class:current={editWaitMode === k.mode}
									aria-pressed={editWaitMode === k.mode}
									disabled={waitKindLocked && !waitModeHasLanes(k.mode)}
									onclick={() => pickWaitKind(k.mode)}
								>
									<strong>{k.title}</strong>
									<span class="muted">{k.example}</span>
								</button>
							{/each}
							{#if waitKindLocked}
								<p class="hint muted">
									Only “Until they do something” and “Until specific conditions are met” have “Did it” and “Timed out”
									paths, and this wait has steps in them. Empty both paths to pick another kind.
								</p>
							{/if}
						</fieldset>
					{:else}
						<p class="wait-kind-head">
							<strong>{WAIT_KIND_CHOICES.find((k) => k.mode === editWaitMode)?.title}</strong>
							<button type="button" class="secondary sm" onclick={() => (waitChoosing = true)}>Back</button>
						</p>
					{/if}
					<div class="wait-fields" hidden={waitChoosing}>
					{#if editWaitMode === 'delay'}
						<div class="row">
							<label class="field delay-field">
								<span>Wait for</span>
								<span class="delay-inputs">
									<input type="number" name="wait_delay_value" min="1" bind:value={editWaitDelayValue} />
									<select name="wait_delay_unit" bind:value={editWaitDelayUnit}>
										<option value="minutes">minutes</option>
										<option value="hours">hours</option>
										<option value="days">days</option>
										<option value="weeks">weeks</option>
									</select>
								</span>
								<span class="hint muted">From 1 minute to 365 days, counted from when the contact reaches this step.</span>
							</label>
						</div>
						<div class="row">
							<label class="check">
								<input type="checkbox" name="wait_weekdays_only" value="1" bind:checked={editWaitWeekdaysOnly} />
								Weekdays only
							</label>
							<span class="hint muted">If the wait ends on a weekend, continue Monday at the same time (Settings → Timezone).</span>
						</div>
					{:else if editWaitMode === 'event'}
						<div class="row two">
							<label class="field">
								<span>Event</span>
								<select name="wait_event" bind:value={editWaitEvent}>
									{#if selectedPrevEmail || editWaitEvent === 'opened'}<option value="opened">Opens {prevEmailName}</option>{/if}
									{#if selectedPrevEmail || editWaitEvent === 'clicked'}<option value="clicked">Clicks {prevEmailName}</option>{/if}
									<option value="replied">Replies</option>
									<option value="visited">Visits a page</option>
								</select>
							</label>
							<label class="field">
								<span>Give up after</span>
								<span class="delay-inputs">
									<input type="number" name="wait_timeout_value" min="1" bind:value={editWaitTimeoutValue} />
									<select name="wait_timeout_unit" bind:value={editWaitTimeoutUnit}>
										<option value="hours">hours</option>
										<option value="days">days</option>
									</select>
								</span>
							</label>
						</div>
						{#if editWaitEvent === 'visited'}
							<label class="field">
								<span>Page path contains</span>
								<input name="wait_path" bind:value={editWaitPath} placeholder="/pricing" maxlength="200" />
							</label>
						{/if}
						{#if !selectedPrevEmail && (editWaitEvent === 'opened' || editWaitEvent === 'clicked')}
							<p class="err">{NO_PREVIOUS_EMAIL}</p>
						{/if}
						<p class="hint muted">
							Checked every few minutes. When it happens the contact goes down “Did it”; at the timeout they go down
							“Timed out”. Either path can stay empty — then the flow simply continues after this step. Opens and
							clicks count on the last email this contact got in this pass ({prevEmailName} on the usual path); Apple
							Mail auto-opens don't count. If no email was sent in this pass, the contact goes down “Timed out” at once.
						</p>
					{:else if editWaitMode === 'date'}
						<div class="row">
							<label class="radio"><input type="radio" name="wait_date_kind" value="next" bind:group={editWaitDateKind} /> The next…</label>
							<label class="radio"><input type="radio" name="wait_date_kind" value="at" bind:group={editWaitDateKind} /> A fixed date</label>
						</div>
						{#if editWaitDateKind === 'at'}
							<label class="field">
								<span>Date and time</span>
								<input type="datetime-local" name="wait_at" bind:value={editWaitAt} />
							</label>
						{:else}
							<div class="row two">
								<label class="field">
									<span>Day</span>
									<select name="wait_day" bind:value={editWaitDay}>
										{#each WAIT_DAYS as d (d)}<option value={d}>{WAIT_DAY_LABELS[d]}</option>{/each}
									</select>
								</label>
								<label class="field">
									<span>At</span>
									<input type="time" name="wait_time" bind:value={editWaitTime} />
								</label>
							</div>
						{/if}
						<p class="hint muted">In Settings → Timezone time. A fixed date that has passed doesn't wait.</p>
					{:else if editWaitMode === 'field_date'}
						<!-- #627: a date custom field, on / before / after it, at a time of day. -->
						<label class="field">
							<span>Date field</span>
							<select name="wait_field" bind:value={editWaitField}>
								<option value="">Choose a date field…</option>
								{#each dateFields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
							</select>
						</label>
						{#if dateFields.length === 0}
							<p class="hint muted">There are no custom fields of type Date yet. Add one in Settings → Custom fields.</p>
						{/if}
						<div class="row two">
							<label class="field">
								<span>Continue</span>
								<select name="wait_relation" bind:value={editWaitRelation}>
									<option value="on">On the date</option>
									<option value="before">Before the date</option>
									<option value="after">After the date</option>
								</select>
							</label>
							<label class="field">
								<span>At</span>
								<input type="time" name="wait_field_time" bind:value={editWaitFieldTime} />
							</label>
						</div>
						{#if editWaitRelation !== 'on'}
							<label class="field delay-field">
								<span>{editWaitRelation === 'before' ? 'How long before' : 'How long after'}</span>
								<span class="delay-inputs">
									<input type="number" name="wait_offset" min="1" bind:value={editWaitOffset} />
									<select name="wait_offset_unit" bind:value={editWaitOffsetUnit}>
										<option value="hours">hours</option>
										<option value="days">days</option>
										<option value="weeks">weeks</option>
									</select>
								</span>
							</label>
						{/if}
						<fieldset class="field">
							<legend>If the date has already passed</legend>
							<label class="radio"><input type="radio" name="wait_if_passed" value="continue" bind:group={editWaitIfPassed} /> Continue to the next step</label>
							<label class="radio"><input type="radio" name="wait_if_passed" value="exit" bind:group={editWaitIfPassed} /> End this contact’s pass</label>
						</fieldset>
						<p class="hint muted">
							The field is read again every few hours, so changing a contact’s date moves their wait. An empty or unreadable
							date counts as already passed. Times are in Settings → Timezone.
						</p>
					{:else if editWaitMode === 'rules'}
						<!-- #626: wait until the contact matches these rules (the Condition step's builder). -->
						<input type="hidden" name="wait_rules" value={JSON.stringify(editWaitRules)} />
						<div class="rule-set">
							<RuleBuilder
								bind:rules={editWaitRules}
								noun="condition"
								metrics={ruleMetrics}
								companies={data.companies}
								stages={data.pipelineStages}
								topics={contactConditions.topics}
								tags={contactConditions.tags}
								scores={data.scores}
								fields={data.customFields}
								forms={data.forms}
								automation={{ lists: memberGroups, emailSteps: [], noStepRules: true }}
							/>
						</div>
						{#if editWaitRulesProblem}<p class="err rule-err">{editWaitRulesProblem}</p>{/if}
						<div class="row">
							<label class="check">
								<input type="checkbox" name="wait_limit" value="1" bind:checked={editWaitLimitOn} />
								Set a time limit
							</label>
							{#if editWaitLimitOn}
								<span class="delay-inputs">
									<span>Continue anyway after</span>
									<input type="number" name="wait_timeout_value" min="1" bind:value={editWaitTimeoutValue} aria-label="Time limit" />
									<select name="wait_timeout_unit" bind:value={editWaitTimeoutUnit} aria-label="Time limit unit">
										<option value="hours">hours</option>
										<option value="days">days</option>
									</select>
								</span>
							{/if}
						</div>
						<p class="hint muted">
							Checked every few minutes. When the contact matches they go down “Did it”.
							{#if editWaitLimitOn}
								If they still don't match after the time limit (1 hour to 90 days), they go down “Timed out”.
							{:else}
								<strong>No time limit:</strong> a contact who never matches waits here for good — “Timed out” is never used.
							{/if}
							Either path can stay empty — then the flow simply continues after this step. To wait for an open or a
							click, choose “Until they do something”.
						</p>
					{:else}
						<div class="row two">
							<label class="field">
								<span>From</span>
								<input type="time" name="wait_start" bind:value={editWaitStart} />
							</label>
							<label class="field">
								<span>Until</span>
								<input type="time" name="wait_end" bind:value={editWaitEnd} />
							</label>
						</div>
						<label class="field">
							<span>On</span>
							<select name="wait_days" bind:value={editWaitDays}>
								<option value="weekdays">Monday – Friday</option>
								<option value="every">Every day</option>
							</select>
						</label>
						<p class="hint muted">Contacts who get here outside the window wait until it opens (Settings → Timezone time).</p>
					{/if}
					</div>
				{:else if selected.type === 'tag'}
					<div class="row two">
						<label class="field">
							<span>Action</span>
							<select name="tag_action" bind:value={editTagAction}>
								<option value="add">Add tag</option>
								<option value="remove">Remove tag</option>
							</select>
						</label>
						<div class="field">
							<span>Tag</span>
							<SearchSelect
								name="tag_name"
								bind:value={() => editTagName, (v) => (editTagName = String(v))}
								options={tagOptions}
								allowCreate
								placeholder="tag name"
								ariaLabel="Tag"
							/>
						</div>
					</div>
					<p class="hint muted">Adds or removes this contact tag on the contact when they reach this step. Adding a new name creates the tag. (Not the same as the automation tags next to the name, which only organise automations.)</p>
				{:else if selected.type === 'action'}
					<div class="row">
						<label class="radio">
							<input type="radio" name="action_kind" value="enroll_automation" bind:group={editActionKind} />
							Start an automation
						</label>
						<label class="radio">
							<input type="radio" name="action_kind" value="end_automation" bind:group={editActionKind} />
							End another automation
						</label>
						<label class="radio">
							<input type="radio" name="action_kind" value="goto_step" bind:group={editActionKind} />
							Go to a step
						</label>
						<label class="radio">
							<input type="radio" name="action_kind" value="pipeline_move" bind:group={editActionKind} />
							Move to pipeline stage
						</label>
						<label class="radio">
							<input type="radio" name="action_kind" value="pipeline_remove" bind:group={editActionKind} />
							Remove from pipeline
						</label>
						<label class="radio">
							<input type="radio" name="action_kind" value="set_tier" bind:group={editActionKind} />
							Set engagement tier
						</label>
						<label class="radio">
							<input type="radio" name="action_kind" value="adjust_score" bind:group={editActionKind} />
							Adjust score
						</label>
					</div>
					{#if editActionKind === 'adjust_score'}
						<div class="row two">
							<label class="field">
								<span>Score</span>
								<select name="target_score_id" bind:value={editScoreId}>
									<option value="">Choose a score…</option>
									{#each data.scores as sc (sc.id)}<option value={sc.id}>{sc.name}</option>{/each}
								</select>
							</label>
							<label class="field">
								<span>Points (± whole number)</span>
								<input
									type="number"
									name="score_delta"
									min={SCORE_LIMITS.minPoints}
									max={SCORE_LIMITS.maxPoints}
									step="1"
									bind:value={editScoreDelta}
								/>
							</label>
						</div>
						<label class="field">
							<span>Points expire after (days, blank = never)</span>
							<input
								type="number"
								name="score_expires_days"
								min={SCORE_LIMITS.minExpiryDays}
								max={SCORE_LIMITS.maxExpiryDays}
								placeholder="never"
								bind:value={editScoreExpires}
								style="width: 8em"
							/>
						</label>
						<p class="hint muted">
							Adds the points to the contact's score (a negative number takes points away). They show in the
							contact's score history as “Set by an automation” and count like any other points.
						</p>
					{:else if editActionKind === 'set_tier'}
						<div class="row two">
							<label class="field">
								<span>Tier</span>
								<select name="target_tier" bind:value={editTier}>
									{#each TIERS as t (t)}<option value={t}>{TIER_LABELS[t]}</option>{/each}
									<option value="clear">Back to automatic (clear the override)</option>
								</select>
							</label>
							{#if editTier !== 'clear'}
								<fieldset class="field">
									<legend>How long</legend>
									<label class="radio">
										<input type="radio" name="tier_until" value="cleared" bind:group={editTierUntil} />
										Until cleared
									</label>
									<label class="radio">
										<input type="radio" name="tier_until" value="days" bind:group={editTierUntil} />
										For
										<input
											type="number"
											name="tier_days"
											min="1"
											max={TIER_OVERRIDE_DAYS_MAX}
											bind:value={editTierDays}
											disabled={editTierUntil !== 'days'}
											aria-label="Number of days"
											style="width: 5em"
										/>
										days
									</label>
								</fieldset>
							{/if}
						</div>
						<p class="hint muted">
							Overrides the contact's engagement tier. The automatic score keeps computing underneath and
							takes over again when the override is cleared or its days run out.
						</p>
					{:else if editActionKind === 'pipeline_move'}
						<div class="row two">
							<label class="field">
								<span>Move to stage</span>
								<select name="target_stage_id" bind:value={editStageId}>
									<option value="">Choose a stage…</option>
									{#each data.pipelineStages as st (st.id)}<option value={st.id}>{st.name}</option>{/each}
								</select>
							</label>
							<label class="field">
								<span>Only if currently in</span>
								<select name="only_from_stage_id" bind:value={editOnlyFromStageId}>
									<option value="">Any stage (or not on the board)</option>
									{#each data.pipelineStages.filter((st) => st.id !== editStageId) as st (st.id)}<option value={st.id}>{st.name}</option>{/each}
								</select>
							</label>
						</div>
						<p class="hint muted">
							Moves the contact's pipeline card to this stage, or adds them to the board there if they aren't
							on it. With “only if currently in” set, contacts in any other stage (or not on the board) are
							skipped. The card's history shows this automation as the mover.
						</p>
					{:else if editActionKind === 'pipeline_remove'}
						<p class="hint muted">Takes the contact's card off the pipeline board (its history is kept). No-op if they aren't on it.</p>
					{:else if editActionKind === 'goto_step'}
						<label class="field">
							<span>Step to go to</span>
							<select name="target_step_id" bind:value={editTargetStepId}>
								<option value="">Choose a step…</option>
								{#each gotoGroups as g, gi (gi)}
									{@const opts = g.steps.filter((gs) => gs.id !== selected!.id)}
									{#if opts.length > 0}
										<optgroup label={g.label}>
											{#each opts as gs (gs.id)}
												<option value={gs.id}>{stepRef(gs.id)}</option>
											{/each}
										</optgroup>
									{/if}
								{/each}
							</select>
						</label>
						<p class="hint muted">
							Move this contact to another step in this automation. They wait that step's own delay, then
							continue from there. Loops stop after 25 jumps per pass.
						</p>
					{:else}
						<div class="field">
							<span>Target automation</span>
							<SearchSelect
								name="target_automation_id"
								bind:value={() => editTargetAutomationId, (v) => (editTargetAutomationId = v === '__all__' || v === '' ? v : Number(v))}
								options={automationOptions}
								placeholder="Choose an automation…"
								ariaLabel="Target automation"
							/>
						</div>
						<p class="hint muted">
							{editActionKind === 'end_automation'
								? "Remove this contact from another automation — or from all other automations — by ending their active pass there."
								: "Enroll this contact in another automation when they reach this step. Honours that automation's once/multiple setting; paused or draft targets are skipped."}
						</p>
					{/if}
				{:else}
					<div class="row two">
						<label class="field">
							<span>Subject</span>
							<input name="subject" bind:value={editSubject} placeholder="Email subject" />
						</label>
						<!-- #396: approved senders (Settings → Approved senders, as Compose checks); a
						     value that isn't approved (any more) stays selectable but flagged. -->
						<div class="field from-field">
							<label for="step-from">From</label>
							{#if editFromOther}
								<span class="from-other">
									<input id="step-from" name="from_email" type="email" bind:value={editFrom} placeholder="you@example.com" />
									<button type="button" class="secondary sm" onclick={() => { editFromOther = false; editFrom = selected!.from_email || data.defaultFrom; }}>List</button>
								</span>
							{:else}
								<select
									id="step-from"
									name="from_email"
									value={editFrom}
									onchange={(e) => {
										const v = e.currentTarget.value;
										if (v === '__other__') {
											editFromOther = true;
											editFrom = '';
										} else editFrom = v;
									}}
								>
									{#each fromChoices.options as o (o.value)}
										<option value={o.value}>{o.value}{o.approved ? '' : ' (not approved)'}</option>
									{/each}
									{#if fromChoices.other}<option value="__other__">Other address…</option>{/if}
								</select>
							{/if}
							{#if !fromApproved}
								<span class="from-warn" role="alert">Not an approved sender — Save will refuse it. Pick another, or add it in Settings → Approved senders.</span>
							{/if}
						</div>
					</div>

					<label class="field">
						<span>Preheader <span class="muted">(optional inbox preview)</span></span>
						<input name="preheader" bind:value={editPreheader} placeholder="Shown after the subject in most inboxes" />
					</label>

					{#key selected.id}
						<BlockEditor
							upload={uploadMedia}
							brandLogos={editorLogos(data.brandKit)}
							swatches={editorSwatches(data.brandKit)}
							bind:blocks={editBlocks}
							mergeTags={data.mergeTags}
							preview={renderStepPreview}
							selectionActions={editorActions('email', data.editorAsk)}
							slashActions={editorSlashActions('email', data.editorAsk, () => editSubject)}
							onready={(b) => (baseBlocks = fingerprint(b))}
						/>
					{/key}

					<!-- #396: test the drawer's current content (saved or not) — to you only. -->
					<div class="step-test">
						<button type="button" class="secondary" onclick={sendStepTest} disabled={testBusy}>
							<Icon name="email-step" size={16} /> {testBusy ? 'Sending…' : 'Send test'}
						</button>
						<span class="hint muted">To {data.testTo || 'your address'}, with the real unsubscribe link and headers. Merge tags use that contact's record.</span>
						{#if testResult}<p class={testResult.ok ? 'ok' : 'err'} role="status">{testResult.text}</p>{/if}
					</div>
					<PreSendChecks
						fields={stepFields}
						bind:report={checksReport}
						stale={checksStale}
						endpoint="/automations/{a.id}/checks"
						anyway={false}
						emptyText="Run the pre-send checks on this email before you activate the automation. Nothing is sent."
						onran={() => (checksFingerprint = fingerprint({ b: editBlocks, s: editSubject, p: editPreheader }))}
					/>

					<fieldset class="engagement">
						<legend>Auto-tag on engagement <span class="muted">(optional)</span></legend>
						<label class="check">
							<input type="checkbox" name="tag_on_open_enabled" bind:checked={editTagOnOpenEnabled} />
							Tag the contact when they <strong>open</strong> this email
						</label>
						{#if editTagOnOpenEnabled}
							<div class="eng-tag">
								<SearchSelect
									name="tag_on_open"
									bind:value={() => editTagOnOpen, (v) => (editTagOnOpen = String(v))}
									options={tagOptions}
									allowCreate
									maxlength={60}
									placeholder="tag name"
									ariaLabel="Tag on open"
								/>
							</div>
						{/if}
						<label class="check">
							<input type="checkbox" name="tag_on_click_enabled" bind:checked={editTagOnClickEnabled} />
							Tag the contact when they <strong>click</strong> a link
						</label>
						{#if editTagOnClickEnabled}
							<div class="eng-tag">
								<SearchSelect
									name="tag_on_click"
									bind:value={() => editTagOnClick, (v) => (editTagOnClick = String(v))}
									options={tagOptions}
									allowCreate
									maxlength={60}
									placeholder="tag name"
									ariaLabel="Tag on click"
								/>
							</div>
						{/if}
						<p class="hint muted">Applied when Postmark reports the open/click. Creates the tag if it's new — shows on the contact's record.</p>
					</fieldset>
				{/if}

				<div class="edit-actions">
					<button type="submit" disabled={(selected.type === 'branch' && !!editRulesProblem) || (selected.type === 'wait' && !!editWaitRulesProblem)}>Save step</button>
					<button type="button" class="secondary" onclick={requestCloseDrawer}>Cancel</button>
				</div>
			</form>
			{#if selected.type === 'email'}
				<StepAbTest
					stepId={selected.id}
					subject={selected.subject}
					test={data.abTests[selected.id] ?? null}
					error={form?.abStep === selected.id ? (form?.abError ?? null) : null}
				/>
			{/if}
		{/if}
	</div>
{/if}

<SimulateContact automationId={a.id} onopen={openStepById} />

{#if showPerf || showInsp}
<section class="card tabs-card">
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div class="tabs" role="tablist" aria-label="Automation details" tabindex="-1" onkeydown={onTabKeydown}>
		{#if showPerf}
			<button
				type="button"
				role="tab"
				id="tab-performance"
				aria-controls="panel-performance"
				aria-selected={tab === 'performance'}
				tabindex={tab === 'performance' ? 0 : -1}
				class="tab"
				class:active={tab === 'performance'}
				onclick={() => setTab('performance')}>Performance</button
			>
		{/if}
		{#if showInsp}
			<button
				type="button"
				role="tab"
				id="tab-inspector"
				aria-controls="panel-inspector"
				aria-selected={tab === 'inspector'}
				tabindex={tab === 'inspector' ? 0 : -1}
				class="tab"
				class:active={tab === 'inspector'}
				onclick={() => setTab('inspector')}>Enrollment inspector</button
			>
		{/if}
	</div>
{#if showPerf}
	<div class="perf" role="tabpanel" id="panel-performance" aria-labelledby="tab-performance" hidden={tab !== 'performance'}>
		<!-- #397: funnel date range (UTC days). Reached / from previous / exited by goal read the timeline. -->
		<form method="GET" class="perf-range" data-sveltekit-reset="false">
			<label>From <input type="date" name="perf_from" value={data.funnel.range.from ?? ''} /></label>
			<label>To <input type="date" name="perf_to" value={data.funnel.range.to ?? ''} /></label>
			<button type="submit" class="secondary sm">Apply</button>
			{#if data.funnel.range.from || data.funnel.range.to}<a href="?#performance" class="sm">All time</a>{/if}
			{#if goalExitTotal > 0}
				<span class="muted perf-goals">
					Exited by goal: <strong>{fmt(goalExitTotal)}</strong>
					({data.funnel.goals.map((g) => `${completedReasonText(`goal:${g.kind}`)?.replace('Exited by goal: ', '')} ${fmt(g.n)}`).join(' · ')})
				</span>
			{/if}
		</form>
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Step</th><th>Reached</th><th title="Share of the contacts who reached the step before">From previous</th><th>Exited by goal</th><th>Waiting</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Unsubs</th></tr>
				</thead>
				<tbody>
					{#each data.stepStats as st, i (st.step_id)}
						{@const step = data.steps.find((x) => x.id === st.step_id)}
						<tr>
							<td class="perf-step">{i + 1}. {step ? stepLabel(step) : '—'}</td>
							<td>{fmt(reachedOf(st.step_id))}</td>
							<td class="muted">{fromPrevious(st.step_id)}</td>
							<td>{funnelByStep.get(st.step_id)?.exited ? fmt(funnelByStep.get(st.step_id)?.exited ?? 0) : '—'}</td>
							<td>{st.waiting}</td>
							{#if st.type === 'email' && st.campaign_id}
								<td>{#if st.sent}<a href="/campaign/{st.campaign_id}">{st.sent}</a>{:else}0{/if}</td>
								<td>{st.opens ?? 0} <span class="muted">({pctOf(st.opens ?? 0, st.sent ?? 0)})</span></td>
								<td>{st.clicks ?? 0} <span class="muted">({pctOf(st.clicks ?? 0, st.sent ?? 0)})</span></td>
								<td>{st.unsubs ?? 0}</td>
							{:else if st.type === 'branch'}
								<td class="muted" colspan="4">
									→ YES {st.went_yes} <span class="muted">({pctOf(st.went_yes, st.went_yes + st.went_no)})</span>
									· NO {st.went_no} <span class="muted">({pctOf(st.went_no, st.went_yes + st.went_no)})</span>
								</td>
							{:else if st.type === 'wait'}
								<td class="muted" colspan="4">
									{#if st.went_yes + st.went_no > 0}
										did it {st.went_yes} <span class="muted">({pctOf(st.went_yes, st.went_yes + st.went_no)})</span>
										· timed out {st.went_no}
									{:else}
										wait step
									{/if}
								</td>
							{:else if st.type === 'action'}
								<td class="muted" colspan="4">
									{#if step?.action_kind === 'goto_step'}
										jumped {st.act_jumped} · skipped {st.act_skipped}
									{:else if step?.action_kind === 'pipeline_move' || step?.action_kind === 'pipeline_remove'}
										{step.action_kind === 'pipeline_remove' ? 'removed' : 'moved'} {st.act_pipeline} · skipped {st.act_skipped}
									{:else if step?.action_kind === 'set_tier'}
										{step.target_tier === 'clear' ? 'cleared' : 'set'} {st.act_tier} · skipped {st.act_skipped}
									{:else if step?.action_kind === 'adjust_score'}
										adjusted {st.act_score} · skipped {st.act_skipped}
									{:else}
										{actionDecisionLabel('enrolled')} {st.act_enrolled} · ended {st.act_ended} · skipped {st.act_skipped}
									{/if}
								</td>
							{:else}
								<td class="muted" colspan="4">{st.type === 'tag' ? 'tag step' : 'no sends yet'}</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted perf-note">
			Reached = contacts who got to the step in the date range (recorded since the timeline shipped). Waiting = active
			contacts currently at that step. Opens/clicks are unique per recipient.
		</p>
	</div>
{/if}

{#if showInsp}
<div class="insp" role="tabpanel" id="panel-inspector" aria-labelledby="tab-inspector" hidden={tab !== 'inspector'} bind:this={inspEl}>
	<div class="insp-filters">
		<input
			type="search"
			bind:value={inspEmail}
			oninput={onInspSearch}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					clearTimeout(inspTimer);
					inspGo({ q: inspEmail });
				}
			}}
			placeholder="Search email or name…"
			class="insp-search"
			aria-label="Search enrollments by email or name"
		/>
		<select value={data.inspector.status} onchange={(e) => inspGo({ status: e.currentTarget.value })} aria-label="Filter by status">
			<option value="">All statuses</option>
			<option value="active">Active</option>
			<option value="completed">Completed</option>
			<option value="cancelled">Cancelled</option>
			<option value="failed">Failed</option>
		</select>
		<select value={data.inspector.step ? String(data.inspector.step) : ''} onchange={(e) => inspGo({ step: e.currentTarget.value })} aria-label="Filter by step">
			<option value="">All steps</option>
			{#each data.steps as s (s.id)}
				<option value={String(s.id)}>{stepLabel(s)}</option>
			{/each}
		</select>
		{#if data.counts.failed > 0}
			<form
				method="POST"
				action="?/retryAllFailed"
				use:enhance
				class="inline insp-retry-all"
				onsubmit={(e) => {
					if (!confirm(`Retry all ${data.counts.failed} failed enrollment${data.counts.failed === 1 ? '' : 's'}? Each goes back to active at the step it failed on.`)) e.preventDefault();
				}}
			>
				<button type="submit" class="secondary sm">Retry all failed ({fmt(data.counts.failed)})</button>
			</form>
		{/if}
	</div>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th></th>
					<th>Contact</th>
					<th>Status</th>
					<th>Step</th>
					<th>Next run</th>
					<th>Attempts</th>
					<th>Last error</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each data.enrollments as e (e.id)}
					{@const step = data.steps.find((s) => s.id === e.current_step_id)}
					{@const errText = e.last_error ? enrollmentErrorText(e.last_error) : ''}
					<tr>
						<td>
							<button type="button" class="iconbtn" onclick={() => toggleInsp(e.id)} aria-expanded={inspExpanded.has(e.id)} title="Path through the automation">
								<Icon name={inspExpanded.has(e.id) ? 'chevron-down' : 'chevron-right'} size={16} />
							</button>
						</td>
						<td><a href="/contacts/{e.contact_id}">{e.email}</a></td>
						<td>
							<span class="badge {enrollBadge(e.status)}">{e.status}</span>
							{#if e.completed_reason}<span class="muted insp-reason">{completedReasonText(e.completed_reason)}</span>{/if}
						</td>
						<td class="muted">
							{step ? stepLabel(step) : e.current_step_id ? '(deleted step)' : '—'}
							{#if passWaiting(e)}<span class="insp-waiting">{passWaiting(e)}</span>{/if}
						</td>
						<td class="muted">{e.next_run_at ? e.next_run_at + ' UTC' : '—'}</td>
						<td class="muted">{e.attempts > 0 ? e.attempts : ''}</td>
						<td class="insp-err" title={errText}>{errText.length > 60 ? errText.slice(0, 60) + '…' : errText}</td>
						<td class="insp-actions">
							{#if e.status === 'failed'}
								<form method="POST" action="?/retryEnrollment" use:enhance class="inline">
									<input type="hidden" name="enrollment_id" value={e.id} />
									<button type="submit" class="secondary sm">Retry</button>
								</form>
							{/if}
							{#if e.status === 'active'}
								<form method="POST" action="?/cancelEnrollment" use:enhance class="inline"
									onsubmit={(ev) => { if (!confirm('Cancel this enrollment?')) ev.preventDefault(); }}>
									<input type="hidden" name="enrollment_id" value={e.id} />
									<button type="submit" class="secondary sm">Cancel</button>
								</form>
							{/if}
						</td>
					</tr>
					{#if inspExpanded.has(e.id)}
						{@const hits = data.branchHits.filter((h) => h.enrollment_id === e.id)}
						{@const events = data.timeline[e.id] ?? []}
						<tr class="insp-detail">
							<td colspan="8">
								{#if events.length > 0}
									<!-- #397: the full path, appended — repeat visits each get their own row. -->
									<ol class="timeline">
										{#each events as ev, ti (ti)}
											<li>
												<span class="muted">{ev.at} UTC</span>
												{timelineText(ev, ev.kind === 'enrolled' || ev.kind === 'reached' ? stepTitleById(ev.step_id) : null)}
												{#if ev.kind !== 'enrolled' && ev.kind !== 'reached' && ev.step_id !== null}
													<span class="muted">· {stepTitleById(ev.step_id)}</span>
												{/if}
											</li>
										{/each}
									</ol>
								{:else if hits.length > 0}
									<ul class="branch-decisions">
										{#each hits as h (h.step_id)}
											{@const bstep = data.steps.find((s) => s.id === h.step_id)}
											{#if bstep?.type === 'action'}
												<li>{actionDecisionLabel(h.label)} at <Icon name={stepGlyph(bstep)} size={14} /> {stepLabel(bstep)} — {h.decided_at} UTC</li>
											{:else}
												<li>took {h.label.toUpperCase()} at <Icon name={bstep ? stepGlyph(bstep) : 'condition'} size={14} /> {bstep ? stepLabel(bstep) : '(deleted branch)'} — {h.decided_at} UTC</li>
											{/if}
										{/each}
									</ul>
								{:else}
									<span class="muted">No branch decisions recorded for this enrollment.</span>
								{/if}
							</td>
						</tr>
					{/if}
				{/each}
				{#if data.enrollments.length === 0}
					<tr><td colspan="8" class="muted">No enrollments match the filter.</td></tr>
				{/if}
			</tbody>
		</table>
	</div>
	<div class="insp-paging">
		<span class="muted">
			{#if data.inspector.total > 0}
				Showing {fmt((data.inspector.page - 1) * data.inspector.pageSize + 1)}–{fmt((data.inspector.page - 1) * data.inspector.pageSize + data.enrollments.length)}
				of {fmt(data.inspector.total)}
			{:else}
				0 matching
			{/if}
		</span>
		{#if inspPages > 1}
			<span class="insp-pages">
				<button type="button" class="secondary sm" disabled={data.inspector.page <= 1} onclick={() => inspGo({ page: data.inspector.page - 1 })}>Previous</button>
				<span class="muted">Page {data.inspector.page} of {inspPages}</span>
				<button type="button" class="secondary sm" disabled={data.inspector.page >= inspPages} onclick={() => inspGo({ page: data.inspector.page + 1 })}>Next</button>
			</span>
		{/if}
	</div>
</div>
{/if}
</section>
{/if}

<style>
	/* ---- Header row (#220): title · status · labels | Activate/Pause · ⋯ ---- */
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-s);
		margin-bottom: var(--space-s);
	}
	.title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-s);
		flex: 1;
		min-width: 0;
	}
	.title {
		margin: 0;
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
		min-width: 0;
	}
	.title-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 0 var(--space-xs);
		margin-left: calc(-1 * var(--space-xs));
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		box-shadow: none;
		color: var(--text);
		font: inherit;
		font-weight: var(--weight-ui-heavy);
		text-align: left;
		overflow-wrap: anywhere;
		cursor: text;
	}
	.title-btn:hover,
	.title-btn:focus-visible {
		box-shadow: 0 0 0 var(--border-s) var(--border);
		background: var(--surface);
	}
	.title-edit {
		display: inline-flex;
		color: var(--muted);
		opacity: 0;
	}
	.title-btn:hover .title-edit,
	.title-btn:focus-visible .title-edit {
		opacity: 1;
	}
	.rename {
		display: flex;
		margin: 0;
		flex: 0 1 26rem;
		min-width: 0;
	}
	.rename input {
		flex: 1;
		min-width: 0;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		font-weight: var(--weight-ui-heavy);
	}
	.head-actions {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin-left: auto;
	}
	.head-actions form {
		margin: 0;
	}
	.head-actions button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.more {
		position: relative;
	}
	.more-btn {
		padding-inline: var(--space-xs);
	}
	.more-menu {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 30;
		min-width: 11rem;
		padding: var(--space-xxs);
		background: var(--surface);
		border: 0;
		border-radius: var(--radius-s);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
	}
	.more-menu form {
		margin: 0;
	}
	.more-menu button {
		display: flex;
		width: 100%;
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-s);
		border: none;
		border-radius: var(--radius-xs);
		background: transparent;
		box-shadow: none;
		color: var(--text);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		text-align: left;
	}
	.more-menu button:hover,
	.more-menu button:focus-visible {
		background: var(--btn-hover);
	}
	.more-menu .danger-item {
		color: var(--danger);
	}
	.label-plus {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		padding: var(--space-xxs) var(--space-xs);
		border-radius: var(--radius-full);
		border: var(--border-s) dashed var(--border);
		box-shadow: none;
		background: transparent;
		color: var(--muted);
	}
	.label-plus:hover {
		color: var(--text);
		border-color: var(--muted);
	}

	/* ---- Summary strip: Trigger · Enrollments · Activity · Goals (#397), each ≤ 96px ---- */
	.summary {
		display: grid;
		grid-template-columns: minmax(0, 1.25fr) minmax(0, 1.45fr) minmax(0, 1fr) minmax(0, 1.25fr);
		gap: var(--space-s);
		margin-bottom: var(--space-s);
	}
	.tile {
		background: var(--surface);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius);
		padding: var(--space-s) var(--space-s);
		max-height: 96px;
		box-sizing: border-box;
		min-width: 0;
		overflow: hidden;
	}
	.tile-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-xs);
		margin-bottom: var(--space-xs);
	}
	.tile-head h2 {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		font-weight: var(--weight-ui-heavy);
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: var(--tracking-xl);
	}
	.tile-head button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		white-space: nowrap;
	}
	.tile-line {
		margin: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tile .counts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xxs) var(--space-m);
	}
	.tile .counts .n {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	/* #228: the four enrollment counts stay on one line from 1280px; each may shrink
	   (ellipsis) rather than wrap. Narrower screens wrap as before. */
	@media (min-width: 1280px) {
		.tile .counts {
			flex-wrap: nowrap;
			gap: var(--space-xxs) var(--space-s);
		}
		.tile .counts li {
			flex: 0 1 auto;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
	}
	.err {
		color: var(--danger);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		margin: 0 0 var(--space-s);
	}
	/* #395: activation problems; a step's row opens it in the drawer. */
	.activation-problems {
		padding-left: var(--space-l);
	}
	.activation-problems .linklike {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		cursor: pointer;
	}
	.enroll-preview {
		font-size: var(--size-s);
		line-height: var(--line-s);
		margin: 0 0 var(--space-s);
	}
	.labels-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}
	.label-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		padding: var(--space-xxs) var(--space-xxs) var(--space-xxs) var(--space-xs);
		border-radius: var(--radius-full);
		background: var(--neutral-muted);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		color: var(--text);
	}
	.label-x-form {
		margin: 0;
		display: inline-flex;
	}
	.label-x {
		padding: 0;
		width: 16px;
		height: 16px;
		line-height: 1;
		border: none;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--muted);
		box-shadow: none;
		font-size: var(--size-m);
		letter-spacing: var(--letter-spacing-m);
	}
	.label-x:hover {
		background: color-mix(in srgb, var(--danger) 18%, transparent);
		color: var(--danger);
	}
	.label-add {
		margin: 0;
		display: inline-flex;
		gap: var(--space-xxs);
		align-items: center;
	}
	@media (max-width: 1023px) {
		.summary {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
		.summary .tile:first-child {
			grid-column: 1 / -1;
		}
	}
	.trigger select {
		max-width: 100%;
	}
	.metric-trigger {
		display: flex;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}
	.metric-trigger input {
		width: 6rem;
	}
	.metric-trigger .path-input {
		width: 12rem;
	}
	.metric-trigger .cooldown {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
	}
	.metric-trigger .cooldown input {
		width: 4.5rem;
	}
	.card h2 {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		margin: 0 0 var(--space-s);
	}
	.trigger {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin: 0;
	}
	.topic-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		padding-top: var(--space-s);
		box-shadow: inset 0 var(--border-s) 0 var(--border);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.reentry {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin: 0;
		padding: var(--space-s) 0 0;
		border: none;
		box-shadow: inset 0 var(--border-s) 0 var(--border);
	}
	/* #425: breathing room between the type picker / its fields and the re-entry divider. */
	.trigger .reentry {
		margin-top: var(--space-s);
		padding-top: var(--space-m);
	}
	.reentry-label {
		padding: 0;
		margin-bottom: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.radio {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.counts {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.counts .n {
		font-weight: var(--weight-ui-heavy);
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		color: var(--text);
		margin-right: var(--space-xxs);
	}
	.enroll-banner {
		margin: 0 0 var(--space-m);
	}
	.enrollform {
		display: flex;
		gap: var(--space-xs);
		margin: 0;
	}
	.enrollform select {
		flex: 1;
		min-width: 0;
	}
	.pick-divider {
		border: none;
		box-shadow: inset 0 var(--border-s) 0 var(--border);
		margin: var(--space-m) 0 var(--space-s);
	}
	.pick-divider-label {
		margin: 0 0 var(--space-s);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.pickform {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin: 0;
	}
	.pick-typeahead {
		position: relative;
		display: block;
	}
	.pick-typeahead input {
		width: 100%;
	}
	.pick-suggestions {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 20;
		margin: var(--space-xxs) 0 0;
		padding: var(--space-xxs);
		list-style: none;
		background: var(--surface);
		border: 0;
		border-radius: var(--radius-s);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-m);
		max-height: 220px;
		overflow: auto;
	}
	.pick-sug {
		display: flex;
		align-items: baseline;
		gap: var(--space-xs);
		width: 100%;
		text-align: left;
		padding: var(--space-xs) var(--space-xs);
		background: transparent;
		border: none;
		border-radius: var(--radius-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: inherit;
	}
	.pick-sug:hover,
	.pick-sug.active {
		background: var(--bg);
		filter: none;
	}
	.pick-sug.unsubscribed {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.pick-sug-email {
		font-weight: var(--weight-ui-heavy);
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.pick-sug-name {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.pick-sug-unsub {
		margin-left: auto;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--danger);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 40%, var(--border));
		border-radius: var(--radius-full);
		padding: 0 var(--space-xs);
		white-space: nowrap;
	}
	.pick-chips {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.pick-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		background: var(--surface);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-full);
		padding: var(--space-xxs) var(--space-xxs) var(--space-xxs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.pick-chip-x {
		background: transparent;
		border: none;
		box-shadow: none;
		color: var(--muted);
		cursor: pointer;
		font-size: var(--size-m);
		letter-spacing: var(--letter-spacing-m);
		line-height: 1;
		padding: 0 var(--space-xxs);
	}
	.pick-chip-x:hover {
		color: var(--danger);
	}
	.steps {
		margin-bottom: var(--space-m);
	}
	.steps-head {
		display: flex;
		align-items: baseline;
		gap: var(--space-xs);
		margin-bottom: var(--space-xs);
	}
	.steps-head h2 {
		margin: 0;
	}
	.lock-note {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		margin: var(--space-xxs) 0 0;
	}
	.hidden-form {
		display: none;
	}

	/* ================= Canvas (ActiveCampaign-style vertical flow) ================= */
	/* #218: a fixed viewport (clips, never scrolls) with the flow drawn inside it as a
	   transformed world — pan + zoom are translate()/scale() on .canvas-world. The page
	   never scrolls horizontally. touch-action: none hands touch pan/pinch to the
	   pointer handlers. */
	.canvas-scroll {
		position: relative;
		overflow: hidden;
		height: 70vh;
		min-height: 320px;
		margin: 0 calc(-1 * var(--space-xxs));
		border-radius: var(--radius-xs);
		cursor: grab;
		touch-action: none;
		background-image: radial-gradient(circle, color-mix(in srgb, var(--text) 14%, transparent) 1px, transparent 1px);
		background-size: 22px 22px;
		background-position: 4px 4px;
	}
	.canvas-scroll.panning,
	.canvas-scroll.space-pan.panning {
		cursor: grabbing;
		user-select: none;
	}
	.canvas-scroll.space-pan {
		cursor: grab;
	}
	.canvas-scroll.space-pan :global(*) {
		cursor: inherit;
	}
	.canvas-world {
		position: absolute;
		top: 0;
		left: 0;
		transform-origin: 0 0;
		visibility: hidden;
	}
	.canvas-world.ready {
		visibility: visible;
	}
	.canvas-world.animating {
		transition: transform var(--motion-large-duration) var(--motion-large-easing);
	}
	@media (prefers-reduced-motion: reduce) {
		.canvas-world.animating {
			transition: none;
		}
	}
	/* Fullscreen canvas modal — fixed over the whole viewport (above the sticky nav's
	   z-index:10, below the drawer's backdrop/panel at 60/61 so the drawer still opens on
	   top when a node is edited from here). The card behind it stays in the DOM, just
	   covered; page scroll is locked separately via the canvasExpanded $effect above. */
	.canvas-scroll.expanded {
		position: fixed;
		inset: 0;
		z-index: 20;
		height: auto;
		margin: 0;
		border-radius: 0;
		background-color: var(--surface);
	}
	.canvas-expand-btn {
		align-self: center;
		margin-left: auto;
		width: 24px;
		height: 22px;
		padding: 0;
		display: grid;
		place-items: center;
		border-radius: var(--radius-full);
		border: 0;
		background: var(--surface);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		color: var(--muted);
		cursor: pointer;
	}
	.canvas-expand-btn:hover {
		background: var(--btn-hover);
		color: var(--text);
	}
	.canvas-expand-btn.active {
		background: var(--btn-primary-bg);
		box-shadow: 0 0 0 var(--border-s) var(--btn-primary-bg);
		color: var(--btn-primary-text);
	}
	.canvas-collapse-btn {
		position: fixed;
		top: 14px;
		right: 14px;
		z-index: 21;
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xxs) var(--space-s);
		border-radius: var(--radius-full);
		border: 0;
		background: var(--surface);
		color: var(--text);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
		cursor: pointer;
	}
	.canvas-collapse-btn:hover {
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		color: var(--text);
	}
	.canvas-scroll:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.zoom-ctl {
		position: relative;
		align-self: center;
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
	}
	.zoom-ctl + .canvas-expand-btn {
		margin-left: 0;
	}
	.zoom-btn,
	.zoom-pct,
	.zoom-chip {
		height: 22px;
		padding: 0 var(--space-xs);
		border-radius: var(--radius-full);
		border: 0;
		background: var(--surface);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		color: var(--muted);
		font-size: var(--size-xs);
		letter-spacing: var(--letter-spacing-xs);
		line-height: 1;
		cursor: pointer;
	}
	.zoom-btn {
		width: 24px;
		padding: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.zoom-pct {
		min-width: 3.4rem;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.zoom-chip {
		box-shadow: none;
		background: var(--surface-subtle, var(--neutral-muted));
	}
	.zoom-btn:hover:not(:disabled),
	.zoom-pct:hover,
	.zoom-chip:hover {
		background: var(--btn-hover);
		color: var(--text);
	}
	.zoom-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.zoom-menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 30;
		display: flex;
		flex-direction: column;
		min-width: 6rem;
		padding: var(--space-xxs);
		background: var(--surface);
		border: 0;
		border-radius: var(--radius);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
	}
	.zoom-menu button {
		text-align: left;
		padding: var(--space-xxs) var(--space-s);
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		box-shadow: none;
		color: var(--text);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		cursor: pointer;
	}
	.zoom-menu button:hover,
	.zoom-menu button.active {
		background: var(--btn-hover);
	}
	.canvas-zoom-float {
		position: fixed;
		top: 14px;
		right: 130px;
		z-index: 21;
		display: flex;
		padding: var(--space-xxs) var(--space-xs);
		border-radius: var(--radius-full);
		border: 0;
		background: var(--surface);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	.canvas {
		width: max-content;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: var(--space-xs) var(--space-xs) var(--space-m);
	}
	.flow-start {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		font-weight: var(--weight-ui-heavy);
		letter-spacing: var(--tracking-xl);
		text-transform: uppercase;
		color: var(--muted);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		background: var(--surface-subtle, var(--neutral-muted));
		border-radius: var(--radius-full);
		padding: 0 var(--space-s);
	}
	.terminal {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-heavy);
		color: var(--neutral-1);
		background: var(--neutral-9);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--neutral-10);
		border-radius: var(--radius-full);
		padding: var(--space-xxs) var(--space-m);
	}

	/* --- Connectors + insertion points --- */
	.connector {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.cline {
		display: block;
		width: 1.5px;
		height: 12px;
		background: var(--border);
		flex-shrink: 0;
	}
	button.plus {
		width: 22px;
		height: 22px;
		padding: 0;
		display: grid;
		place-items: center;
		border-radius: 50%;
		border: 0;
		background: var(--surface);
		color: var(--muted);
		font-size: var(--size-s);
		letter-spacing: var(--letter-spacing-s);
		line-height: 1;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		cursor: pointer;
	}
	button.plus:hover,
	button.plus.open {
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface));
	}
	.picker {
		position: fixed;
		transform: translateX(-50%);
		z-index: 40;
		min-width: 200px;
		background: var(--surface);
		border: 0;
		border-radius: var(--radius);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
		padding: var(--space-xxs);
		display: flex;
		flex-direction: column;
	}
	.picker.flip {
		transform: translate(-50%, -100%);
	}
	.picker-form {
		margin: 0;
		display: flex;
	}
	button.picker-item {
		flex: 1;
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-s);
		background: transparent;
		border: none;
		box-shadow: none;
		color: var(--text);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		text-align: left;
		border-radius: var(--radius-xs);
		cursor: pointer;
	}
	button.picker-item:hover {
		background: color-mix(in srgb, var(--accent) 9%, var(--surface));
	}
	.picker-glyph {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border-radius: var(--radius-xs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		flex-shrink: 0;
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
		background: transparent;
	}

	/* --- Wait chip (rendered as part of the connector, AC-style) --- */
	button.wait-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		padding: 0 var(--space-s);
		border-radius: var(--radius-full);
		border: var(--border-s) dashed var(--border);
		background: var(--surface-subtle, var(--neutral-muted));
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		box-shadow: none;
		cursor: pointer;
	}
	button.wait-chip:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	/* --- Node cards --- */
	.node {
		position: relative;
		width: var(--nodew, 340px);
		border: 0;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 0 0 var(--border-s) var(--node-edge, var(--border)), var(--shadow-small);
		padding: var(--space-xs) var(--space-s);
		cursor: pointer;
		text-align: left;
	}
	.node:hover {
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--accent) 45%, var(--border)), var(--shadow-medium);
	}
	.node:focus-visible {
		outline: none;
		box-shadow: 0 0 0 var(--border-l) var(--focus-ring);
	}
	.node.selected {
		box-shadow: 0 0 0 var(--border-s) var(--accent), 0 0 0 var(--border-l) var(--focus-ring);
	}
	.node.dragover {
		box-shadow: 0 0 0 var(--border-s) var(--accent), 0 0 0 var(--border-l) var(--focus-ring);
	}
	/* #146: briefly highlights a "Go to a step" target after its ↗ link is clicked. */
	.node.flash {
		box-shadow: 0 0 0 var(--border-s) var(--accent), 0 0 0 var(--border-l) var(--focus-ring);
		transition: box-shadow var(--motion-duration) var(--motion-easing);
	}
	.goto-link {
		margin-left: var(--space-xxs);
		text-decoration: none;
	}
	.node.t-branch {
		--node-edge: color-mix(in srgb, var(--border) 55%, var(--color-2) 45%);
		background: color-mix(in srgb, var(--surface) 96%, var(--color-2) 4%);
	}
	.node.t-end {
		background: color-mix(in srgb, var(--surface) 94%, var(--neutral-9) 6%);
	}
	.node.t-action {
		--node-edge: color-mix(in srgb, var(--border) 55%, var(--color-4) 45%);
		background: color-mix(in srgb, var(--surface) 96%, var(--color-4) 4%);
	}
	.node-main {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		min-width: 0;
	}
	.glyph {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border-radius: var(--radius-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		flex-shrink: 0;
	}
	.glyph.t-email,
	.picker-glyph.t-email {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--accent);
	}
	.glyph.t-tag,
	.picker-glyph.t-tag {
		background: var(--neutral-muted);
		color: var(--text);
	}
	.glyph.t-branch,
	.picker-glyph.t-branch {
		background: color-mix(in srgb, var(--color-2) 40%, var(--surface));
		color: var(--neutral-10);
	}
	.glyph.t-end,
	.picker-glyph.t-end {
		background: var(--neutral-9);
		color: var(--neutral-1);
	}
	.glyph.t-action,
	.picker-glyph.t-action {
		background: color-mix(in srgb, var(--color-4) 40%, var(--surface));
		color: var(--neutral-10);
	}
	/* #397: wait-until steps */
	.glyph.t-wait,
	.picker-glyph.t-wait {
		background: var(--neutral-muted);
		color: var(--text);
	}
	.node-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 0;
	}
	.node-type {
		font-size: var(--size-xxs);
		line-height: var(--line-xxs);
		font-weight: var(--weight-ui-heavy);
		letter-spacing: var(--tracking-xl);
		text-transform: uppercase;
		color: var(--muted);
	}
	.node.t-branch .node-type,
	.node.t-action .node-type {
		color: var(--text);
	}
	.node-title {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-medium);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.target-status-badge {
		font-size: var(--size-xxs);
		line-height: var(--line-xxs);
		font-weight: var(--weight-ui-heavy);
		text-transform: uppercase;
		letter-spacing: var(--tracking-xl);
		color: var(--muted);
		background: var(--neutral-muted);
		border-radius: var(--radius-full);
		padding: 0 var(--space-xs);
		margin-left: var(--space-xxs);
	}
	/* #395: a step added but never saved valid — the engine holds contacts there. */
	.unfinished-badge {
		font-size: var(--size-xxs);
		line-height: var(--line-xxs);
		font-weight: var(--weight-ui-heavy);
		text-transform: uppercase;
		letter-spacing: var(--tracking-xl);
		color: var(--text);
		border: 1px solid var(--warn);
		border-radius: var(--radius-full);
		padding: 0 var(--space-xs);
		margin-left: var(--space-xs);
	}
	.node-chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xxs);
		margin: var(--space-xs) 0 0 calc(30px + var(--space-s));
	}
	.chip {
		font: inherit;
		font-size: var(--size-xxs);
		line-height: var(--line-xxs);
		letter-spacing: var(--letter-spacing-xxs);
		color: var(--muted);
		background: var(--surface-subtle, var(--neutral-muted));
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border-muted, var(--border));
		border-radius: var(--radius-full);
		padding: 0 var(--space-xs);
		white-space: nowrap;
	}
	button.chip {
		appearance: none;
		-webkit-appearance: none;
		box-shadow: none;
		cursor: default;
	}
	.chip.waiting {
		color: var(--text);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--warn) 40%, var(--border));
		background: color-mix(in srgb, var(--warn) 10%, var(--surface));
		cursor: pointer;
	}
	.chip.waiting:hover,
	.chip.waiting:focus-visible {
		box-shadow: 0 0 0 var(--border-s) var(--warn);
		background: color-mix(in srgb, var(--warn) 18%, var(--surface));
	}
	.chip.waiting:focus-visible {
		outline: none;
		box-shadow: 0 0 0 var(--border-l) var(--focus-ring);
	}

	/* --- Waiting-at-step popover (#124) --- */
	.waiting-pop {
		position: absolute;
		touch-action: pan-y;
		top: 100%;
		left: 0;
		margin-top: var(--space-xs);
		width: 340px;
		max-width: calc(100vw - 2rem);
		max-height: 320px;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		color: var(--text);
		border: 0;
		border-radius: var(--radius);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
		z-index: 5;
		cursor: default;
	}
	.waiting-pop:focus-visible {
		outline: none;
	}
	.waiting-pop-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-s);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.waiting-pop-msg {
		padding: var(--space-s) var(--space-s);
		margin: 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.waiting-pop-msg.error {
		color: var(--danger, #b91c1c);
	}
	.waiting-pop-list {
		list-style: none;
		margin: 0;
		padding: var(--space-xxs) 0;
		overflow-y: auto;
	}
	.waiting-pop-list li {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xxs) var(--space-s);
	}
	.waiting-pop-list li:hover {
		background: var(--surface-subtle, var(--neutral-muted));
	}
	.waiting-pop-who {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
		gap: 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.waiting-pop-who a {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.waiting-pop-name {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.waiting-pop-due {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		white-space: nowrap;
		flex-shrink: 0;
	}
	.waiting-pop-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-s);
		box-shadow: inset 0 var(--border-s) 0 var(--border);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.waiting-pop-actions {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
	}
	/* Hover toolbar — hidden until hover/focus. The drawer carries the ALWAYS-visible
	   fallbacks for these actions (move/delete), per repo convention (no touch DnD). */
	.node-tools {
		position: absolute;
		top: -11px;
		right: 8px;
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--motion-duration) var(--motion-easing);
		background: var(--surface);
		border: 0;
		border-radius: var(--radius-full);
		padding: 0 var(--space-xxs);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-small);
	}
	.node:hover .node-tools,
	.node:focus-within .node-tools,
	.node:focus-visible .node-tools {
		opacity: 1;
		pointer-events: auto;
	}
	.handle {
		cursor: grab;
		color: var(--muted);
		user-select: none;
		font-size: var(--size-s);
		letter-spacing: var(--letter-spacing-s);
		line-height: 1;
		padding: 0 0;
	}
	.handle:active {
		cursor: grabbing;
	}
	/* #396: pointer-event drag — the handle owns the gesture (no canvas pan / page scroll). */
	.handle {
		display: inline-flex;
		touch-action: none;
	}
	.node.dragging {
		opacity: 0.6;
	}
	/* Touch has no hover: keep the step tools (handle, ↑ / ↓, delete) visible. */
	@media (hover: none) {
		.node-tools {
			opacity: 1;
			pointer-events: auto;
		}
		.handle {
			padding: var(--space-xxs);
		}
	}

	/* ---- #396: status strip, wait node states, wait popover, undo toast ---- */
	/* #427: plain meta line when there's nothing to flag; otherwise the global .notice. */
	.status-meta {
		margin: 0 0 var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.notice {
		margin: 0 0 var(--space-s);
	}
	.notice .status-detail {
		color: var(--muted);
	}
	.status-detail::before {
		content: '· ';
	}
	button.wait-chip.zero {
		border-color: transparent;
		background: transparent;
		opacity: 0.75;
	}
	button.wait-chip.open,
	button.wait-chip:focus-visible {
		border-color: var(--accent);
		color: var(--text);
		opacity: 1;
	}
	.wait-pop {
		padding: var(--space-s);
		min-width: 260px;
	}
	.wait-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin: 0;
	}
	.wait-pop-title {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.wait-pop-actions {
		display: flex;
		gap: var(--space-xs);
	}
	.undo-toast {
		position: fixed;
		left: 50%;
		bottom: var(--space-l);
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: var(--space-s);
		padding: var(--space-xs) var(--space-s);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		max-width: calc(100vw - 2 * var(--space-s));
	}
	.dirty-dot {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
		padding: 0 var(--space-xs);
		border-radius: var(--radius-full);
		box-shadow: 0 0 0 var(--border-s) var(--border);
	}
	.drawer-head h3:focus {
		outline: none;
	}
	.from-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
	}
	.from-other {
		display: flex;
		gap: var(--space-xs);
	}
	.from-other input {
		flex: 1;
		min-width: 0;
	}
	.from-warn {
		color: var(--danger);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.step-test {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-s);
		margin-top: var(--space-s);
	}
	.step-test button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.step-test p {
		flex-basis: 100%;
		margin: 0;
	}
	.enroll-preview {
		margin: var(--space-xs) 0 0;
	}
	.enroll-skips {
		list-style: none;
		padding: 0;
		display: grid;
		gap: var(--space-xs);
	}
	.enroll-skips li {
		overflow-wrap: anywhere;
	}
	.skip-email {
		font-weight: 600;
	}
	.skip-force {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		margin-left: var(--space-xs);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.enroll-inactive {
		margin: 0 0 var(--space-s);
		color: var(--text);
	}
	.pick-confirm {
		display: inline-flex;
		gap: var(--space-xs);
	}
	.insp-retry-all {
		margin-left: auto;
	}
	.insp-paging {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-xs);
		margin-top: var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.insp-pages {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.inline {
		margin: 0;
		display: inline;
	}
	button.sm {
		padding: 0 var(--space-s);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		box-shadow: none;
	}
	.iconbtn {
		padding: 0 var(--space-xs);
		font-size: var(--size-xs);
		letter-spacing: var(--letter-spacing-xs);
		line-height: var(--line-xs);
		background: var(--btn-bg);
		color: var(--btn-text);
		box-shadow: 0 0 0 var(--border-s) var(--btn-border);
	}
	.node-tools .iconbtn {
		background: transparent;
		border: none;
		padding: 0 var(--space-xxs);
	}
	.iconbtn:hover {
		background: var(--btn-hover);
	}
	.iconbtn.del {
		color: var(--danger);
	}
	.iconbtn.del:hover {
		box-shadow: 0 0 0 var(--border-s) var(--danger);
	}
	.iconbtn:disabled {
		opacity: 0.4;
	}

	/* --- Branch lanes (#75/#76) — fork, labeled sub-flows, visual re-join. Widths come
	   from the subtree layout (#218, $lib/canvas-layout), set inline. --- */
	.branch-block {
		display: flex;
		flex-direction: column;
		align-items: center;
		align-self: center;
		flex-shrink: 0;
	}
	.fork {
		display: block;
		overflow: visible;
	}
	.fork path {
		fill: none;
		stroke: var(--border);
		stroke-width: 1.5;
	}
	.rejoin-text {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		margin-top: var(--space-xxs);
	}
	.lanes {
		display: grid;
		justify-content: center;
		align-items: stretch;
		width: 100%;
		/* room for the lane pills that sit on the lanes' top border */
		margin-top: var(--space-s);
	}
	.lane {
		--nodew: 280px;
		box-sizing: border-box;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius);
		/* 11px + the 1px border = LAYOUT.lanePad */
		padding: 0 var(--space-s) var(--space-xs);
		background: color-mix(in srgb, var(--surface) 60%, transparent);
	}
	.lane.yes {
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--accent) 30%, var(--border));
		background: color-mix(in srgb, var(--accent) 3%, var(--surface));
	}
	.lane.no {
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 25%, var(--border));
		background: color-mix(in srgb, var(--danger) 3%, var(--surface));
	}
	/* Nested lanes: a slightly stronger border, never a darker fill. */
	.lane.nested.yes {
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--accent) 50%, var(--border));
	}
	.lane.nested.no {
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 45%, var(--border));
	}
	/* The YES/NO (A/B) pill sits on the lane's top border. */
	.lane-head {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin-top: calc(-1 * var(--space-s));
		min-height: 20px;
	}
	.path-label {
		display: inline-flex;
		align-items: center;
		padding: 0 var(--space-s);
		border-radius: var(--radius-full);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		font-weight: var(--weight-ui-heavy);
		letter-spacing: var(--tracking-xl);
		flex-shrink: 0;
	}
	.path-label.yes { background: var(--accent); color: var(--accent-text); }
	.path-label.no { background: var(--danger); color: var(--neutral-1); }
	.pct-pill {
		font-size: var(--size-xxs);
		line-height: var(--line-xxs);
		letter-spacing: var(--letter-spacing-xxs);
		font-weight: var(--weight-ui-heavy);
		border-radius: var(--radius-full);
		padding: 0 var(--space-xs);
		white-space: nowrap;
	}
	.pct-pill.yes {
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface));
	}
	.pct-pill.no {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 10%, var(--surface));
	}
	.lane-flow {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.lane-empty {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		margin-top: var(--space-xs);
	}

	/* --- Editor drawer --- */
	.drawer-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: var(--backdrop);
	}
	.drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 61;
		width: min(480px, 100%);
		background: var(--surface);
		box-shadow: inset var(--border-s) 0 0 var(--border), var(--shadow-medium);
		overflow-y: auto;
		padding: var(--space-m);
		animation: drawer-in-right var(--motion-large-duration) var(--motion-large-easing);
	}
	/* Three drawer modes (#docked default / centered modal / fullscreen) — chosen via the
	   header icon buttons and persisted to localStorage. */
	.drawer.mode-centered {
		top: 4vh;
		bottom: 4vh;
		right: auto;
		left: 50%;
		width: min(920px, 92vw);
		border-radius: var(--radius);
		box-shadow: var(--border-shadow-s), var(--shadow-l);
		animation: drawer-in-center var(--motion-large-duration) var(--motion-large-easing);
	}
	.drawer.mode-fullscreen {
		top: 0;
		right: 0;
		bottom: 0;
		left: 0;
		width: 100%;
		box-shadow: none;
		border-radius: 0;
		animation: drawer-in-full var(--motion-large-duration) var(--motion-large-easing);
	}
	@keyframes drawer-in-right {
		from { transform: translateX(24px); opacity: 0; }
		to { transform: translateX(0); opacity: 1; }
	}
	@keyframes drawer-in-center {
		from { transform: translate(-50%, 12px); opacity: 0; }
		to { transform: translate(-50%, 0); opacity: 1; }
	}
	@keyframes drawer-in-full {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	.drawer.mode-centered {
		transform: translateX(-50%);
	}
	/* Wider modes give the email editor's markdown/preview panes room to breathe. */
	.drawer.mode-centered .step-edit :global(.editor),
	.drawer.mode-fullscreen .step-edit :global(.editor) {
		min-height: 46vh;
	}
	.drawer.mode-fullscreen .step-edit {
		max-width: 1100px;
		margin: 0 auto;
	}
	.drawer-head {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		margin-bottom: var(--space-s);
	}
	.drawer-head h3 {
		margin: 0;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		flex: 1;
	}
	.drawer-modebtns {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-full);
		padding: 0;
	}
	.mode-btn {
		width: 24px;
		height: 22px;
		padding: 0;
		display: grid;
		place-items: center;
		border-radius: var(--radius-full);
		border: none;
		background: transparent;
		box-shadow: none;
		color: var(--muted);
		cursor: pointer;
	}
	.mode-btn:hover {
		background: var(--btn-hover);
		color: var(--text);
	}
	.mode-btn.active {
		background: var(--btn-primary-bg);
		color: var(--btn-primary-text);
	}
	.drawer-close {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.drawer-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		padding-bottom: var(--space-s);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
		margin-bottom: var(--space-s);
	}
	.push-right {
		margin-left: auto;
	}
	.del-btn {
		color: var(--danger);
	}
	.del-btn:hover {
		box-shadow: 0 0 0 var(--border-s) var(--danger);
	}
	.drawer-err {
		margin: 0 0 var(--space-s);
	}
	.drawer-note {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.step-edit {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
	}
	.row.two {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-s);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.field > span:first-child {
		color: var(--muted);
	}
	.delay-inputs {
		display: inline-flex;
		gap: var(--space-xs);
	}
	.delay-inputs input {
		width: 5.5rem;
	}
	.hint {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	/* #625: the wait step's kind chooser ("The contact will wait:"). */
	.wait-kinds {
		display: grid;
		gap: var(--space-xs);
		border: 0;
		padding: 0;
		margin: 0;
	}
	.wait-kinds legend {
		padding: 0;
		margin-bottom: var(--space-xs);
		font-weight: 600;
	}
	button.wait-kind {
		display: grid;
		gap: 2px;
		width: 100%;
		text-align: left;
		padding: var(--space-s);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface, transparent);
		color: var(--text);
	}
	button.wait-kind:hover:not(:disabled),
	button.wait-kind.current {
		border-color: var(--accent);
	}
	button.wait-kind:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	button.wait-kind span {
		font-size: var(--size-xs);
	}
	.wait-kind-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-s);
		margin: 0;
	}
	.also-waits {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}
	/* #221: the Condition rule set — rows wrap inside the drawer; the drawer itself scrolls. */
	.rule-set {
		padding: var(--space-s) var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.rule-err {
		margin: 0;
	}
	.edit-actions {
		display: flex;
		gap: var(--space-xs);
	}
	.engagement {
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius);
		padding: var(--space-s) var(--space-s);
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	.engagement legend {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
		padding: 0 var(--space-xs);
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.engagement .eng-tag {
		margin-left: var(--space-xl);
		max-width: 22rem;
	}
	@media (max-width: 768px) {
		.iconbtn,
		.canvas-expand-btn,
		.zoom-btn,
		.zoom-pct,
		.mode-btn {
			min-width: 40px;
			min-height: 40px;
		}
		.steps-head {
			flex-wrap: wrap;
		}
		.lock-note {
			order: 10;
			flex-basis: 100%;
			white-space: normal;
		}
		.canvas-scroll {
			height: 60vh;
		}
		/* Header wraps: back link, then the name on its own line, then the actions row. */
		.head {
			flex-direction: column;
			align-items: stretch;
		}
		.title-row {
			flex: none;
		}
		.title {
			flex-basis: 100%;
		}
		.rename {
			flex: 1 1 100%;
		}
		.head-actions {
			margin-left: 0;
		}
		.summary {
			grid-template-columns: minmax(0, 1fr);
		}
		.tile {
			max-height: none;
		}
		.node-tools .iconbtn {
			min-width: 0;
			min-height: 0;
		}
		.label-x,
		.pick-chip-x {
			width: 40px;
			height: 40px;
			margin: calc(-1 * var(--space-s)) calc(-1 * var(--space-xs)) calc(-1 * var(--space-s)) calc(-1 * var(--space-xs));
		}
	}
	@media (max-width: 640px) {
		.row.two {
			grid-template-columns: minmax(0, 1fr);
		}
		.drawer {
			width: 100%;
			max-width: 100vw;
			padding: var(--space-m);
		}
		.drawer.mode-centered {
			top: 0;
			bottom: 0;
			left: 0;
			width: 100%;
			border-radius: 0;
			transform: none;
			animation: drawer-in-full var(--motion-large-duration) var(--motion-large-easing);
		}
		.edit-actions {
			flex-wrap: wrap;
		}
		.engagement .eng-tag {
			max-width: calc(100% - 1.7rem);
		}
		.insp-filters {
			flex-wrap: wrap;
		}
		.insp-search {
			flex-basis: 100%;
		}
		.insp-filters select {
			flex: 1 1 0;
			min-width: 0;
			max-width: 100%;
		}
	}

	/* Performance | Enrollment inspector tabs (#220) */
	.tabs-card { margin-bottom: var(--space-m); }
	.tabs {
		display: flex;
		gap: var(--space-xxs);
		margin: calc(-1 * var(--space-xxs)) 0 var(--space-s);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tab {
		flex: none;
		padding: var(--space-xs) var(--space-s);
		margin-bottom: -1px;
		border: none;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-heavy);
		white-space: nowrap;
	}
	.tab:hover {
		color: var(--text);
	}
	.tab.active {
		color: var(--text);
		box-shadow: inset 0 calc(-1 * var(--border-l)) 0 var(--accent);
	}
	.perf-step { font-weight: var(--weight-ui-medium); }
	.perf-note { margin: var(--space-xs) 0 0; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }

	/* Enrollment inspector (#80) */
	.insp { scroll-margin-top: 4rem; }
	.insp-filters {
		display: flex;
		gap: var(--space-xs);
		margin-bottom: var(--space-s);
	}
	.insp-search { flex: 1; min-width: 0; }
	.insp-err {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--danger);
		max-width: 18rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.insp-actions { white-space: nowrap; }
	.insp-detail td {
		padding: var(--space-xxs) var(--space-s) var(--space-xs);
		background: var(--surface-subtle, var(--neutral-muted));
	}
	.branch-decisions {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}

	/* ---- #397: pause reason, status history, triggers while paused, goals, funnel, timeline ---- */
	.pause-form {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.pause-form input {
		width: 14rem;
	}
	.status-history {
		margin: 0 0 var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.status-history summary {
		cursor: pointer;
		color: var(--muted);
	}
	.status-history ul,
	.goal-list,
	.timeline {
		margin: var(--space-xxs) 0 0;
		padding-left: var(--space-m);
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
	}
	.pending-triggers {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-s);
	}
	.pending-triggers form {
		margin: 0;
	}
	.goal-list li {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.goal-add {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		margin: var(--space-s) 0 var(--space-xs);
	}
	.perf-range {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-s);
		margin: 0 0 var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.perf-range label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
	}
	.timeline {
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.insp-waiting,
	.insp-reason {
		display: block;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
</style>
