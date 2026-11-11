import { afterAll, expect, test } from "bun:test";
import { fakeHub, on } from "./test-web.ts";

// On a phone the toast sits above whatever fixed bar the screen has at the bottom: the tab bar, or the composer inside a conversation.
const hub = fakeHub({ stream: "fake" });
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(view);
const opened = hub.nextStream();
await view.navigate(`${hub.origin}/`);
await opened;
await waitFor(`typeof openTarget === "function" && S && NT.loaded`);

const RECTS = (bar: string) => `JSON.stringify((() => { const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }; return { snack: box(".snack"), bar: box(${JSON.stringify(bar)}) }; })())`;
type Box = { top: number; bottom: number; left: number; right: number };
const apart = async (bar: string) => {
	const { snack, bar: b } = JSON.parse((await view.evaluate(RECTS(bar))) as string) as { snack: Box; bar: Box };
	return snack.bottom <= b.top || snack.top >= b.bottom;
};
const toastAt = async (go: string, ready: string, before = "") => {
	await view.evaluate(`(${go}, 0)`);
	await waitFor(ready);
	if (before) await view.evaluate(`(${before}, 0)`);
	await view.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))).then(() => 0)`);
	await view.evaluate(`(toast("저장했어요"), 0)`);
	await waitFor(`!!document.querySelector(".snack")`);
	await view.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))).then(() => 0)`);
};

test("in a conversation the toast does not cover the composer", async () => {
	await toastAt(`openTarget("main", "chat")`, `current === "chat" && CV.placed && document.querySelector("#composer").getBoundingClientRect().height > 0`);
	expect(await apart("#composer")).toBe(true);
});

// The status line the app draws at the top of the composer while something works (renderWorking); it is inside the composer, so the toast clears it with it.
const STATUS_LINE = `(() => { const box = document.querySelector("#runline"); box.hidden = false; document.querySelector("#runline-tx").textContent = "작업 중…"; })()`;

test("in a conversation the toast does not cover the status line above the input", async () => {
	await toastAt(`openTarget("main", "chat")`, `current === "chat" && CV.placed && document.querySelector("#composer").getBoundingClientRect().height > 0`, STATUS_LINE);
	await waitFor(`document.querySelector("#runline").getBoundingClientRect().height > 0`);
	expect(await apart("#runline")).toBe(true);
	expect(await apart("#composer")).toBe(true);
});

test("on a screen with the tab bar the toast stays above the tab bar", async () => {
	await toastAt(`go("home")`, `current === "home" && document.querySelector("#nav").getBoundingClientRect().height > 0`);
	expect(await apart("#nav")).toBe(true);
});

// A toast speaks about the screen it was raised on (go, 05-command-palette.js).
const SNACK = `(() => { const n = document.querySelector(".snack"); return !n ? "none" : n.style.pointerEvents === "none" ? "leaving" : "up"; })()`;
test("moving to another screen takes the toast down; one raised together with the move, or one that offers 되돌리기, stays", async () => {
	await toastAt(`go("home")`, `current === "home"`);
	expect(await view.evaluate(`(go("settings"), ${SNACK})`)).toBe("leaving");
	await waitFor(`current === "settings" && !document.querySelector(".snack")`);
	expect(await view.evaluate(`(toast("프로젝트를 지웠어요"), go("home"), ${SNACK})`)).toBe("up");
	await waitFor(`current === "home"`);
	await view.evaluate(`(toast("삭제했어요", false, { label: "되돌리기", onclick() {} }), 0)`);
	expect(await view.evaluate(`(go("settings"), ${SNACK})`)).toBe("up");
	await view.evaluate(`(document.querySelectorAll(".snack").forEach(n => n.remove()), go("home"), 0)`);
});

// el() holds a .btn whose handler returns a promise (01-core.js holdWhileSending).
test("a button that sends a request is off until the answer comes, so a second press sends nothing", async () => {
	const r = await view.evaluate(`(async () => {
		let n = 0, done;
		const b = el("button", { class: "btn pri", type: "button", onclick: () => { n++; return new Promise(res => { done = res; }); } }, "보내기");
		document.body.append(b);
		b.click(); const off = b.disabled; b.click(); const sent = n;
		done(); await Promise.resolve(); await Promise.resolve();
		const on = !b.disabled; b.remove();
		return JSON.stringify({ off, sent, on });
	})()`);
	expect(JSON.parse(r as string)).toEqual({ off: true, sent: 1, on: true });
});
