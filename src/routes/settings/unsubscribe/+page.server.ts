import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getUnsubPage, pruneUnsubMedia, saveUnsubPage, storeUnsubMedia } from '$lib/server/unsubscribe-page';
import { reorderTopics, topicAdminRows } from '$lib/server/topics';
import {
	LINKS_MAX,
	parseVideoUrl,
	validatePosterFile,
	validateUnsubPageText,
	validateVideoFile,
	type PageVideo,
	type UnsubPageConfig
} from '$lib/unsubscribe-page';

// Settings → Unsubscribe page (#374), admin-only (load + every action): heading, intro,
// video (embed link or upload), what shows after unsubscribing, links, the opt-in
// Resubscribe button and the accent colour. Stored in app_state `unsubscribe_page`.

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const db = getDB(event);
	return { config: await getUnsubPage(db), hasMedia: !!event.platform?.env?.MEDIA, topics: await topicAdminRows(db) };
};

type Pending = { file: File; kind: 'video' | 'poster'; ext: string; apply: (key: string) => void };

function fileOf(v: FormDataEntryValue | null): File | null {
	return v instanceof File && v.size > 0 ? v : null;
}

/**
 * One video slot (`` = before, `after_` = after) from the form → the stored video, or an
 * error. New files are validated here and stored later (in `pending`), so a bad field never
 * leaves an orphan upload behind.
 */
function readVideo(
	data: FormData,
	prefix: '' | 'after_',
	prev: PageVideo | null,
	pending: Pending[]
): { ok: true; video: PageVideo | null } | { ok: false; error: string } {
	const kind = String(data.get(`${prefix}video_kind`) ?? 'none');
	if (kind === 'none') return { ok: true, video: null };
	if (kind === 'embed') {
		const url = String(data.get(`${prefix}video_url`) ?? '').trim();
		const parsed = parseVideoUrl(url);
		if (!parsed) return { ok: false, error: 'That video link isn’t a YouTube, Vimeo or Loom video URL.' };
		return { ok: true, video: { kind: 'embed', url, ...parsed } };
	}
	if (kind !== 'upload') return { ok: false, error: 'Pick a video option.' };

	const prevUpload = prev?.kind === 'upload' ? prev : null;
	const file = fileOf(data.get(`${prefix}video_file`));
	let video: PageVideo & { kind: 'upload' };
	if (file) {
		const check = validateVideoFile(file);
		if (!check.ok) return { ok: false, error: check.error };
		video = { kind: 'upload', key: '', type: file.type === 'video/webm' ? 'video/webm' : 'video/mp4', posterKey: prevUpload?.posterKey ?? null };
		pending.push({ file, kind: 'video', ext: check.ext, apply: (key) => (video.key = key) });
	} else if (prevUpload) {
		video = { ...prevUpload };
	} else {
		return { ok: false, error: 'Choose an MP4 or WebM file to upload.' };
	}
	const poster = fileOf(data.get(`${prefix}poster_file`));
	if (poster) {
		const check = validatePosterFile(poster);
		if (!check.ok) return { ok: false, error: check.error };
		pending.push({ file: poster, kind: 'poster', ext: check.ext, apply: (key) => (video.posterKey = key) });
	} else if (data.get(`${prefix}remove_poster`) === '1') {
		video.posterKey = null;
	}
	return { ok: true, video };
}

export const actions: Actions = {
	save: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const bucket = event.platform?.env?.MEDIA;
		let data: FormData;
		try {
			data = await event.request.formData();
		} catch {
			return fail(400, { error: 'The upload could not be read. Videos must be 50 MB or smaller.' });
		}
		const text = validateUnsubPageText({
			heading: String(data.get('heading') ?? ''),
			intro: String(data.get('intro') ?? ''),
			caption: String(data.get('caption') ?? ''),
			placement: String(data.get('placement') ?? 'below'),
			afterHeading: String(data.get('after_heading') ?? ''),
			afterMessage: String(data.get('after_message') ?? ''),
			afterCaption: String(data.get('after_caption') ?? ''),
			links: Array.from({ length: LINKS_MAX }, (_, i) => ({
				label: String(data.get(`link_label_${i}`) ?? ''),
				url: String(data.get(`link_url_${i}`) ?? '')
			})),
			resubscribe: data.get('resubscribe') === '1',
			accent: String(data.get('accent') ?? '')
		});
		if (!text.ok) return fail(400, { error: text.error });

		const prev = await getUnsubPage(db);
		const pending: Pending[] = [];
		const before = readVideo(data, '', prev.video, pending);
		if (!before.ok) return fail(400, { error: before.error });
		const after = readVideo(data, 'after_', prev.afterVideo, pending);
		if (!after.ok) return fail(400, { error: `After unsubscribing: ${after.error}` });
		if (pending.length && !bucket) return fail(500, { error: 'Media storage isn’t configured, so files can’t be uploaded.' });

		for (const p of pending) p.apply(await storeUnsubMedia(bucket!, p.kind, p.file, p.ext));
		const next: UnsubPageConfig = { ...text.value, video: before.video, afterVideo: after.video };
		await saveUnsubPage(db, next);
		await pruneUnsubMedia(bucket, prev, next);
		return { saved: true };
	},

	// #414: Topics panel — drag (or ↑ / ↓) to reorder; `order` = topic list ids, comma-separated.
	reorderTopics: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const ids = String(data.get('order') ?? '')
			.split(',')
			.map((v) => Number(v.trim()));
		await reorderTopics(getDB(event), ids);
		return { topicsSaved: true };
	}
};
