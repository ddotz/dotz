// Exact room open for a KakaoTalk send, by Accessibility only (room.jxa.js): KakaoTalk is never brought to the front, no key is sent and
// nothing is searched, so the owner sees no right-click scan.
// 1. The chat list rows are read (no click): the row whose title equals the database room name, normalized, is the one. Same-name rooms are
//    told apart by the member count the row shows (groups) against the database count.
// 2. Only that row is opened: its context menu once, then "채팅방 열기" (AXPress).
// 3. The open window is checked against the database room (title, member count where the window shows it). A window that is not the room
//    is closed and the send is refused.
// Every step is timed and named, so a failed send says which step failed (AxStep, kept on the send record).
// Open limits (seen 2026-10): list rows expose only AXShowMenu, and the search button has no AX action, so the room cannot be reached
// without that one menu; reading all 290 rows takes 20 s, so only the first rows are read, within a time box.
import jxa from "./room.jxa.js" with { type: "text" };
import type { Room, Runner } from "./types.ts";

export type RoomFact = { chatId: string; name: string; kind?: Room["kind"]; members?: number };
export type WindowFacts = { title: string; members?: number; self?: boolean };
export type AxStep = { step: string; ms: number; ok: boolean; why?: string };
export type Opened = { ok: true; steps: AxStep[] } | { ok: false; reason: string; steps: AxStep[] };

const READ_ROWS = 60;
const OPEN_CAP_MS = 5_000;
const ROWS_BUDGET_MS = 2_500;

const osascript = (runner: Runner, req: object, timeoutMs = 30_000) => runner(["osascript", "-l", "JavaScript", "-e", jxa], { stdin: `${JSON.stringify(req)}\n`, timeoutMs });

export const REFUSE = {
	notListed: "방을 찾지 못했어요",
	mismatch: "방 이름이나 인원이 달라요",
	noList: "카카오톡 대화 목록 창이 닫혀 있어요. 창을 열어 두면 보낼 수 있어요",
	openFailed: "방을 열지 못했어요",
	timeout: "방을 여는 데 5초가 넘게 걸려서 멈췄어요",
} as const;

export const normalizeTitle = (s: string) => s.normalize("NFC").replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim();

// The member count a group row shows right after its title (a 1:1 row shows the time there).
export const rowMembers = (texts: string[]) => (/^\d+$/.test(texts[1] ?? "") ? Number(texts[1]) : undefined);

export type RowChoice = { ok: true; index: number } | { ok: false; why: "none" | "mismatch" };

// Which list row is the room. A name no other database room has needs one row of that title (the window is checked after, and a window
// is the only place the count is proven); a shared name must be told apart by the row's own member count, else it is refused.
export function chooseRow(rows: string[][], room: RoomFact, shared: boolean): RowChoice {
	const want = normalizeTitle(room.name);
	let hits = rows.flatMap((t, index) => (normalizeTitle(t[0] ?? "") === want ? [{ index, members: rowMembers(t) }] : []));
	if (!hits.length) return { ok: false, why: "none" };
	if (shared || hits.length > 1) {
		if (room.kind === "group") hits = hits.filter(h => h.members !== undefined && h.members === room.members);
		else if (room.kind === "direct" || room.kind === "self") hits = hits.filter(h => h.members === undefined);
		return hits.length === 1 ? { ok: true, index: hits[0]!.index } : { ok: false, why: "mismatch" };
	}
	return { ok: true, index: hits[0]!.index };
}

