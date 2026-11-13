// The one model call behind a KakaoTalk draft request (never per incoming message): read the room, write the reply in the owner's voice,
// lint it (design 3.6) and store it. A revise records what it teaches only after the new draft is stored. Split out of createKakaoWeb
// (hub/kakao/web.ts), which hands it its room and database helpers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerLint } from "../reply-draft.ts";
import { writePrivate } from "./creds.ts";
import { type KakaoDb, messages, ownTextCounts, ownTexts, roomHead } from "./db.ts";
import { basisOf, buildDraftPrompt, chatLines, contextLines, estimateTokens, ownPairs, ownSamples, parseDraftReply, registerOf, type StyleHint, sinceOwnLast } from "./draft.ts";
import { createDraft } from "./send.ts";
import type { KakaoConfig, KakaoPaths, Room } from "./types.ts";
import type { WebDeps } from "./web.ts";

const NO_REPLY = "답할 내용이 없어서 초안을 만들지 않았어요";
const DRAFT_FAILED = "초안을 만들지 못했어요. 잠시 뒤에 다시 눌러 주세요";
const DRAFT_READ = 300;
const REGISTER_LINES = 80;
const VOICE_ROOMS = 8;
const readJsonText = (file: string): string | undefined => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
};

export type MakeDraftCtx = {
	deps: WebDeps;
	paths: KakaoPaths;
	now: () => number;
	getDb: (config: KakaoConfig) => Promise<KakaoDb>;
	allRooms: (config: KakaoConfig, fresh?: boolean) => Promise<{ all: Room[] }>;
	eligible: (rooms: Room[], config: KakaoConfig) => Room[];
	setAsk: (chatId: string, ask: { question: string; choices: string[]; basisLogId: string; created: number } | undefined) => void;
	storedAsks: () => Record<string, unknown>;
};
/** `code`: the stored draft (absent when the call asked the owner a question instead). */
export type Made = { ok: true; code?: string; lesson?: string } | { ok: false; error: string };

/** What a KakaoTalk text fails before it is stored: empty, a blank left to fill, a phrase the room's profile forbids, or over 3000 characters. */
export function kakaoLint(text: string, style: StyleHint | undefined): string[] {
	return ownerLint({ body: text }, { kind: "chat", app: "kakao", from: "", text: "" }, style ?? { rules: [], corrections: [], forbidden: [], samples: [] });
}

