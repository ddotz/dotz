import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appAsset, indexPage, webBuild } from "./webapp.ts";

// The owner types on a phone (390px, on-screen keyboard) while the page keeps getting updates. Typing must survive all of them: the composer is
// never replaced, never loses focus or text, and its box does not move. A new web build must not reload a page the owner is typing on.
const enc = new TextEncoder();
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const send = (e: object) => { for (const c of streams) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); };
const STATE = { web_build: webBuild(), status: "idle" };
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === "/") return indexPage(req);
		if (pathname === "/sw.js") return new Response("no", { status: 404 });   // no worker: a build change reaches the page's own check at once
		const asset = appAsset(req, pathname);
		if (asset) return asset;
		if (pathname === "/api/state") return Response.json({ name: "dotz", web_build: STATE.web_build, orchestrator: { status: STATE.status }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (pathname === "/api/events") {
			let ctl!: ReadableStreamDefaultController<Uint8Array>;
			return new Response(new ReadableStream<Uint8Array>({
				start(c) { ctl = c; streams.add(c); c.enqueue(enc.encode("event: reset\ndata: {}\n\n")); },
				cancel() { streams.delete(ctl); },
			}), { headers: { "Content-Type": "text/event-stream" } });
		}
		return pathname.startsWith("/api/") ? Response.json({}) : new Response("not found", { status: 404 });
	},
});
const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { view.close(); server.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else setTimeout(tick, 20); }; tick(); })`);
const snap = async () => JSON.parse((await view.evaluate(`JSON.stringify((() => { const r = document.querySelector("#send").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, same: document.querySelector("#text") === window.__ta, focus: document.activeElement === window.__ta, value: window.__ta.value, caret: window.__ta.selectionStart }; })())`)) as string) as { top: number; bottom: number; height: number; same: boolean; focus: boolean; value: string; caret: number };
const reloads = async () => Number(await view.evaluate(`window.__reloads`));
const setHidden = (hidden: boolean) => view.evaluate(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => ${hidden ? '"hidden"' : '"visible"'} }); document.dispatchEvent(new Event("visibilitychange")); })()`);

beforeEach(async () => {
	STATE.web_build = webBuild(); STATE.status = "idle";
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`typeof S === "object" && S && S.web_build`);
	while (streams.size < 1) await Bun.sleep(10);
	await view.evaluate(`(() => { go("chat", "main"); window.__ta = document.querySelector("#text"); sessionStorage.clear(); window.__reloads = 0; reloadPage = () => { window.__reloads++; }; })()`);
	await waitFor(`!document.querySelector("#v-chat").hidden`);
	await view.click("#text");
	await waitFor(`document.activeElement === window.__ta`);
});

// Everything that arrives while the owner types: a state poll that flips the working line, a toast, a corner notice, a new message, a new web build.
async function arrivals(each: () => Promise<void>) {
	STATE.status = "working";
	await view.evaluate(`refreshState()`);
	await waitFor(`!document.querySelector("#working").hidden`);
	await each();
	await view.evaluate(`(() => { toast("저장했어요"); notify({ kind: "lane_report", lane: "x", text: "서브 작업이 끝났어요", ts: new Date().toISOString() }); })()`);
	await waitFor(`document.querySelector(".snack") && document.querySelector(".ntf-box")?.children.length`);
	await each();
	send({ kind: "out", target: "main", source: "gateway", text: "새 답변이 왔어요", ts: new Date().toISOString() });
	await waitFor(`ts("main").msgs.some(m => m.text === "새 답변이 왔어요")`);
	await each();
	STATE.web_build = "next-build-0001";
	await view.evaluate(`refreshState()`);
	await waitFor(`webBuildAsked === "next-build-0001"`);
	await each();
}

