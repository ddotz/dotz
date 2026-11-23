// The KakaoTalk adapter of the one reply flow (design 1.8 column 4) on a temp store: the view, the actions and every send result as the queue reads it.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localMidnight } from "../reply-route.ts";
import { kakaoAdapter, outcomeOf } from "./reply-adapter.ts";
import { createDraft, readDrafts } from "./send.ts";
import { kakaoPaths } from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "kakao-adapter-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const paths = kakaoPaths(dir, dir);
const runner = async () => ({ code: 0, stdout: "", stderr: "" });
let revised: { chatId: string; change: string; intent?: string }[] = [];
let taught: { line: string; forbid: string[]; everywhere: boolean } = { line: "짧게 쓴다", forbid: [], everywhere: false };
const kit = {
	paths,
	revise: async (chatId: string, r: { code: string; change: string; intent?: string }) => {
		revised.push({ chatId, change: r.change, ...(r.intent ? { intent: r.intent } : {}) });
		const d = await createDraft({ chatId, roomName: "Alex", text: "3시", basisLogId: "9", replaces: r.code }, { paths, runner });
		return { ok: true as const, code: d.code, learned: taught };
	},
	sendDeps: async () => ({ paths, runner }),
};
beforeEach(() => {
	rmSync(join(dir, "kakao"), { recursive: true, force: true });
	revised = [];
	taught = { line: "짧게 쓴다", forbid: [], everywhere: false };
});
const draft = () => createDraft({ chatId: "1", roomName: "Alex", text: "내일 3시에 봐요", basisLogId: "9" }, { paths, runner });

test("a pending draft is the one view; another kind's ref is not this adapter's", async () => {
	const a = kakaoAdapter(kit);
	const d = await draft();
	expect(await a.get(d.code)).toMatchObject({ item: "kakao:1", kind: "kakao", conv: "kakao:1", label: "Alex", draft: { state: "pending", to: "Alex", text: "내일 3시에 봐요" }, can: { send: true, revise: true, edit: true } });
	expect((await a.list()).map(v => v.ref)).toEqual([d.code]);
	expect(await a.get("RAAAAAA")).toBeUndefined();
	expect(a.target(d.code)).toEqual({ kind: "kakao", lane: "kakao" });
	expect(a.question(d.code)).toBe(`카톡 답장 보낼까요? (${d.code})`);
	expect(await a.ask(d.code)).toContain(`(${d.code})`);
});

test("a change to a message the owner asked for carries his request, so it is rewritten as that message; a reply's change has none", async () => {
	const a = kakaoAdapter(kit);
	const asked = await createDraft({ chatId: "1", roomName: "Alex", text: "짧은 설명", basisLogId: "9", intent: "맥미니 설명자료 만들어" }, { paths, runner });
	await a.revise(asked.code, "더 자세히");
	const reply = await draft();
	await a.revise(reply.code, "더 짧게");
	expect(revised).toEqual([{ chatId: "1", change: "더 자세히", intent: "맥미니 설명자료 만들어" }, { chatId: "1", change: "더 짧게" }]);
});

test("a send job that is not the owner's act (or code's retry of one) is refused before KakaoTalk is touched", async () => {
	const d = await draft();
	let touched = 0;
	const a = kakaoAdapter({ ...kit, sendDeps: async () => (touched++, { paths, runner }) });
	expect(await a.run!({ ref: d.code, conv: "kakao:1", action: "send", title: a.question(d.code) })).toEqual({ sent: "no", code: "not_approved" });
	expect(touched).toBe(0);
	expect(readDrafts(paths).find(x => x.code === d.code)!.status).toBe("pending");
});

test("the view quotes the message the draft answers; a database that cannot be read leaves it out", async () => {
	const d = await draft();
	const original = { who: "Alex", text: "내일 몇 시에 볼까요?", at: 1 };
	const withQuote = kakaoAdapter({ ...kit, original: async x => (x.basisLogId === "9" ? original : undefined) });
	expect((await withQuote.get(d.code))!.original).toEqual(original);
	expect((await withQuote.list())[0]!.original).toEqual(original);
	const broken = kakaoAdapter({ ...kit, original: async () => { throw new Error("db locked"); } });
	expect((await broken.get(d.code))!.original).toBeUndefined();
});

