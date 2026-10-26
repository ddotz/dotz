// Approval-gated KakaoTalk reply. A reply is a draft the owner approves in the gateway; only then is it sent, and only by UI automation
// of the KakaoTalk app by macOS Accessibility (room.jxa.js).
// One send is a bounded ladder (one try, an in-place retry, a reopened window, a deeper list read, KakaoTalk to the front) and each rung
// re-verifies the room before anything is typed. A pressed 전송 is confirmed from KakaoTalk's own database and never pressed twice. Text
// dotz itself left in a room's input is recognized (kakao/input.json) and cleared; the owner's own draft is never touched.
// There is no Kakao message API, HTTP or private-protocol path in this module.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { claimSend } from "../draft-claim.ts";
import { draftApprovalBlock } from "../draft-approval.ts";
import { type Confirmer, dbConfirmer, dbPreview } from "./confirm.ts";
import { writePrivate } from "./creds.ts";
import { draftParts } from "./draft.ts";
import { type AxStep, axSend, closeWindow, type Focus, normalizeTitle, openRoom, REFUSE, type RoomFact, sameText, type SendOut } from "./room.ts";
import { KAKAO_BUNDLE, type KakaoPaths, type Runner } from "./types.ts";

export type DraftStatus = "pending" | "sent" | "dropped" | "stale";
// tokens: what the one model call behind the draft used (estimated = counted from characters, not reported by the model).
export type DraftTokens = { in: number; out: number; estimated?: true };
// unconfirmed: the 전송 button was pressed but the send was not confirmed; the draft counts as sent so it is never sent again.
// sentParts: how many parts of the text (draft.ts draftParts) are already in the room; a retry sends only the rest, so no part goes twice.
// intent: a message the owner asked for himself ("내일 7시로 미루자고 정중하게"), not a reply to the room's last message.
export type Draft = { code: string; chatId: string; roomName: string; text: string; basisLogId: string; created: string; status: DraftStatus; sentAt?: string; tokens?: DraftTokens; unconfirmed?: true; sentParts?: number; intent?: string };
// `later`: how the idle close of a kept window is scheduled (tests pass their own; the default is an unref'd timer). `sleep`: how a
// confirmation poll waits (tests pass the fake clock). `confirm`: whether a pressed text reached the database; without it an install's own
// database is asked through confirm.ts, and when there is none the press result stands.
export type SendDeps = { paths: KakaoPaths; runner: Runner; now?: () => number; later?: (fn: () => void, ms: number) => void; sleep?: (ms: number) => Promise<void>; confirm?: Confirmer };
// ms: wall time of each phase of one send; ax: every Accessibility step of it (room.ts AxStep) with its time and, where it failed, the exact
// failing step. Both are kept on the send record (sends.json), so a slow or failed send can be read from data.
export type SendMs = { front: number; pick: number; send: number; total: number; keep?: true };
// Recovery is which rung of the ladder an attempt was: the first try, an in-place retry, a reopened window, a deeper list read, or
// KakaoTalk brought to the front (last resort). `left`: what the room's input still held after the attempt (our text, recorded per room).
export type Recovery = "none" | "retry" | "reopen" | "deep" | "front";
export type SendAttempt = { n: number; recovery: Recovery; ok: boolean; state: "sent" | "failed" | "unconfirmed"; reason?: string; ms: number; ax: AxStep[]; at: number; left?: string };
// focus: kept on the send record only when the send had to open the KakaoTalk list window (room.ts Focus). `ax`: the steps of the attempt
// that ended the send (a recovered send keeps its earlier attempts under `attempts`).
export type SendResult = { ok: boolean; reason?: string; ms?: SendMs; ax?: AxStep[]; focus?: Focus; unconfirmed?: true; attempts?: SendAttempt[] };

// One KakaoTalk message (a typed send, one part of a draft) and a whole draft of several parts.
const MAX_TEXT = 1000;
const MAX_DRAFT_TEXT = 3000;
// Why a draft text cannot be sent (empty, a part over MAX_TEXT, the whole over MAX_DRAFT_TEXT), else undefined.
export const draftTextError = (text: string): string | undefined =>
	!text.trim() ? "답장 글이 비어 있어요" : [...text].length > MAX_DRAFT_TEXT ? `답장은 모두 합쳡 ${MAX_DRAFT_TEXT}자까지예요` : draftParts(text).some(p => [...p].length > MAX_TEXT) ? `메시지 하나는 ${MAX_TEXT}자까지예요` : undefined;
