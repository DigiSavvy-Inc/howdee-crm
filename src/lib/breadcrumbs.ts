// Breadcrumb trail model (#265), shared by Breadcrumbs.svelte and its tests.
// The last item is the current page; everything before it is an ancestor (a link when it has
// an href, plain text otherwise — e.g. "Creative", which has no index page).

export type Crumb = { label: string; href?: string };

export type CrumbView = { label: string; href: string | null; current: boolean };

export function crumbView(items: Crumb[]): CrumbView[] {
	return items.map((c, i) => {
		const current = i === items.length - 1;
		return { label: c.label, href: current ? null : (c.href ?? null), current };
	});
}

/** The nearest linked ancestor — the single "← Parent" link shown on narrow screens. */
export function crumbParent(items: Crumb[]): { label: string; href: string } | null {
	for (let i = items.length - 2; i >= 0; i--) {
		const href = items[i].href;
		if (href) return { label: items[i].label, href };
	}
	return null;
}
