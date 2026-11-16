import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, run, waitFor, type View } from "./test-web.ts";

// The side drawer (#sheet, web/js/06-subagents.js) in a headless browser at 390 and 1280px, on the demo's data (site/demo, as web-golden-web.test.ts
// runs it). It is the one panel beside the screen: the running subagents and a 구성 card's detail both open in it, it stays one overlay whatever it
// shows, and a card's unsaved edit still asks before another card or a project map's 뒤로 takes the drawer away.
const ROOT = join(import.meta.dir, "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const hub = fakeHub({ slowTimers: true, headScript: [src("site/demo/fixtures.js"), src("site/demo/demo-api.js")].join("\n;\n") });
afterEach(() => hub.release());
afterAll(() => hub.stop());

const BOOT = `typeof S !== "undefined" && S && typeof target === "string" && CV.loaded && NT.loaded`;
const CARD = "gateway", OTHER = "orchestrator";
type Drawer = { shown: boolean; label: string | null; name: string; sub: string; tag: string | null; toList: boolean; rows: number; kids: number; ov: number; card: string; subs: string | null; room: boolean; focus: string };
// What the drawer shows and holds, read once the page's own history traversal is over (on a phone, closing an overlay steps the history back).
const drawer = async (v: View): Promise<Drawer> => {
	await waitFor(v, `!H.moving`);
	return ev<Drawer>(v, `({ shown: !sheet.hidden, label: sheet.getAttribute("aria-label"), name: $("#sh-name").textContent, sub: $("#sh-sub").textContent, tag: $("#sh-tag").hidden ? null : $("#sh-tag").textContent,
		toList: !$("#sh-back").hidden, rows: shBody.querySelectorAll(".subrow").length, kids: shBody.children.length, ov: OV.length, card: hSel, subs: SUBD ? SUBD.id || SUBD.sources.join() : null,
		room: $("#harness").classList.contains("hs-open"), focus: document.activeElement ? document.activeElement.id : "" })`);
};
const tx = (v: View, key: string, vars: object = {}) => ev<string>(v, `TX(${JSON.stringify(key)}, ${JSON.stringify(vars)})`);
const open = async (w: number): Promise<View> => {
	const v = await hub.view({ width: w, height: w < 600 ? 844 : 800 }, "/#home");
	await waitFor(v, BOOT);
	return v;
};
const card = (id: string) => `document.querySelector('#harness [data-id="${id}"]')`;
const toHarness = async (v: View) => {
	await run(v, `go("harness")`);
	await waitFor(v, `current === "harness" && ${card(CARD)}`);
};
const openCard = async (v: View, id: string) => {
	await run(v, `${card(id)}.click()`);
	await waitFor(v, `!sheet.hidden && hSel === ${JSON.stringify(id)} && shBody.children.length`);
};
const node = (v: View, id: string) => ev<{ label: string; summary: string }>(v, `(n => ({ label: n.label, summary: n.summary }))(hNode(${JSON.stringify(id)}))`);
const unsavedQuestion = `(d => !!d && d.innerText.includes(TX("system.pj.dirty.title")))(document.querySelector("dialog[open]:not([data-leaving])"))`;
const answer = async (v: View, key: string) => {
	await run(v, `[...document.querySelectorAll("dialog[open]:not([data-leaving]) button")].find(b => b.textContent.trim() === TX(${JSON.stringify(key)})).click()`);
	await waitFor(v, `!document.querySelector("dialog[open]")`);
};
const back = (v: View) => v.evaluate(`new Promise((res, rej) => { const t = __rt(() => rej(new Error("no popstate")), 8000); addEventListener("popstate", () => { clearTimeout(t); res(0); }, { once: true }); history.back(); })`);

for (const w of [390, 1280]) {
	describe(`${w}px`, () => {
		test("a 구성 card opens in the one drawer, and back closes it", async () => {
			const v = await open(w);
			expect(await ev(v, `document.querySelectorAll("#hsheet").length`)).toBe(0);
			expect(await ev(v, `document.querySelectorAll("aside.sheet").length`)).toBe(1);
			await toHarness(v);
			await openCard(v, CARD);
			const a = await node(v, CARD), d = await drawer(v);
			expect(d).toMatchObject({ shown: true, label: await tx(v, "shell.sheet.detail"), name: a.label, sub: a.summary, toList: false, ov: 1, card: CARD, subs: null, room: true });
			expect(d.kids).toBeGreaterThan(0);
			const flat = await ev<boolean>(v, `histFlat()`);   // a wide screen keeps overlays out of the history: back leaves 구성, and the drawer closes with it
			await back(v);
			await waitFor(v, `sheet.hidden`);
			expect(await drawer(v)).toMatchObject({ shown: false, kids: 0, ov: 0, card: "", room: false });
			expect(await ev(v, `current === "harness"`)).toBe(!flat);
		}, 20_000);

		test("the running subagents open in it, one record and back to the list, and closing gives the focus back", async () => {
			const v = await open(w);
			await run(v, `go("chat", "main")`);
			await waitFor(v, `current === "chat" && CV.placed && [$("#runline-subs"), $("#runstate-subs")].some(b => b.offsetParent)`);
			const opener = await ev<string>(v, `[$("#runline-subs"), $("#runstate-subs")].find(b => b.offsetParent).id`);
			await run(v, `$("#${opener}").focus(); $("#${opener}").click()`);
			await waitFor(v, `!sheet.hidden && SUBD && shBody.querySelector(".subrow")`);
			const n = await ev<number>(v, `SUBD.sources.flatMap(s => runningSubs(s)).length`);
			expect(n).toBeGreaterThan(0);
			const list = { shown: true, label: await tx(v, "common.subagent"), name: await tx(v, "base.sub.running", { n }), tag: null, toList: false, rows: n, ov: 1, card: "", focus: "sh-close" };
			expect(await drawer(v)).toMatchObject(list);
			await run(v, `shBody.querySelector(".subrow").click()`);
			await waitFor(v, `SUBD && SUBD.id && SUBD.data`);
			const one = await drawer(v);
			expect(one).toMatchObject({ shown: true, label: list.label, toList: true, rows: 0, ov: 1 });
			expect(one.tag).toBeTruthy();
			await run(v, `$("#sh-back").click()`);
			await waitFor(v, `SUBD && !SUBD.id`);
			expect(await drawer(v)).toMatchObject(list);
			await run(v, `$("#sh-close").click()`);
			await waitFor(v, `sheet.hidden`);
			expect(await drawer(v)).toMatchObject({ shown: false, kids: 0, ov: 0, subs: null, focus: opener });
		}, 20_000);

		test("a 구성 card pressed while the subagents are open takes the drawer over", async () => {
			const v = await open(w);
			await run(v, `openSubs(["orchestrator"])`);
			await waitFor(v, `!sheet.hidden && SUBD`);
			await toHarness(v);
			expect(await drawer(v)).toMatchObject({ shown: true, subs: "orchestrator", ov: 1 });
			await openCard(v, CARD);
			expect(await drawer(v)).toMatchObject({ shown: true, label: await tx(v, "shell.sheet.detail"), name: (await node(v, CARD)).label, toList: false, rows: 0, ov: 1, card: CARD, subs: null });
			await run(v, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
			await waitFor(v, `sheet.hidden`);
			expect(await drawer(v)).toMatchObject({ shown: false, kids: 0, ov: 0, card: "", subs: null, room: false });
		}, 20_000);

		test("a conversation change closes the running subagents, never a 구성 card's detail", async () => {
			const v = await open(w);
			const lane = await ev<string>(v, `"lane:" + S.lanes[0].name`);
			await toHarness(v);
			await openCard(v, CARD);
			await run(v, `setTarget(${JSON.stringify(lane)})`);
			expect(await ev(v, `target`)).toBe(lane);
			expect(await drawer(v)).toMatchObject({ shown: true, ov: 1, card: CARD, subs: null });
			await run(v, `openSubs(["orchestrator"])`);
			await waitFor(v, `!sheet.hidden && SUBD`);
			await run(v, `setTarget(MAIN)`);
			expect(await ev(v, `target`)).toBe("main");
			expect(await drawer(v)).toMatchObject({ shown: false, kids: 0, ov: 0, card: "", subs: null });
		}, 20_000);

		test("an unsaved edit still asks before another card takes the drawer", async () => {
			const v = await open(w);
			await toHarness(v);
			await openCard(v, CARD);
			await run(v, `const i = shBody.querySelector("input[type=number]"); i.value = String(Number(i.value) + 1); i.dispatchEvent(new Event("input", { bubbles: true }))`);
			expect(await ev(v, `hDirty()`)).toBe(true);
			await run(v, `${card(OTHER)}.click()`);
			await waitFor(v, unsavedQuestion);
			await answer(v, "common.cancel");
			expect(await drawer(v)).toMatchObject({ shown: true, name: (await node(v, CARD)).label, ov: 1, card: CARD });
			expect(await ev(v, `hDirty()`)).toBe(true);
			await run(v, `${card(OTHER)}.click()`);
			await waitFor(v, unsavedQuestion);
			await answer(v, "system.pj.dirty.ok");
			await waitFor(v, `hSel === ${JSON.stringify(OTHER)}`);
			expect(await drawer(v)).toMatchObject({ shown: true, name: (await node(v, OTHER)).label, ov: 1, card: OTHER });
		}, 20_000);

		test("an unsaved edit still asks before a project map's 뒤로 takes the drawer", async () => {
			const v = await open(w);
			await toHarness(v);
			await waitFor(v, `document.querySelector("#harness .pj-card")`);
			await run(v, `document.querySelector("#harness .pj-card").click()`);
			await waitFor(v, `hProjId && document.querySelector("#harness .pj-bk button") && ${card(CARD)}`);
			const pj = await ev<string>(v, `hProjId`);
			await openCard(v, CARD);
			await run(v, `const t = [...shBody.querySelectorAll("textarea")].pop(); t.value = "포트를 바꿔 주세요"; t.dispatchEvent(new Event("input", { bubbles: true }))`);
			expect(await ev(v, `hDirty()`)).toBe(true);
			await run(v, `document.querySelector("#harness .pj-bk button").click()`);
			await waitFor(v, unsavedQuestion);
			await answer(v, "common.cancel");
			expect(await ev(v, `hProjId`)).toBe(pj);
			expect(await drawer(v)).toMatchObject({ shown: true, ov: 1, card: CARD });
			expect(await ev(v, `hDirty()`)).toBe(true);
			await run(v, `document.querySelector("#harness .pj-bk button").click()`);
			await waitFor(v, unsavedQuestion);
			await answer(v, "system.pj.dirty.ok");
			await waitFor(v, `hProjId === "" && sheet.hidden`);
			expect(await drawer(v)).toMatchObject({ shown: false, kids: 0, ov: 0, card: "", room: false });
		}, 20_000);
	});
}
