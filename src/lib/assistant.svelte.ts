// Assistant panel open state (#287), shared by the header button, Cmd/Ctrl+J and the panel.
// Lives in the root layout, so it survives client-side navigation.

export const ASSISTANT_WIDTH_KEY = 'ds-assistant-width';
export const ASSISTANT_MIN_WIDTH = 380;
export const ASSISTANT_MAX_WIDTH = 640;

export const assistant = $state({ open: false });

/** #301: contact ids checked on /contacts or /lists/[id] (set by ContactBulkBar while it is
 *  shown, ≤ SELECTION_MAX), sent as page context so "tag these" works. */
export const assistantSelection = $state({ ids: [] as number[] });

/** #309: bumped when an assistant write (or its Undo) changed campaign draft `campaignId`, so
 *  the composer can offer "Draft updated by assistant: Reload" and the campaign page reloads. */
export const assistantDraftUpdate = $state({ campaignId: 0, n: 0 });

export function noteDraftUpdate(campaignId: number | null): void {
	if (!campaignId) return;
	assistantDraftUpdate.campaignId = campaignId;
	assistantDraftUpdate.n++;
}

export function toggleAssistant(): void {
	assistant.open = !assistant.open;
}

export function clampAssistantWidth(w: number): number {
	if (!Number.isFinite(w)) return 420;
	return Math.max(ASSISTANT_MIN_WIDTH, Math.min(ASSISTANT_MAX_WIDTH, Math.round(w)));
}
