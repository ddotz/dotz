import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, decisionPush, noticePush, relayedMessage } from "./push.ts";
import { fakeHub, idleState, inbox, json, on, type View } from "./test-web.ts";
import type { Notice } from "./notices.ts";

// Every kind of push x every situation the owner can be in when tapping it: the worker (web/sw.js, run as shipped) decides between handing the tap
// to an open window and opening the address; the real page then has to end on the item itself (the message in view and highlighted, or the card open).
const ts = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, 0, i)).toISOString();
const says = (i: number) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` });
const MAIN = Array.from({ length: 420 }, (_, i) => says(i));
const ANS_AT = ts(300), OLD_ANS_AT = ts(120), EV_AT = ts(310), ASK_AT = ts(410), LANE_AT = ts(500), MAIL_AT = ts(501), ALERT_AT = ts(502), WORK_AT = ts(503), LASK_AT = ts(504), PROJ_AT = ts(505), SET_AT = ts(506), WORK2_AT = ts(507);
const LANE = [
	{ ts: ts(499), kind: "lane_report", lane: "a", source: "lane:a", text: "[run] 하는 중" },
	{ ts: LANE_AT, kind: "lane_report", lane: "a", source: "lane:a", text: "[done] 빌드 끝났어요" },
	{ ts: LASK_AT, kind: "lane_report", lane: "a", source: "lane:a", text: "[ask] 배포할까요?" },
];
const MAIL = [{ ts: MAIL_AT, kind: "mail", incoming: true, source: "zele", channel: "mail:abc", conv: "mail:abc", mail: "abc", subject: "견적서", from: "김철수", text: "견적서 보내요" }];
const ALERTS = [{ ts: ALERT_AT, kind: "out", source: "gateway", target: "alert", text: "[fail] 게이트웨이 오류" }];
const WORKLOG = [
	{ ts: WORK_AT, kind: "out", source: "orchestrator", target: "worklog", text: "[done] 정리를 마쳤어요" },
	{ ts: WORK2_AT, kind: "out", source: "lane:a", target: "worklog", update_key: "lane:a", text: "[done] 빌드 정리를 마쳤어요" },
];
const PROJ = [{ ts: PROJ_AT, kind: "out", source: "orchestrator", target: "ch:1", text: "[done] 프로젝트 일을 마쳤어요" }];
const SETTINGS = [{ ts: SET_AT, kind: "out", source: "orchestrator", target: "settings:disk", text: "[done] 감시 설정을 바꿨어요" }];
// A project thread with 1800 messages; the pushed one is far enough back that paging older messages (web/js/30-notices.js ntReach) does not reach it.
const LONG_AT = ts(100);
const LONG = Array.from({ length: 1800 }, (_, i) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "ch:2", text: `긴 대화 ${i}번이에요.` }));
const base = { read: false, tone: "", text: "내용" };
const decision = { options: [{ n: 1, label: "네" }, { n: 2, label: "아니요" }], to: "main", reply_to: ASK_AT, group: 1, state: "open" };
const report = (i: number) => ({ ...base, id: `w${i}`, kind: "watch", cls: "news", title: "디스크 감시", text: `사용량 ${i}%`, open: "alert", src: "alert", watch: "disk", ts: ts(200 + i), updated: ts(200 + i), at: ts(200 + i) });
const notices = [
	{ ...base, id: "ans", kind: "message", cls: "conv", title: "땃쥐", open: "main", src: "main", ts: ANS_AT, updated: ANS_AT, at: ANS_AT },
	{ ...base, id: "oldans", kind: "message", cls: "conv", title: "땃쥐", open: "main", src: "main", ts: OLD_ANS_AT, updated: OLD_ANS_AT, at: OLD_ANS_AT },
	{ ...base, id: "rep", kind: "result", tone: "done", cls: "result", title: "빌드 세션", open: "lane:a", src: "lane:a", key: "lane:a", ts: LANE_AT, updated: LANE_AT, at: LANE_AT },
	{ ...base, id: "dec", kind: "decision", tone: "ask", cls: "ask", title: "배포할까요?", open: "main", src: "main", ts: ASK_AT, updated: ASK_AT, at: ASK_AT, decision },
	{ ...base, id: "ml", kind: "watch", cls: "news", title: "김철수", text: "견적서", open: "mail:abc", src: "mail:abc", key: "mail:abc", ts: MAIL_AT, updated: MAIL_AT, at: MAIL_AT },
	{ ...base, id: "al", kind: "alert", tone: "fail", cls: "alert", title: "게이트웨이 오류", open: "alert", src: "alert", ts: ALERT_AT, updated: ALERT_AT, at: ALERT_AT },
	{ ...base, id: "wl", kind: "worklog", tone: "done", cls: "result", title: "작업 기록", open: "worklog", src: "worklog", key: "worklog:1", ts: WORK_AT, updated: WORK_AT, at: WORK_AT },
	{ ...base, id: "wls", kind: "result", tone: "done", cls: "result", title: "빌드 세션", open: "lane:a", src: "lane:a", key: "lane:a", msg: "worklog", ts: WORK2_AT, updated: WORK2_AT, at: WORK2_AT },
	{ ...base, id: "prj", kind: "message", cls: "conv", title: "프로젝트", open: "ch:1", src: "ch:1", ts: PROJ_AT, updated: PROJ_AT, at: PROJ_AT },
	{ ...base, id: "set", kind: "message", cls: "conv", title: "디스크 감시", open: "settings:disk", src: "settings:disk", ts: SET_AT, updated: SET_AT, at: SET_AT },
	...Array.from({ length: 40 }, (_, i) => report(i)),
];
const monitor = { name: "디스크 감시", watch: "disk", kind: "watch", every: "1시간마다", last_result: "ok", last_run: ts(300), next_run: ts(900) };
const lanes = [{ name: "a", title: "빌드 세션", status: "idle", kind: "work" }, { name: "b", title: "다른 세션", status: "idle", kind: "work" }];

// The api of a gateway; `self` and `other` name the computers of /api/peers.
const arrived = inbox<string>();
const held = new Map<string, Promise<void>>();
// Holds the answers of one path back until the returned function is called: the order in which the page's requests are answered is the test's.
const hold = (path: string) => {
	let open!: () => void;
	held.set(path, new Promise<void>(r => (open = r)));
	return () => { held.delete(path); open(); };
};
const api = (peers: () => object[]) => async (_req: Request, url: URL) => {
	arrived.push(url.pathname);
	await held.get(url.pathname);
	if (url.pathname === "/api/history") {
		const t = url.searchParams.get("target"), before = url.searchParams.get("before");
		const all = t === "ch:2" ? LONG : t === "main" ? MAIN : t === "lane:a" ? LANE : t === "mail:abc" ? MAIL : t === "alert" ? ALERTS : t === "worklog" ? WORKLOG : t === "ch:1" ? PROJ : t === "settings:disk" ? SETTINGS : [];
		const around = url.searchParams.get("around");
		if (around) {   // like hub/routes.ts and hub/events.ts historyPage
			const hit = all.findIndex(e => e.ts === around), limit = Number(url.searchParams.get("limit") ?? 150) || 150;
			if (hit < 0) return json({ target: t, events: [] });
			const lo = Math.max(0, hit - (limit >> 1));
			return json({ target: t, events: all.slice(lo, lo + limit), at: all[hit]!.ts, prev: all[lo - 1]?.ts, next: all[lo + limit]?.ts });
		}
		const list = before ? all.filter(e => e.ts < before) : all;
		return json({ target: t, events: list.slice(-Number(url.searchParams.get("limit") ?? 60) || -60) });
	}
	if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
	if (url.pathname === "/api/notices") return json({ unread: notices.length, items: notices });
	if (url.pathname === "/api/monitors") return json({ items: [monitor] });
	if (url.pathname === "/api/peers") return json(peers());
	return undefined;
};
const state = () => ({ ...idleState({ channels: { work: { 1: { name: "프로젝트" }, 2: { name: "긴 대화" } } } }), lanes, notices_unread: notices.length });
let other!: ReturnType<typeof fakeHub>;
const hub = fakeHub({ state, api: api(() => [{ name: "맥북", url: hub.origin, self: true, online: true }, { name: "맥미니", url: other.origin, self: false, online: true }]) });
other = fakeHub({ state, api: api(() => [{ name: "맥미니", url: other.origin, self: true, online: true }, { name: "맥북", url: hub.origin, self: false, online: true }]) });
afterAll(() => { hub.stop(); other.stop(); });
// A test owns the windows it opened: they go back to the pool when it ends (a window of a test that timed out is closed), so a long file does not keep
// hundreds of live pages loaded and none of them reaches the next test.
afterEach(() => { hub.release(); other.release(); });

// web/sw.js as shipped, platform stubbed: a tap on a notification opens a window or hands the message to the open one.
const swOf = (origin: string, wins: unknown[]) => {
	const h: Record<string, (ev: unknown) => void> = {}, shown: { data: unknown }[] = [], opened: string[] = [], timers: (() => void)[] = [];
	const self = {
		addEventListener: (k: string, f: (ev: unknown) => void) => { h[k] = f; },
		clients: { matchAll: async () => wins, openWindow: async (u: string) => { opened.push(u); } },
		registration: { showNotification: async (_t: string, o: { data: unknown }) => { shown.push(o); }, getNotifications: async () => [], pushManager: { getSubscription: async () => null } },
	};
	// The test preload replaces setTimeout with a manual scheduler shared by the whole process: the worker gets its own, which `fire` runs.
	const setTimer = (fn: () => void) => timers.push(fn);
	new Function("self", "location", "caches", "setTimeout", "clearTimeout", readFileSync(join(import.meta.dir, "..", "web", "sw.js"), "utf8"))(self, new URL(origin), { open: async () => ({ put: async () => {} }) }, setTimer, () => {});
	return {
		opened,
		fire: () => void timers.splice(0).forEach(f => f()),
		// `ring` runs once the click is handed to the worker, before the worker is waited for.
		tap: async (msg: object, ring?: () => Promise<void>) => {
			const wait: Promise<unknown>[] = [];
			h.push!({ data: { json: () => msg }, waitUntil: (p: Promise<unknown>) => wait.push(p) });
			await Promise.all(wait);
			const data = shown[shown.length - 1]!.data;
			wait.length = 0;
			h.notificationclick!({ notification: { close: () => {}, data }, action: "", waitUntil: (p: Promise<unknown>) => wait.push(p) });
			await ring?.();
			await Promise.all(wait);
		},
	};
};
const noticeOf = (id: string) => notices.find(n => n.id === id) as unknown as Notice;
const pushOf = (id: string) => noticePush(noticeOf(id))!;
const event = (e: object) => classify({ kind: "out", source: "orchestrator", target: "web", ...e } as never)!;

type Spec = { conv?: string; at?: string; nid?: string; sheet?: "ns" | "fs"; hash?: string; push: object };
// What each push is about, and where the owner must end up. `conv`: the conversation the highlighted message is in.
const KINDS: Record<string, Spec> = {
	"answer (notice)": { push: pushOf("ans"), conv: "main", at: ANS_AT },
	"answer (event, no notice id)": { push: event({ ts: EV_AT, text: "[done] 끝났어요" }), conv: "main", at: EV_AT },
	"answer older than the loaded page": { push: pushOf("oldans"), conv: "main", at: OLD_ANS_AT },
	"question": { push: decisionPush(noticeOf("dec")), conv: "main", at: ASK_AT, sheet: "ns" },
	"questions of one app (group)": { push: { kind: "ask", title: "답변이 필요해요", body: "메일 답장 확인 3건", url: "/#home", tag: "decision-group:mail", ts: ASK_AT, id: "dec" }, conv: "main", at: ASK_AT, sheet: "ns" },
	"session done": { push: pushOf("rep"), conv: "lane:a", at: LANE_AT },
	"session question": { push: event({ lane: "a", kind: "lane_report", source: "lane:a", ts: LASK_AT, text: "[ask] 배포할까요?" }), conv: "lane:a", at: LASK_AT },
	"monitor news": { push: pushOf("w2"), nid: "w2" },
	"failure alert": { push: pushOf("al"), conv: "alert", at: ALERT_AT, sheet: "fs" },
	"mail": { push: pushOf("ml"), conv: "mail:abc", at: MAIL_AT },
	"worklog": { push: pushOf("wl"), conv: "worklog", at: WORK_AT },
	"worklog line of a session": { push: pushOf("wls"), conv: "worklog", at: WORK2_AT },
	"answer in a project thread": { push: pushOf("prj"), conv: "ch:1", at: PROJ_AT },
	"answer in a monitor's settings conversation": { push: event({ ts: SET_AT, target: "settings:disk", text: "[done] 감시 설정을 바꿨어요" }), conv: "settings:disk", at: SET_AT },
};

type Seen = { hl: boolean; snack: string; ns: boolean; fs: number; at: string; nid: string; seen: boolean; pane: string; mirror: boolean; hash: string };
// Waits for the page to answer the tap (a highlight, or a toast saying why not) and reads where it stands, in one page-side step: the highlight fades after 2.3 s.
const settle = async (view: View): Promise<Seen> => JSON.parse(await view.evaluate(`new Promise(res => {
	const t0 = performance.now();
	const snap = () => {
		const h = document.querySelector(".nt-hl"), sn = document.querySelector(".snack");
		const out = { hl: !!h, snack: sn ? sn.textContent : "", ns: !!NS.h, fs: FS.length, at: "", nid: "", seen: false, pane: "", mirror: false, hash: location.hash };
		if (h) {
			const m = h.closest("[data-ts]"), row = h.closest("[data-nid]"), sc = h.closest("#mon-timeline") || h.closest(".pane-tl") || timeline, r = h.getBoundingClientRect(), a = sc.getBoundingClientRect(), pane = h.closest(".pane");
			Object.assign(out, { at: m ? m.dataset.ts : "", nid: row ? row.dataset.nid : "", seen: r.height > 0 && r.bottom > a.top && r.top < a.bottom, pane: pane ? (paneFind(pane.dataset.id) || {}).t || "" : target, mirror: !!pane && !pane.classList.contains("on") });
		}
		return JSON.stringify(out);
	};
	const tick = () => { if (document.querySelector(".nt-hl, .snack") || performance.now() - t0 > 6000) res(snap()); else requestAnimationFrame(tick); };
	tick();
})`) as string);

const expectLanded = async (view: View, k: Spec) => {
	const got = await settle(view);
	expect(got).toMatchObject({ hl: true, seen: true, snack: "", mirror: false, ...(k.conv ? { pane: k.conv } : {}), ...(k.at ? { at: k.at } : {}), ...(k.nid ? { nid: k.nid } : {}) });
	if (k.hash) expect(got.hash).toBe(k.hash);
	if (k.sheet === "ns") await on(view).waitFor(`NS.h`, 6000);
	if (k.sheet === "fs") await on(view).waitFor(`FS.length === 1`, 6000);
};

const WIDE = 1280;
const ready = async (view: View) => { await on(view).waitFor(`NT.loaded && current !== undefined`); };
const reset = (view: View) => on(view).run(`localStorage.removeItem("dotz-panes");`);
// The app was closed: it starts at the address the worker opens.
const cold = async (width: number, push: object, layout?: object) => {
	const sw = swOf(hub.origin, []);
	await sw.tap(push);
	const path = sw.opened[0]!.slice(hub.origin.length);
	if (!layout) {
		const view = await hub.view({ width, height: 844 }, path);
		await ready(view);
		return view;
	}
	const view = await hub.view({ width, height: 844 }, "/#home");
	await on(view).run(`localStorage.setItem("dotz-panes", ${JSON.stringify(JSON.stringify(layout))});`);
	await view.navigate(hub.origin + path);
	await ready(view);
	return view;
};
const split = (a: string, b: string, active: string) => ({ root: { dir: "row", a: { id: "p1", kind: "chat", t: a, at: null, stick: true, dot: "" }, b: { id: "p2", kind: "chat", t: b, at: null, stick: true, dot: "" }, r: 0.5 }, active: active === a ? "p1" : "p2", seq: 2 });
// The app is open in another place; the worker hands the tap to its window.
const HIDE = `Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
	window.__frames = []; window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = f => window.__frames.push(f);`;
const SHOW = `delete document.hidden; delete document.visibilityState; window.requestAnimationFrame = window.__raf; document.dispatchEvent(new Event("visibilitychange"));
	for (const f of window.__frames.splice(0)) window.requestAnimationFrame(f);`;
const opened = async (width: number, path: string, ok: string, push: object, layout?: object, hidden = false) => {
	const view = await hub.view({ width, height: 844 }, path);
	await on(view).waitFor(`NT.loaded && ${ok}`);
	if (layout) {
		await on(view).run(`localStorage.setItem("dotz-panes", ${JSON.stringify(JSON.stringify(layout))}); paneRestore();`);
		await on(view).waitFor(`paneCount() === 2 && document.querySelectorAll("#split .pane").length === 2 && CV.placed`);
	}
	const posted: unknown[] = [];
	await swOf(hub.origin, [{ url: `${hub.origin}/`, focus: async () => {}, postMessage: (m: unknown, ports?: MessagePort[]) => { posted.push(m); ports?.[0]?.postMessage(1); } }]).tap(push);
	if (hidden) await on(view).run(HIDE);
	await on(view).run(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(posted[0])} }));`);
	if (hidden) await on(view).run(SHOW);
	return view;
};

