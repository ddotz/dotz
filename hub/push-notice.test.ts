// Which bell notices become a phone notification (once per matter), and when a notification is held back because it is already on screen.
import { expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAME } from "./config.ts";
import { emit } from "./events.ts";
import { type Notice, onNoticeUnread } from "./notices.ts";
import { convOfUrl, noticePush, presenceQuiets, pushRoute, resetPushDedupeForTest, shouldNotify } from "./push.ts";
import { b64u } from "./webpush.ts";

const notice = (n: Partial<Notice>): Notice => ({ id: "n1", ts: "2026-11-01T00:00:00Z", updated: "2026-11-01T00:00:00Z", kind: "message", tone: "", title: "제목", text: "본문", open: "main", at: "2026-11-01T00:00:00Z", read: false, ...n });

test("results, monitoring news, alerts and unread answers notify; progress, questions (decisionPush) and read items do not", () => {
	expect(noticePush(notice({ kind: "result", tone: "done", title: "ui-pwa", open: "lane:ui-pwa", key: "lane:ui-pwa", text: "[done] 배포 끝" }))).toMatchObject({ kind: "lane", title: "ui-pwa · 완료", url: "/#chat/lane:ui-pwa", tag: "lane:ui-pwa", ts: "2026-11-01T00:00:00Z" });
	expect(noticePush(notice({ kind: "result", tone: "fail", title: "ui-pwa", open: "lane:ui-pwa" }))).toMatchObject({ title: "ui-pwa · 실패" });
	expect(noticePush(notice({ kind: "watch", title: "메일", open: "alert", watch: "mail-new", text: "새 메일 2통" }))).toMatchObject({ kind: "watch", title: "메일 · 새 소식", body: "새 메일 2통", url: "/#chat/alert", tag: "watch:mail-new" });
	expect(noticePush(notice({ kind: "watch", title: "예약", open: "ch:123", text: "3시 회의" }))).toMatchObject({ kind: "watch", url: "/#chat/ch:123", tag: "watch:n1" });
	expect(noticePush(notice({ kind: "message", title: NAME, open: "main", text: "보고서 정리했어요" }))).toMatchObject({ kind: "answer", title: `${NAME} · 새 메시지`, url: "/#chat/main", tag: "answer" });
	expect(noticePush(notice({ kind: "message", title: "프로젝트", open: "ch:9" }))).toMatchObject({ tag: "answer:ch:9", url: "/#chat/ch:9" });
	expect(noticePush(notice({ kind: "alert", tone: "", title: "알림", open: "alert", text: "모델 제공자 오류(timeout)" }))).toMatchObject({ kind: "usage", title: `${NAME} · 경고`, tag: "alert" });
	expect(noticePush(notice({ kind: "alert", tone: "", title: "새 버전", open: "settings", key: "self-update" }))).toMatchObject({ kind: "update", url: "/#settings", tag: "update" });
	expect(noticePush(notice({ kind: "worklog", tone: "fail", title: "작업 기록", open: "worklog" }))).toMatchObject({ kind: "usage", title: "작업 기록 · 실패" });
	// no notification
	expect(noticePush(notice({ kind: "result", tone: "run", open: "lane:x" }))).toBeUndefined();
	expect(noticePush(notice({ kind: "worklog", tone: "done" }))).toBeUndefined();
	expect(noticePush(notice({ kind: "alert", text: "토큰 누수 점검 (10-19): 경고 3건" }))).toBeUndefined();
	expect(noticePush(notice({ kind: "result", tone: "ask", open: "lane:x" }))).toBeUndefined();
	expect(noticePush(notice({ kind: "decision", tone: "ask", decision: { options: [], to: "main", group: 1, state: "open" } }))).toBeUndefined();
	expect(noticePush(notice({ kind: "watch", read: true }))).toBeUndefined();
	expect(noticePush(notice({ kind: "watch", dismissed: true }))).toBeUndefined();
});

test("one matter is one notification: the same tag again within the window, or a conversation on screen, is not sent", () => {
	resetPushDedupeForTest();
	const t = Date.parse("2026-11-01T00:00:00Z"), none = () => false;
	const m = { kind: "lane" as const, tag: "lane:x", body: "끝", url: "/#chat/lane:x" };
	expect(shouldNotify(m, t, none)).toBe(true);
	expect(shouldNotify({ ...m, body: "다른 말로 끝" }, t + 1000, none)).toBe(false);   // the event and its bell notice
	expect(shouldNotify({ ...m, tag: "lane:y", url: "/#chat/lane:y" }, t + 1000, none)).toBe(true);
	expect(shouldNotify({ ...m, body: "다음 일도 끝" }, t + 3 * 60_000, none)).toBe(true);
	expect(shouldNotify({ ...m, tag: "answer", url: "/#chat/main" }, t, conv => conv === "main")).toBe(false);
	expect(shouldNotify({ kind: "test", tag: "test", body: "", url: "/#chat/main" }, t, () => true)).toBe(true);
	resetPushDedupeForTest();
});

