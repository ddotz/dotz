// 직접 수정 is verbatim (design 3.3) and a revise learns only after its new draft is stored (3.4).
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { draftLintFailures, editDraft, reviseDraft } from "../lib/flow.ts";
import { paths, toneFile } from "../lib/settings.ts";
import * as store from "../lib/store.ts";
import { addDraft, getDraft, type DraftRec } from "../lib/store.ts";
import { fakeModel, goodReply, j, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.drafts(), paths.inbox(), join(env.dir, "custom", "reply-drafts")]) rmSync(p, { force: true, recursive: true });
	mkdirSync(join(env.dir, "custom", "reply-drafts"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true }));
	mkdirSync(dirname(toneFile("install")), { recursive: true });
	writeFileSync(toneFile("install"), "## 금지\n\n- 무조건\n");
});

const rec = (o: Partial<DraftRec> = {}): DraftRec =>
	({ id: "REDIT1", kind: "mail", app: "mail", source: "zele", mailId: "m1", ref: "k1", to: "kim@example.com", subject: "Re: 문의", body: "확인해 보고 말씀드릴게요.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", text: "문의드립니다", from: "Kim <kim@example.com>", subject: "문의" }, ...o }) as unknown as DraftRec;

test("the owner's text is stored byte for byte, and editedFrom keeps the model's text from before his first edit", () => {
	addDraft(rec());
	const mine = "김 팀장님,\n목요일 저녁까지 보내드릴게요.  감사합니다 :)";
	expect(editDraft("REDIT1", `${mine}\r\n`).ok).toBe(true);
	expect(getDraft("REDIT1")?.body).toBe(mine);
	expect(getDraft("REDIT1")?.editedFrom).toBe("확인해 보고 말씀드릴게요.");
	expect(editDraft("REDIT1", "두 번째 수정이에요").ok).toBe(true);
	expect(getDraft("REDIT1")?.editedFrom).toBe("확인해 보고 말씀드릴게요.");
});

test("a forbidden word refuses the edit with its code and stores nothing", () => {
	addDraft(rec());
	const r = editDraft("REDIT1", "무조건 금요일에 드릴게요");
	expect([r.ok, r.code]).toEqual([false, "forbidden_word"]);
	expect(getDraft("REDIT1")?.body).toBe("확인해 보고 말씀드릴게요.");
	expect(getDraft("REDIT1")?.editedFrom).toBeUndefined();
});

test("an edited body longer than the style's limit still passes the send-time lint: his length is not the style's", () => {
	writeFileSync(join(env.dir, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true, maxChars: 20 }));
	addDraft(rec());
	const long = "안녕하세요. 문의 주신 견적은 목요일 저녁까지 정리해서 메일로 보내드리겠습니다. 감사합니다.";
	expect(editDraft("REDIT1", long).ok).toBe(true);
	expect(draftLintFailures(getDraft("REDIT1")!)).toEqual([]);
});

test("a revise whose new draft could not be stored records no lesson", async () => {
	addDraft(rec());
	const m = fakeModel([j({ ...goodReply, body: "목요일까지 보내드릴게요.", lesson: "마감은 넉넉히 잡아서 쓴다" })]);
	const write = spyOn(store, "addDraft").mockImplementation(() => { throw new Error("disk full"); });
	try {
		await expect(reviseDraft("REDIT1", "마감을 목요일로", { call: m.call })).rejects.toThrow("disk full");
	} finally {
		write.mockRestore();
	}
	for (const key of ["install", { app: "mail" }] as const) {
		const tone = Bun.file(toneFile(key));
		expect((await tone.exists()) ? await tone.text() : "").not.toContain("마감은 넉넉히");
	}
});
