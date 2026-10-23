// Approval-gated KakaoTalk reply. A reply is a draft the owner approves in the gateway; only then is it sent, and only by UI automation
// of the KakaoTalk app through the installed kmsg CLI (MIT, see THIRD_PARTY_NOTICES.md).
// There is no Kakao message API, HTTP or private-protocol path in this module.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { draftApprovalBlock } from "../draft-approval.ts";
import { writePrivate } from "./creds.ts";
import { pickRoom, type RoomFact } from "./room.ts";
import { KAKAO_BUNDLE, type KakaoPaths, type Runner } from "./types.ts";

export type DraftStatus = "pending" | "sent" | "dropped" | "stale";
// tokens: what the one model call behind the draft used (estimated = counted from characters, not reported by the model).
export type DraftTokens = { in: number; out: number; estimated?: true };
export type Draft = { code: string; chatId: string; roomName: string; text: string; basisLogId: string; created: string; status: DraftStatus; sentAt?: string; tokens?: DraftTokens };
export type SendDeps = { paths: KakaoPaths; runner: Runner; now?: () => number; kmsg?: string };
export type SendResult = { ok: boolean; reason?: string };

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

// Every send of the gateway (typed, draft, CLI) goes through this chain: one at a time, because kmsg drives the one KakaoTalk window.
let sendChain: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(job: () => Promise<T>): Promise<T> => {
	const run = sendChain.then(job, job);
	sendChain = run.catch(() => undefined);
	return run;
};

// The app in front before the send (bundle id), so the owner's screen goes back to it. Never throws: a failure only skips the restore.
async function frontmostApp(runner: Runner): Promise<string | undefined> {
	try {
		const r = await runner(["osascript", "-e", 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'], { timeoutMs: 5_000 });
		const id = r.stdout.trim();
		return r.code === 0 && /^[A-Za-z0-9.-]+$/.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

async function refocus(runner: Runner, id: string | undefined): Promise<void> {
	if (!id || id === KAKAO_BUNDLE) return;
	try {
		await runner(["open", "-b", id], { timeoutMs: 5_000 });
	} catch {}
}

// `roomNames` lists every room of the database with its type and member count (kind, members); the send is checked against them.
type RoomNames = () => Promise<RoomFact[]>;

// The last plain line kmsg wrote on stderr, as a short reason (no message text, no room name).
const kmsgWhy = (stderr: string) => {
	const line = stderr.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("[trace")).at(-1);
	return line ? ` (${line.slice(0, 80)})` : "";
};

const sendTextNow = async (input: { chatId: string; roomName: string; text: string }, deps: SendDeps & { roomNames?: RoomNames }): Promise<SendResult> => {
	if (input.roomName.trim() === "(unknown)") return refuse("이름을 알 수 없는 대화방이라 화면 자동화로 찾을 수 없어요");
	let all: RoomFact[] = [];
	if (deps.roomNames) {
		try {
			all = await deps.roomNames();
		} catch {
			return refuse("대화방 목록을 확인하지 못해서 보내지 않았어요");
		}
	}
	const kmsg = deps.kmsg ?? Bun.which("kmsg") ?? "/opt/homebrew/bin/kmsg";
	const front = await frontmostApp(deps.runner);
	// The room is a list row opened by id and checked against the database room (room.ts); a name search never picks it.
	const known = all.find(r => r.chatId === input.chatId);
	const picked = await pickRoom({ ...known, chatId: input.chatId, name: input.roomName }, all, { kmsg, runner: deps.runner });
	if (!picked.ok) {
		await refocus(deps.runner, front);
		return refuse(picked.reason);
	}
	// kmsg prints "Message sent" once Enter went through; a later failure (closing the window) is still a sent message. Without that
	// line nothing was sent, so one retry with deep window recovery is safe (a cold first window often fails).
	const wentOut = (r: { code: number; stdout: string }) => r.code === 0 || /Message sent/i.test(r.stdout);
	let sent = await deps.runner([kmsg, "send", "--chat-id", picked.id, "--", input.text], { timeoutMs: 90_000 });
	if (!wentOut(sent)) sent = await deps.runner([kmsg, "send", "--chat-id", picked.id, "--deep-recovery", "--", input.text], { timeoutMs: 90_000 });
	await refocus(deps.runner, front);
	if (!wentOut(sent)) return refuse(`카카오톡에서 보내지 못했어요${kmsgWhy(sent.stderr)}`);
	return { ok: true };
};

// The kmsg path shared by every send: the exact list row is picked and its window verified (room.ts), the real send by that row's id, then the owner's previous app is back in front.
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

async function sendDraftNow(code: string, deps: SendDeps & { latestIncoming: (chatId: string) => Promise<string | undefined>; roomNames?: RoomNames; ownerApproved?: boolean; text?: string }): Promise<SendResult> {
	const d = readDrafts(deps.paths).find(x => x.code === code);
	if (!d) return refuse("그 초안을 찾지 못했어요");
	if (d.status === "sent") return refuse("이미 보낸 초안이에요");
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
	if (r.ok) setStatus(deps.paths, code, "sent", { text, sentAt: new Date(nowMs(deps)).toISOString() });
	return r;
}
