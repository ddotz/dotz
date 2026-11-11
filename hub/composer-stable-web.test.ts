import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";
import { webBuild } from "./webapp.ts";

// The owner types on a phone (390px, on-screen keyboard) while the page keeps getting updates. Typing must survive all of them: the composer is
// never replaced, never loses focus or text, and its box does not move. A new web build must not reload a page the owner is typing on.
const send = (e: object) => hub.push(e);
const STATE = { web_build: webBuild(), status: "idle", lanes: [] as object[] };
const hub = fakeHub({
	stream: "fake",
	api: (req, url) => {
		const { pathname } = url;
		if (pathname === "/sw.js") return new Response("no", { status: 404 });   // no worker: a build change reaches the page's own check at once
		if (pathname === "/api/state") return Response.json({ name: "dotz", web_build: STATE.web_build, orchestrator: { status: STATE.status }, lanes: STATE.lanes, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());

const { waitFor } = on(view);
const snap = async () => JSON.parse((await view.evaluate(`JSON.stringify((() => { const r = document.querySelector("#send").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, same: document.querySelector("#text") === window.__ta, focus: document.activeElement === window.__ta, value: window.__ta.value, caret: window.__ta.selectionStart }; })())`)) as string) as { top: number; bottom: number; height: number; same: boolean; focus: boolean; value: string; caret: number };
const reloads = async () => Number(await view.evaluate(`window.__reloads`));
const setHidden = (hidden: boolean) => view.evaluate(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => ${hidden ? '"hidden"' : '"visible"'} }); document.dispatchEvent(new Event("visibilitychange")); })()`);

beforeEach(async () => {
	STATE.web_build = webBuild(); STATE.status = "idle"; STATE.lanes = [];
	const opened = hub.nextStream();
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof S === "object" && S && S.web_build`);
	await opened;
	await view.evaluate(`(() => { go("chat", "main"); ta.value = ""; saveDraft(); autosize(); window.__ta = document.querySelector("#text"); sessionStorage.clear(); window.__reloads = 0; reloadPage = () => { window.__reloads++; }; })()`);
	await waitFor(`!document.querySelector("#v-chat").hidden`);
	await view.click("#text");
	await waitFor(`document.activeElement === window.__ta`);
	// The screen's opening animation moves the composer by fractions of a pixel: the first measure comes after it ends.
	await view.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => true)`);
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
	const now = () => new Date().toISOString();
	const note = async () => JSON.parse((await view.evaluate(`JSON.stringify({ same: document.activeElement === window.__note, conn: window.__note.isConnected, value: window.__note.value })`)) as string) as { same: boolean; conn: boolean; value: string };
	const markNote = () => view.evaluate(`(() => { window.__note = document.activeElement; })()`);
	const noteFocused = `document.activeElement && document.activeElement.classList.contains("dc-note")`;
	test("the reason typed in a decision sheet keeps its field through a live progress update and a new notice", async () => {
		// the dock sheet: an [ask] in the main conversation, opened over the screen, option 2 (안 됨) asks for the reason
		send({ kind: "out", target: "main", source: "orchestrator", text: "[ask] 폰에서 확인해 주세요\n결정: 폰에서 확인해 주세요\n1) 확인됨\n2) 안 됨", ts: now() });
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

	// An update that does change the open sheet (here its title) waits while the reason is typed, and is drawn once the owner leaves the field.
	test("a notice update that changes the open sheet keeps the reason field being typed in, and lands after the field is left", async () => {
		const item = { id: 9201, kind: "decision", title: "배포를 확인해 주세요", text: "폰에서 확인해 주세요", ts: now(), decision: { state: "open", to: "main", options: [{ n: 1, label: "확인됨" }, { n: 2, label: "안 됨" }] } };
		send({ kind: "notice", item });
		await waitFor(`ntById(9201)`);
		await view.evaluate(`noticeSheetOpen(9201)`);
		await waitFor(`NS.node`);
		await view.evaluate(`ntAnswer(ntById(9201), ntById(9201).decision.options[1])`);
		await waitFor(noteFocused);
		await view.type("글자가 잘려요");
		await markNote();
		send({ kind: "notice", item: { ...item, title: "배포를 다시 확인해 주세요" } });
		await waitFor(`ntById(9201).title === "배포를 다시 확인해 주세요"`);
		expect(await note()).toEqual({ same: true, conn: true, value: "글자가 잘려요" });
		await view.evaluate(`document.activeElement.blur()`);
		await waitFor(`document.querySelector("#ds-t").textContent === "배포를 다시 확인해 주세요"`);
		await view.evaluate(`ntSheetClose(false)`);
	}, 30_000);

	// A new message redraws a question's card inside its message; the reason field it draws there must not take the composer's focus.
	test("a new message leaves the focus in the composer being typed in, even when a question's reason field is drawn", async () => {
		send({ kind: "out", target: "main", source: "orchestrator", text: "[ask] 화면을 확인해 주세요\n결정: 화면을 확인해 주세요\n1) 확인됨\n2) 안 됨", ts: now() });
		await waitFor(`DC.cur && DC.cur.question.includes("화면을")`);
		// the tap on 2 (안 됨) leaves the composer, as a tap on a button does, and the card's reason field opens with the focus
		await view.evaluate(`(() => { document.activeElement.blur(); pickOption(DC.cur, 0, DC.cur.blocks[0].options.find(o => o.n === 2)); })()`);
		await waitFor(noteFocused);
		await view.click("#text");
		await waitFor(`document.activeElement === window.__ta`);
		await view.type("안녕");
		send({ kind: "out", target: "main", source: "orchestrator", text: "다른 답변", ts: now() });
		await waitFor(`!!document.querySelector("#timeline .dc-note") && document.querySelector("#timeline").textContent.includes("다른 답변")`);
		expect(JSON.parse(await view.evaluate(`JSON.stringify({ same: document.activeElement === window.__ta, value: ta.value })`) as string)).toEqual({ same: true, value: "안녕" });
	}, 30_000);

	// A plain message after a question hands its card from the message (decisionOne) to the question's open notice (decisionGroup). The reason
	// being typed in the docked card stays: on Android Chrome the field was rebuilt and the keyboard went down for good.
	test("the reason typed in the docked card keeps its field when a later message hands the question to its notice", async () => {
		const at = now();
		send({ kind: "out", target: "main", source: "orchestrator", text: "[ask] 버튼을 확인해 주세요\n결정: 버튼을 확인해 주세요\n1) 확인됨\n2) 안 됨", ts: at });
		send({ kind: "notice", item: { id: 9301, kind: "decision", title: "버튼을 확인해 주세요", text: "버튼을 확인해 주세요", ts: at, decision: { state: "open", to: "main", reply_to: at, group: 1, options: [{ n: 1, label: "확인됨" }, { n: 2, label: "안 됨" }] } } });
		await waitFor(`ntById(9301) && DC.cur && DC.cur.question.includes("버튼을")`);
		await view.evaluate(`(() => { document.activeElement.blur(); pickOption(DC.cur, 0, DC.cur.blocks[0].options.find(o => o.n === 2)); })()`);
		await waitFor(`document.activeElement && document.activeElement.matches("#dcard .dc-note")`);
		await view.type("버튼이 안 보여");
		await markNote();
		send({ kind: "out", target: "main", source: "gateway", text: "다른 일도 끝났어요", ts: now() });
		await waitFor(`ts("main").msgs.some(m => m.text === "다른 일도 끝났어요") && !decisionOne("main") && DC.cur && DC.cur.each`);
		expect(await note()).toEqual({ same: true, conn: true, value: "버튼이 안 보여" });
	}, 30_000);

	// The tab bar steps aside for the keyboard in the frame the keyboard arrives. Hidden at the focus before it, the docked card dropped by the
	// bar's height and then rose with the keyboard: on iOS the reason field moved 3 times for one tap.
	test("a tap on the docked card's reason field leaves the tab bar until the keyboard arrives, then both move in one frame", async () => {
		send({ kind: "out", target: "main", source: "orchestrator", text: "[ask] 글자를 확인해 주세요\n결정: 글자를 확인해 주세요\n1) 확인됨\n2) 안 됨", ts: now() });
		await waitFor(`DC.cur && DC.cur.question.includes("글자를")`);
		await view.evaluate(`(() => { document.activeElement.blur(); pickOption(DC.cur, 0, DC.cur.blocks[0].options.find(o => o.n === 2)); })()`);
		await waitFor(noteFocused);
		const frames = () => view.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))`);
		const at = async () => JSON.parse((await view.evaluate(`JSON.stringify({ top: Math.round(document.querySelector("#dcard .dc-note").getBoundingClientRect().top), bottom: Math.round(document.querySelector("#dcard .dc-note").getBoundingClientRect().bottom), bar: getComputedStyle(document.querySelector(".side")).display !== "none" })`)) as string) as { top: number; bottom: number; bar: boolean };
		await view.evaluate(`(document.activeElement.blur(), 0)`);
		await view.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => 0)`);   // the card's rise-in has ended
		await frames();
		const rest = await at();
		await view.click("#dcard .dc-note");
		await waitFor(noteFocused);
		await frames();
		expect(await at()).toEqual(rest);
		await view.resize(390, 544);   // the keyboard arrives and the page shrinks (resizes-content)
		await view.evaluate(`visualViewport.dispatchEvent(new Event("resize")), 0`);
		await frames();
		const typing = await at();
		expect(rest.bar).toBe(true);
		expect(typing.bar).toBe(false);
		expect(typing.top).toBeGreaterThanOrEqual(0);
		expect(typing.bottom).toBeLessThanOrEqual(544);
		await view.resize(390, 844);
	}, 30_000);

	test("the app height follows the same viewport the layout uses, so a lagging window.innerHeight cannot shrink the page twice", async () => {
		await view.resize(390, 544);   // the keyboard has already resized the page (resizes-content)
		await view.evaluate(`Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 844 }), 0`);   // a frame where innerHeight lags
		await view.evaluate(`visualViewport.dispatchEvent(new Event("resize")), 0`);
		await waitFor(`document.documentElement.style.getPropertyValue("--kb") !== ""`);
		await view.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);   // the queued apply has run
		expect(await view.evaluate(`document.documentElement.style.getPropertyValue("--kb")`)).toBe("0px");
		expect(Number(await view.evaluate(`document.querySelector(".app").getBoundingClientRect().height`))).toBeGreaterThan(540);
		await view.resize(390, 844);
	}, 30_000);

	// iOS Safari ignores resizes-content: it pans the visual viewport down by the keyboard's height instead of shrinking the page. What the
	// keyboard covers is only what lies below the visual viewport's bottom edge, so a pan already counts as shown and must not shrink .app too.
	test("--kb is only what the keyboard covers below the visual viewport: 0 after a pan or a zoom, the keyboard height with no pan", async () => {
		const src = await Bun.file(new URL("../web/js/34-composer-viewport.js", import.meta.url)).text();
		await view.resize(390, 699);
		await view.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
		const kbFor = async (height: number, offsetTop: number, scale: number) => String(await view.evaluate(`(async () => {
			const vv = Object.assign(new EventTarget(), { height: ${height}, offsetTop: ${offsetTop}, scale: ${scale} });
			Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
			document.documentElement.style.removeProperty("--kb");
			(0, eval)(${JSON.stringify(src)});
			vv.dispatchEvent(new Event("scroll"));
			await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
			return document.documentElement.style.getPropertyValue("--kb");
		})()`));
		expect(await kbFor(371, 328, 1)).toBe("0px");
		expect(await kbFor(371, 0, 1)).toBe("328px");
		expect(await kbFor(371, 0, 1.067)).toBe("0px");
		await view.resize(390, 844);
	}, 30_000);
	// A session that ends while its composer holds text or the focus: if it can still be written to (resumable), the view stays on it until the owner has left the box with nothing in it.
	// One that cannot (gone from the list, ended for good) carries the text into the main conversation instead, after that conversation's own draft.
	test("an ended session that can be resumed keeps the typed text and focus; one that cannot carries them into main", async () => {
		const refresh = () => view.evaluate(`refreshState().then(() => 0)`);
		const open = async (name: string) => {
			STATE.lanes = [{ name, status: "idle", live: true, alive: true }];
			await refresh();
			await view.evaluate(`(go("chat", "lane:${name}"), 0)`);
			await waitFor(`target === "lane:${name}"`);
			await view.click("#text");
			await waitFor(`document.activeElement === window.__ta`);
		};
		const state = async () => JSON.parse((await view.evaluate(`JSON.stringify({ target, value: ta.value, focus: document.activeElement === ta })`)) as string) as { target: string; value: string; focus: boolean };

		await open("x");
		await view.type("끝나기 전에 쓰던 글");
		STATE.lanes = [];   // the session leaves the list: nowhere to send, so the text moves to main
		await refresh();
		expect(await state()).toEqual({ target: "main", value: "끝나기 전에 쓰던 글", focus: true });
		await view.evaluate(`(ta.value = "", ta.dispatchEvent(new Event("input")), ta.blur(), 0)`);

		await open("z");
		await view.type("이어 쓸 수 있는 글");
		STATE.lanes = [{ name: "z", status: "exited", live: false, alive: false, resumable: true }];   // ended but resumable: still written to
		await refresh();
		expect(await state()).toEqual({ target: "lane:z", value: "이어 쓸 수 있는 글", focus: true });
		await view.evaluate(`(ta.value = "", ta.dispatchEvent(new Event("input")), ta.blur(), 0)`);
		await waitFor(`target === "main"`);

		await open("y");
		await view.evaluate(`(ts("main").draft = "앞에 쓴 글", 0)`);
		await view.type("메모");
		STATE.lanes = [{ name: "y", status: "exited", live: false, alive: false, resumable: false }];   // ended, and the composer would be off
		await refresh();
		expect(await state()).toEqual({ target: "main", value: "앞에 쓴 글\n메모", focus: true });
	}, 30_000);

});
