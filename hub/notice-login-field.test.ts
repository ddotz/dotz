import { beforeEach, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { blockText, recoveryText } from "./limit-alert.ts";
import { listNotices, type Notice, resetNoticesForTest } from "./notices.ts";
import { watchLine } from "./watchtext.ts";

type Listed = Notice & { waits?: string; login?: string };
const post = (text: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target: "alert", nk: "alert", text });
const listed = (has: string) => (listNotices(300).items as Listed[]).find(n => n.kind === "alert" && n.text.includes(has))!;

beforeEach(resetNoticesForTest);

test("a provider's login stop is listed with that provider's id while it waits, and a watch's lost login is not", () => {
	post(`땃쥐: ${blockText("auth", "anthropic", "anthropic", 1_800_000)}`);
	post(watchLine("카톡", "failed 3 times in a row (exit 1)", "DOTZ_FAIL login\n세션이 끊겼어요"));
	expect([listed("anthropic").waits, listed("anthropic").login]).toEqual(["login", "anthropic"]);
	expect([listed("카톡").waits, listed("카톡").login]).toEqual(["login", undefined]);
});

test("a provider's login stop that ended has no login id", () => {
	post(`땃쥐: ${blockText("auth", "openai-codex", "openai-codex", 1_800_000)}`);
	expect(listed("openai-codex").login).toBe("openai-codex");
	post(`땃쥐: ${recoveryText()}`);
	expect(listed("openai-codex").login).toBeUndefined();
});
