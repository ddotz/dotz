// Approval-gated KakaoTalk reply. A reply is a draft the owner approves in the gateway; only then is it sent, and only by UI automation
// of the KakaoTalk app through the installed kmsg CLI (MIT, see THIRD_PARTY_NOTICES.md).
// There is no Kakao message API, HTTP or private-protocol path in this module.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { issueBlock } from "../choices.ts";
import { writePrivate } from "./creds.ts";
import type { KakaoPaths, Runner } from "./types.ts";

export type DraftStatus = "pending" | "sent" | "dropped" | "stale";
export type Draft = { code: string; chatId: string; roomName: string; text: string; basisLogId: string; created: string; status: DraftStatus; sentAt?: string };
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

export async function createDraft(input: { chatId: string; roomName: string; text: string; basisLogId: string }, deps: SendDeps): Promise<Draft> {
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
	const quoted = d.text.split("\n").map(l => `> ${l}`).join("\n");
	return `${quoted}\n${issueBlock(`카톡 답장 보낼까요? (${d.code})`, [
		{ name: "보내기", result: `${d.roomName}에 이 글을 그대로 보내요` },
		{ name: "고치기", result: "글을 고쳐서 다시 물어봐요" },
		{ name: "보내지 않기", result: "이 초안은 버려요" },
	])}`;
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

const newer = (latest: string, basis: string) => (/^\d+$/.test(latest) && /^\d+$/.test(basis) ? BigInt(latest) > BigInt(basis) : latest !== basis);

// kmsg --dry-run only echoes the target. The room counts as resolved when the header (before the Message: line) names exactly this
// room once and says nothing about several matches.
function resolvesRoom(out: string, room: string): boolean {
	const header = out.split(/^Message:/m)[0]!;
	if (/ambiguous|multiple|여러|모호/i.test(header)) return false;
	const named = [...header.matchAll(/^Recipient:[ \t]*(.*)$/gm)].map(m => m[1]!.trim());
	return named.length === 1 && named[0] === room;
}

const sending = new Set<string>();
const refuse = (reason: string): SendResult => ({ ok: false, reason });

// kmsg finds the room by searching its name, which also matches longer names. A send goes out only when no other room's name
// equals or contains this one; `roomNames` lists every room name in the database.
export const uniqueRoomName = (room: string, chatId: string, all: { chatId: string; name: string }[]) =>
	!all.some(r => r.chatId !== chatId && r.name.includes(room));

export async function sendDraft(code: string, deps: SendDeps & { latestIncoming: (chatId: string) => Promise<string | undefined>; roomNames?: () => Promise<{ chatId: string; name: string }[]> }): Promise<SendResult> {
	if (sending.has(code)) return refuse("이미 보내는 중이에요");
	sending.add(code);
	try {
		const d = readDrafts(deps.paths).find(x => x.code === code);
		if (!d) return refuse("그 초안을 찾지 못했어요");
		if (d.status === "sent") return refuse("이미 보낸 초안이에요");
		if (d.status !== "pending") return refuse("더 이상 보낼 수 없는 초안이에요");
		const v = verdict(d, deps.paths);
		if (v === "cancelled") {
			setStatus(deps.paths, code, "dropped");
			return refuse("보내지 않기로 한 초안이에요");
		}
		if (v !== "approved") return refuse("아직 보내도 된다는 답을 받지 못했어요");
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
		if (deps.roomNames) {
			let all: { chatId: string; name: string }[];
			try {
				all = await deps.roomNames();
			} catch {
				return refuse("대화방 목록을 확인하지 못해서 보내지 않았어요");
			}
			if (!uniqueRoomName(d.roomName, d.chatId, all)) return refuse("이름이 같거나 겹치는 대화방이 있어서 자동으로 보내지 않았어요. 카카오톡에서 직접 보내 주세요");
		}
		const kmsg = deps.kmsg ?? Bun.which("kmsg") ?? "/opt/homebrew/bin/kmsg";
		const dry = await deps.runner([kmsg, "send", "--dry-run", "--", d.roomName, d.text], { timeoutMs: 20_000 });
		if (dry.code !== 0 || !resolvesRoom(dry.stdout, d.roomName)) return refuse("대화방을 하나로 확정하지 못해서 보내지 않았어요");
		const sent = await deps.runner([kmsg, "send", "--", d.roomName, d.text], { timeoutMs: 90_000 });
		if (sent.code !== 0) return refuse("카카오톡에서 보내지 못했어요");
		setStatus(deps.paths, code, "sent", { sentAt: new Date(nowMs(deps)).toISOString() });
		return { ok: true };
	} finally {
		sending.delete(code);
	}
}