// The one model call of a draft request (never per incoming message). Never rejects: every outcome is a kakao_draft event.
// With `choice` (the owner's pick of the room's open question) the call writes the reply for that pick instead of deciding again.
// With `revise` (a pending draft and the owner's change request) the call rewrites that draft; createDraft marks the old one stale only when the new one is stored.
export async function makeDraft(ctx: MakeDraftCtx, config: KakaoConfig, chatId: string, choice?: string, revise?: { code: string; draft: string; change: string }, intent?: string, opts: { learn?: false } = {}): Promise<Made> {
const { deps, paths, now, getDb, allRooms, eligible, setAsk, storedAsks } = ctx;
const summaryFile = (id: string) => join(paths.dataDir, "kakao", "summaries", `${id}.md`);
const done = (error?: string, made?: { code: string; lesson?: string }): Made => {
	deps.broadcast({ kind: "kakao_draft", chatId, ...(error ? { error } : {}) });
	return error ? { ok: false, error } : made ? { ok: true, ...made } : { ok: true };
};
	try {
		const room = eligible((await allRooms(config, true)).all, config).find(r => r.chatId === chatId);
		if (!room) return done("대화방을 찾지 못했어요");
		const db = await getDb(config);
		const recent = await messages(db, chatId, DRAFT_READ, config.userId ?? "");
		const self = room.kind === "self";
		const compose = !!intent;
		const window = compose ? recent : sinceOwnLast(recent, self);
		// A message of his own has no message to answer: its basis is the room's newest row (nothing older makes it stale).
		const basis = compose ? (await roomHead(db, chatId)) || "0" : basisOf(window, self);
		if (!basis) return done(NO_REPLY);
		if (deps.learnVoice) {
			try {
				const db = await getDb(config);
				const me = config.userId ?? "";
				const all = (await allRooms(config)).all;
				const excluded = new Set(config.exclude_chats ?? []);
				const recentRooms = all.filter(r => (r.kind === "direct" || r.kind === "group") && !excluded.has(r.chatId)).sort((a, b) => b.lastAt - a.lastAt).slice(0, VOICE_ROOMS).map(r => r.chatId);
				await deps.learnVoice({ chatId, ownCounts: ids => ownTextCounts(db, ids, me), ownTexts: (id, limit) => ownTexts(db, id, me, limit), messages: (id, limit) => messages(db, id, limit, me), ask: deps.draftModel, recentRooms: async () => recentRooms });
			} catch {}
		}
		let style: StyleHint | undefined;
		try {
			style = deps.draftStyle?.(chatId);
		} catch {}
		// The register from his own last lines of the room, not only those among the last messages: a busy group room has few of them there.
		const ownLines = await ownTexts(db, chatId, config.userId ?? "", REGISTER_LINES);
		const context = compose ? [] : contextLines(recent, window);
		// The pairs come from before the context, so the prompt does not spend its budget on the same lines twice.
		const pairs = ownPairs(compose ? recent : recent.slice(0, recent.length - window.length - context.length));
		const group = room.kind === "group" || room.kind === "open";
		const { system, user } = buildDraftPrompt({ lines: chatLines(window), context, group, summary: readJsonText(summaryFile(chatId)), pairs, samples: ownSamples(recent), register: registerOf(ownLines), style, ...(choice ? { choice } : {}), ...(revise ? { revise: { draft: revise.draft, change: revise.change } } : {}), ...(intent ? { intent } : {}) });
		// One retry with the findings when the model's text fails the lint (design 3.6); what still fails is a 확인 note on the draft.
		let reply = await deps.draftModel!(system, user, chatId);
		let parsed = parseDraftReply(reply.text);
		let notes = parsed?.action === "draft" ? kakaoLint(parsed.body, style) : [];
		if (notes.length) {
			reply = await deps.draftModel!(system, `${user}\n\nYour last draft failed these checks; fix them: ${notes.join("; ")}`, chatId);
			parsed = parseDraftReply(reply.text) ?? parsed;
			notes = parsed?.action === "draft" ? kakaoLint(parsed.body, style) : [];
		}
		if (!parsed) return done(DRAFT_FAILED);
		// A message he asked for has no room question and no skip: the call must write it.
		if (intent && parsed.action !== "draft") return done(DRAFT_FAILED);
		if (parsed.action === "ask" && !choice && !revise && !intent) {
			if (parsed.summary) writePrivate(summaryFile(chatId), `${parsed.summary}\n`);
			setAsk(chatId, { question: parsed.question!, choices: parsed.choices!, basisLogId: basis, created: now() });
			return done();
		}
		if (parsed.action !== "draft" || !parsed.body) return done(parsed.action === "skip" ? NO_REPLY : DRAFT_FAILED);
		const reported = (reply.inputTokens ?? 0) > 0 || (reply.outputTokens ?? 0) > 0;
		let made: { code: string };
		const tokens = reported ? { in: reply.inputTokens ?? 0, out: reply.outputTokens ?? 0 } : { in: estimateTokens(system.length + user.length), out: estimateTokens(reply.text.length), estimated: true as const };
		try {
			made = await createDraft({ chatId, roomName: room.name, text: parsed.body, basisLogId: basis, tokens, ...(intent ? { intent } : {}), ...(revise ? { replaces: revise.code } : {}), ...(notes.length ? { notes: notes.map(n => `확인: ${n}`) } : {}) }, { paths, runner: deps.runner, now });
		} catch (e) {
			return done(e instanceof Error ? e.message : DRAFT_FAILED);
		}
		// Learned only once the new draft is stored, and only what lasts: a one-off change (lesson "") teaches nothing.
		const lesson = revise ? (parsed.lesson ?? revise.change).trim() : "";
		if (lesson && opts.learn !== false) deps.onRevise?.(chatId, lesson);
		if (parsed.summary) writePrivate(summaryFile(chatId), `${parsed.summary}\n`);
		if (storedAsks()[chatId]) setAsk(chatId, undefined);
		return done(undefined, { code: made.code, ...(lesson ? { lesson } : {}) });
	} catch {
		return done(DRAFT_FAILED);
	}
}

