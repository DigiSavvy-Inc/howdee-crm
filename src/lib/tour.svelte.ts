// #104: shared state for the product tour so it can be started from anywhere (auto-open on
// first run, or replayed from HelpPanel's "Take the tour" button).
export const tour = $state({ open: false, step: 0 });

export function startTour() {
	tour.step = 0;
	tour.open = true;
}

export function closeTour() {
	tour.open = false;
}
