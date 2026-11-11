// Context search, extraction (docs: recall-index.ts). Pure: turns the lines of one session JSONL file into owner/answer pairs.
// A pair is the owner's words plus the answer text up to the next owner message of that session. Three eras feed it:
// gateway conversation sessions ([dotz inbox] wrappers), lane sessions (brief, [owner via ...]) and the legacy pre-gateway
// sessions (Discord monitor events, replies sent from eval code). Machine noise (keepalives, handovers, reports) is dropped,
// tool results, thinking and system prompts are never read. Streaming: lines in, pairs out, nothing is held but one pair.
import { createHash } from "node:crypto";
import { isGatewayNote } from "./gateway-added.ts";

export type PairKind = "owner" | "brief" | "relay";
export interface RawLine { readonly text: string; readonly line: number; readonly offset: number }
export interface RecallCtx {
	readonly file: string; readonly cwd: string; readonly session: string; readonly title: string; readonly convKey: string;
	readonly afterBrief: boolean; readonly ownerCap: number; readonly answerCap: number;
}
export interface Pair {
	readonly id: string; readonly entry: string; readonly line: number; readonly offset: number; readonly ts: string;
	readonly room: string; readonly kind: PairKind; readonly owner: string; readonly answer: string; readonly msgIds: readonly string[];
	readonly cwd: string; readonly session: string; readonly title: string; readonly project: string;
	readonly afterBrief: boolean; readonly open: boolean;
}
interface OwnerMsg { readonly text: string; readonly kind: PairKind; readonly room: string; readonly msgId: string; readonly ts: string }
interface Draft { readonly entry: string; readonly line: number; readonly offset: number; readonly ts: string; readonly room: string; readonly kind: PairKind; owner: string; readonly answers: string[]; readonly msgIds: string[]; readonly afterBrief: boolean }
type Json = Record<string, unknown>;

export const OWNER_CAP = 2000;
export const ANSWER_CAP = 3000;
export const OPEN_CAP = 6000;
export const EXTRACT_VERSION = "3";

