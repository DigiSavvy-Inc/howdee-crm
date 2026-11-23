// Mask secret values in a message before it is logged or stored (#604: moved out of
// snapshot-report.ts — contact writes and the heartbeat tick use it too). Pure.

export function redactSecrets(message: string, secrets: Array<string | null | undefined>): string {
	let out = message;
	for (const secret of secrets) {
		const s = (secret ?? '').trim();
		if (s.length < 6) continue;
		out = out.split(s).join('[REDACTED]');
	}
	return out;
}