describe("typing on the phone composer while the page updates", () => {
	test("text, focus, caret and the composer box stay put through a state poll, toast, notice, new message and new web build; no reload", async () => {
		await view.type("안녕하세요 배포 확인");
		const first = await snap();
		expect(first).toMatchObject({ same: true, focus: true, value: "안녕하세요 배포 확인" });
		await arrivals(async () => {
			const now = await snap();
			expect(now).toMatchObject({ same: true, focus: true, value: first.value, caret: first.caret });
			expect(now.bottom).toBeCloseTo(first.bottom, 1);
			expect(now.height).toBeCloseTo(first.height, 1);
		});
		expect(await reloads()).toBe(0);
		expect(await view.evaluate(`!!document.querySelector(".shell-chip")`)).toBe(true);   // the new version is offered, not forced
		await view.type("!");   // still typing into the same box
		expect((await snap()).value).toBe("안녕하세요 배포 확인!");
		// page hidden with text still in the box: nothing reloads, the draft is not at risk
		await setHidden(true);
		expect(await reloads()).toBe(0);
	}, 45_000);

	test("a focused but still empty composer is not reloaded under the owner; the update waits for the page to be hidden", async () => {
		const first = await snap();
		STATE.web_build = "next-build-0002";
		await view.evaluate(`refreshState()`);
		await waitFor(`webBuildAsked === "next-build-0002"`);
		expect(await reloads()).toBe(0);
		expect(await view.evaluate(`!!document.querySelector(".shell-chip")`)).toBe(true);
		expect(await snap()).toMatchObject({ same: true, focus: true, value: "", bottom: first.bottom });
		await setHidden(true);   // the owner leaves the app with nothing typed
		await waitFor(`window.__reloads === 1`);
		await setHidden(false);
	}, 30_000);

	test("the update applies once the text is gone and the page is hidden, never while it is visible", async () => {
		await view.type("메모");
		STATE.web_build = "next-build-0003";
		await view.evaluate(`refreshState()`);
		await waitFor(`webBuildAsked === "next-build-0003"`);
		await setHidden(true);
		expect(await reloads()).toBe(0);
		await setHidden(false);
		await view.evaluate(`(() => { window.__ta.value = ""; window.__ta.dispatchEvent(new Event("input")); })()`);
		expect(await reloads()).toBe(0);   // visible and empty: still no reload while the owner is in the app
		await setHidden(true);
		await waitFor(`window.__reloads === 1`);
		await setHidden(false);
	}, 30_000);

	// A decision answered with a reason is typed into the sheet's own field (the dock sheet for an [ask] in a conversation, the notice sheet from
	// 알림). A live update must not redraw that field: a new node takes the focus from the old one, and a phone closes and reopens its keyboard.
	test("the reason typed in a decision sheet keeps its field through a live progress update and a new notice", async () => {
		const now = () => new Date().toISOString();
		const note = async () => JSON.parse((await view.evaluate(`JSON.stringify({ same: document.activeElement === window.__note, conn: window.__note.isConnected, value: window.__note.value })`)) as string) as { same: boolean; conn: boolean; value: string };
		const markNote = () => view.evaluate(`(() => { window.__note = document.activeElement; })()`);
		const noteFocused = `document.activeElement && document.activeElement.classList.contains("dc-note")`;
		// the dock sheet: an [ask] in the main conversation, opened over the screen, option 2 (안 됨) asks for the reason
		send({ kind: "out", target: "main", source: "orchestrator", text: "[ask] 폰에서 확인해 주세요\n1) 확인됨\n2) 안 됨", ts: now() });
		await waitFor(`decisionOf("main")`);
		await view.evaluate(`(() => { dkOpen(decisionOf("main")); pickOption(DK.dc, 0, DK.dc.blocks[0].options.find(o => o.n === 2)); })()`);
		await waitFor(noteFocused);
		await view.type("버튼이 안 보여");
		await markNote();
		send({ kind: "out", target: "main", source: "orchestrator", update_key: "progress", text: "진행 중 1", ts: now() });
		await waitFor(`ts("main").msgs.some(m => m.text === "진행 중 1")`);
		expect(await note()).toEqual({ same: true, conn: true, value: "버튼이 안 보여" });
		await view.evaluate(`dkClose(false)`);
		// the notice sheet: an open decision notice, option 2 asks for the reason, then another notice arrives
		send({ kind: "notice", item: { id: 9101, kind: "decision", title: "배포를 확인해 주세요", text: "폰에서 확인해 주세요", ts: now(), decision: { state: "open", to: "main", options: [{ n: 1, label: "확인됨" }, { n: 2, label: "안 됨" }] } } });
		await waitFor(`ntById(9101)`);
		await view.evaluate(`noticeSheetOpen(9101)`);
		await waitFor(`NS.node`);
		await view.evaluate(`ntAnswer(ntById(9101), ntById(9101).decision.options[1])`);
		await waitFor(noteFocused);
		await view.type("글자가 잘려요");
		await markNote();
		send({ kind: "notice", item: { id: 9102, kind: "message", title: "세션 x", text: "서브 작업이 끝났어요", ts: now() } });
		await waitFor(`ntById(9102)`);
		expect(await note()).toEqual({ same: true, conn: true, value: "글자가 잘려요" });
		await view.evaluate(`ntSheetClose(false)`);
	}, 30_000);

	test("the app height follows the same viewport the layout uses, so a lagging window.innerHeight cannot shrink the page twice", async () => {
		await view.resize(390, 544);   // the keyboard has already resized the page (resizes-content)
		await view.evaluate(`Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 844 }), 0`);   // a frame where innerHeight lags
		await view.evaluate(`visualViewport.dispatchEvent(new Event("resize")), 0`);
		await waitFor(`document.documentElement.style.getPropertyValue("--kb") !== ""`);
		await Bun.sleep(80);   // one animation frame for the queued apply
		expect(await view.evaluate(`document.documentElement.style.getPropertyValue("--kb")`)).toBe("0px");
		expect(Number(await view.evaluate(`document.querySelector(".app").getBoundingClientRect().height`))).toBeGreaterThan(540);
		await view.resize(390, 844);
	}, 30_000);
});
