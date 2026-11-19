import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, run, waitFor } from "./test-web.ts";

const hub = fakeHub({ state: idleState({}) });
afterAll(() => hub.stop());

const fresh = async (width: number, height: number) => {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof ATT !== "undefined" && S`);
	await run(v, `go("chat", MAIN)`);
	await waitFor(v, `current === "chat" && target === MAIN`);
	return v;
};

describe("textarea height with a short visible area", () => {
	test("with the keyboard up in a short viewport the box still keeps one line of room instead of collapsing to nothing", async () => {
		const v = await fresh(390, 844);
		await run(v, `document.documentElement.style.setProperty("--vvh", "150px")`);
		const sizes = JSON.parse(String(await v.evaluate(`JSON.stringify((() => { const s = getComputedStyle(document.querySelector(".sendrow textarea")); return { max: parseFloat(s.maxHeight), min: parseFloat(s.minHeight) }; })())`))) as { max: number; min: number };
		expect(sizes.min).toBeGreaterThan(0);
		expect(sizes.max).toBeGreaterThanOrEqual(sizes.min);
	});
});

describe("keyboard-up detection", () => {
	const src = Bun.file(new URL("../web/js/34-composer-viewport.js", import.meta.url)).text();
	const kbUp = async (typing: boolean, shrink: number) => {
		const v = await fresh(390, 844);
		const out = await v.evaluate(`(async () => {
			const vv = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
			Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
			(0, eval)(${JSON.stringify(await src)});
			const ta = document.querySelector("#text");
			${typing ? "ta.focus();" : "ta.blur();"}
			vv.height = 800 - ${shrink};
			vv.dispatchEvent(new Event("resize"));
			await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
			return String(document.documentElement.hasAttribute("data-kb"));
		})()`);
		return out === "true";
	};

	test("a short keyboard (a compact layout, 120px) counts as up while a field has the focus", async () => {
		expect(await kbUp(true, 120)).toBe(true);
	});

	test("the same 120px shrink with no field focused is the browser's bars, not a keyboard", async () => {
		expect(await kbUp(false, 120)).toBe(false);
	});

	test("a full keyboard (300px) counts as up", async () => {
		expect(await kbUp(true, 300)).toBe(true);
	});
});
