// Approval-gated KakaoTalk reply. A reply is a draft the owner approves in the gateway; only then is it sent, and only by UI automation
// of the KakaoTalk app by macOS Accessibility (room.jxa.js).
// There is no Kakao message API, HTTP or private-protocol path in this module.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { claimSend } from "../draft-claim.ts";
import { draftApprovalBlock } from "../draft-approval.ts";
import { writePrivate } from "./creds.ts";
import { type AxStep, axSend, closeWindow, type Focus, openRoom, type RoomFact } from "./room.ts";
import { KAKAO_BUNDLE, type KakaoPaths, type Runner } from "./types.ts";

export type DraftStatus = "pending" | "sent" | "dropped" | "stale";
// tokens: what the one model call behind the draft used (estimated = counted from characters, not reported by the model).
export type DraftTokens = { in: number; out: number; estimated?: true };
// unconfirmed: the 전송 button was pressed but the send was not confirmed; the draft counts as sent so it is never sent again.
export type Draft = { code: string; chatId: string; roomName: string; text: string; basisLogId: string; created: string; status: DraftStatus; sentAt?: string; tokens?: DraftTokens; unconfirmed?: true };
// `later`: how the idle close of a kept window is scheduled (tests pass their own; the default is an unref'd timer).
export type SendDeps = { paths: KakaoPaths; runner: Runner; now?: () => number; later?: (fn: () => void, ms: number) => void };
// ms: wall time of each phase of one send; ax: every Accessibility step of it (room.ts AxStep) with its time and, where it failed, the exact
// failing step. Both are kept on the send record (sends.json), so a slow or failed send can be read from data.
export type SendMs = { front: number; pick: number; send: number; total: number; keep?: true };
// focus: kept on the send record only when the send had to open the KakaoTalk list window (room.ts Focus).
export type SendResult = { ok: boolean; reason?: string; ms?: SendMs; ax?: AxStep[]; focus?: Focus; unconfirmed?: true };

const MAX_TEXT = 1000;
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

export async function createDraft(input: { chatId: string; roomName: string; text: string; basisLogId: string; tokens?: DraftTokens }, deps: SendDeps): Promise<Draft> {
	const length = [...input.text].length;
	if (!input.text.trim() || length > MAX_TEXT) throw new Error(`답장 글은 1자에서 ${MAX_TEXT}자 사이여야 해요`);
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
	busy: "카카오톡 입력창에 보내지 않은 글이 있어서 보내지 않았어요",
	no_window: "열린 대화창을 찾지 못해서 보내지 않았어요",
};

const sendTextNow = async (input: { chatId: string; roomName: string; text: string }, deps: SendDeps & { roomNames?: RoomNames }): Promise<SendResult> => {
	if (input.roomName.trim() === "(unknown)") return refuse("이름을 알 수 없는 대화방이라 화면 자동화로 찾을 수 없어요");
	const t0 = performance.now();
	// The frontmost lookup runs beside the room open and the send; it is waited for only where its answer is needed.
	const frontP = frontState(deps.runner);
	const ms: SendMs = { front: 0, pick: 0, send: 0, total: 0 };
	let ax: AxStep[] = [];
	let focus: Focus | undefined;
	const fin = (r: SendResult): SendResult => ({ ...r, ms: { ...ms, total: Math.round(performance.now() - t0) }, ax, ...(focus ? { focus } : {}) });
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
	// The room's one list row opened by Accessibility actions (room.ts openRoom: at most one context menu, 5 s cap), its window checked
	// against the database room (title and member count), the text put into its input and the 전송 button pressed, all by Accessibility:
	// KakaoTalk does not come to the front, no key event is sent and the owner's app keeps the focus. Only when KakaoTalk has no list window
// is it opened through its menu, which raises KakaoTalk for a moment: the app in front before is put back then (Focus). There is no other path: a failure at any
	// step is a failed send with its reason, never a scan of the list by another tool.
	const p = performance.now();
	const opened = await openRoom({ ...known, chatId: input.chatId, name: input.roomName }, all, deps.runner);
	ms.pick = Math.round(performance.now() - p);
	ax = opened.steps;
	focus = opened.focus;
	if (!opened.ok) {
		if (warm?.id === axKey) forgetWarm();
		ms.front = (await frontP).ms;
		return fin(refuse(opened.reason));
	}
	const s = performance.now();
	const r = await axSend(input.roomName, input.text, deps.runner);
	ms.send = Math.round(performance.now() - s);
	ax = [...ax, { step: "input", ms: ms.send, ok: r.ok, ...(r.ok ? {} : { why: r.why ?? "failed" }) }];
	const front = await frontP;
	ms.front = front.ms;
	if (r.ok || r.pressed) {
		const keep = warm?.id === axKey || front.kakaoShown;
		if (keep) {
			keepWarm(axKey, deps, input.roomName);
			ms.keep = true;
		} else {
			if (warm?.id === axKey) forgetWarm();
			await closeWindow(deps.runner, input.roomName);
		}
		return fin(r.ok ? { ok: true } : { ...refuse(UNCONFIRMED), unconfirmed: true });
	}
	await closeWindow(deps.runner, input.roomName);
	if (warm?.id === axKey) forgetWarm();
	return fin(refuse(INPUT_WHY[r.why ?? ""] ?? `카카오톡 입력창에 글을 넣지 못했어요 (${r.why ?? "failed"})`));
};

// The one path of every send: the exact list row is opened and its window verified (room.ts), then the text goes in by Accessibility.
export const sendText = (input: { chatId: string; roomName: string; text: string }, deps: SendDeps & { roomNames?: RoomNames }): Promise<SendResult> => oneAtATime(() => sendTextNow(input, deps));

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
	const text = deps.text ?? d.text;
	if (!text.trim() || [...text].length > MAX_TEXT) return refuse(`답장 글은 1자에서 ${MAX_TEXT}자 사이여야 해요`);
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
	const r = await sendTextNow({ chatId: d.chatId, roomName: d.roomName, text }, deps);
	if (r.ok || r.unconfirmed) setStatus(deps.paths, code, "sent", { text, sentAt: new Date(nowMs(deps)).toISOString(), ...(r.unconfirmed ? { unconfirmed: true as const } : {}) });
	return r;
}
