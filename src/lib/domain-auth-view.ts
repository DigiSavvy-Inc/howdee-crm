// #363: wording for the Domain authentication card on /deliverability (universal, so the
// page and the tests share it).

const STATUS_LABEL: Record<string, string> = { pass: 'Pass', warn: 'Warn', fail: 'Fail', unknown: 'Unknown' };

/** "Checked just now: 2 domains, 1 passing, 1 needs attention". */
export function checkedText(s: { domains: number; passing: number; attention: number }): string {
	if (s.domains === 0) return 'Checked just now: no sending domain found.';
	return `Checked just now: ${s.domains} domain${s.domains === 1 ? '' : 's'}, ${s.passing} passing, ${s.attention} need${s.attention === 1 ? 's' : ''} attention`;
}

/** "was Fail → now Pass". */
export function changeText(c: { was: string; now: string }): string {
	return `was ${STATUS_LABEL[c.was] ?? c.was} → now ${STATUS_LABEL[c.now] ?? c.now}`;
}
