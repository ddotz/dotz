import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, on } from "./test-web.ts";

const hub = fakeHub();
const view = await hub.view({ width: 1100, height: 800 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

const sends = () =>
	ev<{ main: boolean; kakao: boolean }>(`(() => {
		const fire = t => { const e = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented; };
		return { main: fire(document.querySelector("#text")), kakao: fire(document.querySelector("#kk-text")) };
	})()`);

const boot = async (width: number) => {
	await view.resize(width, 800);
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof mbCompose === "function" && S && current && document.querySelector("#kk-text")`);
};

describe("Enter in the two composers", () => {
	test("a wide window with a mouse sends from both", async () => {
		await boot(1100);
		expect(await sends()).toEqual({ main: true, kakao: true });
	});

	test("a narrow window with a mouse gives the same answer in both", async () => {
		await boot(500);
		expect(await sends()).toEqual({ main: true, kakao: true });
	});

	test("a touch screen makes a new line in both, whatever the width", async () => {
		for (const width of [1100, 500]) {
			await boot(width);
			await run(`const real = window.matchMedia.bind(window); window.matchMedia = q => (q.includes("pointer: coarse") ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(q))`);
			expect(await sends()).toEqual({ main: false, kakao: false });
		}
	});
});
