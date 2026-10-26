// Exact room open for a KakaoTalk send, by Accessibility only (room.jxa.js): KakaoTalk is never brought to the front (except the last rung of
// send.ts's ladder), no key is sent and nothing is searched, so the owner sees no right-click scan.
// 1. The chat list rows are read (no click): the row whose title equals the database room name, normalized (NFC, invisible marks, whitespace,
//    a trailing member count), is the one. Same-name rooms are told apart by the member count the row shows (groups) against the database
//    count, and when that is not enough by the newest message the list shows under the name against the database preview. The whole list is
//    read with the AX API inside room.jxa.js (~20 ms a row; 290 rows ≈ 4 s), starting at the row the database order predicts, and the read
//    stops at the first name hit or the budget ({ok:false} reason says the list end was reached or the time ran out).
// 2. Only that row is opened: its context menu once, then "채팅방 열기" (AXPress).
// 3. The open window is checked against the database room (title, member count where the window shows it). A window that is not the room
//    is closed and the send is refused.
// Every step is timed and named, so a failed send says which step failed (AxStep, kept on the send record).
// Open limits (seen 2026-10): list rows expose only AXShowMenu, and the search button has no AX action, so the room cannot be reached
// without that one menu; reading all 290 rows takes 20 s, so only the first rows are read, within a time box.
import jxa from "./room.jxa.js" with { type: "text" };
import type { Room, Runner } from "./types.ts";

// preview/lastAt: the room's newest message from the database, used only to tell same-name rows apart (the list shows it under the name).
export type RoomFact = { chatId: string; name: string; kind?: Room["kind"]; members?: number; preview?: string; lastAt?: number };
export type WindowFacts = { title: string; members?: number; self?: boolean };
export type AxStep = { step: string; ms: number; ok: boolean; why?: string };
// Focus: set only when the list window had to be opened. `from`: bundle id of the app in front before; `took`: KakaoTalk came to the front
// when its list window showed; `restored`: the app in front before was put back at once.
export type Focus = { from?: string; took: boolean; restored: boolean };
export type Opened = { ok: true; steps: AxStep[]; focus?: Focus } | { ok: false; reason: string; steps: AxStep[]; focus?: Focus };

const READ_ROWS = 60;
// The measured native scan is ~20 ms a row (290 rows ≈ 5.8 s), so only the last rung gets the whole list; every earlier rung relies on the
// database-order hint and stops at the first name hit.
const OPEN_CAP_MS = 8_000;
const ROWS_BUDGET_MS = 3_500;
const DEEP_BUDGET_MS = 6_000;

const osascript = (runner: Runner, req: object, timeoutMs = 30_000) => runner(["osascript", "-l", "JavaScript", "-e", jxa], { stdin: `${JSON.stringify(req)}\n`, timeoutMs });

export const REFUSE = {
	notListed: "방을 찾지 못했어요",
	notFoundEnd: "목록 끝까지 찾지 못했어요",
	notFoundTime: "시간 안에 방을 찾지 못했어요",
	mismatch: "방 이름이나 인원이 달라요",
	noList: "카톡 창이 닫혀 있어요. 카카오톡 창을 열어 주세요",
	openFailed: "방을 열지 못했어요",
	partial: "같은 이름의 방을 목록 끝까지 확인하지 못해서 고르지 않았어요",
	timeout: "방을 여는 데 5초가 넘게 걸려서 멈췄어요",
} as const;

