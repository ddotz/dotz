import { afterAll, expect, test } from "bun:test";
import { advanceTimers, ev, fakeHub, run, waitFor } from "./test-web.ts";

// This computer's gateway is off: nothing under /api answers and the owner's custom.js hangs too. The page still finishes loading, and
// once the state has not come for a few seconds the header offers the other computer from the last known list; the tap switches.
let off = false;
let reached: () => void = () => {};
const hung = new Promise<void>(res => { reached = res; });
const hub = fakeHub({
	slowTimers: true,
	api: (_req, url) => {
		if (!off || !(url.pathname.startsWith("/api/") || url.pathname === "/custom.js")) return undefined;
		reached();
		return new Promise<Response>(() => {});
	},
});
afterAll(() => hub.stop());

test("with this gateway not answering, the page loads and the header switches to the other computer", async () => {
	// its own view, not the shared pool: its last load never ends (the hung requests), so it is closed, not reused
	const v = new Bun.WebView({ width: 390, height: 844 });
	await v.navigate(`${hub.origin}/`);
	await run(v, `localStorage.setItem("dotz-peers", JSON.stringify([{ name: "맥북", url: "https://a.example", self: true, online: true }, { name: "맥미니", url: "https://b.example", self: false, online: false }]))`);
	off = true;
	void v.navigate(`${hub.origin}/`).catch(() => {});
	await hung;   // the new page's first request reached the gateway that does not answer
	await waitFor(v, `document.readyState === "complete" && typeof go === "function"`);
	expect(await ev<boolean>(v, `$("#conn").hidden`)).toBe(true);
	await advanceTimers(v, 4000);
	await waitFor(v, `!$("#conn").hidden`);
	expect(await ev<string>(v, `$("#conn").textContent`)).toContain("맥미니");
	await run(v, `window.prGo = h => { window.__went = h; }; $("#conn").click()`);
	expect(await ev<string>(v, `window.__went || ""`)).toStartWith("https://b.example/");
	v.close();
}, 30_000);
