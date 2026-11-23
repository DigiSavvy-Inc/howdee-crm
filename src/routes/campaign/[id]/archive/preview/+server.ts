import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { renderIssuePreview, webVersionFromForm, webVersionProblem } from '$lib/server/newsletter-archive';

// #483: the newsletter archive page for one issue, as the public would see it — whether or not
// it's published or the archive is on. Admin session only, never indexed or cached.
// GET = the saved version; POST = the editor's unsaved fields (the Preview button).

async function respond(event: Parameters<RequestHandler>[0], draft?: ReturnType<typeof webVersionFromForm>): Promise<Response> {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Only an admin can preview the newsletter archive.');
	if (draft) {
		const problem = webVersionProblem(draft);
		if (problem) throw error(400, problem);
	}
	const html = await renderIssuePreview(getDB(event), Number(event.params.id), { base: await publicBaseUrlFor(event), origin: event.url.origin }, draft);
	if (!html) throw error(404, 'Only sent broadcasts have a newsletter archive version.');
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
	});
}

export const GET: RequestHandler = (event) => respond(event);
export const POST: RequestHandler = async (event) => respond(event, webVersionFromForm(await event.request.formData()));