// Each test loads the whole app into a window of its own: 20s, not the default 5s, so a busy machine running other work does not fail it.
describe.each(Object.entries(KINDS))("%s", (_name, k) => {
	test("app closed, phone", async () => {
		await expectLanded(await cold(390, k.push), k);
	}, 20_000);
	test("app closed, wide window", async () => {
		await expectLanded(await cold(WIDE, k.push), k);
	}, 20_000);
	test("app closed, wide window that was left split", async () => {
		const view = await cold(WIDE, k.push, split(k.conv && !k.conv.startsWith("mail:") ? k.conv : "main", "lane:b", "lane:b"));
		try { await expectLanded(view, k); } finally { await reset(view); }
	}, 20_000);
	test("open on the main chat", async () => {
		await expectLanded(await opened(390, "/#chat/main", `current === "chat" && target === "main" && CV.placed`, k.push), k);
	}, 20_000);
	test("open in the background on the main chat: the page comes forward after the tap arrived", async () => {
		await expectLanded(await opened(390, "/#chat/main", `current === "chat" && target === "main" && CV.placed`, k.push, undefined, true), k);
	}, 20_000);
	test("open on the main chat, wide window", async () => {
		await expectLanded(await opened(WIDE, "/#chat/main", `current === "chat" && target === "main" && CV.placed`, k.push), k);
	}, 20_000);
	test("open on settings, wide window", async () => {
		await expectLanded(await opened(WIDE, "/#settings", `current === "settings"`, k.push), k);
	}, 20_000);
	test.each([["home", "/#home", `current === "home"`], ["the 알림 screen", "/#notices", `current === "notices"`], ["모니터링", "/#monitoring", `current === "monitoring" && NM.loaded`]])("open on %s", async (_n, path, ok) => {
		await expectLanded(await opened(390, path, ok, k.push), k);
	}, 20_000);
	test("open on settings", async () => {
		await expectLanded(await opened(390, "/#settings", `current === "settings"`, k.push), k);
	}, 20_000);
	test("open on another conversation", async () => {
		await expectLanded(await opened(390, "/#chat/lane:b", `current === "chat" && target === "lane:b" && CV.placed`, k.push), k);
	}, 20_000);
	const here = k.conv && !k.conv.startsWith("mail:") ? k.conv : "";
	if (here) test("wide, split: the conversation sits in the pane that is not active", async () => {
		const view = await opened(WIDE, "/#chat/main", `current === "chat" && CV.placed`, k.push, split(here, "lane:b", "lane:b"));
		try { await expectLanded(view, k); } finally { await reset(view); }
	}, 20_000);
	if (here) test("wide, split: the conversation sits in the active pane", async () => {
		const view = await opened(WIDE, "/#chat/main", `current === "chat" && CV.placed`, k.push, split(here, "lane:b", here));
		try { await expectLanded(view, k); } finally { await reset(view); }
	}, 20_000);
	test("wide, split: neither pane holds the conversation", async () => {
		const view = await opened(WIDE, "/#chat/main", `current === "chat" && CV.placed`, k.push, split(here === "lane:a" ? "worklog" : "lane:a", "lane:b", "lane:b"));
		try { await expectLanded(view, k); } finally { await reset(view); }
	}, 20_000);
});

