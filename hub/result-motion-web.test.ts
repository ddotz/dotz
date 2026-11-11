import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, on } from "./test-web.ts";

// Result motion (web/js/01-motion.js motionGone, pressWait, motionAfter): a card leaves only after the hub said yes, folds away while the
// rows under it glide up, and the rows that glide take no tap until they stand still. Every wait is on a page event or state, never a sleep.
const hub = fakeHub({ state: idleState() });
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

// A plain list of three cards with a button each, drawn into the app page (the helpers are global there).
const LIST = `const box = document.createElement("div"); box.id = "rm-list"; box.style.cssText = "position:fixed;inset:0 auto auto 0;width:390px;z-index:99;background:var(--bg)";
	box.innerHTML = [1, 2, 3].map(i => '<div class="card rm-c" id="rm-' + i + '" style="height:120px"><button type="button" class="btn" id="rm-b' + i + '">보내기</button></div>').join("");
	document.body.append(box); window.rmHits = []; for (const b of box.querySelectorAll("button")) b.onclick = () => rmHits.push(b.id);`;
await view.navigate(`${hub.origin}/`);
await waitFor(`typeof motionGone === "function" && typeof S !== "undefined"`);
await run(`window.rmMM = matchMedia`);
const fresh = async (reduced = false) => {
	await run(`document.getElementById("rm-list")?.remove(); window.matchMedia = ${reduced ? `q => /reduced-motion/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : rmMM(q)` : "rmMM"}`);
	await run(LIST);
};

describe("motionGone", () => {
	test("the card leaves the DOM when its motion ends, the next card glides into its place and takes no tap while it moves", async () => {
		await fresh();
		const top1 = await ev<number>(`document.getElementById("rm-1").getBoundingClientRect().top`);
		const b1 = await ev<{ x: number; y: number }>(`(() => { const r = document.getElementById("rm-b1").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		// Subscribe to the end first, then start the leave.
		await run(`window.rmGone = new Promise(r => document.addEventListener("motion-gone", e => r(e.detail.el.id), { once: true })); window.rmLeave = motionGone(document.getElementById("rm-1"))`);
		// Mid-motion: card 1 is still there, lifted out and inert to taps; card 2 has its final box but is drawn where it was, and is inert.
		expect(await ev(`!!document.getElementById("rm-1") && document.getElementById("rm-1").dataset.gone === "1"`)).toBe(true);
		expect(await ev(`document.getElementById("rm-2").inert`)).toBe(true);
		expect(await ev(`document.getElementById("rm-2").getAnimations().length`)).toBe(1);
		// Held near its end, card 2's button is under the spot where card 1's button was: a real tap there must not press it.
		await run(`for (const a of document.getAnimations()) { a.pause(); a.currentTime = 200; }`);
		expect(await ev<number>(`Math.abs(document.getElementById("rm-b2").getBoundingClientRect().top - ${b1.y}) < 30`)).toBe(true);
		await view.click(b1.x, b1.y);
		expect(await ev(`rmHits`)).toEqual([]);
		await run(`for (const a of document.getAnimations()) a.finish()`);
		expect(await view.evaluate(`rmGone`)).toBe("rm-1");
		expect(await ev(`!!document.getElementById("rm-1")`)).toBe(false);
		expect(await ev(`document.getElementById("rm-2").inert`)).toBe(false);
		expect(await ev<number>(`Math.round(document.getElementById("rm-2").getBoundingClientRect().top)`)).toBe(Math.round(top1));
	});

	test("focus inside the leaving card goes to the card that took its place", async () => {
		await fresh();
		await run(`document.getElementById("rm-b1").focus(); window.rmGone = new Promise(r => document.addEventListener("motion-gone", () => r(1), { once: true })); motionGone(document.getElementById("rm-1"))`);
		await view.evaluate(`rmGone`);
		expect(await ev(`document.activeElement && document.activeElement.id`)).toBe("rm-b2");
	});

	test("with reduced motion the card is gone at once, without an animation", async () => {
		await fresh(true);
		await run(`window.rmN = 0; document.addEventListener("motion-gone", () => rmN++); motionGone(document.getElementById("rm-1"))`);
		expect(await ev(`[!!document.getElementById("rm-1"), rmN, document.getElementById("rm-2").getAnimations().length]`)).toEqual([false, 1, 0]);
	});

	test("a redraw of the list asked for while a card leaves waits for it, and only the last one runs", async () => {
		await fresh();
		await run(`window.rmDraws = []; const box = document.getElementById("rm-list"); window.rmGone = new Promise(r => document.addEventListener("motion-gone", () => r(1), { once: true })); motionGone(document.getElementById("rm-1"));
			window.rmWaited = [motionAfter(box, () => rmDraws.push("a")), motionAfter(box, () => rmDraws.push("b"))]`);
		expect(await ev(`[rmWaited, rmDraws]`)).toEqual([[true, true], []]);
		await view.evaluate(`rmGone`);
		expect(await ev(`rmDraws`)).toEqual(["b"]);
		expect(await ev(`motionAfter(document.getElementById("rm-list"), () => 0)`)).toBe(false);
	});

	test("pressWait keeps the width, says what it does, takes no second press, and its undo gives the button back", async () => {
		await fresh();
		const w = await ev<number>(`document.getElementById("rm-b1").offsetWidth`);
		await run(`window.rmUndo = pressWait(document.getElementById("rm-b1"), "보내는 중…")`);
		expect(await ev(`[document.getElementById("rm-b1").textContent, document.getElementById("rm-b1").disabled, document.getElementById("rm-b1").getAttribute("aria-busy")]`)).toEqual(["보내는 중…", true, "true"]);
		expect(await ev<number>(`document.getElementById("rm-b1").offsetWidth`)).toBeGreaterThanOrEqual(w);
		await run(`rmUndo()`);
		expect(await ev(`[document.getElementById("rm-b1").textContent, document.getElementById("rm-b1").disabled, document.getElementById("rm-b1").hasAttribute("aria-busy")]`)).toEqual(["보내기", false, false]);
	});
});
