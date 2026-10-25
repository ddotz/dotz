// Reply state of a mail thread for the zele mail watch (hub/zele.ts tick): parses `zele mail read <thread>` and decides
// whether the newest messages still need the owner. Pure, so the rules are tested without zele (hub/mail-thread.test.ts).

export type ThreadMessage = { from: string; addr: string; date: string; unread: boolean; body: string };
/** `own`: the owner wrote last. `ack`: the other side only acknowledged the owner's reply. `action`: the owner is needed;
 * `answered` says whether the owner had already replied in this thread. */
export type Triage = { kind: "own" } | { kind: "ack" } | { kind: "action"; answered: boolean };

const SEPARATOR = /^\s*─{3,}\s*$/;
const ADDR = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/** `zele mail read` text: a header, then message blocks split by a line of `─`, each `From: Name <addr> [unread]`, `To:`,
 * `Date:`, optional `Auth:`, a blank line, the body. A block without a `From:` line (the thread header) is not a message. */
export function parseThread(text: string): ThreadMessage[] {
	const blocks: string[][] = [[]];
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (SEPARATOR.test(line)) blocks.push([]);
		else blocks.at(-1)!.push(line);
	}
	const out: ThreadMessage[] = [];
	for (const lines of blocks) {
		const at = lines.findIndex(l => /^From:\s/.test(l));
		if (at < 0) continue;
		const fromLine = lines[at].replace(/^From:\s*/, "");
		const blank = lines.findIndex((l, i) => i > at && !l.trim());
		const head = lines.slice(at, blank < 0 ? lines.length : blank);
		const date = head.find(l => /^\s*Date:\s/.test(l))?.replace(/^\s*Date:\s*/, "").trim() ?? "";
		out.push({
			from: fromLine.replace(/\s*\[unread\]\s*$/i, "").trim(),
			addr: (fromLine.match(/<([^>]+)>/)?.[1] ?? fromLine.match(ADDR)?.[0] ?? "").trim().toLowerCase(),
			date,
			unread: /\[unread\]\s*$/i.test(fromLine),
			body: blank < 0 ? "" : lines.slice(blank + 1).join("\n").trim(),
		});
	}
	return out;
}

// Where a client starts quoting the earlier mail; everything from there on is not the new text.
const QUOTE_START = [/^On .+wrote:\s*$/i, /^20\d\d[.\-/년 ].*작성:?\s*$/, /^-{2,}\s*(Original Message|원본 메시지)\s*-{2,}$/i, /^(From|보낸 사람):\s/i];

/** The new text of a message: quoted lines, the quoted earlier mail and a `-- ` signature dropped. */
export function newText(body: string): string {
	const kept: string[] = [];
	for (const line of body.split("\n")) {
		const t = line.trim();
		if (QUOTE_START.some(r => r.test(t)) || line === "-- " || t === "--") break;
		if (!t.startsWith(">")) kept.push(line);
	}
	return kept.join("\n").trim();
}

const REQUEST = /부탁|요청|문의|가능|할 수 있|please|could|can you/i;
// An ack has to say thanks or "received": a short note without it ("see the file", "3pm then") may still need the owner.
const THANKS = /감사|고맙|잘 받았|받았습니다|확인했습니다|thank|received|got it/i;
const ACK_MAX_LINES = 4;
const ACK_MAX_CHARS = 300;

/** A short thank-you or "received" note: a thanks word, no question, no request words, a few lines at most. An empty note is not one,
 * since it may carry only an attachment the owner has to look at. */
export function isAck(body: string): boolean {
	const text = newText(body);
	const lines = text.split("\n").filter(l => l.trim());
	return THANKS.test(text) && !/[?？]/.test(text) && !REQUEST.test(text) && lines.length <= ACK_MAX_LINES && text.length <= ACK_MAX_CHARS;
}

/** `owner` holds the mailbox's own addresses, lowercase. An empty thread (nothing parsed) needs the owner, so a format
 * change in zele can only make the watch louder, never drop mail. */
export function triage(messages: ThreadMessage[], owner: ReadonlySet<string>): Triage {
	const last = messages.at(-1);
	if (last && owner.has(last.addr)) return { kind: "own" };
	const reply = messages.findLastIndex(m => owner.has(m.addr));
	if (reply < 0) return { kind: "action", answered: false };
	return messages.slice(reply + 1).every(m => isAck(m.body)) ? { kind: "ack" } : { kind: "action", answered: true };
}
