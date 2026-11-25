// #731: the "Finish setup" messages every send path uses on an install that hasn't connected a
// sending provider or set a From address yet. Universal (no server imports), so the engine, the
// form actions, the API routes and the pages all show the same words (docs/easy-install.md).

/** No sending provider is configured yet (nothing saved in Settings → Sending, nothing in the env). */
export const FINISH_SETUP_SENDING =
	'Finish setup: sending isn’t set up yet. Paste the sending provider’s token in Settings → Sending (or follow Settings → Setup).';

/** No From address: the step / form has none, and neither Settings → General → Default From nor
 *  POSTMARK_FROM is set. */
export const FINISH_SETUP_FROM =
	'Finish setup: no sender configured. Set the Default From address in Settings → General (or follow Settings → Setup).';

/** True for a message that came from one of the constants above (a held automation pass, a form). */
export function isFinishSetupMessage(msg: string | null | undefined): boolean {
	return (msg ?? '').startsWith('Finish setup:');
}
