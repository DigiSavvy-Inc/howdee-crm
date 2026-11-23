import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { editBrandKit, getBrandKit, storeKitLogo, validateKitLogoFile } from '$lib/server/brand-kit';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { KIT_BACKGROUNDS, KIT_LIMITS, cleanLabel, type KitOp } from '$lib/brand-kit';

// Settings → Brand kit (#595), admin-only (load + every action): the colour swatches and
// logos the editors (compose, templates, pages, automations, the archive editor) and
// ColorField offer as presets. Logos upload to R2 beside the Branding logo.

type Event = Parameters<Actions[string]>[0];

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

const str = (d: FormData, k: string) => String(d.get(k) ?? '');
const dir = (d: FormData): 'up' | 'down' => (d.get('dir') === 'up' ? 'up' : 'down');

async function run(event: Event, op: (d: FormData) => KitOp | Promise<KitOp>, section: 'swatch' | 'logo') {
	if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.', section });
	const data = await event.request.formData();
	const r = await editBrandKit(getDB(event), await op(data), event.platform?.env?.MEDIA);
	if (!r.ok) return fail(400, { error: r.error, section });
	return { saved: true, section };
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return { kit: await getBrandKit(getDB(event)), limits: KIT_LIMITS, backgrounds: KIT_BACKGROUNDS };
};

export const actions: Actions = {
	addSwatch: (e) => run(e, (d) => ({ op: 'addSwatch', label: d.get('label'), hex: d.get('hex') }), 'swatch'),
	updateSwatch: (e) => run(e, (d) => ({ op: 'updateSwatch', key: str(d, 'key'), label: d.get('label'), hex: d.get('hex') }), 'swatch'),
	removeSwatch: (e) => run(e, (d) => ({ op: 'removeSwatch', key: str(d, 'key') }), 'swatch'),
	moveSwatch: (e) => run(e, (d) => ({ op: 'moveSwatch', key: str(d, 'key'), dir: dir(d) }), 'swatch'),
	updateLogo: (e) =>
		run(e, (d) => ({ op: 'updateLogo', key: str(d, 'key'), label: d.get('label'), alt: d.get('alt'), background: d.get('background') }), 'logo'),
	removeLogo: (e) => run(e, (d) => ({ op: 'removeLogo', key: str(d, 'key') }), 'logo'),
	moveLogo: (e) => run(e, (d) => ({ op: 'moveLogo', key: str(d, 'key'), dir: dir(d) }), 'logo'),

	// Upload first (validated like the Branding logo, minus SVG), then add it to the kit.
	addLogo: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.', section: 'logo' });
		const db = getDB(event);
		const data = await event.request.formData();
		const f = data.get('file');
		const file = f instanceof File && f.size > 0 ? f : null;
		if (!cleanLabel(data.get('label'))) return fail(400, { error: 'Give the logo a name.', section: 'logo' });
		if (!file) return fail(400, { error: 'Choose a PNG or WebP logo to upload.', section: 'logo' });
		const check = validateKitLogoFile(file);
		if (!check.ok) return fail(check.status, { error: check.error, section: 'logo' });
		const bucket = event.platform?.env?.MEDIA;
		if (!bucket) return fail(500, { error: 'Media storage (R2) is not configured.', section: 'logo' });
		const kit = await getBrandKit(db);
		if (kit.logos.length >= KIT_LIMITS.logos) return fail(400, { error: `A brand kit holds up to ${KIT_LIMITS.logos} logos.`, section: 'logo' });
		const src = await storeKitLogo(bucket, file, check.ext, await publicBaseUrlFor(event));
		const r = await editBrandKit(db, { op: 'addLogo', label: data.get('label'), alt: data.get('alt'), background: data.get('background'), src }, bucket);
		if (!r.ok) return fail(400, { error: r.error, section: 'logo' });
		return { saved: true, section: 'logo' };
	}
};