export const capText = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.floor(n * 0.6))}\n...\n${s.slice(s.length - Math.floor(n * 0.4))}`);

const NOISE = /^(?:\[keepalive\]|\[dotz reflect\]|\[gateway check\]|\[자동 복구|\[자동 재개\]|\[야간 정리\]|\[REPORT\]|\[LEAD\]|\[handover\]|<environment_context>|<system-reminder>|<omo-|<memory_notice|<recalled-memory|\[dotz lane |당신은 자신만의 git worktree)/;
const INBOX_HEAD = /^\[dotz inbox\] ([^\n]*)\n?/gm;
const INBOX_ROOM = /^(web(?::[\w-]+)?|ch:\d+|th:\d+|mail:\S+)(?=[\s(]|$)/;
const WRAPPER = /^\[Answer to question [^\]]*\]\s*(?:The user responded:\s*)?|^\[peer handoff [^\]]*\][\s\S]*?Owner's words \(verbatim\):\s*/;
const TRAILER = /^\((?:작업 채널 목록|오너에게는|오너 메시지예요|당신이 한 이 질문)/;
const ATTACH = /^\[attachment\] (.+?) \([^()]*\) \//;
const LANE_FOOTER = /^(?:\[dotz lane |당신은 자신만의 git worktree)/m;
const TRIVIAL = /^(?:ok\.?|-|\[later\]|\[run\][^\n]*)$/i;
const WAKE_TYPES = new Set(["omo-senpi:wake", "goal-continuation"]);
const SEND_CODE = /message send|discordbot/;
const STRING_LIT = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
const MONITOR_JSON = /\): (\{[\s\S]*\})\s*<\/system-reminder>/;

const asJson = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseJson(text: string): Json | undefined {
	try {
		return asJson(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export function sessionHeader(firstLine: string): { cwd: string; session: string } | undefined {
	const o = parseJson(firstLine);
	return o?.type === "session" ? { cwd: str(o.cwd), session: str(o.id) } : undefined;
}

export function projectOf(cwd: string, convKey: string): string {
	return /\/\.dotz\/lanes\/([^/]+)/.exec(cwd)?.[1] ?? /\/\.dotz\/projects\/([^/]+)/.exec(cwd)?.[1] ?? /\/Code\/([^/]+)/.exec(cwd)?.[1] ?? (/\/\.dotz\/?$/.test(cwd) ? convKey : "");
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(p => (asJson(p)?.type === "text" ? str(asJson(p)?.text) : "")).join("");
};

const unwrap = (t: string): string => t.replace(WRAPPER, "").trim();

function cleanBody(body: string): string {
	const out: string[] = [], files: string[] = [];
	for (const l of unwrap(body).split("\n")) {
		if (TRAILER.test(l) || isGatewayNote(l)) break;
		if (l.startsWith("[지칭]")) continue;
		const a = ATTACH.exec(l);
		if (a) files.push(`첨부: ${a[1]}`);
		else out.push(l);
	}
	return [...out, ...files].join("\n").trim();
}

function inboxMessages(text: string, ts: string): OwnerMsg[] {
	const heads = [...text.matchAll(INBOX_HEAD)];
	return heads.flatMap((h, i) => {
		const rest = h[1] ?? "";
		const room = INBOX_ROOM.exec(rest)?.[1];
		if (!room) return [];
		const body = cleanBody(text.slice((h.index ?? 0) + h[0].length, heads[i + 1]?.index ?? text.length));
		if (!body) return [];
		const name = /^ch:\d+ (#\S+)/.exec(rest)?.[1];
		return [{ text: body, kind: "owner", room: name ?? room, msgId: /\bmsg=([\w-]+)/.exec(rest)?.[1] ?? "", ts }];
	});
}

type CwdKind = "conv" | "lane" | "other";
const cwdKindOf = (cwd: string): CwdKind => (/\/\.dotz\/lanes\//.test(cwd) ? "lane" : /\/\.dotz\/?$/.test(cwd) ? "conv" : "other");

function plainMessages(t: string, kind: CwdKind, afterBrief: boolean, ts: string): OwnerMsg[] {
	const msg = (text: string, k: PairKind, room: string): OwnerMsg[] => (text ? [{ text, kind: k, room, msgId: "", ts }] : []);
	if (kind === "conv") return [];
	if (kind === "lane") {
		const via = /^\[owner via (\w+)\]\s*/.exec(t);
		if (via) return msg(cleanBody(t.slice(via[0].length)), "owner", (via[1] ?? "").toLowerCase());
		if (afterBrief) return [];
		const cut = t.search(LANE_FOOTER);
		return msg((cut < 0 ? t : t.slice(0, cut)).replace(/\n*---\s*$/, "").trim(), "brief", "");
	}
	const relay = /^\[((?:사용자|형) [^\]]*)\]\s*/.exec(t);
	return relay ? msg(t.slice(relay[0].length).trim(), "relay", (relay[1] ?? "").slice(0, 60)) : msg(t, "owner", "");
}

function userMessages(raw: string, kind: CwdKind, afterBrief: boolean, ts: string): OwnerMsg[] {
	const t = raw.trim();
	if (!t || NOISE.test(t)) return [];
	if (/^\[dotz inbox\] /m.test(t)) return inboxMessages(t, ts);
	if (t.startsWith("[dotz gateway]")) return [];
	return plainMessages(unwrap(t), kind, afterBrief, ts);
}

function monitorMessage(content: string, entryTs: string): OwnerMsg | undefined {
	const j = parseJson(MONITOR_JSON.exec(content)?.[1] ?? "");
	if (!j || j.kind !== "message" || !str(j.content).trim()) return undefined;
	return { text: str(j.content).trim(), kind: "owner", room: `ch:${str(j.channel_id)}`, msgId: str(j.id), ts: str(j.ts) || entryTs };
}

function sentLiterals(code: string): string {
	const out: string[] = [];
	for (const m of code.matchAll(STRING_LIT)) {
		const s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\([nt"'`\\])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
		if ((s.match(/[가-힣]/g)?.length ?? 0) >= 10) out.push(s);
	}
	return out.join("\n");
}

