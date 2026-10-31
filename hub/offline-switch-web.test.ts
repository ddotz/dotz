import { afterAll, expect, test } from "bun:test";
import { advanceTimers, ev, fakeHub, run, waitFor } from "./test-web.ts";

// This computer's gateway is off: nothing under /api answers and the owner's custom.js hangs too. The page still finishes loading; when the
// state has not come within a few seconds of opening, it goes to the other computer from the last known list by itself. A page that came by such
// a switch, or one that had reached its gateway before the drop, only shows the header line (a button to the other computer).
let off = false;
let reached: () => void = () => {};
const hub = fakeHub({
	slowTimers: true,
	api: (_req, url) => {
		if (!off || !(url.pathname.startsWith("/api/") || url.pathname === "/custom.js")) return undefined;
		reached();
		return new Promise<Response>(() => {});
	},
});
afterAll(() => hub.stop());
const PEERS = JSON.stringify([{ name: "맥북", url: "https://a.example", self: true, online: true }, { name: "맥미니", url: "https://b.example", self: false, online: false }]);

// A page opened on `path` with the gateway off, its switch caught (prGo), past the wait.
async function openOff(path: string) {
	// its own view, not the shared pool: its last load never ends (the hung requests), so it is closed, not reused
	const v = new Bun.WebView({ width: 390, height: 844 });
	await v.navigate(`${hub.origin}/`);
	await run(v, `localStorage.setItem("dotz-peers", ${JSON.stringify(PEERS)})`);
	// the first page's own fetch on its stream's open (the 빠른 처리 list) has come back, so the first request after `off` is the new page's
	await waitFor(v, `performance.getEntriesByType("resource").some(e => e.name.includes("/api/approvals") && e.responseEnd > 0)`);
	off = true;
	const hung = new Promise<void>(res => { reached = res; });
	void v.navigate(`${hub.origin}${path}`).catch(() => {});
	await hung;   // the new page's first request reached the gateway that does not answer
	await waitFor(v, `document.readyState === "complete" && typeof go === "function"`);
	await run(v, "window.prGo = h => { window.__went = h; }");
	await advanceTimers(v, 4000);
	return v;
}

test("opened while this gateway does not answer, the page loads and goes to the other computer by itself, without a notice", async () => {
	const v = await openOff("/");
	await waitFor(v, "!!window.__went");
	expect(await ev<string>(v, "window.__went")).toStartWith("https://b.example/?did=");
	expect(await ev<string>(v, "window.__went")).toContain("auto=1");
	expect(await ev<number>(v, `document.querySelectorAll(".snack, .toast").length`)).toBe(0);
	v.close();
	off = false;
}, 30_000);

test("a page that came by such a switch does not switch back; its header line is the button to try again", async () => {
	const v = await openOff("/?auto=1");
	await waitFor(v, `!$("#conn").hidden`);
	expect(await ev<string>(v, "window.__went || ''")).toBe("");
	expect(await ev<string>(v, "location.search")).toBe("");
	expect(await ev<string>(v, `$("#conn").textContent`)).toContain("맥미니");
	await run(v, `$("#conn").click()`);
	expect(await ev<string>(v, "window.__went || ''")).toStartWith("https://b.example/");
	v.close();
	off = false;
}, 30_000);
