import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, run, waitFor } from "./test-web.ts";

// A menu fades out the way a dialog does (closeMenu in web/js/03-menu.js): the state is released at once (focus on the anchor, aria-expanded false,
// no open menu), the node carries [data-leaving] while it fades and is gone after; a second menu that opens meanwhile is the only one left.
const hub = fakeHub({});
afterAll(() => hub.stop());

const SETUP = `(() => {
	for (const id of ["a1", "a2"]) { const b = document.createElement("button"); b.id = id; b.textContent = id; document.body.append(b); }
	window.__picked = [];
	window.__open = (id, sheet) => showMenu(document.getElementById(id), [{ value: "x", label: "하나" }, { value: "y", label: "둘" }], { onPick: v => window.__picked.push(v), sheet });
})()`;

for (const [name, width, sheet] of [["a dropdown on a wide screen", 1280, false], ["a menu sheet on a phone", 390, true]] as const) {
	test(`${name} leaves the DOM after a pick and focus is back on its anchor`, async () => {
		const v = await hub.view({ width, height: 844 }, "/");
		await waitFor(v, `typeof showMenu === "function"`);
		await run(v, `${SETUP}; window.__node = null; window.__open("a1", ${sheet}); window.__node = document.querySelector(".menu")`);
		await waitFor(v, `document.querySelector(".menu .mi")`);
		expect(await ev<string>(v, `getComputedStyle(__node).animationDuration`)).toBe(sheet ? "0.22s" : "0.15s");
		await run(v, `document.querySelector(".menu .mi").click()`);
		const now = await ev<{ leaving: string | null; open: boolean; expanded: string | null; focus: boolean; picked: string[] }>(v, `({ leaving: __node.dataset.leaving ?? null, open: typeof openMenu !== "undefined" && !!openMenu, expanded: a1.getAttribute("aria-expanded"), focus: document.activeElement === a1, picked: __picked })`);
		expect(now).toEqual({ leaving: "1", open: false, expanded: "false", focus: true, picked: ["x"] });
		await waitFor(v, `!__node.isConnected`);
		expect(await ev<number>(v, `document.querySelectorAll(".menu").length`)).toBe(0);
	});
}

test("a second menu that opens while the first fades is the only one in the DOM", async () => {
	const v = await hub.view({ width: 1280, height: 844 }, "/");
	await waitFor(v, `typeof showMenu === "function"`);
	await run(v, `${SETUP}; window.__open("a1", false)`);
	await waitFor(v, `document.querySelector(".menu .mi")`);
	await run(v, `closeMenu(); window.__open("a2", false)`);
	expect(await ev<{ n: number; leaving: number; open: string | null }>(v, `({ n: document.querySelectorAll(".menu").length, leaving: document.querySelectorAll(".menu[data-leaving]").length, open: openMenu && openMenu.anchor.id })`)).toEqual({ n: 1, leaving: 0, open: "a2" });
	await run(v, `closeMenu()`);
	await waitFor(v, `!document.querySelector(".menu")`);
});