// Does the open window show this database room? A fact the window does not show is not held against it, except where the name alone
// cannot tell rooms apart (`shared`): then the type markers must be shown and right.
export function windowMatches(w: WindowFacts, room: RoomFact, shared: boolean): boolean {
	if (normalizeTitle(w.title) !== normalizeTitle(room.name)) return false;
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
		const r = await osascript(runner, { action: "probe", deep, ...(name === undefined ? {} : { name }) }, 10_000);
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
		await osascript(runner, { action: "close", ...(name === undefined ? {} : { name }) }, 10_000);
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

type Out = { ok?: boolean; opened?: boolean; rows?: unknown; stopped?: string; step?: string; why?: string; err?: string; ms?: Record<string, number> };

async function call(runner: Runner, req: object, timeoutMs: number): Promise<{ out: Out; ms: number; timedOut: boolean }> {
	const t = performance.now();
	let out: Out = {};
	try {
		const r = await osascript(runner, req, timeoutMs);
		out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "") as Out;
	} catch {}
	const ms = Math.round(performance.now() - t);
	return { out, ms, timedOut: out.ok === undefined && ms >= timeoutMs - 50 };
}

const failWhy = (o: Out) => [o.why ?? "failed", o.err].filter(Boolean).join(":");

// Opens the one list row that is this database room and checks its window. `all` lists every database room (same-name detection). Nothing
// is typed. The open phase (rows read + row open) is capped at OPEN_CAP_MS; every outcome other than ok leaves no window of ours open.
export async function openRoom(room: RoomFact, all: RoomFact[], runner: Runner): Promise<Opened> {
	const steps: AxStep[] = [];
	const t0 = performance.now();
	const left = () => OPEN_CAP_MS - (performance.now() - t0);
	const shared = all.some(r => r.chatId !== room.chatId && normalizeTitle(r.name) === normalizeTitle(room.name));
	const stop = (reason: string): Opened => ({ ok: false, reason, steps });

	const listed = await call(runner, { action: "rows", name: room.name, max: READ_ROWS, budgetMs: ROWS_BUDGET_MS, first: !shared }, Math.min(left(), 4_000));
	if (listed.out.ok !== true) {
		steps.push({ step: "rows", ms: listed.ms, ok: false, why: listed.timedOut ? "timeout" : failWhy(listed.out) });
		return stop(listed.out.why === "no_list" ? REFUSE.noList : listed.timedOut ? REFUSE.timeout : REFUSE.openFailed);
	}
	if (listed.out.opened === true) steps.push({ step: "rows", ms: listed.ms, ok: true, why: "already_open" });
	else {
		const rows = Array.isArray(listed.out.rows) ? (listed.out.rows as unknown[]).map(r => (Array.isArray(r) ? r.map(String) : [])) : [];
		const choice = chooseRow(rows, room, shared);
		steps.push({ step: "rows", ms: listed.ms, ok: choice.ok, why: `${rows.length}:${listed.out.stopped ?? "?"}${choice.ok ? `:row${choice.index}` : `:${choice.why}`}` });
		if (!choice.ok) return stop(choice.why === "none" ? REFUSE.notListed : REFUSE.mismatch);
		if (left() < 1_000) return stop(REFUSE.timeout);
		const row = await call(runner, { action: "open", name: room.name, row: choice.index }, Math.max(1_500, left()));
		const phases = Object.entries(row.out.ms ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
		steps.push({ step: row.out.step ?? "open", ms: row.ms, ok: row.out.ok === true, why: row.out.ok === true ? phases : `${row.timedOut ? "timeout" : failWhy(row.out)}${phases ? `:${phases}` : ""}` });
		if (row.out.ok !== true) {
			if (row.out.step === "window") await closeWindow(runner, room.name);
			return stop(row.timedOut ? REFUSE.timeout : REFUSE.openFailed);
		}
	}
	const tv = performance.now();
	const w = await readWindow(runner, shared, room.name);
	const good = w !== undefined && windowMatches(w, room, shared);
	steps.push({ step: "verify", ms: Math.round(performance.now() - tv), ok: good, ...(good ? {} : { why: w ? "mismatch" : "unreadable" }) });
	if (!good) {
		await closeWindow(runner, room.name);
		return stop(w ? REFUSE.mismatch : REFUSE.openFailed);
	}
	return { ok: true, steps };
}