// The page's two first reads (the conversation and the notices) answer in either order; the tap must land whichever comes last.
// Each opens a window and holds a reply until the page asked for it: 20s, not the default 5s, so a busy machine running other work does not fail it.
describe.each([["/api/history"], ["/api/notices"]])("app closed, %s answered last", late => {
	test.each(["answer (notice)", "question", "session done", "monitor news", "mail"])("%s", async name => {
		const k = KINDS[name]!, sw = swOf(hub.origin, []);
		await sw.tap(k.push);
		const release = hold(late);
		try {
			const seen = arrived.length;
			const view = await hub.view({ width: 390, height: 844 }, sw.opened[0]!.slice(hub.origin.length));
			// Monitor news opens the monitoring screen, which reads no conversation: its page never asks /api/history (before windows were handed back
			// after each test, another test's page left open asked for it and this wait was met by that one).
			if (late !== "/api/history" || k.conv) await arrived.until(a => a.slice(seen).includes(late), 10_000, `${late} asked`);
			if (late === "/api/history") await on(view).waitFor(`NT.loaded`);
			else if (k.conv) await on(view).waitFor(`ts(${JSON.stringify(k.conv)}).hLoaded`);
			release();
			await expectLanded(view, k);
		} finally { release(); }
	}, 20_000);
});

