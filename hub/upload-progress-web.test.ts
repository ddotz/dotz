// The composer's upload chip, headless (Bun.WebView) against a fake hub. XMLHttpRequest is a page-side fake the test drives by hand, so a percent
// is what the test says it is and no assertion leans on how fast a socket goes. An upload lives in a store by conversation, not in the tray:
// it outlives a repaint of the tray and a move to another conversation, and × aborts it.
// UPLOAD_SHOTS=<dir> keeps screenshots at 390 and 1280, light and dark (default: none).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, idleState, json, run, type View, waitFor } from "./test-web.ts";

const SHOTS = process.env.UPLOAD_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const MB = 1048576;
const hub = fakeHub({
	state: idleState({ upload_max: 50 * MB }),
	api: (_req, url) => {
		if (url.pathname === "/api/conversations") return json({ items: [{ target: "mail:fx-a", unread: 0, read: "", mail: { subject: "견적", from: "Kim", source: "mail", at: "2026-10-27T09:00:00Z", summary: "", reply: "" }, last: { ts: "2026-10-27T09:00:00Z", text: "메일", from: "bot" } }] });
		return undefined;
	},
});
afterAll(() => hub.stop());

// Every request the page opens lands in XHRS; the test plays the browser's side of it.
const FAKE_XHR = `window.XHRS = []; window.XMLHttpRequest = class { upload = {}; status = 0; responseText = ""; open(m, u) { this.url = u; } send(b) { this.body = b; XHRS.push(this); } abort() { this.aborted = true; this.onabort && this.onabort(); } getResponseHeader() { return null; } }`;
const answer = (i: number, name: string, size: number) => `XHRS[${i}].status = 200; XHRS[${i}].responseText = JSON.stringify({ ok: true, files: [{ path: "/uploads/${name}", name: "${name}", type: "", size: ${size} }] }); XHRS[${i}].onload()`;
const add = (name: string, size: number) => `{ const f = new File(["x"], "${name}"); Object.defineProperty(f, "size", { value: ${size} }); addFiles([f]); }`;
// A long upload: its start moved far enough back that the next progress event shows the ring.
const slow = (i: number, sent: number, size: number) => `UPS[target][ATT[${i}].id].at = 0; XHRS[${i}].upload.onprogress({ lengthComputable: true, loaded: ${sent}, total: ${size} })`;
const chip = (i = 0) => ev<{ pct: string; p: string; meta: string; name: string }>(view, `(() => { const c = document.querySelectorAll("#atray .fatt")[${i}], r = c.querySelector(".pring"); return { pct: r ? r.textContent : "", p: r ? r.style.getPropertyValue("--p") : "", meta: c.querySelector(".fi-m").textContent, name: c.querySelector(".fi-n").textContent }; })()`);
let view: View;
const fresh = async (width = 1280, height = 800) => {
	view = await hub.view({ width, height });
	await view.navigate(`${hub.origin}/`);
	await waitFor(view, `typeof ATT !== "undefined" && S`);
	await run(view, `localStorage.clear(); ${FAKE_XHR}; go("chat", MAIN)`);
	await waitFor(view, `current === "chat" && target === MAIN`);
	return view;
};
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };

