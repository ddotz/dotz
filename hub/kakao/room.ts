// Exact room choice for a KakaoTalk send. The target is a room of the database, never a name alone: a search by a person's name also
// lists every group that person is in, and a 1:1, the memo chat and groups can share one name. So the send never lets kmsg search.
// 1. The chat list rows (`kmsg chats`) whose title equals the room name are the candidates; none, or too many, refuse.
// 2. Each candidate row is opened by its kmsg chat_id (a list row, not a search) and the open window is read (room.jxa.js) and
//    compared with the database room: title, type and member count. Exactly one candidate must match.
// 3. The window is closed again. Only then the caller sends to that chat_id. Every other outcome refuses without typing anything.
// Open limits (seen 2026-10): kmsg has no way to open a room by the database chat id (its chat_id is a hash of the list row), and the
// final `kmsg send --chat-id` opens the same row again; the window it opens cannot be read before Enter.
import jxa from "./room.jxa.js" with { type: "text" };
import { KAKAO_BUNDLE, type Room, type Runner } from "./types.ts";

export type RoomFact = { chatId: string; name: string; kind?: Room["kind"]; members?: number };
export type ListRow = { chatId: string; title: string };
export type WindowFacts = { title: string; members?: number; self?: boolean };
export type Pick = { ok: true; id: string } | { ok: false; reason: string };

const MAX_CANDIDATES = 4;
const LIST_LIMIT = 300;
// `kmsg chats` walks the list row by row (measured 2026-10: 0.4 s for 1 row, 19.6 s for 200). A room no other database room shares is
// looked for in the first rows only, and in all LIST_LIMIT rows when that finds none.
const QUICK_LIMIT = 40;

const osascript = (runner: Runner, req: object) => runner(["osascript", "-l", "JavaScript", "-e", jxa], { stdin: `${JSON.stringify(req)}\n`, timeoutMs: 30_000 });

export const REFUSE = {
	notListed: "카카오톡 대화 목록에서 이 방을 찾지 못해서 보내지 않았어요",
	same: "같은 이름의 방이 여러 개라 보내지 않았어요. 카카오톡에서 직접 보내 주세요",
	mismatch: "열린 대화창이 고른 방과 달라서 보내지 않았어요",
	unreadable: "열린 대화창을 확인하지 못해서 보내지 않았어요",
	list: "카카오톡 대화 목록을 읽지 못해서 보내지 않았어요",
} as const;

export async function listRows(kmsg: string, runner: Runner, limit = LIST_LIMIT): Promise<ListRow[] | undefined> {
	try {
		const r = await runner([kmsg, "chats", "--json", "--limit", String(limit)], { timeoutMs: 60_000 });
		if (r.code !== 0) return undefined;
		const chats = JSON.parse(r.stdout)?.chats;
		if (!Array.isArray(chats)) return undefined;
		return chats.filter(c => c && typeof c.chat_id === "string" && typeof c.title === "string").map(c => ({ chatId: c.chat_id, title: c.title }));
	} catch {
		return undefined;
	}
}

// Does the open window show this database room? A fact the window does not show is not held against it, except where the name alone
// cannot tell rooms apart (`shared`): then the type markers must be shown and right.
export function windowMatches(w: WindowFacts, room: RoomFact, shared: boolean): boolean {
	if (w.title !== room.name) return false;
	if (room.kind === "self") {
		if (w.members !== undefined && w.members > 2) return false;
		return shared ? w.self === true : w.self !== false;
	}
	if (w.self === true) return false;
	if (room.kind === "group") {
		if (shared && (w.members === undefined || room.members === undefined)) return false;
		return w.members === undefined || room.members === undefined || w.members === room.members;
	}
	if (room.kind === "direct") return w.members === undefined || w.members <= 2;
	return !shared;
}

// `name`: only the window of that title counts (other chat windows may be open); without it the one chat window open.
export async function readWindow(runner: Runner, deep = false, name?: string): Promise<WindowFacts | undefined> {
	try {
		const r = await osascript(runner, { action: "probe", deep, ...(name === undefined ? {} : { name }) });
		const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
		if (r.code !== 0 || out?.ok !== true || !Array.isArray(out.windows) || out.windows.length !== 1) return undefined;
		const w = out.windows[0];
		if (typeof w?.title !== "string") return undefined;
		return {
			title: w.title,
			...(Number.isInteger(w.members) ? { members: w.members } : {}),
			...(typeof w.self === "boolean" ? { self: w.self } : {}),
		};
	} catch {
		return undefined;
	}
}