// Zero-width marks, variation selectors and the line-break forms differ between KakaoTalk's AX value and the text we typed; both sides of
// every comparison run through this. Whitespace inside a line is collapsed, line breaks are kept (a draft can be several lines).
export const normalizeInput = (s: string) =>
	s
		.normalize("NFC")
		.replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
		.replace(/[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u2028\u2029]/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.trim();

// The same text after KakaoTalk's own normalization (NFD/NFC, \\r vs \\n, trimmed ends, invisible marks).
export const sameText = (a: string, b: string) => normalizeInput(a) === normalizeInput(b);

// An empty input, also when it only shows its placeholder or invisible characters.
export const inputFree = (value: string, placeholder?: string) => normalizeInput(value) === "" || (placeholder !== undefined && placeholder !== "" && sameText(value, placeholder));

// A trailing member count some rows carry after the name ("스터디방 (5)") is not part of the name.
export const normalizeTitle = (s: string) => normalizeInput(s).replace(/\s*\(\s*\d+\s*\)$/, "").trim();

// The member count a group row shows right after its title (a 1:1 row shows the time there).
export const rowMembers = (texts: string[]) => (/^\d+$/.test(texts[1] ?? "") ? Number(texts[1]) : undefined);

// What the list shows under the name: the newest message. A time, a count or an unread badge is not a preview.
const CLOCK = /^(?:오전|오후)?\s*\d{1,2}:\d{2}$|^(?:어제|오늘|방금|\d+\s*(?:분|시간|일) 전)$|^\d{1,2}월\s*\d{1,2}일$/;
const BADGE = /^\d+\+?$/;
export const rowPreview = (texts: string[]) => texts.slice(1).find(t => normalizeInput(t) !== "" && !BADGE.test(normalizeInput(t)) && !CLOCK.test(normalizeInput(t)));

// KakaoTalk cuts a long preview with "…"; a short one must match exactly (a two-letter word is not evidence).
const previewSame = (shown: string, want: string) => {
	const a = normalizeInput(shown).replace(/[…\.]{1,3}$/, "").trim();
	const b = normalizeInput(want).replace(/[…\.]{1,3}$/, "").trim();
	if (!a || !b) return false;
	if (a === b) return true;
	return (b.length >= 8 && b.startsWith(a)) || (a.length >= 8 && a.startsWith(b));
};

// members/preview: what the chosen row showed (re-verified at open time when the choice rested on them).
export type RowChoice = { ok: true; index: number; via: "name" | "members" | "preview"; members?: number; preview?: string } | { ok: false; why: "none" | "mismatch" };

// Which list row is the room. A name no other database room has needs one row of that title (the window is checked after, and a window
// is the only place the count is proven); a shared name is told apart by the row's own member count, and when that is not enough (two
// rooms of one name and one size), by the newest message the list shows under the name (database preview).
export function chooseRow(rows: string[][], room: RoomFact, shared: boolean): RowChoice {
	const want = normalizeTitle(room.name);
	const hits = rows.flatMap((t, index) => (normalizeTitle(t[0] ?? "") === want ? [{ index, members: rowMembers(t), preview: rowPreview(t) }] : []));
	if (!hits.length) return { ok: false, why: "none" };
	if (!shared && hits.length === 1) return { ok: true, index: hits[0]!.index, via: "name" };
	let left = hits;
	if (room.kind === "group") left = left.filter(h => h.members !== undefined && h.members === room.members);
	else if (room.kind === "direct" || room.kind === "self") left = left.filter(h => h.members === undefined);
	const pickHit = (h: (typeof hits)[number], via: "members" | "preview"): RowChoice => ({ ok: true, index: h.index, via, ...(h.members !== undefined ? { members: h.members } : {}), ...(via === "preview" && h.preview !== undefined ? { preview: h.preview } : {}) });
	if (left.length === 1) return pickHit(left[0]!, "members");
	// Same name and size: the newest message of the database room is the only fact left that the screen itself shows.
	if (room.preview && left.length > 1) {
		const byPreview = left.filter(h => h.preview !== undefined && previewSame(h.preview, room.preview!));
		if (byPreview.length === 1) return pickHit(byPreview[0]!, "preview");
	}
	return { ok: false, why: "mismatch" };
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
// `ours`: texts this room's input may still hold from an earlier dotz attempt (cleared and replaced). `priorPressed`: texts whose 전송 was
// pressed before without confirmation (never typed over or pressed again). `left`: what the input still holds after a failed attempt.
export type SendOut = { ok: boolean; pressed?: boolean; why?: string; preview?: string; left?: string };
export async function axSend(name: string, text: string, runner: Runner, opts: { ours?: string[]; priorPressed?: string[] } = {}): Promise<SendOut> {
	try {
		const r = await osascript(runner, { action: "send", name, text, ...(opts.ours?.length ? { ours: opts.ours } : {}), ...(opts.priorPressed?.length ? { priorPressed: opts.priorPressed } : {}) });
		const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
		if (out?.ok === true) return { ok: true };
		if (typeof out?.why !== "string") return UNCERTAIN;
		return {
			ok: false,
			pressed: out?.pressed === true,
			why: typeof out?.why === "string" ? out.why : "failed",
			...(typeof out?.preview === "string" ? { preview: out.preview } : {}),
			...(typeof out?.left === "string" ? { left: out.left } : {}),
		};
	} catch {
		return UNCERTAIN;
	}
}
// No answer that says how far the script got (killed by the timeout, no JSON, no reason): the press may have happened, so it counts as
// pressed. The send then asks the database and never types or presses again (exactly once beats delivery).
const UNCERTAIN: SendOut = { ok: false, pressed: true, why: "uncertain" };

type Out = { focus?: { from?: unknown; took?: unknown; restored?: unknown }; ok?: boolean; opened?: boolean; rows?: unknown; hits?: unknown; scanned?: number; pages?: number; stopped?: string; step?: string; why?: string; err?: string; ms?: Record<string, number> };

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

const DEEP_ROWS = 120;

// Opens the one list row that is this database room and checks its window. `all` lists every database room (same-name detection). Nothing
// is typed. `hint`: the row the database order predicts (the list is newest first); the scan starts there, so a room far down costs one row
// read instead of hundreds. `deep`: scan without the hint and with the whole budget (the order assumption was wrong). The open phase (rows
// read + row open) is capped at OPEN_CAP_MS; every outcome other than ok leaves no window of ours open.
export async function openRoom(room: RoomFact, all: RoomFact[], runner: Runner, opts: { deep?: boolean; hint?: number } = {}): Promise<Opened> {
	const steps: AxStep[] = [];
	const t0 = performance.now();
	const left = () => cap - (performance.now() - t0);
	const want = normalizeTitle(room.name);
	const namesakes = all.filter(r => r.chatId !== room.chatId && normalizeTitle(r.name) === want).length;
	const shared = namesakes > 0;
	let focus: Focus | undefined;
	const stop = (reason: string): Opened => ({ ok: false, reason, steps, ...(focus ? { focus } : {}) });
	const deep = opts.deep === true;
	// A shared name is only chosen once every row of that name was seen (the list end, or as many rows as the database has rooms of that
	// name), so it gets the whole budget at once instead of failing rung after rung on a partial read.
	const budget = deep || shared ? DEEP_BUDGET_MS : ROWS_BUDGET_MS;
	const need = shared ? namesakes + 1 : 1;
	const rowsReq = { action: "rows", name: room.name, max: deep ? DEEP_ROWS : READ_ROWS, budgetMs: budget, first: !shared, ...(shared ? { need } : {}), ...(deep || opts.hint === undefined ? {} : { hint: opts.hint }) };
	const cap = shared ? OPEN_CAP_MS + 2_000 : OPEN_CAP_MS;
	const rowsCallMs = budget + 1_200;

	let listed = await call(runner, rowsReq, Math.min(left(), rowsCallMs));
	// No list window (KakaoTalk runs from the menu bar): open it once through its menu 창 > 채팅. KakaoTalk then comes to the front for
	// a moment; the app in front before is put back inside that call, and the change is kept on the send record.
	if (listed.out.ok !== true && listed.out.why === "no_list") {
		steps.push({ step: "rows", ms: listed.ms, ok: false, why: "no_list" });
		const opening = await call(runner, { action: "openlist" }, Math.min(Math.max(1_500, left()), 4_000));
		const f = opening.out.focus;
		if (f) focus = { ...(typeof f.from === "string" && f.from ? { from: f.from } : {}), took: f.took === true, restored: f.restored === true };
		const phases = Object.entries(opening.out.ms ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
		steps.push({ step: "openlist", ms: opening.ms, ok: opening.out.ok === true, why: opening.out.ok === true ? phases : `${opening.timedOut ? "timeout" : failWhy(opening.out)}${phases ? `:${phases}` : ""}` });
		if (opening.out.ok !== true) return stop(opening.timedOut ? REFUSE.timeout : REFUSE.noList);
		if (left() < 1_000) return stop(REFUSE.timeout);
		listed = await call(runner, rowsReq, Math.min(left(), rowsCallMs));
	}
	if (listed.out.ok !== true) {
		steps.push({ step: "rows", ms: listed.ms, ok: false, why: listed.timedOut ? "timeout" : failWhy(listed.out) });
		return stop(listed.out.why === "no_list" ? REFUSE.noList : listed.timedOut ? REFUSE.timeout : REFUSE.openFailed);
	}
	if (listed.out.opened === true) steps.push({ step: "rows", ms: listed.ms, ok: true, why: "already_open" });
	else {
		const hits = Array.isArray(listed.out.hits) ? (listed.out.hits as unknown[]).flatMap(h => (h && typeof h === "object" && Number.isInteger((h as { index?: unknown }).index) && Array.isArray((h as { texts?: unknown }).texts) ? [{ index: (h as { index: number }).index, texts: ((h as { texts: unknown[] }).texts).map(String) }] : [])) : [];
		// A sparse array keeps every hit at its list row index; chooseRow reads only the rows that were read.
		const rows: string[][] = [];
		for (const h of hits) rows[h.index] = h.texts;
		const choice = chooseRow(rows, room, shared);
		const scanned = typeof listed.out.scanned === "number" ? listed.out.scanned : rows.length;
		const stopped = listed.out.stopped ?? "?";
		steps.push({ step: deep ? "rows:deep" : "rows", ms: listed.ms, ok: choice.ok, why: `${scanned}:${stopped}${listed.out.pages ? `:p${listed.out.pages}` : ""}${choice.ok ? `:row${choice.index}:${choice.via}` : `:${choice.why}`}` });
		if (!choice.ok) return stop(choice.why === "none" ? (stopped === "budget" ? REFUSE.notFoundTime : REFUSE.notFoundEnd) : REFUSE.mismatch);
		if (shared && stopped !== "end" && !(stopped === "found" && hits.length >= need)) return stop(REFUSE.partial);
		if (left() < 1_000) return stop(REFUSE.timeout);
		// What told the row apart is checked again on the row at open time (a twin that moved into this index is refused, never opened).
		const expect = shared ? { ...(choice.members !== undefined ? { members: choice.members } : { noCount: true }), ...(choice.preview !== undefined ? { preview: choice.preview } : {}) } : undefined;
		const row = await call(runner, { action: "open", name: room.name, row: choice.index, ...(expect ? { expect } : {}) }, Math.max(1_500, left()));
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
	return { ok: true, steps, ...(focus ? { focus } : {}) };
}
