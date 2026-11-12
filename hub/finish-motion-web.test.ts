import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { fakeHub, idleState, on } from "./test-web.ts";

// Motion 4, working -> finished (web/js/01-motion.js motionSwap, motionKeep, motionGone; web/DESIGN.md Result motion): a row that finishes changes in
// place, a row that leaves 지금 진행 중 fades where it stands while the rows below glide up and the group's count changes at the same moment, a first
// paint or a refresh with nothing new moves nothing, and with reduced motion every change is instant. Every wait is on the page's own event or state.
const ago = (m: number) => Date.now() - m * 60_000;
const lane = (name: string, i: number) => ({ name, title: `세션 ${name}`, status: "working", startedAt: new Date(ago(30 - i)).toISOString(), model: "anthropic/claude-opus-5-5" });
const hub = fakeHub({
	state: () => idleState({ work_now: Date.now(), lanes: ["a", "b", "c"].map(lane),
		work: [1, 2, 3].map(i => ({ id: `w${i}`, description: `작업 ${i}`, status: "running", started_at: ago(4 + i), model: "Opus 5.5" })), runs: {} }),
});
afterAll(() => hub.stop());

const RUN = '#home-cards .hn[data-k="running"]';
const COUNT = '#home-cards [data-id="now:running"] .hc-n';
const REDUCED = "window.matchMedia = q => /reduced-motion/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : window.fmMM(q)";

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
	describe(`finish motion at ${width}x${height}`, () => {
		setDefaultTimeout(30_000);
		// A fresh page per test: three sessions and three workers run, nothing moves yet.
		const open = async (reduced = false) => {
			const view = await hub.view({ width, height });
			const { waitFor, ev, run } = on(view);
			await view.navigate(`${hub.origin}/#home`);
			await waitFor(`current === "home" && NT.loaded && HOME_READY && document.querySelectorAll('${RUN} .hr').length === 6`);
			await run(`window.fmMM = matchMedia; ${reduced ? REDUCED : ""}`);
			// whatever the first paint started has ended
			await view.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => 0))).then(() => 0)`);
			return { view, ev, run, waitFor };
		};
		const rowOf = (k: string) => `${RUN} .hr[${k.startsWith("w") ? "data-work" : "data-t"}="${k}"]`;
		const top = (k: string) => `Math.round(document.querySelector(${JSON.stringify(rowOf(k))}).getBoundingClientRect().top)`;

		test("a worker that finishes changes in place: the same row, new dot, time and count kept, nothing redrawn from nothing", async () => {
			const { ev, run } = await open();
			const topW = await ev<number>(top("w2"));
			await run(`window.fmRow = document.querySelector(${JSON.stringify(rowOf("w2"))}); window.fmWas = [fmRow.querySelector(".dot").className, fmRow.querySelector(".hs").textContent];
				S.work[1].status = "done"; S.work[1].ended_at = workNow(); renderHomeNow()`);
			expect(await ev(`document.querySelector(${JSON.stringify(rowOf("w2"))}) === fmRow`)).toBe(true);
			expect(await ev(`[fmRow.querySelector(".dot").className !== fmWas[0], fmRow.querySelector(".hs").textContent !== fmWas[1]]`)).toEqual([true, true]);
			expect(await ev(`fmRow.getAnimations().length`)).toBeGreaterThan(0);
			expect(await ev<number>(top("w2"))).toBe(topW);   // it keeps its place in the list
			expect(await ev(`document.querySelector('${COUNT}').textContent`)).toBe("6개");
		});

		test("a session that leaves the group fades where it stands, the rows below glide up, the count changes with it, a redraw in between does not draw it back", async () => {
			const { view, ev, run } = await open();
			const topB = await ev<number>(top("lane:b")), widthB = await ev<number>(`Math.round(document.querySelector(${JSON.stringify(rowOf("lane:b"))}).getBoundingClientRect().width)`);
			const leftB = await ev<number>(`Math.round(document.querySelector(${JSON.stringify(rowOf("lane:b"))}).getBoundingClientRect().left)`);
			await run(`window.fmGone = new Promise(r => document.addEventListener("motion-gone", () => r(1), { once: true })); S.lanes.find(l => l.name === "b").status = "idle"; renderHomeNow()`);
			// mid-motion: still there, lifted, on its own spot (same left and width as before), the row under it inert and moving, the count already new
			expect(await ev(`document.querySelector(${JSON.stringify(rowOf("lane:b"))}).dataset.gone`)).toBe("1");
			expect(await ev(`[Math.round(document.querySelector(${JSON.stringify(rowOf("lane:b"))}).getBoundingClientRect().left), Math.round(document.querySelector(${JSON.stringify(rowOf("lane:b"))}).getBoundingClientRect().width)]`)).toEqual([leftB, widthB]);
			expect(await ev(`document.querySelector(${JSON.stringify(rowOf("lane:c"))}).inert`)).toBe(true);
			expect(await ev(`document.querySelector(${JSON.stringify(rowOf("lane:c"))}).getAnimations().length`)).toBeGreaterThan(0);
			expect(await ev(`document.querySelector('${COUNT}').textContent`)).toBe("5개");
			await run("renderHomeNow()");   // a redraw asked for while it leaves waits for it
			expect(await ev(`document.querySelectorAll('${RUN} [data-t="lane:b"]').length`)).toBe(1);
			await view.evaluate("fmGone");
			expect(await ev(`document.querySelectorAll('${RUN} [data-t="lane:b"]').length`)).toBe(0);
			expect(await ev(`document.querySelector(${JSON.stringify(rowOf("lane:c"))}).inert`)).toBe(false);
			expect(await ev<number>(top("lane:c"))).toBe(topB);
			expect(await ev(`document.querySelector('${COUNT}').textContent`)).toBe("5개");
		});

		test("the first paint and a refresh with no change start no animation", async () => {
			const { ev, run } = await open();
			await run("renderHomeNow(); renderHomeNow()");
			expect(await ev(`document.getAnimations().filter(a => a.constructor === Animation && a.effect && document.querySelector("#v-home").contains(a.effect.target)).length`)).toBe(0);
			expect(await ev(`document.querySelectorAll("#v-home [data-gone]").length`)).toBe(0);
		});

		test("with reduced motion a finished worker changes at once and a leaving session is gone at once", async () => {
			const { ev, run } = await open(true);
			await run(`window.fmRow = document.querySelector(${JSON.stringify(rowOf("w2"))}); S.work[1].status = "done"; S.work[1].ended_at = workNow(); S.lanes.find(l => l.name === "b").status = "idle"; renderHomeNow()`);
			expect(await ev(`[document.querySelector(${JSON.stringify(rowOf("w2"))}) === fmRow, fmRow.getAnimations().length]`)).toEqual([true, 0]);
			expect(await ev(`[document.querySelectorAll('${RUN} [data-t="lane:b"]').length, document.querySelectorAll("#v-home [data-gone]").length, document.querySelector('${COUNT}').textContent]`)).toEqual([0, 0, "5개"]);
			expect(await ev(`document.getAnimations().filter(a => a.constructor === Animation && a.effect && document.querySelector("#v-home").contains(a.effect.target)).length`)).toBe(0);
		});

		// 채팅's list: the same session leaves its 진행 중 group (on a phone the list is the screen the chat tab opens)
		test("the conversation list: a session leaves 진행 중 the same way", async () => {
			const { view, ev, run, waitFor } = await open();
			await run(width < 640 ? 'go("chat", "list")' : 'go("chat", MAIN)');
			await waitFor('current === "chat" && document.querySelectorAll("#chat-convo .cv-row[data-t^=\'lane:\']").length === 3');
			const rows = '#chat-convo .cv-row[data-t="lane:';
			const inCard = (k: string) => `Math.round(document.querySelector('${rows}${k}"]').getBoundingClientRect().top - document.querySelector('${rows}${k}"]').closest(".cv-card").getBoundingClientRect().top)`;   // the page itself may shift as the list gets shorter
			const topB = await ev<number>(inCard("b"));
			await run(`window.fmGone = new Promise(r => document.addEventListener("motion-gone", () => r(1), { once: true })); S.lanes.find(l => l.name === "b").status = "idle"; convSig = ""; convPaint()`);
			expect(await ev(`document.querySelector('${rows}b"]').dataset.gone`)).toBe("1");
			await run("convSig = ''; convPaint()");
			expect(await ev(`document.querySelectorAll('${rows}b"]').length`)).toBe(1);
			await view.evaluate("fmGone");
			expect(await ev(`document.querySelectorAll('${rows}b"]').length`)).toBe(0);
			expect(await ev<number>(inCard("c"))).toBe(topB);
		});
	});
}
