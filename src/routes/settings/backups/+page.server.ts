import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { backupIsStale, listBackups, readLast, readRun, runBackupStep, startRun } from '$lib/server/backups';

// Settings → Backups (#308). Admin-only: last run, the stored backups with download links
// (streamed by ./download/[date]/[file]), and Back up now. See $lib/server/backups.ts.

function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event.locals);
	const db = getDB(event);
	const bucket = event.platform?.env?.MEDIA;
	const { last, lastSuccessAt } = await readLast(db);
	const run = await readRun(db);
	let backups: Awaited<ReturnType<typeof listBackups>> = [];
	let listError: string | null = null;
	if (bucket) {
		try {
			backups = await listBackups(bucket);
		} catch (e) {
			listError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		}
	}
	return {
		hasBucket: !!bucket,
		last,
		lastSuccessAt,
		stale: backupIsStale(lastSuccessAt),
		run: run ? { date: run.date, trigger: run.trigger, startedAt: run.startedAt, tablesDone: run.index, tablesTotal: run.tables.length } : null,
		backups,
		listError
	};
};

export const actions: Actions = {
	backupNow: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const bucket = event.platform?.env?.MEDIA;
		if (!bucket) return fail(400, { error: 'The MEDIA bucket is not bound to this Worker.' });
		const started = await startRun(db, 'manual');
		if (!started.ok) return fail(409, { error: started.error });
		// Run a first step now; the heartbeat finishes a big backup over the next ticks.
		const step = await runBackupStep(db, bucket);
		if (step.state === 'error') return fail(500, { error: step.error });
		return { started: true, finished: step.state === 'finished' };
	}
};
