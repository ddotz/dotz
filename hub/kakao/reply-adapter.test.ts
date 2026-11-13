// The KakaoTalk adapter of the one reply flow (design 1.8 column 4) on a temp store: the view, the actions and every send result as the queue reads it.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kakaoAdapter, outcomeOf } from "./reply-adapter.ts";
import { createDraft, readDrafts } from "./send.ts";
import { kakaoPaths } from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "kakao-adapter-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const paths = kakaoPaths(dir, dir);
const runner = async () => ({ code: 0, stdout: "", stderr: "" });
let revised: { chatId: string; change: string }[] = [];
const kit = {
	paths,
	revise: async (chatId: string, r: { code: string; change: string }) => {
		revised.push({ chatId, change: r.change });
		const d = await createDraft({ chatId, roomName: "Alex", text: "3시", basisLogId: "9", replaces: r.code }, { paths, runner });
		return { ok: true as const, code: d.code, lesson: "짧게 쓴다" };
	},
	sendDeps: async () => ({ paths, runner }),
};
beforeEach(() => {
	rmSync(join(dir, "kakao"), { recursive: true, force: true });
	revised = [];
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
