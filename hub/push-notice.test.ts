// Which bell notices become a phone notification (once per matter), and when a notification is held back because it is already on screen.
import { expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAME } from "./config.ts";
import { emit } from "./events.ts";
import { type Notice, onNoticeUnread } from "./notices.ts";
import { classify, convOfUrl, decisionPush, noticePush, presenceQuiets, pushRoute, resetPushDedupeForTest, shouldNotify } from "./push.ts";
import { b64u } from "./webpush.ts";
import { diskReader, HANGUL, resolveView, setWebView, webView } from "./web-i18n.ts";

const notice = (n: Partial<Notice>): Notice => ({ id: "n1", ts: "2026-11-01T00:00:00Z", updated: "2026-11-01T00:00:00Z", kind: "message", tone: "", title: "제목", text: "본문", open: "main", at: "2026-11-01T00:00:00Z", read: false, ...n });

test("a notification names the place its message lives in", () => {
	const t = "2026-11-01T00:00:00Z";
	expect(noticePush(notice({ kind: "watch", title: "메일", open: "mail:abc", at: t }))).toMatchObject({ url: "/?m=2026-11-01T00%3A00%3A00Z&i=n1#chat/mail:abc", ts: t, nid: "n1" });
	expect(classify({ ts: t, kind: "out", source: "gateway", target: "alert", text: "[fail] 게이트웨이 오류" })).toMatchObject({ url: "/?m=2026-11-01T00%3A00%3A00Z#chat/alert", ts: t });
	const dec = (to: string) => notice({ kind: "decision", tone: "ask", at: t, decision: { options: [], to, group: 1, state: "open" } });
	expect(decisionPush(dec("alert")).url).toBe("/?m=2026-11-01T00%3A00%3A00Z&n=n1#chat/alert");
	expect(decisionPush(dec("mail:abc")).url).toBe("/?m=2026-11-01T00%3A00%3A00Z&n=n1#chat/mail:abc");
	expect(decisionPush(dec("auth:1")).url).toBe("/?m=2026-11-01T00%3A00%3A00Z&n=n1#chat/main");
});

test("results, monitoring news, alerts and unread answers notify; progress, questions (decisionPush) and read items do not", () => {
	expect(noticePush(notice({ kind: "result", tone: "done", title: "ui-pwa", open: "lane:ui-pwa", key: "lane:ui-pwa", text: "[done] 배포 끝" }))).toMatchObject({ kind: "result", title: "ui-pwa · 완료", url: "/?m=2026-11-01T00%3A00%3A00Z&i=n1#chat/lane:ui-pwa", tag: "lane:ui-pwa", ts: "2026-11-01T00:00:00Z" });
	expect(noticePush(notice({ kind: "result", tone: "fail", title: "ui-pwa", open: "lane:ui-pwa" }))).toMatchObject({ title: "ui-pwa · 실패" });
	expect(noticePush(notice({ kind: "watch", title: "메일", open: "alert", watch: "mail-new", text: "새 메일 2통" }))).toMatchObject({ kind: "news", title: "메일 · 새 소식", body: "새 메일 2통", url: "/?m=2026-11-01T00%3A00%3A00Z&i=n1#chat/alert", tag: "watch:mail-new" });
	expect(noticePush(notice({ kind: "watch", title: "예약", open: "ch:123", text: "3시 회의" }))).toMatchObject({ kind: "news", url: "/?m=2026-11-01T00%3A00%3A00Z&i=n1#chat/ch:123", tag: "watch:n1" });
	expect(noticePush(notice({ kind: "message", title: NAME, open: "main", text: "보고서 정리했어요" }))).toMatchObject({ kind: "conv", title: `${NAME} · 새 메시지`, url: "/?m=2026-11-01T00%3A00%3A00Z&i=n1#chat/main", tag: "answer" });
	expect(noticePush(notice({ kind: "message", title: "프로젝트", open: "ch:9" }))).toMatchObject({ tag: "answer:ch:9", url: "/?m=2026-11-01T00%3A00%3A00Z&i=n1#chat/ch:9" });
	expect(noticePush(notice({ kind: "alert", tone: "", title: "알림", open: "alert", text: "모델 제공자 오류(timeout)" }))).toMatchObject({ kind: "alert", title: `${NAME} · 경고`, tag: expect.stringMatching(/^alert:[0-9a-f]{12}$/) });
	expect(noticePush(notice({ kind: "alert", tone: "", title: "새 버전", open: "settings", key: "self-update" }))).toMatchObject({ kind: "news", url: "/?m=2026-11-01T00%3A00%3A00Z&i=n1#settings", tag: "update" });
	expect(noticePush(notice({ kind: "worklog", tone: "fail", title: "작업 기록", open: "worklog" }))).toMatchObject({ kind: "alert", title: "작업 기록 · 실패" });
	// a finished work log entry is a result too (notice class result)
	expect(noticePush(notice({ kind: "worklog", tone: "done", title: "작업 기록", open: "worklog" }))).toMatchObject({ kind: "result", title: "작업 기록 · 완료" });
	// no notification
	expect(noticePush(notice({ kind: "result", tone: "run", open: "lane:x" }))).toBeUndefined();
	expect(noticePush(notice({ kind: "worklog", tone: "run" }))).toBeUndefined();
	expect(noticePush(notice({ kind: "alert", text: "토큰 누수 점검 (10-19): 경고 3건" }))).toBeUndefined();
	expect(noticePush(notice({ kind: "result", tone: "ask", open: "lane:x" }))).toBeUndefined();
	expect(noticePush(notice({ kind: "decision", tone: "ask", decision: { options: [], to: "main", group: 1, state: "open" } }))).toBeUndefined();
	expect(noticePush(notice({ kind: "watch", read: true }))).toBeUndefined();
	expect(noticePush(notice({ kind: "watch", dismissed: true }))).toBeUndefined();
});