const MAX_DRAFTS = 200;
const TAIL_BYTES = 2 * 1024 * 1024;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const OWNER_SOURCES = new Set(["web", "discord", "terminal"]);
const YES = new Set(["1", "1)", "보내기", "보내", "보내요", "ㅇㅇ", "응", "네", "ok", "okay", "ㅇㅋ"]);
const NO = new Set(["2", "2)", "3", "3)", "고치기", "보내지 않기", "보내지마", "보내지 마", "취소", "아니", "아니요", "ㄴㄴ", "no"]);

const nowMs = (d: SendDeps) => (d.now ?? Date.now)();

function readDrafts(paths: KakaoPaths): Draft[] {
	try {
		const raw = JSON.parse(readFileSync(paths.drafts, "utf8"));
		return Array.isArray(raw) ? raw.filter(d => d && typeof d.code === "string" && typeof d.chatId === "string") : [];
	} catch {
		return [];
	}
}

const writeDrafts = (paths: KakaoPaths, list: Draft[]) => writePrivate(paths.drafts, `${JSON.stringify(list.slice(-MAX_DRAFTS), null, 1)}\n`);

export async function listDrafts(deps: SendDeps): Promise<Draft[]> {
	return readDrafts(deps.paths);
}

function newCode(taken: Set<string>): string {
	for (;;) {
		const code = `K${Array.from(randomBytes(4), b => ALPHABET[b % 32]).join("")}`;
		if (!taken.has(code)) return code;
	}
}

export async function createDraft(input: { chatId: string; roomName: string; text: string; basisLogId: string; tokens?: DraftTokens; intent?: string }, deps: SendDeps): Promise<Draft> {
	const bad = draftTextError(input.text);
	if (bad) throw new Error(bad);
	if (!input.chatId || !input.roomName.trim()) throw new Error("대화방 정보가 비어 있어요");
	if (input.roomName.trim() === "(unknown)") throw new Error("이름을 알 수 없는 대화방이라 화면 자동화로 찾을 수 없어요");
	const list = readDrafts(deps.paths);
	for (const d of list) if (d.chatId === input.chatId && d.status === "pending") d.status = "stale";
	const draft: Draft = { code: newCode(new Set(list.map(d => d.code))), ...input, created: new Date(nowMs(deps)).toISOString(), status: "pending" };
	writeDrafts(deps.paths, [...list, draft]);
	return draft;
}

export function draftBlock(d: Draft): string {
	return draftApprovalBlock({ to: d.roomName, toLabel: "대화방", body: d.text, ref: d.code, question: "카톡 답장 보낼까요?" });
}

type Ev = { ts: string; kind: string; source: string; text: string; picks?: { q?: unknown; label?: unknown }[]; reply_to?: unknown; [k: string]: unknown };

function tailJsonl(file: string): Ev[] {
	if (!existsSync(file)) return [];
	const size = statSync(file).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const buf = Buffer.alloc(size - start);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift();
	const out: Ev[] = [];
	for (const line of lines) {
		try {
			const e = JSON.parse(line);
			if (e && typeof e.ts === "string" && typeof e.kind === "string") out.push(e);
		} catch {
			continue;
		}
	}
	return out;
}

// Which conversation an event belongs to (the same rule as eventTarget in hub/events.ts, without its config side effects).
function convOf(e: Ev): string {
	const parts = [e.source, e.target, e.channel, e.lane].filter((v): v is string => typeof v === "string");
	const lane = parts.find(v => v.startsWith("lane:"));
	if (lane) return lane;
	const project = parts.find(v => /^ch:\d+$/.test(v));
	if (project) return project;
	for (const v of [e.channel, e.target]) {
		const m = typeof v === "string" ? /^(?:web:)?(alert|worklog)$/.exec(v) : null;
		if (m) return m[1]!;
	}
	return "main";
}

const hasCode = (text: unknown, code: string) => typeof text === "string" && new RegExp(`(?<![A-Z0-9])${code}(?![A-Z0-9])`).test(text);
const shortText = (text: unknown) => (typeof text === "string" ? text.trim().toLowerCase().replace(/[.!~。\s]+$/u, "") : "");
const ms = (ts: string) => Date.parse(ts);

type Verdict = "approved" | "cancelled" | "none";

