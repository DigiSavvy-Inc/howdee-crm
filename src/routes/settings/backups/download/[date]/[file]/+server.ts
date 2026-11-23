import { error, type RequestHandler } from '@sveltejs/kit';
import { backupKey, isBackupDate, isBackupFile } from '$lib/server/backups';

// Streams one backup object (#308). Admin session only — /settings is never public, and the
// role is checked here too. The gzip bytes are sent as-is (a download, not Content-Encoding).
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (locals.user?.role !== 'admin') throw error(403, 'Admins only.');
	const date = params.date ?? '';
	const file = params.file ?? '';
	if (!isBackupDate(date) || !isBackupFile(file)) throw error(400, 'Bad backup path.');
	const bucket = platform?.env?.MEDIA;
	if (!bucket) throw error(503, 'The MEDIA bucket is not bound.');
	const obj = await bucket.get(backupKey(date, file));
	if (!obj) throw error(404, 'Not found.');
	const type = file.endsWith('.json') ? 'application/json' : 'application/gzip';
	return new Response(obj.body, {
		headers: {
			'content-type': type,
			'content-disposition': `attachment; filename="backup-${date}-${file}"`,
			'cache-control': 'private, no-store'
		}
	});
};