test("one matter is one notification: the same tag again within the window, or a conversation on screen, is not sent", () => {
	resetPushDedupeForTest();
	const t = Date.parse("2026-11-01T00:00:00Z"), none = () => false;
	const m = { kind: "result" as const, tag: "lane:x", body: "끝", url: "/#chat/lane:x" };
	expect(shouldNotify(m, t, none)).toBe(true);
	expect(shouldNotify({ ...m, body: "다른 말로 끝" }, t + 1000, none)).toBe(false);   // the event and its bell notice
	expect(shouldNotify({ ...m, tag: "lane:y", url: "/#chat/lane:y" }, t + 1000, none)).toBe(true);
	expect(shouldNotify({ ...m, body: "다음 일도 끝" }, t + 3 * 60_000, none)).toBe(true);
	expect(shouldNotify({ ...m, tag: "answer", url: "/#chat/main" }, t, conv => conv === "main")).toBe(false);
	expect(shouldNotify({ kind: "test", tag: "test", body: "", url: "/#chat/main" }, t, () => true)).toBe(true);
	resetPushDedupeForTest();
});

test("an answer in a monitor's or a project's own conversation is one phone push (event and bell notice share the tag), none while that conversation is on screen", () => {
	const t = Date.parse("2026-11-11T00:00:00Z"), at = new Date(t).toISOString();
	for (const conv of ["settings:w:harness-failures", "ch:4242"]) {
		resetPushDedupeForTest();
		const byEvent = classify({ ts: at, kind: "out", source: "orchestrator", target: conv, text: "[done] 끝났어요" }, 5 * 60_000);
		const byNotice = noticePush(notice({ kind: "message", open: conv, text: "[done] 끝났어요" }));
		expect(byEvent?.tag).toBe(`answer:${conv}`);
		expect(byNotice?.tag).toBe(byEvent?.tag);
		expect([shouldNotify(byEvent!, t, () => false), shouldNotify(byNotice!, t + 1, () => false)]).toEqual([true, false]);
		resetPushDedupeForTest();
		expect(shouldNotify(byNotice!, t, c => c === conv)).toBe(false);
		expect(noticePush(notice({ kind: "message", open: conv, read: true }))).toBeUndefined();
	}
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
	expect(noticePush(mine[0]!)).toMatchObject({ kind: "result", tag: `lane:${lane}` });
});