test("a focused page quiets only the conversation it shows; an older or relayed presence quiets everything", () => {
	const t = 1_000_000;
	expect(convOfUrl("/#chat/lane:ui-pwa")).toBe("lane:ui-pwa");
	expect(convOfUrl("/#home")).toBeUndefined();
	expect(presenceQuiets({ at: t, conv: "main" }, "/#chat/main", t)).toBe(true);
	expect(presenceQuiets({ at: t, conv: "main" }, "/#chat/lane:x", t)).toBe(false);
	expect(presenceQuiets({ at: t, conv: "" }, "/#chat/main", t)).toBe(false);
	expect(presenceQuiets({ at: t }, "/#home", t)).toBe(true);
	expect(presenceQuiets({ at: t - 61_000, conv: "main" }, "/#chat/main", t)).toBe(false);
	expect(presenceQuiets(undefined, "/#chat/main", t)).toBe(false);
});

test("a notice notifies when it becomes unread, not again while it stays unread", () => {
	const fired: Notice[] = [];
	onNoticeUnread(n => fired.push(n));
	const lane = `pn-${Date.now().toString(36)}`;
	emit("inbox", { ts: new Date().toISOString(), kind: "lane_report", source: `lane:${lane}`, lane, text: "[done] 첫 결과" });
	emit("inbox", { ts: new Date(Date.now() + 1).toISOString(), kind: "lane_report", source: `lane:${lane}`, lane, text: "[done] 같은 일 다시 보고" });
	emit("inbox", { ts: new Date(Date.now() + 2).toISOString(), kind: "lane_report", source: `lane:${lane}`, lane, text: "[run] 진행 중" });
	const mine = fired.filter(n => n.open === `lane:${lane}`);
	expect(mine).toHaveLength(1);
	expect(noticePush(mine[0]!)).toMatchObject({ kind: "lane", tag: `lane:${lane}` });
});

test("a dead app subscription (410) also ends the app's role, so the device's browser may subscribe again", async () => {
	const call = (path: string, method: string, body?: unknown) => pushRoute(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://x${path}`));
	const key = () => {
		const ua = createECDH("prime256v1");
		ua.generateKeys();
		return { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 7)) };
	};
	const did = `dead-app-${Date.now().toString(36)}`;
	const app = "https://push.example.net/dead-app";
	expect((await call("/api/push/subscribe", "POST", { subscription: { endpoint: app, keys: key() }, app: true, did }))!.status).toBe(200);
	expect((await call("/api/push/subscribe", "POST", { subscription: { endpoint: "https://push.example.net/browser-early", keys: key() }, did }))!.status).toBe(409);
	const real = globalThis.fetch;
	globalThis.fetch = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
	try {
		expect((await call("/api/push/test", "POST", { endpoint: app }))!.status).toBe(502);
	} finally {
		globalThis.fetch = real;
	}
	const browser = "https://push.example.net/browser-late";
	expect((await call("/api/push/subscribe", "POST", { subscription: { endpoint: browser, keys: key() }, did }))!.status).toBe(200);
	await call("/api/push/unsubscribe", "POST", { endpoint: browser });
});

// web/sw.js pushSuppressed, run as is.
const sw = readFileSync(join(import.meta.dir, "..", "web", "sw.js"), "utf8");
const pushSuppressed = new Function(`${sw.slice(sw.indexOf("function pushSuppressed"), sw.indexOf('self.addEventListener("push"'))}\nreturn pushSuppressed;`)() as (wins: Array<{ url: string; visibilityState: string; focused: boolean }>, url: string, origin: string) => boolean;

test("the service worker holds back a notification only for the conversation a focused, visible window shows", () => {
	const O = "https://mac:8443";
	const win = (hash: string, visibilityState = "visible", focused = true) => ({ url: `${O}/${hash}`, visibilityState, focused });
	expect(pushSuppressed([win("#chat/main")], "/#chat/main", O)).toBe(true);
	expect(pushSuppressed([win("#chat/lane:x")], "/#chat/lane:x", O)).toBe(true);
	expect(pushSuppressed([win("#chat/main")], "/#chat/lane:x", O)).toBe(false);
	expect(pushSuppressed([win("#chat/main", "hidden")], "/#chat/main", O)).toBe(false);
	expect(pushSuppressed([win("#chat/main", "visible", false)], "/#chat/main", O)).toBe(false);
	expect(pushSuppressed([win("#home")], "/#home", O)).toBe(false);
	expect(pushSuppressed([], "/#chat/main", O)).toBe(false);
	expect(pushSuppressed([{ url: "https://other:1/#chat/main", visibilityState: "visible", focused: true }], "/#chat/main", O)).toBe(false);
});
