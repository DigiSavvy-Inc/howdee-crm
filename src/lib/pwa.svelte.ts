// #135: shared PWA state — the captured install prompt (offered from HelpPanel + the top
// bar), the iOS "Add to Home Screen" hint, and the "Update available" flag set when a newly
// deployed service worker takes over this tab.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };

export const pwa = $state({ canInstall: false, iosHint: false, updateReady: false });

let deferred: InstallPromptEvent | null = null;
let started = false;

/** Call once from the root layout, in the browser. */
export function initPwa() {
	if (started) return;
	started = true;

	const standalone =
		window.matchMedia('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true;
	// iOS Safari never fires beforeinstallprompt; it only installs via the Share sheet.
	pwa.iosHint = !standalone && /iphone|ipad|ipod/i.test(navigator.userAgent);

	window.addEventListener('beforeinstallprompt', (e) => {
		e.preventDefault();
		deferred = e as InstallPromptEvent;
		pwa.canInstall = true;
	});
	window.addEventListener('appinstalled', () => {
		deferred = null;
		pwa.canInstall = false;
	});

	// The SW calls skipWaiting + clients.claim, so a new deploy takes over open tabs. A
	// controller change when one already existed means this tab is running old code.
	if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			pwa.updateReady = true;
		});
	}
}

export async function promptInstall() {
	if (!deferred) return;
	const e = deferred;
	deferred = null;
	pwa.canInstall = false;
	await e.prompt();
	await e.userChoice;
}
