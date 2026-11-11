// Instagram DMs, read only (DESIGN.md "DM 읽기"). One cache file, cache/ig-dm.json, holds the conversations and their latest messages; the
// 모니터링 > 인스타 DM view reads it, the watch `sns-ig-dm` and the view's refresh write it. A poll is one conversation-list call; the messages of a
// conversation are fetched again only when its updated_time moved. Nothing here sends a message. When the feature is off nothing is requested
// and the stored messages are deleted. A missing permission is remembered (and re-checked only after a new token or after a few hours), so a
// quiet account without the permission costs one request per few hours.
import { existsSync, rmSync } from "node:fs";
import { type Ctx, type InstagramSecret, paths, readJson, writeJson } from "./config.ts";
import { conversationMessages, conversations, DM_PERMISSION, isPermissionError } from "./instagram.ts";

export type DmMessage = { id: string; text: string; mine: boolean; from: string; at: number; attach: ("image" | "video" | "audio" | "file")[] };
export type DmConversation = { id: string; peer: string; updated: string; lastAt: number; last: string; messages: DmMessage[] };
export type DmPerm = "ok" | "missing" | "unknown";
export type DmState = { perm: DmPerm; error?: string; checkedAt?: string; tokenAt?: string; convs: Record<string, DmConversation> };

export const PERMISSION_LINE = `인스타 DM을 읽으려면 ${DM_PERMISSION} 권한이 필요해요. 메타 앱의 Instagram 설정에서 이 권한을 켜고 인스타 토큰을 다시 만들어 주세요`;
const MAX_FETCH_PER_RUN = 20;
const MAX_KEEP = 100;
const RECHECK_MS = 6 * 3_600_000;
const ATTACH_TEXT = { image: "(사진)", video: "(동영상)", audio: "(음성 메시지)", file: "(파일)" } as const;

const EMPTY = (): DmState => ({ perm: "unknown", convs: {} });

export function readDms(): DmState {
	try {
		const s = readJson<DmState>(paths.igDm());
		return s && typeof s === "object" && s.convs ? { ...EMPTY(), ...s } : EMPTY();
	} catch {
		return EMPTY();
	}
}

export const clearDms = (): void => rmSync(paths.igDm(), { force: true });

// The API gives a unix time or an ISO string.
const toMs = (v: string | number | undefined): number => {
	if (v === undefined) return 0;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : Date.parse(String(v)) || 0;
};

// What a message shows in a list: its text, else what it carries.
export const messageText = (m: Pick<DmMessage, "text" | "attach">): string => m.text || (m.attach.length ? ATTACH_TEXT[m.attach[0]!] : "(내용 없음)");

export type SyncResult = { skipped?: "off" | "recheck-later"; perm: DmPerm; fetched: number };

// `own` identifies the owner's account: its Instagram id and username (messages from it are "mine").
export async function syncDms(ctx: Ctx, opts: { enabled: () => boolean; own: { id: string; username: string }; force?: boolean }): Promise<SyncResult> {
	if (!opts.enabled()) {
		if (existsSync(paths.igDm())) clearDms();
		return { skipped: "off", perm: "unknown", fetched: 0 };
	}
	const state = readDms();
	const secret = readJson<InstagramSecret>(paths.instagram());
	const tokenAt = secret?.obtained_at;
	const nowMs = ctx.now().getTime();
	if (!opts.force && state.perm === "missing" && state.tokenAt === tokenAt && state.checkedAt && nowMs - Date.parse(state.checkedAt) < RECHECK_MS) return { skipped: "recheck-later", perm: "missing", fetched: 0 };
	const at = ctx.now().toISOString();
	let list;
	try {
		list = await conversations(ctx);
	} catch (e) {
		if (!isPermissionError(e)) throw e;
		writeJson(paths.igDm(), { ...state, perm: "missing", error: PERMISSION_LINE, checkedAt: at, ...(tokenAt ? { tokenAt } : {}) } satisfies DmState);
		return { perm: "missing", fetched: 0 };
	}
	const owner = opts.own.username.toLowerCase();
	const convs = { ...state.convs };
	let fetched = 0;
	for (const c of list) {
		if (fetched >= MAX_FETCH_PER_RUN) break;
		if (convs[c.id]?.updated === String(c.updated_time)) continue;
		fetched++;
		const raw = await conversationMessages(ctx, c.id);
		const mine = (p: { id?: string; username?: string }) => (p.id !== undefined && p.id === opts.own.id) || (p.username !== undefined && p.username.toLowerCase() === owner);
		const messages: DmMessage[] = raw
			.map(m => ({ id: m.id, text: m.text, mine: mine(m.from), from: m.from.username ?? m.from.id ?? "", at: toMs(m.created_time), attach: m.attachments.map(a => a.kind) }))
			.sort((a, b) => a.at - b.at);
		const parties = raw.flatMap(m => [m.from, ...m.to]).filter(p => !mine(p));
		const peer = parties.find(p => p.username)?.username ?? parties[0]?.id ?? convs[c.id]?.peer ?? "알 수 없는 사용자";
		const last = messages[messages.length - 1];
		convs[c.id] = { id: c.id, peer, updated: String(c.updated_time), lastAt: last?.at ?? toMs(c.updated_time), last: last ? messageText(last).slice(0, 80) : "", messages };
	}
	const keep = Object.values(convs).sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_KEEP);
	writeJson(paths.igDm(), { perm: "ok", checkedAt: at, ...(tokenAt ? { tokenAt } : {}), convs: Object.fromEntries(keep.map(c => [c.id, c])) } satisfies DmState, true);
	return { perm: "ok", fetched };
}