// What an assistant message hands to the owner now: dotz_send text (not progress notes) and strings sent from eval/bash code.
function sentTexts(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap(p => {
		const c = asJson(p);
		const a = asJson(c?.arguments);
		if (c?.type !== "toolCall" || !a) return [];
		if (c.name === "dotz_send") return a.update_key ? [] : [str(a.text).trim()];
		const code = str(a.code) || str(a.command);
		return SEND_CODE.test(code) ? [sentLiterals(code)] : [];
	}).filter(Boolean);
}

const finalText = (content: unknown): string =>
	Array.isArray(content) && !content.some(p => asJson(p)?.type === "toolCall") ? textOf(content).trim() : "";

export function* extractPairs(lines: Iterable<RawLine>, ctx: RecallCtx): Generator<Pair> {
	let cwd = ctx.cwd, session = ctx.session, title = ctx.title, afterBrief = ctx.afterBrief;
	let cur: Draft | undefined;
	let turn = { counts: true, final: "" };
	const keep = (s: string) => { if (cur && s && !TRIVIAL.test(s) && !cur.answers.includes(s)) cur.answers.push(s); };
	const endTurn = (counts: boolean) => { if (turn.counts) keep(turn.final); turn = { counts, final: "" }; };
	const close = (d: Draft, open: boolean): Pair => ({
		id: createHash("sha1").update(`${ctx.file}\0${d.entry}`).digest("hex").slice(0, 16), entry: d.entry, line: d.line, offset: d.offset, ts: d.ts,
		room: d.room, kind: d.kind, owner: capText(d.owner, ctx.ownerCap), answer: capText(d.answers.join("\n\n"), ctx.answerCap), msgIds: d.msgIds,
		cwd, session, title, project: projectOf(cwd, ctx.convKey), afterBrief: d.afterBrief, open,
	});
	for (const raw of lines) {
		if (!raw.text || raw.text.includes('"role":"toolResult"')) continue;
		const o = parseJson(raw.text);
		if (!o) continue;
		const ts = str(o.timestamp);
		const m = asJson(o.message);
		let owners: OwnerMsg[] | undefined;
		if (o.type === "session") { cwd = str(o.cwd) || cwd; session = str(o.id) || session; continue; }
		if (o.type === "session_info") { title = str(o.name) || title; continue; }
		if (o.type === "custom_message") {
			if (o.customType === "senpi-monitor:notification") {
				const mm = monitorMessage(str(o.content), ts);
				if (!mm) { endTurn(false); continue; }
				owners = [mm];
			} else { if (WAKE_TYPES.has(str(o.customType))) endTurn(true); continue; }
		} else if (o.type === "message" && m?.role === "user") {
			owners = userMessages(textOf(m.content), cwdKindOf(cwd), afterBrief, ts);
			if (!owners.length) { endTurn(false); continue; }
		} else if (o.type === "message" && m?.role === "assistant") {
			turn.final = finalText(m.content) || turn.final;
			for (const s of sentTexts(m.content)) keep(s);
			continue;
		}
		if (!owners) continue;
		endTurn(true);
		for (const msg of owners) {
			if (cur && (cur.answers.length || cur.kind === "brief" || msg.kind === "brief")) { yield close(cur, false); cur = undefined; }
			if (cur) {
				cur.owner += `\n\n${msg.text}`;
				if (msg.msgId) cur.msgIds.push(msg.msgId);
				continue;
			}
			cur = { entry: str(o.id), line: raw.line, offset: raw.offset, ts: msg.ts || ts, room: msg.room, kind: msg.kind, owner: msg.text, answers: [], msgIds: msg.msgId ? [msg.msgId] : [], afterBrief };
			afterBrief = true;
		}
	}
	endTurn(true);
	if (cur) yield close(cur, true);
}
