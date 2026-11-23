// #332: a campaign's audience as people read it. Universal (compose, campaign pages, API).

export type AudienceGroup = { id: number; name: string; kind: string };
export type AudienceView = { include: AudienceGroup[]; exclude: AudienceGroup[] };

/** "Customers + Newsletter, excluding VIP" — '' when nothing is included. */
export function audienceLabel(a: AudienceView): string {
	if (!a.include.length) return '';
	const inc = a.include.map((g) => g.name).join(' + ');
	return a.exclude.length ? `${inc}, excluding ${a.exclude.map((g) => g.name).join(' + ')}` : inc;
}
