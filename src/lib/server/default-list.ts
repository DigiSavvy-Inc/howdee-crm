// #596: the list a contact lands on when the request names none (/api/ingest with no `list`
// and no key default, /api/luma with no Settings → Luma list). Read from the DEFAULT_LIST_NAME
// var — there is no built-in name. '' = not configured: the caller rejects the request.

export const NO_DEFAULT_LIST_ERROR =
	'No list configured: send a list, set a default list on the webhook key (or Settings → Luma list), or set the DEFAULT_LIST_NAME var.';

export function defaultListName(env: unknown): string {
	return String((env as { DEFAULT_LIST_NAME?: unknown } | null | undefined)?.DEFAULT_LIST_NAME ?? '').trim();
}