// Only the owner's own messages (web, discord, terminal) count. Any cancel after the draft was made wins over every approval.
function verdict(d: Draft, paths: KakaoPaths): Verdict {
	const created = ms(d.created);
	const outs = tailJsonl(paths.outbox).filter(e => e.kind === "out");
	let approved = false;
	let cancelled = false;
	for (const m of tailJsonl(paths.inbox)) {
		if (m.kind !== "message" || !OWNER_SOURCES.has(m.source) || !(ms(m.ts) > created)) continue;
		for (const p of Array.isArray(m.picks) ? m.picks : []) {
			if (!hasCode(p?.q, d.code)) continue;
			if (p.label === "보내기") approved = true;
			else if (p.label === "고치기" || p.label === "보내지 않기") cancelled = true;
		}
		const t = shortText(m.text);
		const yes = YES.has(t);
		if (!yes && !NO.has(t)) continue;
		const answersAsk =
			typeof m.reply_to === "string"
				? outs.some(o => o.ts === m.reply_to && hasCode(o.text, d.code))
				: hasCode(outs.findLast(o => ms(o.ts) < ms(m.ts) && convOf(o) === convOf(m))?.text, d.code);
		if (!answersAsk) continue;
		if (yes) approved = true;
		else cancelled = true;
	}
	return cancelled ? "cancelled" : approved ? "approved" : "none";
}

export async function approval(code: string, deps: SendDeps): Promise<boolean> {
	const d = readDrafts(deps.paths).find(x => x.code === code);
	return d ? verdict(d, deps.paths) === "approved" : false;
}

const setStatus = (paths: KakaoPaths, code: string, status: DraftStatus, extra: Partial<Draft> = {}) =>
	writeDrafts(paths, readDrafts(paths).map(d => (d.code === code ? { ...d, ...extra, status } : d)));

export const newer = (latest: string, basis: string) => (/^\d+$/.test(latest) && /^\d+$/.test(basis) ? BigInt(latest) > BigInt(basis) : latest !== basis);

const sending = new Set<string>();
const refuse = (reason: string): SendResult => ({ ok: false, reason });

// Every send of the gateway (typed, draft, CLI) goes through this chain: one at a time, because they drive the one KakaoTalk list.
let sendChain: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(job: () => Promise<T>): Promise<T> => {
	const run = sendChain.then(job, job);
	sendChain = run.catch(() => undefined);
	return run;
};

// The app in front before the send (bundle id), so the owner's screen goes back to it, and whether KakaoTalk shows a window now (only
// then may a send keep its window open). Never throws: a failure only skips the restore and the keeping.
const FRONT_SCRIPT = `tell application "System Events"
set f to bundle identifier of first application process whose frontmost is true
set v to "0"
try
set k to first application process whose bundle identifier is "${KAKAO_BUNDLE}"
if (visible of k) and ((count of windows of k) > 0) then set v to "1"
end try
return f & " " & v
end tell`;
type Front = { id?: string; kakaoShown: boolean; ms: number };
async function frontState(runner: Runner): Promise<Front> {
	const t0 = performance.now();
	const out: Front = { kakaoShown: false, ms: 0 };
	try {
		const r = await runner(["osascript", "-e", FRONT_SCRIPT], { timeoutMs: 5_000 });
		const [id, shown] = r.stdout.trim().split(/\s+/);
		if (r.code === 0 && id && /^[A-Za-z0-9.-]+$/.test(id)) {
			out.id = id;
			out.kakaoShown = shown === "1";
		}
	} catch {}
	out.ms = Math.round(performance.now() - t0);
	return out;
}

// A send that kept its chat window open makes the next send of that room skip the row open (the open window is only verified).
// The window is closed again after KEEP_IDLE_MS without a send, in the send queue so it never closes a window under a send.
const KEEP_IDLE_MS = 5 * 60_000;
let warm: { id: string; epoch: number; runner: Runner } | undefined;
let warmEpoch = 0;
export const forgetWarm = () => {
	warm = undefined;
	warmEpoch++;
};
function keepWarm(id: string, deps: SendDeps, name?: string) {
	const epoch = ++warmEpoch;
	warm = { id, epoch, runner: deps.runner };
	const fire = () => {
		void oneAtATime(async () => {
			if (warm?.epoch !== epoch) return;
			warm = undefined;
			await closeWindow(deps.runner, name);
		});
	};
	if (deps.later) deps.later(fire, KEEP_IDLE_MS);
	else (setTimeout(fire, KEEP_IDLE_MS) as { unref?: () => void }).unref?.();
}