test("revise returns the new code with what it replaced and the room's lesson; edit, drop and restore move the store", async () => {
	const a = kakaoAdapter(kit);
	const d = await draft();
	const r = await a.revise(d.code, "더 짧게");
	expect(r).toMatchObject({ ok: true, replaces: d.code, lesson: { key: { app: "kakao", room: "1" }, line: "짧게 쓴다" } });
	const next = r.ok ? r.ref : "";
	expect((await a.get(next))!.draft).toMatchObject({ text: "3시", replaces: { ref: d.code, text: "내일 3시에 봐요" } });
	expect(await a.edit(next, "3시에 봐!")).toEqual({ ok: true });
	expect((await a.get(next))!.draft).toMatchObject({ text: "3시에 봐!", edited: true });
	expect(await a.drop(next)).toEqual({ ok: true });
	expect(await a.restore(next)).toEqual({ ok: true });
	expect(readDrafts(paths).find(x => x.code === next)!.status).toBe("pending");
});

test("a revise that holds everywhere returns its lesson under the install key with the banned wordings; one that bans only a wording in the room keeps the room key", async () => {
	const a = kakaoAdapter(kit);
	const d = await draft();
	taught = { line: "존댓말로 쓴다", forbid: ["편안한 하루 되세요"], everywhere: true };
	expect(await a.revise(d.code, "편안한 하루 되세요는 비문이야, 항상 존댓말로")).toMatchObject({ ok: true, lesson: { key: { app: "install" }, line: "존댓말로 쓴다", forbid: ["편안한 하루 되세요"] } });
	const room = await draft();
	taught = { line: "", forbid: ["ㅋㅋㅋ"], everywhere: false };
	expect(await a.revise(room.code, "ㅋㅋㅋ 쓰지 마")).toMatchObject({ ok: true, lesson: { key: { app: "kakao", room: "1" }, line: "", forbid: ["ㅋㅋㅋ"] } });
});

test("every send result reads as sent, surely not sent, may be in the room, or some parts in", () => {
	expect(outcomeOf({ ok: true })).toEqual({ sent: "yes" });
	expect(outcomeOf({ ok: true, unconfirmed: true })).toEqual({ sent: "maybe", code: "press_unconfirmed" });
	expect(outcomeOf({ ok: false, sent: "no", code: "lease_held" })).toEqual({ sent: "no", code: "lease_held" });
	expect(outcomeOf({ ok: false, sent: "no", code: "app_not_ready" })).toEqual({ sent: "no", code: "app_not_ready" });
	expect(outcomeOf({ ok: false, sent: "maybe", code: "interrupted" })).toEqual({ sent: "maybe", code: "interrupted" });
	expect(outcomeOf({ ok: false, sent: "partial", code: "app_not_ready", done: 1, total: 3 })).toEqual({ sent: "partial", done: 1, total: 3, code: "app_not_ready", rest: "no" });
	expect(outcomeOf({ ok: false, sent: "partial", code: "press_unconfirmed", done: 2, total: 3 })).toMatchObject({ rest: "maybe" });
	expect(outcomeOf({ ok: false })).toEqual({ sent: "maybe", code: "unknown" });
});

test("a draft sent but unconfirmed is still open until the owner says it went out; proof reads only a confirmed send", async () => {
	const a = kakaoAdapter(kit);
	const d = await draft();
	const all = readDrafts(paths).map(x => (x.code === d.code ? { ...x, status: "sent" as const, unconfirmed: true as const } : x));
	await Bun.write(join(dir, "kakao", "drafts.json"), JSON.stringify(all));
	expect(await a.prove!(d.code)).toBe("unknown");
	expect(await a.markSent(d.code)).toEqual({ ok: true });
	expect(await a.prove!(d.code)).toBe("sent");
});

test("U4-7 a draft sent today is listed as sent with its time; one sent before midnight, an unconfirmed one and one with no time are not", async () => {
	const a = kakaoAdapter(kit);
	const made = [await draft(), await draft(), await draft(), await draft()].map(d => d.code);
	const today = Date.now(), yesterday = localMidnight() - 3_600_000;
	const sent: Record<string, object> = { [made[0]!]: { sentAt: new Date(today).toISOString() }, [made[1]!]: { sentAt: new Date(yesterday).toISOString() }, [made[2]!]: { sentAt: new Date(today).toISOString(), unconfirmed: true }, [made[3]!]: {} };
	await Bun.write(join(dir, "kakao", "drafts.json"), JSON.stringify(readDrafts(paths).map(x => ({ ...x, status: "sent", ...sent[x.code] }))));
	expect((await a.list()).map(v => v.ref)).toEqual([made[0]]);
	expect(await a.get(made[0]!)).toMatchObject({ draft: { state: "sent" }, can: { send: false }, sent: { at: today, how: "owner" } });
	expect((await a.get(made[1]!))!.sent).toEqual({ at: yesterday, how: "owner" });
	expect((await a.get(made[2]!))!.sent).toBeUndefined();
});
