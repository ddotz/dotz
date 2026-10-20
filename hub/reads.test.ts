import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { paths } from "./config.ts";
import { conversationList, unreadOf } from "./conversations.ts";
import { emit, eventTarget, lastEventId, replayAfter } from "./events.ts";
import { markRead, readOf } from "./reads.ts";

const item = (target: string) => conversationList().find(c => c.target === target);
const out = (target: string, ts: string, extra: object = {}) => emit("outbox", { ts, kind: "out", source: "orchestrator", target, text: "답이에요", ...extra });

test("a read position only moves forward, is validated, persisted and broadcast", () => {
	const before = lastEventId();
	expect(markRead({ target: "ch:501", ts: "2026-10-20T10:00:00.000Z" })).toEqual({ ok: true, target: "ch:501", ts: "2026-10-20T10:00:00.000Z", moved: true });
	expect(markRead({ target: "ch:501", ts: "2026-10-20T09:00:00.000Z" })).toEqual({ ok: true, target: "ch:501", ts: "2026-10-20T10:00:00.000Z", moved: false });
	expect(markRead({ target: "ch:501", ts: "2026-10-20T10:00:00.000Z" }).ok && readOf("ch:501")).toBe("2026-10-20T10:00:00.000Z");
	expect(markRead({ target: "ch:501", ts: "2026-10-20T11:30:00.000Z" })).toMatchObject({ ok: true, moved: true });
	expect(readOf("ch:501")).toBe("2026-10-20T11:30:00.000Z");
	expect(markRead({ target: "nope", ts: "2026-10-20T10:00:00.000Z" }).ok).toBe(false);
	expect(markRead({ target: "ch:501", ts: "not a time" }).ok).toBe(false);
	expect(markRead({ target: "ch:501" }).ok).toBe(false);
	expect(readOf("ch:999")).toBeNull();

	expect(JSON.parse(readFileSync(paths.reads, "utf8"))["ch:501"]).toBe("2026-10-20T11:30:00.000Z");
	const frames = (replayAfter(before) ?? []).map(f => JSON.parse(f.split("data: ")[1]));
	expect(frames.filter(f => f.kind === "read")).toEqual([
		expect.objectContaining({ target: "ch:501", ts: "2026-10-20T10:00:00.000Z" }),
		expect.objectContaining({ target: "ch:501", ts: "2026-10-20T11:30:00.000Z" }),
	]);
});

test("positions survive a restart (reads.json is loaded again)", async () => {
	markRead({ target: "lane:persist-a", ts: "2026-10-20T12:00:00.000Z" });
	const fresh = (await import("./reads.ts?restart")) as typeof import("./reads.ts");
	expect(fresh.readOf("lane:persist-a")).toBe("2026-10-20T12:00:00.000Z");
});

test("unread counts real messages after the read position; the owner's own, progress, delivery and notices never count", () => {
	const t = "ch:502";
	emit("inbox", { ts: "2099-10-20T13:00:00.000Z", kind: "message", source: "web", channel: t, text: "내가 보낸 말" });
	out(t, "2099-10-20T13:01:00.000Z");
	out(t, "2099-10-20T13:02:00.000Z", { text: "진행 중: 읽는 중", update_key: "p" });
	emit("outbox", { ts: "2099-10-20T13:03:00.000Z", kind: "delivery", source: "gateway", target: t, ref: "m1", state: "answered", text: "" });
	emit("outbox", { ts: "2099-10-20T13:04:00.000Z", kind: "notice", source: "gateway", target: t, text: "알림" });
	out(t, "2099-10-20T13:05:00.000Z", { text: "두 번째 답" });
	expect(item(t)).toMatchObject({ read: null, unread: 2 });

	markRead({ target: t, ts: "2099-10-20T13:01:00.000Z" });
	expect(item(t)).toMatchObject({ read: "2099-10-20T13:01:00.000Z", unread: 1 });

	emit("inbox", { ts: "2099-10-20T13:06:00.000Z", kind: "message", source: "web", channel: t, text: "또 보냄" });
	expect(unreadOf(t)).toBe(1);
	out(t, "2099-10-20T13:07:00.000Z", { text: "세 번째 답" });
	expect(unreadOf(t)).toBe(2);

	markRead({ target: t, ts: "2099-10-20T13:07:00.000Z" });
	expect(unreadOf(t)).toBe(0);
});

test("a clean gateway restart note and an event replayed twice are not counted extra", () => {
	const t = "ch:503";
	markRead({ target: t, ts: "2026-10-20T14:00:00.000Z" });
	emit("outbox", { ts: "2026-10-20T14:01:00.000Z", kind: "out", source: "gateway", target: t, text: "게이트웨이 재시작했어요. 끊긴 작업은 없어요." });
	expect(unreadOf(t)).toBe(0);
	const e = { ts: "2026-10-20T14:02:00.000Z", kind: "out", source: "orchestrator", target: t, text: "한 번만 세요" };
	emit("outbox", e);
	emit("outbox", e);
	expect(unreadOf(t)).toBe(1);
});

test("a read frame belongs to no conversation", () => {
	expect(eventTarget({ ts: "2026-10-20T15:00:00.000Z", kind: "read", source: "gateway", text: "", target: "ch:11" })).toBeUndefined();
});

test("on the first run every message said before it counts as read (no reads.json yet: a baseline, never a target)", () => {
	const t = "ch:504";
	emit("outbox", { ts: "2000-01-01T00:00:00.000Z", kind: "out", source: "orchestrator", target: t, text: "아주 옛날 답" });
	expect(item(t)).toMatchObject({ read: null, unread: 0 });
	expect(JSON.parse(readFileSync(paths.reads, "utf8"))._since).toBeTruthy();
	expect(markRead({ target: "_since", ts: "2099-01-01T00:00:00.000Z" }).ok).toBe(false);
});
