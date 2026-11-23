// The no-op stand-in for the SEO Snapshot feature (#608).
//
// The public release has no src/lib/server/snapshot/ folder. It writes this file's content to
// src/lib/server/snapshot/index.ts instead (docs/public-export.md), so every core import of
// `$lib/server/snapshot` keeps compiling. Imports use `$lib/` paths so the file works from
// either place. Every hook does nothing and the feature is always off.
//
// tests/snapshot-seam-608.test.ts runs the core entry points against this object.

import type { SnapshotFeature } from '$lib/server/snapshot-feature';

export const snapshot: SnapshotFeature = {
	enabled: () => false,
	protectedTag: null,
	contactReferences: [],
	approvedHook: () => async () => {},
	afterContactUpsert: async () => {},
	releaseApproved: async () => {},
	handleReviewReply: async () => null,
	tagReply: async () => {},
	bookingListProblem: () => null,
	tick: async () => ({ off: true }),
	contactApprovals: async () => [],
	briefRows: async () => [],
	queuePage: async () => ({ mode: 'off', deliveryDays: 0, tokenSet: false, timezone: 'UTC', rows: [] }),
	queueExisting: async () => ({ queued: false, reason: 'off' }),
	readApproveLink: async () => null,
	submitApproveLink: async () => null
};
