import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noticePush } from "./push.ts";
import { fakeHub, idleState, json, on, type View } from "./test-web.ts";
import type { Notice } from "./notices.ts";

// A tapped notice ends on the exact message or row that caused it (web/js/30-notices.js noticeOpen), in a headless browser against fixture
// conversations, from the bell's rows, a push (web/sw.js, run as shipped) and a cold start, at phone and desktop widths.
const ts = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, 0, i)).toISOString();
const says = (i: number) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` });
const MAIN = Array.from({ length: 420 }, (_, i) => says(i));
const OLD_AT = ts(5), ASK_AT = ts(410), LANE_AT = ts(500), MAIL_AT = ts(501), GAP_AT = "2026-10-20T01:03:20.500Z";
const LANE = [{ ts: ts(499), kind: "lane_report", lane: "a", source: "lane:a", text: "[run] 하는 중" }, { ts: LANE_AT, kind: "lane_report", lane: "a", source: "lane:a", text: "[done] 빌드 끝났어요" }];
const MAIL = [{ ts: MAIL_AT, kind: "mail", incoming: true, source: "zele", channel: "mail:abc", conv: "mail:abc", mail: "abc", subject: "견적서", from: "김철수", text: "견적서 보내요" }];
const base = { read: false, tone: "", text: "내용" };
const decision = { options: [{ n: 1, label: "네" }, { n: 2, label: "아니요" }], to: "main", reply_to: ASK_AT, group: 1, state: "open" };
const report = (i: number) => ({ ...base, id: `w${i}`, kind: "watch", cls: "news", title: "디스크 감시", text: `사용량 ${i}%`, open: "alert", src: "alert", watch: "disk", ts: ts(200 + i), updated: ts(200 + i), at: ts(200 + i) });
const notices = [
	{ ...base, id: "rep", kind: "result", tone: "done", cls: "result", title: "빌드 세션", open: "lane:a", src: "lane:a", key: "lane:a", ts: LANE_AT, updated: LANE_AT, at: LANE_AT },
	{ ...base, id: "dec", kind: "decision", tone: "ask", cls: "ask", title: "배포할까요?", open: "main", src: "main", ts: ASK_AT, updated: ASK_AT, at: ASK_AT, decision },
	{ ...base, id: "ml", kind: "watch", cls: "news", title: "김철수", text: "견적서", open: "mail:abc", src: "mail:abc", key: "mail:abc", ts: MAIL_AT, updated: MAIL_AT, at: MAIL_AT },
	{ ...base, id: "old", kind: "message", cls: "conv", title: "땃쥐", open: "main", src: "main", ts: OLD_AT, updated: OLD_AT, at: OLD_AT },
	{ ...base, id: "gap", kind: "message", cls: "conv", title: "지워진 메시지", open: "main", src: "main", ts: GAP_AT, updated: GAP_AT, at: GAP_AT },
	{ ...base, id: "lost", kind: "message", cls: "conv", title: "없는 메일", open: "mail:lost", src: "mail:lost", ts: MAIL_AT, updated: MAIL_AT, at: "2026-10-20T02:00:00.000Z" },
	...Array.from({ length: 40 }, (_, i) => report(i)),
];
const monitor = { name: "디스크 감시", watch: "disk", kind: "watch", every: "1시간마다", last_result: "ok", last_run: ts(300), next_run: ts(900) };
const lane = { name: "a", title: "빌드 세션", status: "idle", kind: "work" };

const hub = fakeHub({
	state: () => ({ ...idleState(), lanes: [lane], notices_unread: notices.length }),
	api: (_req, url) => {
		if (url.pathname === "/api/history") {
			const t = url.searchParams.get("target"), before = url.searchParams.get("before");
			const all = t === "main" ? MAIN : t === "lane:a" ? LANE : t === "mail:abc" ? MAIL : [];
			const list = before ? all.filter(e => e.ts < before) : all;
			return json({ target: t, events: list.slice(-Number(url.searchParams.get("limit") ?? 60) || -60) });
		}
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: notices.length, items: notices });
		if (url.pathname === "/api/monitors") return json({ items: [monitor] });
	},
});
afterAll(() => hub.stop());

const open = async (width: number, path = "/#home") => {
	const view = await hub.view({ width, height: 844 }, path);
	await on(view).waitFor(`NT.loaded`);
	return view;
};
// The conversation and message the highlight sits on, and whether that message is inside the timeline's visible box.
const landed = async (view: View) => {
	const { waitFor, ev } = on(view);
	await waitFor(`tl.querySelector(".nt-hl") && timeline.clientHeight`);
	return ev<{ t: string; at: string; seen: boolean }>(`(() => {
		const m = tl.querySelector(".nt-hl").closest("[data-ts]"), r = m.getBoundingClientRect(), a = timeline.getBoundingClientRect();
		return { t: target, at: m.dataset.ts, seen: r.bottom > a.top && r.top < a.bottom };
	})()`);
};
const monLanded = async (view: View) => {
	const { waitFor, ev } = on(view);
	await waitFor(`$("#mon-tl .nt-hl")`);
	return ev<{ id: string; seen: boolean; sel: string }>(`(() => {
		const m = $("#mon-tl .nt-hl").closest("[data-nid]"), r = m.getBoundingClientRect(), a = $("#mon-timeline").getBoundingClientRect();
		return { id: m.dataset.nid, sel: MON.sel, seen: r.bottom > a.top && r.top < a.bottom };
	})()`);
};
// A tap on the notice's row on the 알림 screen, under the filter it is listed in.
const tapRow = async (view: View, tab: string, id: string) => {
	const { run, waitFor } = on(view);
	await run(`go("notices");`);
	await waitFor(`current === "notices" && $('#v-notices .nsc-fb[data-f="${tab}"]')`);
	await run(`$('#v-notices .nsc-fb[data-f="${tab}"]').click();`);
	await waitFor(`$('#v-notices .nsc-r[data-nid="${id}"] .nsc-tx')`);
	await run(`$('#v-notices .nsc-r[data-nid="${id}"] .nsc-tx').click();`);
};

// web/sw.js as shipped, with its platform stubbed: what a push shows, and what a tap on it does.
const swOf = (wins: unknown[]) => {
	const h: Record<string, (ev: unknown) => void> = {}, shown: { data: unknown }[] = [], opened: string[] = [];
	const self = {
		addEventListener: (k: string, f: (ev: unknown) => void) => { h[k] = f; },
		clients: { matchAll: async () => wins, openWindow: async (u: string) => { opened.push(u); } },
		registration: { showNotification: async (_t: string, o: { data: unknown }) => { shown.push(o); }, getNotifications: async () => [], pushManager: { getSubscription: async () => null } },
	};
	new Function("self", "location", "caches", readFileSync(join(import.meta.dir, "..", "web", "sw.js"), "utf8"))(self, new URL(hub.origin), {});
	return {
		opened,
		tap: async (msg: object) => {
			const wait: Promise<unknown>[] = [];
			h.push!({ data: { json: () => msg }, waitUntil: (p: Promise<unknown>) => wait.push(p) });
			await Promise.all(wait);
			const data = shown[shown.length - 1]!.data;
			wait.length = 0;
			h.notificationclick!({ notification: { close: () => {}, data }, action: "", waitUntil: (p: Promise<unknown>) => wait.push(p) });
			await Promise.all(wait);
		},
	};
};
const pushOf = (id: string) => noticePush(notices.find(n => n.id === id) as unknown as Notice)!;
const OPEN_WINDOW = (view: View, posted: unknown[]) => ({ url: `${hub.origin}/#home`, focus: async () => {}, postMessage: (m: unknown) => { posted.push(m); void view; } });
// What the worker posted, delivered the way the page receives it from an open window.
const deliver = (view: View, m: unknown) => on(view).run(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(m)} }));`);

describe.each([["phone", 390], ["desktop", 1280]] as const)("%s", (_name, width) => {
	test("a session report lands on the report in that session", async () => {
		const view = await open(width);
		await tapRow(view, "result", "rep");
		expect(await landed(view)).toEqual({ t: "lane:a", at: LANE_AT, seen: true });
	});

	test("a decision row opens its sheet over the 알림 screen; from the home card or a push it lands on the asking message, with its sheet over it", async () => {
		const view = await open(width);
		await tapRow(view, "ask", "dec");
		await on(view).waitFor(`NS.h`);
		expect(await on(view).ev(`current`)).toBe("notices");
		const second = await open(width);
		await on(second).run(`noticeOpenId("dec");`);
		expect(await landed(second)).toEqual({ t: "main", at: ASK_AT, seen: true });
		expect(await on(second).ev(`!!NS.h`)).toBe(true);
	});

	test("a mail opens inside 모니터링 on that mail", async () => {
		const view = await open(width);
		await tapRow(view, "news", "ml");
		expect(await landed(view)).toEqual({ t: "mail:abc", at: MAIL_AT, seen: true });
		expect(await on(view).ev(`location.hash`)).toBe("#monitoring/c:mail%3Aabc");
	});

	test("a monitor report lands on its own row, past the first page, unfolded", async () => {
		const view = await open(width);
		await tapRow(view, "news", "w2");
		expect(await monLanded(view)).toEqual({ id: "w2", sel: "m:디스크 감시", seen: true });
		expect(await on(view).ev(`$('#mon-tl [data-nid="w2"]').textContent`)).toContain("사용량 2%");
	});

	test("a message older than the loaded page is fetched, then landed on", async () => {
		const view = await open(width);
		await on(view).run(`noticeOpenId("old");`);
		expect(await landed(view)).toEqual({ t: "main", at: OLD_AT, seen: true });
	});

	test("a repeat jump does not replay the screen's entry", async () => {
		const view = await open(width, "/#chat/main");
		const { run, ev, waitFor } = on(view);
		await run(`noticeOpenId("old");`);
		await landed(view);
		await run(`window.__rose = 0; const a = Element.prototype.animate; Element.prototype.animate = function (...x) { if (this.id === "v-chat" || this.id === "tl") window.__rose++; return a.apply(this, x); }; tl.querySelector(".nt-hl").classList.remove("nt-hl"); noticeOpenId("old");`);
		await waitFor(`tl.querySelector(".nt-hl")`);
		expect(await ev(`window.__rose`)).toBe(0);
	});

	test("a push tapped with the app open lands on the message", async () => {
		const view = await open(width), posted: unknown[] = [];
		await swOf([OPEN_WINDOW(view, posted)]).tap(pushOf("rep"));
		expect(posted).toEqual([{ open: `${hub.origin}/#chat/lane:a`, ts: LANE_AT, nid: "rep" }]);
		await deliver(view, posted[0]);
		expect(await landed(view)).toEqual({ t: "lane:a", at: LANE_AT, seen: true });
	});

	test("a push tapped with the app closed starts it on the message", async () => {
		const sw = swOf([]);
		await sw.tap(pushOf("rep"));
		const view = await open(width, sw.opened[0]!.slice(hub.origin.length));
		expect(await landed(view)).toEqual({ t: "lane:a", at: LANE_AT, seen: true });
		expect(await on(view).ev(`location.search`)).toBe("");
	});

	test("a monitor's push opens its row, not the 알림 conversation", async () => {
		const view = await open(width), posted: unknown[] = [];
		await swOf([OPEN_WINDOW(view, posted)]).tap(pushOf("w2"));
		await deliver(view, posted[0]);
		expect((await monLanded(view)).id).toBe("w2");
	});

	test("a decision's push, cold: its conversation at the message, the sheet over it", async () => {
		const sw = swOf([]);
		await sw.tap({ kind: "ask", title: "답변이 필요해요", body: "배포할까요?", url: "/#chat/main", tag: "decision:dec", ts: ASK_AT, id: "dec" });
		expect(sw.opened).toEqual([`${hub.origin}/?n=dec#chat/main`]);
		const view = await open(width, "/?n=dec#chat/main");
		expect(await landed(view)).toEqual({ t: "main", at: ASK_AT, seen: true });
		await on(view).waitFor(`NS.h`);
	});

	test("a message that is gone opens the nearest place and says so", async () => {
		const view = await open(width);
		const { run, waitFor, ev } = on(view);
		await run(`noticeOpenId("gap");`);
		await waitFor(`$(".snack")`);
		expect(await ev(`[target, $(".snack").textContent, !!tl.querySelector(".nt-hl")]`)).toEqual(["main", "그 메시지가 없어서 가까운 곳을 열었어요", false]);
	});

	test("a mail that is gone, and a report that is gone, say so", async () => {
		const view = await open(width);
		const { run, waitFor, ev } = on(view);
		await run(`noticeOpenId("lost");`);
		await waitFor(`$(".snack")`);
		expect(await ev(`[target, $(".snack").textContent]`)).toEqual(["mail:lost", "그 메시지를 찾을 수 없어요"]);
		await run(`document.querySelectorAll(".snack").forEach(n => n.remove()); noticeOpen({ id: "nope", kind: "watch", tone: "", title: "없는 감시", src: "alert", open: "alert", at: ${JSON.stringify(ts(1))} });`);
		await waitFor(`$(".snack")`);
		expect(await ev(`[current, $(".snack").textContent]`)).toEqual(["monitoring", "그 소식을 찾을 수 없어요"]);
	});
});
