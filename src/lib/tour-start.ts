// #731: when the product tour may open by itself. "First time" is unchanged from #104: the
// DB flag (`tourSeen`) and the localStorage belt (`tour:v1`), both written only when the tour
// is finished or skipped. The one addition: never on top of the first-run setup wizard
// (Settings → Setup with `?first=1` or `?wizard=<step>`, the same rule as wizardStepFrom).
// The tour then opens on the next signed-in page instead. "Take the tour" is not affected.

/** True when this URL shows the first-run setup wizard. */
export function isSetupWizardUrl(url: URL): boolean {
	if (url.pathname.replace(/\/+$/, '') !== '/settings/setup') return false;
	return url.searchParams.has('wizard') || url.searchParams.get('first') === '1';
}

/** True when the tour should auto-open on this page. */
export function tourShouldAutoStart(opts: { tourSeen: boolean; seenLocal: boolean; url: URL }): boolean {
	if (opts.tourSeen || opts.seenLocal) return false;
	return !isSetupWizardUrl(opts.url);
}