test("monitor reports folded into one row each still notify, and a repeated alert stays quiet", () => {
	resetPushDedupeForTest();
	const pushed: NonNullable<ReturnType<typeof noticePush>>[] = [];
	onNoticeUnread(n => {
		const m = noticePush(n);
		if (m && n.open === "ch:9701") pushed.push(m);
	});
	const base = Date.now() - 3_600_000;
	// the row is unread from the first report on: the next two fold into it without it ever being read
	for (let i = 0; i < 3; i++) emit("outbox", { ts: new Date(base + i * 60_000).toISOString(), kind: "out", source: "gateway", target: "ch:9701", text: `[감시9701] 새 글 ${i}번` });
	expect(pushed.map(m => m.body)).toEqual(["새 글 0번", "새 글 1번", "새 글 2번"]);
	expect(new Set(pushed.map(m => m.tag)).size).toBe(3);
	const t = Date.now();
	resetPushDedupeForTest();   // when another file wired the real push, those emits already went through shouldNotify
	expect(pushed.map(m => shouldNotify(m, t, () => false, () => true))).toEqual([true, true, true]);
	// a repeated alert updates its row and is not pushed again (hub/alert-gate.ts)
	const alerts: unknown[] = [];
	onNoticeUnread(n => n.kind === "alert" && n.text.includes("9702") && alerts.push(noticePush(n)));
	emit("outbox", { ts: new Date(base).toISOString(), kind: "out", source: "gateway", target: "alert", text: "땃쥐: 모델 제공자 오류 9702 (1)" });
	emit("outbox", { ts: new Date(base + 1000).toISOString(), kind: "out", source: "gateway", target: "alert", text: "땃쥐: 모델 제공자 오류 9702 (2)", repeat: true });
	expect(alerts).toHaveLength(1);
	resetPushDedupeForTest();
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
	expect(pushSuppressed([win("#notices")], "/#chat/alert", O)).toBe(true);
	expect(pushSuppressed([win("#notices")], "/#chat/main", O)).toBe(false);
	expect(pushSuppressed([win("#chat/main", "hidden")], "/#chat/main", O)).toBe(false);
	expect(pushSuppressed([win("#chat/main", "visible", false)], "/#chat/main", O)).toBe(false);
	expect(pushSuppressed([win("#home")], "/#home", O)).toBe(false);
	expect(pushSuppressed([], "/#chat/main", O)).toBe(false);
	expect(pushSuppressed([{ url: "https://other:1/#chat/main", visibilityState: "visible", focused: true }], "/#chat/main", O)).toBe(false);
});

test("a failed session or work log entry is a warning, pushed under the alert switch while results are off; a finished one stays a result", () => {
	resetPushDedupeForTest();
	const t = Date.parse("2026-11-19T00:00:00Z"), none = () => false, resultsOff = (cls: string) => cls !== "result";
	const sessionFail = noticePush(notice({ kind: "result", tone: "fail", title: "ui-pwa", open: "lane:ui-pwa", key: "lane:ui-pwa", text: "테스트 실패" }))!;
	const worklogFail = noticePush(notice({ kind: "worklog", tone: "fail", title: "작업 기록", open: "worklog", text: "야간 정리 실패" }))!;
	const reportFail = classify({ ts: "2026-11-19T00:00:00Z", kind: "lane_report", source: "lane:nc3", lane: "nc3", text: "[fail] 빌드가 깨졌어요" })!;
	const sessionDone = noticePush(notice({ kind: "result", tone: "done", title: "ui-done", open: "lane:ui-done", key: "lane:ui-done", text: "끝" }))!;
	expect([sessionFail.kind, worklogFail.kind, reportFail.kind, sessionDone.kind]).toEqual(["alert", "alert", "alert", "result"]);
	expect([sessionFail, worklogFail, reportFail, sessionDone].map(m => shouldNotify(m, t, none, resultsOff))).toEqual([true, true, true, false]);
	resetPushDedupeForTest();
});