// `roomNames` lists every room of the database with its type and member count (kind, members); the send is checked against them.
type RoomNames = () => Promise<RoomFact[]>;

const UNCONFIRMED = "카카오톡 전송 버튼은 눌렀지만 보내졌는지 확인하지 못했어요. 다시 보내지 않았으니 카카오톡에서 확인해 주세요";
const INPUT_WHY: Record<string, string> = {
	no_window: "열린 대화창을 찾지 못해서 보내지 않았어요",
	no_input: "카카오톡 대화창에서 입력창을 찾지 못했어요",
	no_button: "카카오톡 대화창에서 전송 버튼을 찾지 못했어요",
	not_set: "카카오톡 입력창에 글이 들어가지 않아서 보내지 못했어요",
	not_ready: "카카오톡 전송 버튼이 켜지지 않아서 보내지 못했어요",
	stuck: "카카오톡 입력창에 글이 남아 있어서 보내지 못했어요",
	failed: "카카오톡 입력창에 글을 넣지 못했어요",
};
// The owner's own draft in the input is never cleared; it is reported with its first characters, so he knows what to do.
const inputReason = (r: SendOut): string =>
	r.why === "prior_left"
		? `이전에 전송을 누른 글이 입력창에 남아 있어서 이 글은 넣지도 보내지도 않았어요${r.preview ? ` ('${r.preview}')` : ""}. 카카오톡에서 그 글을 보내거나 지운 뒤 다시 보내 주세요`
		: r.why === "owner_text" || r.why === "busy"
		? `카카오톡 입력창에 보내지 않은 글이 있어서 보내지 않았어요${r.preview ? ` ('${r.preview}')` : ""}. 그 글은 지우지 않았어요`
		: (INPUT_WHY[r.why ?? ""] ?? "카카오톡 입력창에 글을 넣지 못했어요");

const kakaoFile = (paths: KakaoPaths, name: string) => join(dirname(paths.drafts), name);
const MAX_SENDS = 200;
const MAX_ATTEMPTS = 8;
// What an attempt left in a room's input: our own text, with the time and whether 전송 was pressed without confirmation. It is how the next
// attempt tells dotz's leftover from the owner's draft.
type Left = { text: string; at: number; pressed?: true };
const readLeft = (paths: KakaoPaths): Record<string, Left> => {
	try {
		const raw = JSON.parse(readFileSync(kakaoFile(paths, "input.json"), "utf8"));
		return raw && typeof raw === "object" ? (raw as Record<string, Left>) : {};
	} catch {
		return {};
	}
};
const writeLeft = (paths: KakaoPaths, chatId: string, left: Left | undefined) => {
	const all = readLeft(paths);
	if (left) all[chatId] = left;
	else delete all[chatId];
	try {
		writePrivate(kakaoFile(paths, "input.json"), `${JSON.stringify(all, null, 1)}\n`);
	} catch {}
};
// Texts dotz typed into a room in this process (a kept window's input can still show the last one).
const recentTyped = new Map<string, string[]>();
const rememberTyped = (chatId: string, text: string) => {
	const list = [...(recentTyped.get(chatId) ?? []).filter(t => t !== text), text].slice(-3);
	recentTyped.set(chatId, list);
};

// Every attempt of a send is kept on that send's record in sends.json (the same store the web shows): attempt number, recovery rung, the
// failing Accessibility step, ms and reason. Bounded: 8 attempts per send, 200 sends.
const saveAttempts = (paths: KakaoPaths, key: { chatId: string; text: string }, attempts: SendAttempt[], final: SendResult, at: number) => {
	const file = kakaoFile(paths, "sends.json");
	let list: Record<string, unknown>[] = [];
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (Array.isArray(raw)) list = raw;
	} catch {}
	const since = at - 15 * 60_000;
	const i = list.findLastIndex(r => r && r.chatId === key.chatId && r.state === "sending" && typeof r.at === "number" && r.at >= since);
	const trimmed = attempts.slice(-MAX_ATTEMPTS);
	if (i >= 0) {
		const prev = Array.isArray(list[i]!.attempts) ? (list[i]!.attempts as SendAttempt[]) : [];
		list[i] = { ...list[i], attempts: [...prev, ...trimmed].slice(-MAX_ATTEMPTS) };
	}
	else
		list.push({
			id: `S${at.toString(36)}${randomBytes(3).toString("hex")}`,
			chatId: key.chatId,
			text: key.text,
			state: final.ok ? "sent" : "failed",
			at,
			...(final.ok ? {} : { reason: final.reason ?? "보내지 못했어요" }),
			...(final.ms ? { ms: final.ms } : {}),
			...(final.ax ? { ax: final.ax } : {}),
			attempts: trimmed,
		});
	try {
		writePrivate(file, `${JSON.stringify(list.slice(-MAX_SENDS), null, 1)}\n`);
	} catch {}
};

