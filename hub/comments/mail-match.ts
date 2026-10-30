// Comment <-> mail matching (off by default; a source turns it on with `mailMatch: true`). Before a reply is drafted, the owner's mailbox is searched
// read-only (zele `mail search` / `mail read`: never send, never mark) for a mail from the same person around the time of the comment, so the card
// says whether the commenter already mailed and whether that mail was answered. The lines become notes of the draft (`메일 대조:`, `근거:`, `초안 메모:`).
import { addressKey, isOwnAddress } from "../mail-state.ts";
import { parseThread, type ThreadMessage } from "../zele.ts";

export type MailQuery = { author: string; postTitle: string; text: string; at: number };
export type MailItem = { id: string; from: string; subject: string; snippet: string };
export type MailSearch = {
	/** zele `mail search <query>` items (newest first). */
	search: (query: string) => Promise<MailItem[]>;
	/** The messages of one thread (zele `mail read <id>`). */
	read: (id: string) => Promise<ThreadMessage[]>;
	/** The owner's own addresses: a message from one of them is his answer. */
	own: () => Promise<ReadonlySet<string>>;
};

const DAY = 864e5;
export const WINDOW_DAYS = 14;
const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[\s"'`~!?.,·:;()[\]{}<>/\\|_-]+/g, "");
// "@name-x1y" (a YouTube handle) -> "name"; "Name" -> "name".
export const handleBase = (author: string): string => author.normalize("NFC").replace(/^@/, "").replace(/-[a-z0-9]{2,5}$/i, "").trim().toLowerCase();
export function splitFrom(from: string): { name: string; addr: string } {
	const m = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(from.normalize("NFC"));
	return m ? { name: m[1]!.trim(), addr: m[2]!.trim() } : { name: "", addr: from.trim() };
}
// Words of the post title long enough to name it (a song, a product, a topic).
export function titleWords(title: string): string[] {
	return [...new Set(title.split(/[\s|ㅣ()[\]!/#,:-]+/).map(norm).filter(w => (/[가-힣]/.test(w) && w.length >= 2) || w.length >= 4))];
}

export type Score = { accepted: boolean; byName: boolean; title?: string; reasons: string[] };
// One mail against one comment. Accepted only when the sender is the commenter (the same name, or his handle in the mail); a mail that only
// names the same post is someone else's and is reported as such, never as a match.
export function scoreMail(m: MailItem, q: MailQuery): Score {
	const base = handleBase(q.author);
	const name = norm(splitFrom(m.from).name);
	const hay = norm(`${m.subject} ${m.snippet}`);
	const reasons: string[] = [];
	const byName = base.length >= 2 && ((!!name && (name === norm(base) || name.includes(norm(base)) || norm(base).includes(name))) || hay.includes(norm(base)));
	if (byName) reasons.push(`보낸 사람 이름이 댓글 작성자(${base})와 같음`);
	const title = titleWords(q.postTitle).find(w => hay.includes(w));
	if (title) reasons.push(`글 제목 낱말(${title})이 메일에 있음`);
	return { accepted: byName, byName, ...(title ? { title } : {}), reasons };
}

export type MatchResult =
	| { found: true; mail: MailItem; score: Score; answered: boolean | undefined; others: number }
	| { found: false; searched: number; near?: MailItem; error?: string };

export function matchLines(r: MatchResult): string[] {
	if (!r.found) {
		if (r.error) return [`메일 대조: 확인 실패 - ${r.error}`];
		const near = r.near ? ` · 같은 글을 말한 다른 사람 메일은 있음: ${r.near.from} · ${r.near.subject || "(제목 없음)"} (같은 사람으로 보지 않음)` : "";
		return ["메일 대조: 못 찾음", `근거: 댓글 앞뒤 ${WINDOW_DAYS}일 받은 메일 ${r.searched}건에 댓글 작성자 이름으로 온 메일이 없음${near}`];
	}
	const reply = r.answered === undefined ? "확인 못 함" : r.answered ? "보냄" : "안 보냄";
	return [
		`메일 대조: 있음 - ${r.mail.from} · ${r.mail.subject || "(제목 없음)"} · 스레드 ${r.mail.id} (답장: ${reply})`,
		`근거: ${r.score.reasons.join(", ")}${r.others ? ` (다른 후보 ${r.others}건)` : ""}`,
		...(r.answered === false ? [`초안 메모: 이 분이 보낸 메일(스레드 ${r.mail.id})에 아직 답장하지 않았어요. 댓글 답글과 메일 답장이 둘 다 필요할 수 있어요`] : []),
	];
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "/");

export async function findMail(q: MailQuery, s: MailSearch, now: number): Promise<MatchResult> {
	const base = handleBase(q.author);
	if (base.length < 2) return { found: false, searched: 0 };
	const win = `after:${ymd(q.at - WINDOW_DAYS * DAY)} before:${ymd(Math.min(q.at + (WINDOW_DAYS + 1) * DAY, now + DAY))} -from:me`;
	let items: MailItem[];
	try {
		const own = await s.own();
		const byId = new Map<string, MailItem>();
		for (const query of [`${win} "${base}"`, ...titleWords(q.postTitle).slice(0, 3).map(w => `${win} "${w}"`)]) for (const m of await s.search(query)) byId.set(m.id, m);
		items = [...byId.values()].filter(m => !isOwnAddress(m.from, own) && !/no-?reply/i.test(m.from));
		const scored = items.map(m => ({ m, sc: scoreMail(m, q) }));
		const ok = scored.filter(x => x.sc.accepted).sort((a, b) => Number(!!b.sc.title) - Number(!!a.sc.title));
		if (!ok.length) return { found: false, searched: items.length, ...(scored.find(x => x.sc.title) ? { near: scored.find(x => x.sc.title)!.m } : {}) };
		const best = ok[0]!;
		let answered: boolean | undefined;
		try {
			const msgs = await s.read(best.m.id);
			const first = msgs.findIndex(m => !isOwnAddress(m.from, own));
			answered = msgs.length ? first >= 0 && msgs.slice(first + 1).some(m => isOwnAddress(m.from, own)) : undefined;
		} catch {
			answered = undefined;
		}
		return { found: true, mail: best.m, score: best.sc, answered, others: ok.length - 1 };
	} catch (e) {
		return { found: false, searched: 0, error: e instanceof Error ? e.message.slice(0, 160) : "메일을 읽지 못했어요" };
	}
}

export const mailMatchLines = async (q: MailQuery, s: MailSearch, now: number): Promise<string[]> => matchLines(await findMail(q, s, now));

// The real search: the zele CLI dotz already uses for mail (hub/zele.ts), read-only.
export function zeleMailSearch(accounts: () => Promise<string[]>): MailSearch {
	const run = async (args: string[]): Promise<string> => {
		const p = Bun.spawn(["zele", "mail", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const timer = setTimeout(() => p.kill(), 60_000);
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		clearTimeout(timer);
		if (code !== 0) throw new Error(`zele mail ${args[0]}: ${err.trim().slice(-160) || `exit ${code}`}`);
		return out.normalize("NFC");
	};
	return {
		search: async query => ((Bun.YAML.parse(await run(["search", query, "--limit", "50"])) as { items?: Record<string, unknown>[] } | null)?.items ?? []).map(t => ({ id: String(t.id), from: String(t.from ?? ""), subject: String(t.subject ?? ""), snippet: String(t.snippet ?? "") })),
		read: async id => parseThread(await run(["read", id])),
		own: async () => new Set((await accounts()).map(addressKey).filter(Boolean)),
	};
}