test("two different alerts within two minutes both notify, each under its own tag; the same alert again keeps its tag", () => {
	resetPushDedupeForTest();
	const t = Date.parse("2026-11-19T00:00:00Z"), none = () => false, on = () => true;
	const first = classify({ ts: "2026-11-19T00:00:00Z", kind: "out", source: "gateway", target: "alert", text: "땃쥐: 모델 제공자 오류(timeout) 1회" })!;
	const second = classify({ ts: "2026-11-19T00:01:00Z", kind: "out", source: "gateway", target: "alert", text: "땃쥐: 디스크 남은 공간 3GB" })!;
	const again = noticePush(notice({ kind: "alert", open: "alert", text: "땃쥐: 모델 제공자 오류(timeout) 4회" }))!;
	expect([first.kind, second.kind]).toEqual(["alert", "alert"]);
	expect(second.tag).not.toBe(first.tag);
	expect(again.tag).toBe(first.tag);
	expect([shouldNotify(first, t, none, on), shouldNotify(second, t + 60_000, none, on), shouldNotify(again, t + 90_000, none, on)]).toEqual([true, true, false]);
	resetPushDedupeForTest();
});

test("push titles are in the install's language: an English install gets no Korean word in any of them", () => {
	const prev = webView();
	setWebView(() => resolveView("en", diskReader()));
	try {
		const ev = (e: Record<string, unknown>) => classify({ ts: "2026-11-19T00:00:00Z", kind: "out", source: "orchestrator", text: "", ...e }, 5 * 60_000)!;
		const dec = notice({ kind: "decision", tone: "ask", decision: { options: [], to: "main", group: 1, state: "open" } });
		const titles = [
			ev({ source: "gateway", target: "alert", text: "dotz: provider error" }).title,
			ev({ target: "web", text: "[ask] which one?" }).title,
			ev({ target: "web", text: "[done] shipped" }).title,
			ev({ target: "web", text: "[fail] broke" }).title,
			ev({ source: "lane:en-x", target: "lane:en-x", text: "[ask] merge?" }).title.replace(/^.* · /, "lane · "),
			noticePush(notice({ kind: "watch", title: "Kim", open: "mail:en1", key: "mail:en1", text: "Quote" }))!.title,
			noticePush(notice({ kind: "watch", title: "Feed", open: "ch:771", text: "new post" }))!.title,
			noticePush(notice({ kind: "message", title: "Proj", open: "ch:772", text: "hi" }))!.title,
			noticePush(notice({ kind: "result", tone: "done", title: "ui", open: "lane:ui", key: "lane:ui" }))!.title,
			noticePush(notice({ kind: "result", tone: "fail", title: "ui", open: "lane:ui", key: "lane:ui" }))!.title,
			noticePush(notice({ kind: "alert", tone: "", title: "x", open: "settings", key: "self-update", text: "1.2.3" }))!.title,
			decisionPush(dec).title,
		];
		expect(titles.filter(s => HANGUL.test(s.replace(NAME, "")))).toEqual([]);
		expect(titles).toEqual([`${NAME} · Alert`, `${NAME} · Needs a look`, `${NAME} · Done`, `${NAME} · Failed`, "lane · Question", "Kim · New mail", "Feed · News", "Proj · New message", "ui · Done", "ui · Failed", `${NAME} · New version`, "Needs your answer"]);
	} finally {
		setWebView(prev ? () => prev : undefined);
	}
});

test("a push title is at most 80 characters with the sender's name in it, and keeps what happened at its end", () => {
	for (const name of ["", "ui", "가".repeat(79), "가".repeat(1500), "x".repeat(4000), "👩‍💻 세션 \"quoted\" $(rm -rf)".repeat(30)]) {
		const title = noticePush(notice({ kind: "result", tone: "done", title: name, open: "lane:cap", key: "lane:cap" }))!.title;
		expect(title.length).toBeLessThanOrEqual(80);
		expect(title.endsWith(" · 완료")).toBe(true);
		if (`${name} · 완료`.length <= 80) expect(title).toBe(`${name} · 완료`);
	}
});
