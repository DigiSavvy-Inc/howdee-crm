// Money display (#353, shared since #436) — client- and server-safe.

/** Each amount in its own currency — never converted. null → "—". */
export function money(n: number | null | undefined, cur: string | null | undefined): string {
	if (n === null || n === undefined) return '—';
	if (cur) {
		try {
			return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n);
		} catch {
			return `${n.toFixed(2)} ${cur}`;
		}
	}
	return n.toFixed(2);
}

/**
 * Whole-dollar money for stat tiles (#436): no cents ("$6,350"), and from 1,000,000 up compact
 * with one decimal ("$1.2M") so a tile value stays short. Same currency handling as money();
 * table cells and the company page keep money().
 */
export function moneyWhole(n: number | null | undefined, cur: string | null | undefined): string {
	if (n === null || n === undefined) return '—';
	const compact = Math.abs(n) >= 1_000_000;
	const opts: Intl.NumberFormatOptions = compact
		? { notation: 'compact', minimumFractionDigits: 1, maximumFractionDigits: 1 }
		: { minimumFractionDigits: 0, maximumFractionDigits: 0 };
	if (cur) {
		try {
			return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, ...opts }).format(n);
		} catch {
			return `${new Intl.NumberFormat(undefined, opts).format(n)} ${cur}`;
		}
	}
	return new Intl.NumberFormat(undefined, opts).format(n);
}

/**
 * Stat-tile money (#436): exact whole dollars below 10,000 ("$6,350"); from 10,000 up compact with
 * at most one decimal and a lowercase suffix ("$49.8k", "$123.5k", "$1.2M"), trailing ".0" dropped
 * ("$50k", "$1M"). Keeps a ~160px tile from clipping. Same currency handling as money().
 */
export function moneyTile(n: number | null | undefined, cur: string | null | undefined): string {
	if (n === null || n === undefined) return '—';
	const abs = Math.abs(n);
	if (abs < 10_000) return moneyWhole(n, cur);
	// Round to one decimal of thousands first so 999,950 rolls up to "$1M", not "$1000k".
	let scaled = Math.round(abs / 100) / 10;
	let suffix = 'k';
	if (scaled >= 1000) {
		scaled = Math.round(abs / 100_000) / 10;
		suffix = 'M';
	}
	const signed = n < 0 ? -scaled : scaled;
	const opts: Intl.NumberFormatOptions = { minimumFractionDigits: 0, maximumFractionDigits: 1 };
	const withSuffix = (fmt: Intl.NumberFormat): string => {
		const parts = fmt.formatToParts(signed);
		let last = -1;
		parts.forEach((p, i) => {
			if (p.type === 'integer' || p.type === 'fraction') last = i;
		});
		return parts.map((p, i) => (i === last ? p.value + suffix : p.value)).join('');
	};
	if (cur) {
		try {
			return withSuffix(new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, ...opts }));
		} catch {
			return `${withSuffix(new Intl.NumberFormat(undefined, opts))} ${cur}`;
		}
	}
	return withSuffix(new Intl.NumberFormat(undefined, opts));
}
