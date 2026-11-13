import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { emit } from "./events.ts";
import { type Notice, readConversationNotices, resetNoticesForTest, setViewing } from "./notices.ts";
import { markRead } from "./reads.ts";

const stored = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));
const post = (text: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web:quick", text });
const mine = () => stored().find(n => n.key === "msg:quick")!;

beforeEach(resetNoticesForTest);

test("the quick chat's unread answer is read by its read position, like any conversation's", () => {
	post("가벼운 대화의 답이에요");
	expect(mine()).toMatchObject({ kind: "message", src: "quick", read: false });
	const r = markRead({ target: "quick", ts: mine().at! });
	expect(r.ok).toBe(true);
	if (r.ok) readConversationNotices(r.target, r.ts, "viewed");
	expect(mine().read).toBe(true);
});

test("viewing the quick chat reads its unread answer, and an answer that comes while it is viewed makes no unread item", () => {
	post("보기 전에 온 답이에요");
	expect(mine().read).toBe(false);
	expect(setViewing("tab-quick", "quick", Date.now())).toMatchObject({ ok: true });
	expect(mine().read).toBe(true);
	post("보는 중에 온 답이에요");
	expect(mine()).toMatchObject({ text: "보기 전에 온 답이에요", read: true });
	setViewing("tab-quick", "", Date.now());
});
