// Minimal Server-Sent Events parser (#287), universal: the Worker reads Anthropic's stream
// with it and the assistant panel reads /api/assistant/chat with it. Feed decoded text with
// push(); complete messages come back as `{ event, data }` (comments skipped).

export type SseMessage = { event: string; data: string };

function parseChunk(chunk: string): SseMessage | null {
	let event = 'message';
	const data: string[] = [];
	for (const line of chunk.split('\n')) {
		if (!line || line.startsWith(':')) continue;
		const i = line.indexOf(':');
		const field = i === -1 ? line : line.slice(0, i);
		let value = i === -1 ? '' : line.slice(i + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') event = value;
		else if (field === 'data') data.push(value);
	}
	return data.length ? { event, data: data.join('\n') } : null;
}

export class SseBuffer {
	private buf = '';

	push(text: string): SseMessage[] {
		this.buf += text.replace(/\r\n?/g, '\n');
		const out: SseMessage[] = [];
		let at: number;
		while ((at = this.buf.indexOf('\n\n')) !== -1) {
			const m = parseChunk(this.buf.slice(0, at));
			this.buf = this.buf.slice(at + 2);
			if (m) out.push(m);
		}
		return out;
	}

	/** Whatever is left once the stream ended without a final blank line. */
	flush(): SseMessage[] {
		const rest = this.buf;
		this.buf = '';
		const m = rest.trim() ? parseChunk(rest) : null;
		return m ? [m] : [];
	}
}
