// The KakaoTalk adapter of the one reply flow (design 1.8 column 4) on a temp store: the view, the actions and every send result as the queue reads it.
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Learned } from "../reply-draft.ts";
import { lessonOfEdit } from "../reply-mail.ts";
import { localMidnight } from "../reply-route.ts";
import { advance, flush } from "../runtime/test-clock.ts";
import { type EditLearning, kakaoAdapter, outcomeOf } from "./reply-adapter.ts";
import { createDraft, editDraft, readDrafts } from "./send.ts";
import { kakaoPaths } from "./types.ts";
import { fakeScreen } from "./ui.fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "kakao-adapter-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const paths = kakaoPaths(dir, dir);
const runner = async () => ({ code: 0, stdout: "", stderr: "" });
let revised: { chatId: string; change: string; intent?: string }[] = [];
let taught: Learned = { line: "짧게 쓴다", forbid: [], scope: "channel" };
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
	taught = { line: "짧게 쓴다", forbid: [], scope: "channel" };
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

test("a revise that holds everywhere returns its lesson under the install key with the banned wordings; one that bans only a wording in the room, or is about the person, keeps the room key", async () => {
	const a = kakaoAdapter(kit);
	const d = await draft();
	taught = { line: "존댓말로 쓴다", forbid: ["편안한 하루 되세요"], scope: "everywhere" };
	expect(await a.revise(d.code, "편안한 하루 되세요는 비문이야, 항상 존댓말로")).toMatchObject({ ok: true, lesson: { key: { app: "install" }, line: "존댓말로 쓴다", forbid: ["편안한 하루 되세요"] } });
	const room = await draft();
	taught = { line: "", forbid: ["ㅋㅋㅋ"], scope: "channel" };
	expect(await a.revise(room.code, "ㅋㅋㅋ 쓰지 마")).toMatchObject({ ok: true, lesson: { key: { app: "kakao", room: "1" }, line: "", forbid: ["ㅋㅋㅋ"] } });
	const person = await draft();
	taught = { line: "이분께는 존댓말로 쓴다", forbid: [], scope: "recipient" };
	const r = await a.revise(person.code, "이분께는 존댓말로");
	expect(r).toMatchObject({ ok: true, lesson: { key: { app: "kakao", room: "1" }, line: "이분께는 존댓말로 쓴다" } });
	expect(r.ok && r.lesson?.key).toEqual({ app: "kakao", room: "1" });
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

const EDIT_LESSON = "친구 방에서 약속을 정할 때는 '봐요' 대신 '봐!!'처럼 들뜬 반말로 쓴다";
const ROOM_LINES = "Alex: 내일 몇 시에 볼까요?";
async function sentEdit(o: { answer?: () => Promise<string>; text?: string; wired?: false; latest?: string; unconfirmed?: true } = {}) {
	const d = await draft();
	expect(editDraft(d.code, o.text ?? "내일 3시에 봐!! ㅎㅎ", { paths })).toEqual({ ok: true });
	const asked: { user: string; chatId: string }[] = [], learned: [string, Learned][] = [];
	const screen = fakeScreen([{ id: "chat_alex", title: "Alex", window: { title: "Alex" } }], o.unconfirmed ? { axSend: () => ({ ok: false, why: "unclear", pressed: true }) } : {});
	const edits: EditLearning = { answered: async x => (x.code === d.code ? ROOM_LINES : ""), ask: async (_system, user, chatId) => (asked.push({ user, chatId }), (o.answer ?? (async () => JSON.stringify({ lesson: EDIT_LESSON, everywhere: false })))()), lessonOfEdit, learn: (chatId, l) => void learned.push([chatId, l]) };
	const a = kakaoAdapter({ ...kit, sendDeps: async () => ({ paths, runner: screen.runner, now: () => 1, latestIncoming: async () => o.latest, ...(o.unconfirmed ? { confirm: async () => false, sleep: async () => undefined, later: () => undefined } : {}) }), ...(o.wired === false ? {} : { edits }) });
	const out = await a.run!({ ref: d.code, conv: "kakao:1", action: "send", title: a.question(d.code), by: "owner" });
	await flush();
	return { out, asked, learned, status: readDrafts(paths).find(x => x.code === d.code)!.status, a, code: d.code };
}

test("a sent KakaoTalk draft the owner edited teaches the model's lesson to that room, read with the chat lines it answered; one about the language itself is marked everywhere", async () => {
	const r = await sentEdit();
	expect([r.out, r.status]).toEqual([{ sent: "yes" }, "sent"]);
	expect(r.learned).toEqual([["1", { line: EDIT_LESSON, forbid: [], scope: "channel" }]]);
	expect(r.asked.map(x => x.chatId)).toEqual(["1"]);
	for (const said of [ROOM_LINES, "내일 3시에 봐요", "내일 3시에 봐!! ㅎㅎ"]) expect(r.asked[0]!.user).toContain(said);
	expect((await sentEdit({ answer: async () => JSON.stringify({ lesson: "맞춤법은 '돼요'로 쓴다", everywhere: true }) })).learned).toEqual([["1", { line: "맞춤법은 '돼요'로 쓴다", forbid: [], scope: "everywhere" }]]);
});

test('a KakaoTalk edit teaches nothing for "", a failed or late call, a whitespace-only edit, a send that did not go out, or no wiring, and the send result stays the same', async () => {
	const plain = await sentEdit({ wired: false });
	expect([plain.out, plain.learned]).toEqual([{ sent: "yes" }, []]);
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	const empty = await sentEdit({ answer: async () => JSON.stringify({ lesson: "", everywhere: true }) });
	const thrown = await sentEdit({ answer: async () => { throw new Error("model down"); } });
	const late = Promise.withResolvers<string>();
	const slow = await sentEdit({ answer: () => late.promise });
	await advance(12_000);
	late.resolve(JSON.stringify({ lesson: EDIT_LESSON, everywhere: false }));
	await flush();
	log.mockRestore();
	for (const r of [empty, thrown, slow]) expect([r.out, r.learned, r.asked.length]).toEqual([plain.out, [], 1]);
	const spaces = await sentEdit({ text: "내일  3시에 봐요 " });
	expect([spaces.out, spaces.learned, spaces.asked]).toEqual([plain.out, [], []]);
	const stale = await sentEdit({ latest: "99" });
	expect([stale.status, stale.learned, stale.asked]).toEqual(["stale", [], []]);
});

test("a KakaoTalk press that was not confirmed is not a send the queue records as sent: it teaches nothing, though the draft counts as sent", async () => {
	const r = await sentEdit({ unconfirmed: true });
	expect([r.out, r.status, r.learned, r.asked]).toEqual([{ sent: "maybe", code: "press_unconfirmed" }, "sent", [], []]);
});

test("a KakaoTalk send the in-process run learned is not learned again by the gateway's learnSent, nor by a new adapter over the same store after a restart", async () => {
	const r = await sentEdit();
	expect(r.learned).toHaveLength(1);
	r.a.learnSent?.(r.code);
	const again: string[] = [];
	kakaoAdapter({ ...kit, edits: { answered: async () => ROOM_LINES, ask: async () => (again.push("asked"), JSON.stringify({ lesson: EDIT_LESSON, everywhere: false })), lessonOfEdit, learn: () => void again.push("learned") } }).learnSent?.(r.code);
	await flush();
	expect([r.learned.length, r.asked.length, again]).toEqual([1, 1, []]);
});

test("an unconfirmed KakaoTalk send is learned only once the owner says it went out (나갔어요), and then once", async () => {
	const r = await sentEdit({ unconfirmed: true });
	r.a.learnSent?.(r.code);
	await flush();
	expect(r.learned).toEqual([]);
	expect(await r.a.markSent(r.code)).toEqual({ ok: true });
	r.a.learnSent?.(r.code);
	r.a.learnSent?.(r.code);
	await flush();
	expect([r.learned, r.asked.length]).toEqual([[["1", { line: EDIT_LESSON, forbid: [], scope: "channel" }]], 1]);
});
