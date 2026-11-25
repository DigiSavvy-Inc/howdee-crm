// The seam between core code and the optional snapshot feature (#608).
//
// Core code reaches the feature only through `snapshot` from `$lib/server/snapshot` (the
// folder's entry module, `snapshot/index.ts`). That object implements this interface. The
// public release leaves the folder out and puts the no-op stand-in (`snapshot-standin.ts`)
// in its place, so this file and every core call site compile unchanged. See
// docs/public-export.md.
//
// Every hook here is safe to call while the feature is off: core still checks `enabled(env)`
// first where #604 says the surface must do nothing.

type Env_ = Partial<Env> | null | undefined;

/** Called after a tag lands on a contact (contact-write's `afterTag`). */
export type SnapshotTagHook = (contactId: number, tagName: string) => Promise<void>;

/** One snapshot approval on the contact page's Activity timeline. */
export type SnapshotApprovalRow = { approved_at: string; approved_via: string | null; domain: string };

/** One snapshot job row for an account brief source. */
export type SnapshotBriefRow = {
	contact_id: number;
	domain: string;
	status: string;
	created_at: string;
	top_issue: string | null;
};

/** What the tick needs from its own context to run snapshot jobs. */
export type SnapshotTickContext = {
	postmarkToken: string;
	sessionSecret: string;
	baseUrl: string;
};

/** Settings → Snapshots page data. */
export type SnapshotQueuePage = {
	mode: string;
	deliveryDays: number;
	tokenSet: boolean;
	timezone: string;
	rows: {
		id: number;
		contact_id: number;
		email: string | null;
		domain: string;
		status: string;
		submitted: string;
		scheduled: string | null;
		state: string;
		error: string | null;
	}[];
};

/** The approve link page (`/snapshot/approve/[token]`). Opaque to core. */
export type SnapshotApproveState = Record<string, unknown>;

export interface SnapshotFeature {
	/** #604 on/off: true when `SNAPSHOT_MODE` is `qa` or `live`. */
	enabled(env: Env_): boolean;

	/** The tag that releases a report. Bulk tag, group rename / merge and the assistant refuse
	 *  it whatever the mode. `null` = no such tag (the stand-in). */
	protectedTag: string | null;

	/** Contact-keyed tables the feature owns, for "is anything still referencing this contact"
	 *  checks (the assistant's create_contact Undo). */
	contactReferences: readonly { table: string; label: string }[];

	/** Contact upsert / API v1 writes: run after `snapshot:approved` lands on a contact. */
	approvedHook(db: D1Database, env: Env_, options?: { allowReenroll?: boolean }): SnapshotTagHook;

	/** `/api/contacts/upsert`: the magnet transform + job queue for a form submit (a no-op for
	 *  any other `source`). A failed queue write is logged, never thrown. */
	afterContactUpsert(db: D1Database, env: Env_, contactId: number, body: Record<string, unknown>): Promise<void>;

	/** Contact page `addTag`: release when the tag is `snapshot:approved`. */
	releaseApproved(db: D1Database, env: Env_, contactIds: number[], tagName: string): Promise<void>;

	/** `/api/inbound`: an approve / hold reply to a review email. `null` = not a review thread. */
	handleReviewReply(
		db: D1Database,
		env: Env_,
		msg: { fromEmail: string; headers: unknown; text: string }
	): Promise<{ jobId: number; outcome: string } | null>;

	/** `/api/inbound`: tag a real lead reply `snapshot:replied`. */
	tagReply(db: D1Database, env: Env_, contactId: number, headers: unknown, subject: string, fromEmail: string): Promise<void>;

	/** `/api/ingest` and Settings → Webhooks: why a booking key / request can't be accepted. */
	bookingListProblem(tags: string[], listName: string | null | undefined): string | null;

	/** Heartbeat tick: process snapshot jobs. Never throws; returns the tick summary. */
	tick(db: D1Database, env: Env_, ctx: SnapshotTickContext): Promise<unknown>;

	/** Contact page: approvals for the Activity timeline. */
	contactApprovals(db: D1Database, contactId: number): Promise<SnapshotApprovalRow[]>;

	/** Account brief (#388): the company's newest snapshot jobs. */
	briefRows(db: D1Database, companyId: number): Promise<SnapshotBriefRow[]>;

	// ---- the feature's own routes (left out of the public release with the folder) ----

	/** Settings → Snapshots load. */
	queuePage(db: D1Database, env: Env_): Promise<SnapshotQueuePage>;

	/** `POST /api/snapshot-jobs`. */
	queueExisting(
		db: D1Database,
		env: Env_,
		contactId: number,
		domain: string,
		operator: boolean
	): Promise<{ queued: boolean; reason: string }>;

	/** `/snapshot/approve/[token]` load: `null` = not a valid link. */
	readApproveLink(db: D1Database, env: Env_, token: string | undefined): Promise<SnapshotApproveState | null>;

	/** `/snapshot/approve/[token]` POST: `null` = not a valid link. */
	submitApproveLink(db: D1Database, env: Env_, token: string | undefined): Promise<SnapshotApproveState | null>;
}