// Last resort of the ladder: KakaoTalk to the front for the menu and the press, and the app the owner had in front put back after that attempt.
async function activateKakao(runner: Runner): Promise<AxStep> {
	const t = performance.now();
	let ok = false;
	try {
		const r = await runner(["osascript", "-e", `tell application id "${KAKAO_BUNDLE}" to activate`], { timeoutMs: 4_000 });
		ok = r.code === 0;
	} catch {}
	return { step: "activate", ms: Math.round(performance.now() - t), ok };
}

async function restoreFront(runner: Runner, front: Front) {
	if (!front.id || front.id === KAKAO_BUNDLE) return;
	try {
		await runner(["osascript", "-e", `tell application "System Events" to set frontmost of (first application process whose bundle identifier is "${front.id}") to true`], { timeoutMs: 4_000 });
	} catch {}
}

const simMs = (ms: SendMs): number => ms.pick + ms.send;
// The time after which no further rung of the ladder starts. A rung usually costs up to ~8 s open + ~11 s input + 10 s confirm, so a send
// normally ends inside the web watchdog (web.ts STUCK_MS 60 s); a rung that hangs longer is covered by the watchdog waiting for a send
// that is still running instead of reporting it failed.
export const LADDER_MS = 30_000;

// After a press (or a press we know happened earlier): the database is the only proof. "sent" and "unconfirmed" both end the send; a send
// that was not pressed keeps its failure.
type Settled = { state: "sent" } | { state: "unconfirmed" } | { state: "failed"; reason: string };
const confirmers = new Map<string, Confirmer>();
function confirmerOf(deps: SendDeps): Confirmer {
	let confirmer = deps.confirm;
	if (!confirmer) {
		const key = deps.paths.config;
		confirmer = confirmers.get(key);
		if (!confirmer) {
			confirmer = dbConfirmer(deps.paths, deps.runner, { ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
			confirmers.set(key, confirmer);
		}
	}
	return confirmer;
}
// Any attempt that may have reached the press (pressed, a throwing press, a lost or unreadable answer) is asked about in the database; only
// an attempt that provably did not press keeps its failure and may go on to the next rung.
async function settle(deps: SendDeps & { roomNames?: RoomNames }, r: SendOut, input: { chatId: string; text: string }, since: number): Promise<Settled> {
	if (!r.ok && !r.pressed) return { state: "failed", reason: inputReason(r) };
	let confirmed: boolean | undefined;
	try {
		confirmed = await confirmerOf(deps)({ chatId: input.chatId, text: input.text, since });
	} catch {}
	if (confirmed === true) return { state: "sent" };
	if (confirmed === false) return { state: "unconfirmed" };
	return r.ok ? { state: "sent" } : { state: "unconfirmed" };
}

// The ladder of one send, cheapest first: the first try, an in-place retry, a closed and reopened room window, a deeper list read (a room
// far down the list), and last KakaoTalk brought to the front. Each rung re-verifies the room before anything is typed.
const RUNGS: { recovery: Recovery; deep: boolean; reopen: boolean; front: boolean }[] = [
	{ recovery: "none", deep: false, reopen: false, front: false },
	{ recovery: "retry", deep: false, reopen: false, front: false },
	{ recovery: "reopen", deep: false, reopen: true, front: false },
	{ recovery: "deep", deep: true, reopen: false, front: false },
	{ recovery: "front", deep: false, reopen: false, front: true },
];

const sendTextNow = async (input: { chatId: string; roomName: string; text: string; parts?: string[] }, deps: SendDeps & { roomNames?: RoomNames }): Promise<SendResult> => {
	if (input.roomName.trim() === "(unknown)") return refuse("이름을 알 수 없는 대화방이라 화면 자동화로 찾을 수 없어요");
	const t0 = performance.now();
	// The frontmost lookup runs beside the room open and the send; it is waited for only where its answer is needed.
	const frontP = frontState(deps.runner);
	const ms: SendMs = { front: 0, pick: 0, send: 0, total: 0 };
	let ax: AxStep[] = [];
	let focus: Focus | undefined;
	let attempts: SendAttempt[] = [];
	const fin = (r: SendResult): SendResult => {
		const out: SendResult = { ...r, attempts, ms: { ...ms, total: Math.round(performance.now() - t0) }, ax, ...(focus ? { focus } : {}) };
		if (attempts.length) saveAttempts(deps.paths, { chatId: input.chatId, text: input.text }, attempts, out, nowMs(deps));
		return out;
	};
	let all: RoomFact[] = [];
	if (deps.roomNames) {
		try {
			all = await deps.roomNames();
		} catch {
			return fin(refuse("대화방 목록을 확인하지 못해서 보내지 않았어요"));
		}
	}
	const known = all.find(r => r.chatId === input.chatId);
	const axKey = `ax:${input.chatId}`;
	// Same-name rooms can only be told apart by the newest message the list shows under the name: the caller's facts may omit it, then the
	// install's database answers (one small read, only when a name is shared).
	let room: RoomFact = { ...known, chatId: input.chatId, name: input.roomName };
	if (all.some(r => r.chatId !== input.chatId && normalizeTitle(r.name) === normalizeTitle(input.roomName)) && !room.preview) {
		try {
			const preview = await dbPreview(deps.paths, deps.runner)(input.chatId);
			if (preview) room = { ...room, preview };
		} catch {}
	}
	// The database lists rooms newest first, the same order as KakaoTalk's chat list: the row index is a hint that saves reading ~100 rows.
	const hint = all.findIndex(r => r.chatId === input.chatId);
	const left = readLeft(deps.paths)[input.chatId];
	const priorPressed = left?.pressed ? [left.text] : [];
	// Text dotz may have left in this room's input (a failed attempt, a kept window) is dotz's, not the owner's: unwrap it. An owner text is
	// any other value, and JXA then refuses to touch it.
	const ours = [...(left && !left.pressed ? [left.text] : []), ...(recentTyped.get(input.chatId) ?? []), ...(input.parts ?? []), input.text];
	let lastReason = "";
	// The owner's own draft is never touched; the window holding it is left open (closing it could lose what he typed).
	let keepForOwner = false;
	let leftPressed = left?.pressed ? left : undefined;
	for (const [i, rung] of RUNGS.entries()) {
		// No new rung starts once the ladder has used its time: the web watchdog (web.ts STUCK_MS) must not outlive a send that can still press.
		if (i > 0 && performance.now() - t0 > LADDER_MS) break;
		const aAt = nowMs(deps);
		const steps: AxStep[] = [];
		const frontBefore = rung.front ? await frontP : undefined;
		if (rung.front) steps.push(await activateKakao(deps.runner));
		const back = async () => {
			if (frontBefore) await restoreFront(deps.runner, frontBefore);
		};
		if (rung.reopen) await closeWindow(deps.runner, input.roomName);
		const p = performance.now();
		const opened = await openRoom(room, all, deps.runner, { deep: rung.deep, ...(hint >= 0 ? { hint } : {}) });
		ms.pick = Math.round(performance.now() - p);
		focus = opened.focus ?? focus;
		steps.push(...opened.steps);
		if (!opened.ok) {
			lastReason = opened.reason;
			attempts.push({ n: attempts.length + 1, recovery: rung.recovery, ok: false, state: "failed", reason: opened.reason, ms: simMs(ms) + (steps.find(s => s.step === "activate")?.ms ?? 0), ax: steps, at: aAt });
			ax = steps;
			await back();
			if (warm?.id === axKey) forgetWarm();
			if (opened.reason === REFUSE.mismatch) await closeWindow(deps.runner, input.roomName);
			// KakaoTalk has no window and its own menu did not open one: no rung of the ladder can change that.
			if (opened.reason === REFUSE.noList) break;
			continue;
		}
		const s = performance.now();
		let r = await axSend(input.roomName, input.text, deps.runner, { ours, priorPressed });
		// Another text whose press was not confirmed still fills the input. When the database shows it did go out (the input only lags), it is
		// dotz's own leftover: cleared and replaced by this text. Otherwise nothing is typed or pressed and the send fails as it is.
		if (r.why === "prior_left" && leftPressed) {
			let sent: boolean | undefined;
			try {
				sent = await confirmerOf(deps)({ chatId: input.chatId, text: leftPressed.text, since: leftPressed.at, once: true });
			} catch {}
			if (sent === true) {
				const done = leftPressed.text;
				writeLeft(deps.paths, input.chatId, undefined);
				leftPressed = undefined;
				priorPressed.splice(0, priorPressed.length, ...priorPressed.filter(t => t !== done));
				ours.push(done);
				r = await axSend(input.roomName, input.text, deps.runner, { ours, priorPressed });
			}
		}
		const sendMs = Math.round(performance.now() - s);
		ms.send = sendMs;
		steps.push({ step: "input", ms: sendMs, ok: r.ok, ...(r.ok ? {} : { why: [r.why ?? "failed", r.preview ? `preview:${r.preview}` : "", r.left ? `left:${r.left.slice(0, 40)}` : ""].filter(Boolean).join(":") }) });
		if (r.ok || r.pressed) rememberTyped(input.chatId, input.text);
		// The same text pressed before keeps its first press time (the database is asked from then); a prior press of another text stays recorded.
		const again = r.why === "prior_pressed" && leftPressed !== undefined && sameText(leftPressed.text, input.text);
		if (r.pressed && !again) writeLeft(deps.paths, input.chatId, { text: input.text, at: aAt, pressed: true });
		else if (r.left && r.why !== "prior_left" && !again) writeLeft(deps.paths, input.chatId, { text: r.left, at: aAt });
		const settled = await settle(deps, r, input, again ? leftPressed!.at : aAt);
		const attempt: SendAttempt = { n: attempts.length + 1, recovery: rung.recovery, ok: settled.state === "sent", state: settled.state, ...(settled.state === "failed" ? { reason: settled.reason } : settled.state === "unconfirmed" ? { reason: UNCONFIRMED } : {}), ms: simMs(ms), ax: steps, at: aAt, ...(r.left ? { left: r.left } : {}) };
		attempts.push(attempt);
		ax = steps;
		await back();
		if (settled.state === "failed") {
			lastReason = settled.reason;
			if (r.why === "owner_text" || r.why === "busy" || r.why === "prior_left") {
				keepForOwner = true;
				break;
			}
			continue;
		}
		const front = await frontP;
		ms.front = front.ms;
		if (settled.state === "sent") {
			writeLeft(deps.paths, input.chatId, undefined);
			const keep = warm?.id === axKey || front.kakaoShown;
			if (keep) {
				keepWarm(axKey, deps, input.roomName);
				ms.keep = true;
			} else {
				if (warm?.id === axKey) forgetWarm();
				await closeWindow(deps.runner, input.roomName);
			}
			return fin({ ok: true });
		}
		// Pressed but unconfirmed: the input keeps the text as ours and it is never pressed again.
		if (r.ok) writeLeft(deps.paths, input.chatId, undefined);
		if (warm?.id === axKey || front.kakaoShown) {
			keepWarm(axKey, deps, input.roomName);
			ms.keep = true;
		} else {
			if (warm?.id === axKey) forgetWarm();
			await closeWindow(deps.runner, input.roomName);
		}
		return fin({ ...refuse(UNCONFIRMED), unconfirmed: true });
	}
	if (keepForOwner) {
		if (warm?.id !== axKey) keepWarm(axKey, deps, input.roomName);
		ms.keep = true;
	} else {
		await closeWindow(deps.runner, input.roomName);
		if (warm?.id === axKey) forgetWarm();
	}
	ms.front = (await frontP).ms;
	const tried = attempts.length > 1;
	return fin(refuse(tried ? `여러 번 다시 시도했지만 ${lastReason || "보내지 못했어요"}` : lastReason || "보내지 못했어요"));
};

// The one path of every send: the exact list row is opened and its window verified (room.ts), then the text goes in by Accessibility.
export const sendText = (input: { chatId: string; roomName: string; text: string; parts?: string[] }, deps: SendDeps & { roomNames?: RoomNames }): Promise<SendResult> => oneAtATime(() => sendTextNow(input, deps));

// A pending draft whose room got a newer incoming message can no longer be sent.
export const markStale = (paths: KakaoPaths, code: string) => setStatus(paths, code, "stale");

export function dropDraft(code: string, deps: Pick<SendDeps, "paths">): SendResult {
	const d = readDrafts(deps.paths).find(x => x.code === code);
	if (!d) return refuse("그 초안을 찾지 못했어요");
	if (d.status !== "pending") return refuse("더 이상 보낼 수 없는 초안이에요");
	setStatus(deps.paths, code, "dropped");
	return { ok: true };
}

// `ownerApproved`: the owner clicked 보내기 in the web app, which replaces the inbox verdict; every other check stays. `text`: the owner's edit.
export function sendDraft(code: string, deps: SendDeps & { latestIncoming: (chatId: string) => Promise<string | undefined>; roomNames?: RoomNames; ownerApproved?: boolean; text?: string }): Promise<SendResult> {
	if (sending.has(code)) return Promise.resolve(refuse("이미 보내는 중이에요"));
	sending.add(code);
	return oneAtATime(() => sendDraftNow(code, deps)).finally(() => sending.delete(code));
}

// The in-process guard above does not see another process (the CLI the bot runs beside the gateway's button): a claim file does (hub/draft-claim.ts).
async function sendDraftNow(code: string, deps: SendDeps & { latestIncoming: (chatId: string) => Promise<string | undefined>; roomNames?: RoomNames; ownerApproved?: boolean; text?: string }): Promise<SendResult> {
	const release = claimSend(join(dirname(deps.paths.drafts), "sending", code));
	if (!release) return refuse("이미 보내는 중이에요");
	try {
		return await sendClaimed(code, deps);
	} finally {
		release();
	}
}

async function sendClaimed(code: string, deps: SendDeps & { latestIncoming: (chatId: string) => Promise<string | undefined>; roomNames?: RoomNames; ownerApproved?: boolean; text?: string }): Promise<SendResult> {
	const d = readDrafts(deps.paths).find(x => x.code === code);
	if (!d) return refuse("그 초안을 찾지 못했어요");
	if (d.status === "sent") return refuse(d.unconfirmed ? `전송 버튼을 이미 눌렀던 초안이라 다시 보내지 않아요. 카카오톡에서 확인해 주세요` : "이미 보낸 초안이에요");
	if (d.status !== "pending") return refuse("더 이상 보낼 수 없는 초안이에요");
	// After a part already went out the text is fixed: an edit then could not be told apart from what is in the room.
	const text = d.sentParts ? d.text : (deps.text ?? d.text);
	const bad = draftTextError(text);
	if (bad) return refuse(bad);
	if (!deps.ownerApproved) {
		const v = verdict(d, deps.paths);
		if (v === "cancelled") {
			setStatus(deps.paths, code, "dropped");
			return refuse("보내지 않기로 한 초안이에요");
		}
		if (v !== "approved") return refuse("아직 보내도 된다는 답을 받지 못했어요");
	}
	let latest: string | undefined;
	try {
		latest = await deps.latestIncoming(d.chatId);
	} catch {
		return refuse("새 메시지가 왔는지 확인하지 못해서 보내지 않았어요");
	}
	if (latest && newer(latest, d.basisLogId)) {
		setStatus(deps.paths, code, "stale");
		return refuse("그사이 새 메시지가 와서 초안이 낡았어요");
	}
	// Each part is its own message, in order. The count of parts in the room is stored after every part, so a failed part is retried alone
	// and an unconfirmed press ends the draft as sent (never pressed again).
	const parts = draftParts(text);
	let done = d.sentParts ?? 0;
	let r: SendResult = { ok: true };
	while (done < parts.length) {
		r = await sendTextNow({ chatId: d.chatId, roomName: d.roomName, text: parts[done]!, parts }, deps);
		if (!r.ok && !r.unconfirmed) break;
		done++;
		if (r.unconfirmed) break;
		if (done < parts.length) setStatus(deps.paths, code, "pending", { text, sentParts: done });
	}
	if (r.ok && done >= parts.length) setStatus(deps.paths, code, "sent", { text, sentParts: done, sentAt: new Date(nowMs(deps)).toISOString() });
	else if (r.unconfirmed) setStatus(deps.paths, code, "sent", { text, sentParts: done, sentAt: new Date(nowMs(deps)).toISOString(), unconfirmed: true as const });
	else if (done > 0) return { ...r, reason: `${parts.length}개 중 ${done}개를 보냈어요. 다시 보내면 나머지만 보내요: ${r.reason ?? "보내지 못했어요"}` };
	return r;
}
