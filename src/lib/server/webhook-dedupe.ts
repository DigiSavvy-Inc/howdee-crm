import { sha256Hex } from './api-keys';

/**
 * #542: one key per Postmark record, so a retry of the same delivery is a no-op. Built from the
 * fields that identify a record (Bounce / SpamComplaint `ID`, the event time, MessageID, link,
 * address). Null when the payload has neither an ID nor a timestamp — then nothing is deduped.
 */
export async function webhookDedupeKey(payload: Record<string, any>): Promise<string | null> {
	const time = payload.ReceivedAt ?? payload.DeliveredAt ?? payload.BouncedAt ?? payload.ChangedAt ?? null;
	const id = payload.ID ?? null;
	if (id == null && time == null) return null;
	const parts = [
		payload.RecordType ?? '',
		id,
		payload.MessageID ?? null,
		time,
		payload.OriginalLink ?? null,
		String(payload.Recipient ?? payload.Email ?? '').toLowerCase()
	];
	return 'pm:' + (await sha256Hex(JSON.stringify(parts)));
}
