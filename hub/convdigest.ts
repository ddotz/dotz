// What the main session needs to know about the conversations it does not answer itself: with one session per conversation
// (hub/convsessions.ts) a mail window or a project channel's turn runs in its own context. Main still oversees everything
// (owner 2026-10-28: "메인 대화창은 모든 내용을 다 다루고 다른 세션까지 커버를 할 수 있어야해"), so the header of its next owner
// prompt carries a short digest of what happened elsewhere since its last one, and dotz_conv reads a conversation in full.
// In memory only: after a restart the events log (dotz_conv read) still holds every exchange.
export type DigestKind = "owner" | "bot";
export type DigestEntry = { key: string; kind: DigestKind; text: string; at: number; by?: string; seq: number };
export type ConvDigest = {
	/** Records one exchange of conversation `key` (progress notes, gateway notices and main's own conversation are not kept). */
	note: (key: string, kind: DigestKind, text: string, at?: number, by?: string) => void;
	/** The digest for `viewer`'s next prompt: at most 8 conversations, ~150 characters each, 1200 in total; "" when nothing happened. */
	take: (viewer: string) => string;
	/** Every kept entry of one conversation, oldest first. */
	of: (key: string) => DigestEntry[];
	clear: () => void;
};

export const DIGEST_MAX = 400;
export const DIGEST_CONVS = 8;
export const DIGEST_LINE = 150;
export const DIGEST_CHARS = 1200;
const OWNER_MAX = 200;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createConvDigest(): ConvDigest {
	const entries: DigestEntry[] = [];
	// Each viewer consumes the digest once: its watermark is the sequence number of the last entry it was shown (a clock watermark
	// at millisecond precision drops an exchange recorded in the same millisecond as the take).
	const since = new Map<string, number>();
	let seq = 0;
	function note(key: string, kind: DigestKind, text: string, at = Date.now(), by?: string): void {
		const t = flat(text);
		if (!t || !key) return;
		entries.push({ key, kind, text: cut(t, OWNER_MAX), at, seq: ++seq, ...(by ? { by } : {}) });
		if (entries.length > DIGEST_MAX) entries.splice(0, entries.length - DIGEST_MAX);
	}
	function take(viewer: string): string {
		const from = since.get(viewer) ?? 0;
		since.set(viewer, seq);
		const fresh = entries.filter(e => e.seq > from && e.key !== viewer && e.by !== viewer);
		if (!fresh.length) return "";
		const byKey = new Map<string, DigestEntry[]>();
		for (const e of fresh) {
			const list = byKey.get(e.key);
			if (list) list.push(e);
			else byKey.set(e.key, [e]);
		}
		const newest = [...byKey.entries()].sort((a, b) => (b[1].at(-1)!.at ?? 0) - (a[1].at(-1)!.at ?? 0)).slice(0, DIGEST_CONVS);
		const lines: string[] = [];
		let total = 0;
		for (const [key, list] of newest) {
			// The last thing the owner said and the last thing that answered, so the line reads as an exchange.
			const owner = list.filter(e => e.kind === "owner").at(-1);
			const bot = list.filter(e => e.kind === "bot").at(-1);
			const parts = [owner ? `주인님: ${cut(owner.text, 70)}` : "", bot ? `답: ${cut(bot.text, 70)}` : ""].filter(Boolean);
			const line = cut(`${key} · ${parts.join(" · ")}`, DIGEST_LINE);
			if (total + line.length + 1 > DIGEST_CHARS) break;
			lines.push(line);
			total += line.length + 1;
		}
		if (!lines.length) return "";
		return `[다른 대화에서 최근에 오간 것]\n${lines.join("\n")}\n전체 내용은 dotz_conv read {key} 로 볼 수 있어요.`;
	}
	return { note, take, of: key => entries.filter(e => e.key === key), clear: () => entries.splice(0) };
}

export const digest = createConvDigest();