// A notice relayed from the other computer: this app opens, switches to that computer and ends on the item there.
// Each test loads the whole app into a window of its own: 20s, not the default 5s, so a busy machine running other work does not fail it.
describe("another computer's push", () => {
	const relayed = (p: object) => relayedMessage({ name: "맥미니", url: other.origin }, p as never)!;
	const cases = {
		"answer": { push: relayed({ kind: "result", title: "완료", body: "끝났어요", url: "/#chat/main", tag: "answer", ts: ANS_AT }), k: { conv: "main", at: ANS_AT } },
		"question": { push: relayed({ kind: "ask", title: "답변이 필요해요", body: "배포할까요?", url: "/#chat/main", tag: "decision:dec", ts: ASK_AT, id: "dec" }), k: { conv: "main", at: ASK_AT, sheet: "ns" as const } },
	};
	describe.each(Object.entries(cases))("%s", (_n, c) => {
		test("app closed", async () => {
			const sw = swOf(hub.origin, []);
			await sw.tap(c.push);
			const gone = other.nextStream();
			const view = await hub.view({ width: 390, height: 844 }, sw.opened[0]!.slice(hub.origin.length));
			await gone;
			await expectLanded(view, c.k as Spec);
		}, 20_000);
		test("app open", async () => {
			const view = await hub.view({ width: 390, height: 844 }, "/#chat/main");
			await on(view).waitFor(`NT.loaded && CV.placed && PR.fresh`);
			const posted: unknown[] = [];
			await swOf(hub.origin, [{ url: `${hub.origin}/`, focus: async () => {}, postMessage: (m: unknown, ports?: MessagePort[]) => { posted.push(m); ports?.[0]?.postMessage(1); } }]).tap(c.push);
			const gone = other.nextStream();
			await on(view).run(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(posted[0])} }));`);
			await gone;
			await expectLanded(view, c.k as Spec);
		}, 20_000);
	});
});

// The tap goes through the worker (web/sw.js notificationclick) into the real page, with windows that are not the plain top-level app window.
// A fresh window, and 1800 messages for the far one: 20s, not the default 5s, so a busy machine running other work does not fail it.
describe.each([["phone", 390], ["wide window", WIDE]] as const)("worker tap, %s", (_name, width) => {
	test("app closed, the message is far back in a long conversation", async () => {
		const sw = swOf(hub.origin, []);
		await sw.tap(event({ ts: LONG_AT, target: "ch:2", text: "[done] 긴 대화의 결과예요" }));
		expect(sw.opened).toHaveLength(1);
		const view = await hub.view({ width, height: 844 }, sw.opened[0]!.slice(hub.origin.length));
		await ready(view);
		await expectLanded(view, { conv: "ch:2", at: LONG_AT, push: {} });
	}, 20_000);
	test("app open in a user app window (/apps/x/) and no app window", async () => {
		// A window of a user app has no receiver for the tap and never answers: the worker must not hand the tap to it.
		const sw = swOf(hub.origin, [{ url: `${hub.origin}/apps/x/`, focus: async () => {}, postMessage: () => {} }]);
		await sw.tap(KINDS["answer (notice)"]!.push);
		expect(sw.opened).toHaveLength(1);
		const view = await hub.view({ width, height: 844 }, sw.opened[0]!.slice(hub.origin.length));
		await ready(view);
		await expectLanded(view, KINDS["answer (notice)"]!);
	}, 20_000);
	test("app open but its window does not answer", async () => {
		const posted: unknown[] = [];
		let handed!: () => void;
		const arrival = new Promise<void>(r => (handed = r));
		const sw = swOf(hub.origin, [{ url: `${hub.origin}/`, focus: async () => {}, postMessage: (m: unknown) => { posted.push(m); handed(); } }]);
		// The window has the message and says nothing; the tap is done when the worker's own waitUntil is, after it gave up waiting for the answer.
		await sw.tap(KINDS["answer (notice)"]!.push, async () => {
			await arrival;
			expect(sw.opened).toHaveLength(0);   // still waiting for it
			sw.fire();
		});
		expect(posted).toHaveLength(1);
		expect(sw.opened).toHaveLength(1);
		const view = await hub.view({ width, height: 844 }, sw.opened[0]!.slice(hub.origin.length));
		await ready(view);
		await expectLanded(view, KINDS["answer (notice)"]!);
	}, 20_000);
});