describe("upload chip", () => {
	test("progress reaches the chip as a ring with the percent, and the sizes in the sub line", async () => {
		const v = await fresh();
		await run(v, add("26.2Q 주석.7z.001", 40 * MB));
		await waitFor(v, `XHRS.length === 1`);
		await run(v, slow(0, 12 * MB, 40 * MB));
		expect(await chip()).toEqual({ pct: "30%", p: "30", meta: "12MB / 40MB", name: "26.2Q 주석.7z.001" });
		await run(v, `XHRS[0].upload.onprogress({ lengthComputable: true, loaded: ${20 * MB}, total: ${40 * MB} })`);
		expect(await chip()).toEqual({ pct: "50%", p: "50", meta: "20MB / 40MB", name: "26.2Q 주석.7z.001" });
		await run(v, answer(0, "a.7z", 40 * MB));
		await waitFor(v, `ATT[0].file`);
		expect(await chip()).toMatchObject({ pct: "", meta: "001 · 40.0MB" });
	});

	test("a short upload never shows a ring: the chip reads the same before and after", async () => {
		const v = await fresh();
		await run(v, add("작은파일.txt", 2048));
		await waitFor(v, `XHRS.length === 1`);
		await run(v, `XHRS[0].upload.onprogress({ lengthComputable: true, loaded: 1024, total: 2048 })`);
		const during = await chip();
		await run(v, answer(0, "s.txt", 2048));
		await waitFor(v, `ATT[0].file`);
		expect(during).toEqual(await chip());
		expect(during.pct).toBe("");
	});

	test("the store survives a repaint of the tray: a chip built again shows the live percent", async () => {
		const v = await fresh();
		await run(v, add("a.zip", 40 * MB));
		await waitFor(v, `XHRS.length === 1`);
		await run(v, slow(0, 10 * MB, 40 * MB));
		await run(v, `$("#atray").replaceChildren(); renderAtt()`);
		expect(await chip()).toMatchObject({ pct: "25%", meta: "10MB / 40MB" });
	});

	test("two files, two rings", async () => {
		const v = await fresh();
		await run(v, `${add("a.zip", 40 * MB)} ${add("b.zip", 20 * MB)}`);
		await waitFor(v, `XHRS.length === 2`);
		await run(v, `${slow(0, 4 * MB, 40 * MB)}; ${slow(1, 15 * MB, 20 * MB)}`);
		expect([(await chip(0)).pct, (await chip(1)).pct]).toEqual(["10%", "75%"]);
	});

	test("leaving and coming back: the chip shows the live percent, and sending still waits for the file", async () => {
		const v = await fresh();
		await run(v, `${add("a.zip", 40 * MB)}; ta.value += "이 파일 봐 줘"`);
		await waitFor(v, `XHRS.length === 1`);
		await run(v, slow(0, 4 * MB, 40 * MB));
		await shot(v, "before-leaving-1280.png");
		await run(v, `setTarget("mail:fx-a")`);
		expect(await ev(v, `$("#atray").hidden`)).toBe(true);
		await run(v, `XHRS[0].upload.onprogress({ lengthComputable: true, loaded: ${30 * MB}, total: ${40 * MB} })`);
		await run(v, `setTarget(MAIN)`);
		expect(await chip()).toMatchObject({ pct: "75%", meta: "30MB / 40MB" });
		await shot(v, "back-mid-upload-1280.png");
		await run(v, `sendChat()`);
		expect(await ev(v, `ATT.length`)).toBe(1);
	});

	test("an upload that ends while the owner is elsewhere is in the draft of its conversation, across a reload too", async () => {
		const v = await fresh();
		await run(v, add("a.zip", 40 * MB));
		await waitFor(v, `XHRS.length === 1`);
		const own = await ev<string>(v, `target`);
		await run(v, `setTarget("mail:fx-a"); ${answer(0, "a.zip", 40 * MB)}`);
		await waitFor(v, `ts(MAIN).att[0].file`);
		expect(await ev(v, `JSON.parse(localStorage.getItem(ATT_KEY(${JSON.stringify(own)}))).map(a => a.file.path)`)).toEqual(["/uploads/a.zip"]);
		await run(v, `setTarget(MAIN)`);
		expect(await chip()).toMatchObject({ pct: "", name: "a.zip" });
	});

	test("× aborts the upload and takes the chip and its token away", async () => {
		const v = await fresh();
		await run(v, add("a.zip", 40 * MB));
		await waitFor(v, `XHRS.length === 1`);
		await run(v, slow(0, 4 * MB, 40 * MB));
		await run(v, `$("#atray .ax").click()`);
		expect(await ev(v, `({ aborted: XHRS[0].aborted, n: ATT.length, gone: atkGone().length, text: ta.value.trim(), jobs: Object.keys(UPS[target] || {}).length })`)).toEqual({ aborted: true, n: 0, gone: 0, text: "", jobs: 0 });
	});

	test("a failure shows the reason and a retry on the chip; the retry sends the same file again and sending stays blocked until then", async () => {
		const v = await fresh();
		await run(v, add("a.zip", 40 * MB));
		await waitFor(v, `XHRS.length === 1`);
		await run(v, `XHRS[0].onerror()`);
		await waitFor(v, `document.querySelector("#atray .up-retry")`);
		expect(await chip()).toMatchObject({ meta: "연결이 끊겼어요" });
		await shot(v, "failed-1280.png");
		await run(v, `sendChat()`);
		expect(await ev(v, `ATT.length`)).toBe(1);
		await run(v, `$("#atray .up-retry").click()`);
		await waitFor(v, `XHRS.length === 2`);
		await run(v, answer(1, "a.zip", 40 * MB));
		await waitFor(v, `ATT[0].file`);
		expect(await ev(v, `document.querySelector("#atray .up-retry")`)).toBe(null);
	});

	test("a file over the hub's limit is refused before any byte goes, with its size in the message", async () => {
		const v = await fresh();
		await run(v, add("big.7z.001", 340 * MB));
		await waitFor(v, `[...document.querySelectorAll(".snack span")].some(s => s.textContent.includes("340MB") && s.textContent.includes("최대 50MB"))`);
		expect(await ev(v, `({ sent: XHRS.length, n: ATT.length })`)).toEqual({ sent: 0, n: 0 });
	});

	test("beforeunload is held only while an upload runs", async () => {
		const v = await fresh();
		const asks = `(() => { const e = new Event("beforeunload", { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })()`;
		expect(await ev(v, asks)).toBe(false);
		await run(v, add("a.zip", 40 * MB));
		await waitFor(v, `XHRS.length === 1`);
		expect(await ev(v, asks)).toBe(true);
		await run(v, answer(0, "a.zip", 40 * MB));
		await waitFor(v, `ATT[0].file`);
		expect(await ev(v, asks)).toBe(false);
	});
});
