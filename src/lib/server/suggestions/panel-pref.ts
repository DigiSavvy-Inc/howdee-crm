// #715: Account → "Show the suggestions panel" — `users.suggestions_panel` (migration 0135,
// default 1 = on). Reads tolerate the column being absent (before 0135): everyone is on, and a
// save is refused with a message instead of a 500.

function missingColumn(err: unknown): boolean {
	const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err);
	return /no such column:\s*(?:[\w"]+\.)?suggestions_panel\b/i.test(msg);
}

/** True unless this user turned the panel off (unknown user / missing column = on). */
export async function suggestionsPanelOn(db: D1Database, userId: number): Promise<boolean> {
	try {
		const row = await db.prepare('SELECT suggestions_panel AS on_ FROM users WHERE id = ?').bind(userId).first<{ on_: number | null }>();
		return row?.on_ !== 0;
	} catch (err) {
		if (missingColumn(err)) return true;
		throw err;
	}
}

/** Save the user's choice; false when the column doesn't exist yet (migration 0135 not applied). */
export async function setSuggestionsPanel(db: D1Database, userId: number, on: boolean): Promise<boolean> {
	try {
		await db.prepare('UPDATE users SET suggestions_panel = ? WHERE id = ?').bind(on ? 1 : 0, userId).run();
		return true;
	} catch (err) {
		if (missingColumn(err)) return false;
		throw err;
	}
}
