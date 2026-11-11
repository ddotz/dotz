import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, run, waitFor, type View } from "./test-web.ts";
import { cardHub } from "./test-pane-cards.ts";

// The cards of a conversation (web/css, @container tlcol) fold by the width of the column they are drawn in, not the window's: the same conversation
// in a 390px window and in a 390px pane of a 1280px window lays each card kind out the same, and no pane width down to 280px pushes anything past the pane's edge.
const hub = fakeHub(cardHub);
afterAll(() => hub.stop());

const KINDS: Record<string, string> = { attachments: ".um .mfiles", table: ".md table", code: ".bm pre", decision: ".dc-rec", result: ".bm.res", task: ".cv-tasks", mail: ".bm.rc" };
const FILLED = `.bm, .um, .dc-rec, .cv-tasks`;
const paneTl = (i: number) => `document.querySelectorAll("#split .pane")[${i}].querySelector(".timeline")`;

const phone = async (width: number): Promise<View> => {
	const v = await hub.view({ width, height: 844 }, "/#chat");
	await waitFor(v, `target === "main" && CV.placed && tl.querySelectorAll("${FILLED}").length >= 6`);
	return v;
};
// Two panes on a 1280px window with the left pane `w` wide; `active` says which pane holds the real conversation, the other is the mirror.
const panes = async (w: number, active: 0 | 1): Promise<View> => {
	const v = await phone(1280);
	await run(v, `paneSplit("lane:가나", "chat", "right")`);
	await waitFor(v, `document.querySelectorAll("#split .pane").length === 2 && document.querySelector("#split .pane.on") && CV.placed`);
	await run(v, `paneFocus(paneList()[${active}].id)`);
	await waitFor(v, `document.querySelectorAll("#split .pane")[${active}].classList.contains("on") && CV.placed`);
	await run(v, `(() => { const box = document.querySelector("#split .pane-row"), bar = box.querySelector(".pane-bar"); PN.root.r = ${w} / (box.getBoundingClientRect().width - bar.offsetWidth); paneShare(PN.root, box); })()`);
	await waitFor(v, `Math.abs(document.querySelectorAll("#split .pane")[0].getBoundingClientRect().width - ${w}) < 1`);
	await waitFor(v, `${paneTl(0)}.querySelectorAll("${FILLED}").length >= 6 && ${paneTl(1)}.querySelectorAll("${FILLED}").length >= 6`);
	return v;
};

type Card = { ratio: number; lines: number; layout: string[] } | null;
type Measured = { cards: Record<string, Card>; over: string[] };
// Per card kind: its width against the column, the line count of its text, and the display / flex direction / wrap / grid track count of it and everything inside.
const measureIn = (v: View, tl: string): Promise<Measured> => ev<Measured>(v, `(() => {
	const tl = ${tl}, kinds = ${JSON.stringify(KINDS)}, pane = tl.closest(".pane") || document.querySelector("#v-chat");
	const edge = pane.getBoundingClientRect().right, col = tl.querySelector(".tl-in").getBoundingClientRect().width;
	const lines = e => { const rg = document.createRange(); rg.selectNodeContents(e); return new Set([...rg.getClientRects()].filter(q => q.width > 0).map(q => Math.round(q.top))).size; };
	const cards = {};
	for (const [name, sel] of Object.entries(kinds)) {
		const e = tl.querySelector(sel);
		if (!e) { cards[name] = null; continue; }
		const layout = [e, ...e.querySelectorAll("*")].slice(0, 400).map(k => ({ k, c: getComputedStyle(k) })).filter(({ c }) => /flex|grid/.test(c.display))
			.map(({ k, c }) => [k.tagName.toLowerCase(), String(k.className), c.display, c.flexDirection, c.flexWrap, c.gridTemplateColumns === "none" ? 0 : c.gridTemplateColumns.split(" ").length].join("|"));
		cards[name] = { ratio: Math.round(e.getBoundingClientRect().width / col * 10) / 10, lines: lines(e), layout };
	}
	const scrolls = [...tl.querySelectorAll("*")].filter(k => ["auto", "scroll"].includes(getComputedStyle(k).overflowX));
	const over = [...tl.querySelectorAll("*")].filter(k => {
		const b = k.getBoundingClientRect();
		return b.width && b.right > edge + 0.5 && getComputedStyle(k).position !== "fixed" && !scrolls.some(s => s !== k && s.contains(k));
	}).map(k => k.tagName.toLowerCase() + "." + String(k.className));
	return { cards, over };
})()`);

test("the same conversation lays each card kind out alike in a 390 window and in a 390 pane, real or mirror", async () => {
	const alone = await measureIn(await phone(390), `document.querySelector("#timeline")`);
	const real = await measureIn(await panes(390, 0), paneTl(0));
	const mirror = await measureIn(await panes(390, 1), paneTl(0));
	for (const [name, base] of Object.entries(alone.cards)) {
		expect(base, name).not.toBeNull();
		for (const [where, m] of [["real", real], ["mirror", mirror]] as const) {
			const c = m.cards[name];
			expect(c, `${name} ${where}`).not.toBeNull();
			expect(Math.abs(c!.ratio - base!.ratio), `${name} ${where} width ratio`).toBeLessThan(0.11);
			expect(c!.lines, `${name} ${where} lines`).toBe(base!.lines);
			expect(c!.layout, `${name} ${where} layout`).toEqual(base!.layout);
		}
	}
}, 60_000);

test("no pane width down to 280 pushes anything in the timeline past the pane's right edge", async () => {
	for (const w of [280, 340, 390]) {
		expect((await measureIn(await panes(w, 0), paneTl(0))).over, `real ${w}`).toEqual([]);
		expect((await measureIn(await panes(w, 1), paneTl(0))).over, `mirror ${w}`).toEqual([]);
	}
}, 120_000);

test("every timeline is the one container the narrow card rules ask", async () => {
	const name = `(t) => getComputedStyle(t).containerName + "|" + getComputedStyle(t).containerType`;
	expect(await ev(await phone(390), `(${name})(document.querySelector("#timeline"))`)).toBe("tlcol|inline-size");
	const v = await panes(340, 0);
	expect(await ev(v, `(${name})(${paneTl(0)})`)).toBe("tlcol|inline-size");
	expect(await ev(v, `(${name})(${paneTl(1)})`)).toBe("tlcol|inline-size");
}, 60_000);