// `name`: only the chat window of that title; without it every chat window.
export const closeWindow = async (runner: Runner, name?: string) => {
	try {
		await osascript(runner, { action: "close", ...(name === undefined ? {} : { name }) });
	} catch {}
};

// Types the text into the open window of the room and presses 전송, by Accessibility only (room.jxa.js send). The text goes on stdin,
// never on a command line. `pressed` without `ok`: the button was pressed but the send is not confirmed, so it must not be retried.
export async function axSend(name: string, text: string, runner: Runner): Promise<{ ok: boolean; pressed?: boolean; why?: string }> {
	try {
		const r = await osascript(runner, { action: "send", name, text });
		const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
		if (out?.ok === true) return { ok: true };
		return { ok: false, pressed: out?.pressed === true, why: typeof out?.why === "string" ? out.why : "failed" };
	} catch {
		return { ok: false, why: "failed" };
	}
}

// Background open (measured 2026-10-23: about 1-2 s, against 17-46 s for `kmsg send|read --chat-id`, which scans 200 rows and needs an Enter key
// with KakaoTalk in front): the one row titled exactly like the room among the first QUICK_LIMIT rows is opened by Accessibility
// actions (room.jxa.js open), with KakaoTalk left in the background. The list window is brought up with `open -g` when it is not
// shown. Other chat windows stay open. The caller still checks the open window against the database room; anything but "ok" leaves
// the slow, checked path to it.
export async function openListRow(name: string, runner: Runner): Promise<string> {
	const run = async () => {
		try {
			const r = await osascript(runner, { action: "open", name, rows: QUICK_LIMIT });
			return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "") as { ok?: boolean; why?: string };
		} catch {
			return {};
		}
	};
	let out = await run();
	if (out.why === "no_list") {
		await runner(["open", "-g", "-b", KAKAO_BUNDLE], { timeoutMs: 5_000 }).catch(() => undefined);
		out = await run();
	}
	return out.ok === true ? "ok" : (out.why ?? "failed");
}

// Picks the one list row that is this database room. `all` lists every database room (for same-name detection).
export async function pickRoom(room: RoomFact, all: RoomFact[], deps: { kmsg: string; runner: Runner }): Promise<Pick> {
	const dbShared = all.some(r => r.chatId !== room.chatId && r.name === room.name);
	let rows = await listRows(deps.kmsg, deps.runner, dbShared ? LIST_LIMIT : QUICK_LIMIT);
	if (rows && !dbShared && !rows.some(r => r.title === room.name)) rows = await listRows(deps.kmsg, deps.runner);
	if (!rows) return { ok: false, reason: REFUSE.list };
	const candidates = rows.filter(r => r.title === room.name);
	if (!candidates.length) return { ok: false, reason: REFUSE.notListed };
	if (candidates.length > MAX_CANDIDATES) return { ok: false, reason: REFUSE.same };
	const shared = candidates.length > 1 || all.some(r => r.chatId !== room.chatId && r.name === room.name);
	const matched: string[] = [];
	let unreadable = false;
	for (const c of candidates) {
		const open = (deep: boolean) => deps.runner([deps.kmsg, "read", "--chat-id", c.chatId, "--limit", "1", "--keep-window", ...(deep ? ["--deep-recovery"] : [])], { timeoutMs: 90_000 }).catch(() => undefined);
		// A cold first window often fails to open (seen with the memo chat); one retry with deep window recovery, as the send does.
		let opened = await open(false);
		if (opened?.code !== 0) opened = await open(true);
		const w = opened?.code === 0 ? await readWindow(deps.runner, shared) : undefined;
		await closeWindow(deps.runner);
		if (!w) unreadable = true;
		else if (windowMatches(w, room, shared)) matched.push(c.chatId);
	}
	if (matched.length === 1) return { ok: true, id: matched[0]! };
	if (matched.length > 1) return { ok: false, reason: REFUSE.same };
	return { ok: false, reason: unreadable ? REFUSE.unreadable : REFUSE.mismatch };
}
