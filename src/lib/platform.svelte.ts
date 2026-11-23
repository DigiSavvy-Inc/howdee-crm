// Which computer the hints are for (#572). Server rendering (and the first client paint)
// uses the Windows/Linux labels; the root layout calls `initPlatform()` on mount, and every
// hint built from `platform.mac` switches to the Mac labels there. Hydration stays matched.
import { detectMac, keyLabel } from '$lib/shortcuts';

export const platform = $state({ mac: false });

export function initPlatform(): void {
	platform.mac = detectMac();
}

/** Reactive label for this computer — use inside markup or a $derived. */
export function kbd(combo: string): string {
	return keyLabel(combo, platform.mac);
}
