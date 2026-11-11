import { afterAll, expect, test } from "bun:test";
import { advanceTimers, fakeHub, inbox, on, run } from "./test-web.ts";
import { sseResponse } from "./events.ts";

// Behind a reverse proxy that answers 502 while the gateway restarts, the browser ends the stream in CLOSED and never tries again: the page opens it again itself.
const attempts = inbox<number>();
const ends = new Set<() => void>();
let failNext = 0, down = false;
const enc = new TextEncoder();

async function events(req: Request, url: URL): Promise<Response> {
	if (down || failNext > 0) {
		if (failNext > 0) failNext--;
		attempts.push(502);
		return new Response("bad gateway", { status: 502 });
	}
	attempts.push(200);
	const src = sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"), req.signal).body!.getReader();
	const end = () => void src.cancel();
	ends.add(end);
	const body = new ReadableStream<Uint8Array>({
		async pull(c) { const r = await src.read(); if (r.done) { ends.delete(end); c.close(); } else c.enqueue(enc.encode(r.value)); },
		cancel() { ends.delete(end); return src.cancel(); },
	});
	return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

const hub = fakeHub({
	slowTimers: true,
	api: (req, url) => (url.pathname === "/api/events" ? events(req, url) : undefined),
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(view);

async function ready() {
	attempts.length = 0; failNext = 0; down = false;
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await attempts.until(a => a.length >= 1);
	await waitFor(`everConnected`);
	await run(view, `window.__f = 0; const real = window.setConn; window.setConn = ok => { if (!ok) window.__f++; return real(ok); };
		window.__banner = 0; new MutationObserver(() => { if (!$("#conn").hidden) window.__banner++; }).observe($("#conn"), { attributes: true });`);
}
const banner = () => view.evaluate(`window.__banner`) as Promise<number>;

test("the stream answers 502 twice, then works: the page is attached again with no user event and shows no banner", async () => {
	await ready();
	failNext = 2;
	for (const end of [...ends]) end();
	await attempts.until(a => a.length >= 4, 8000, "502, 502, then the stream");
	expect(attempts.slice(1)).toEqual([502, 502, 200]);
	await waitFor(`$("#conn").hidden`);
	expect(await banner()).toBe(0);
}, 40_000);

test("a gateway that stays down is tried again with growing waits, the header line comes after 2 s, and the page attaches by itself once it answers", async () => {
	await ready();
	down = true;
	for (const end of [...ends]) end();
	await attempts.until(a => a.length >= 4, 8000, "first tries");
	for (let step = 0; step < 8; step++) {
		const n = attempts.length;
		for (let i = 0; i < 20 && attempts.length === n; i++) {
			await advanceTimers(view, 5_000);
			await attempts.until(a => a.length > n, 250).catch(() => undefined);
		}
		expect(attempts.length).toBe(n + 1);
	}
	await waitFor(`window.__f === ${attempts.filter(a => a === 502).length + 1}`);
	await advanceTimers(view, 2_500);
	await waitFor(`!$("#conn").hidden`);
	down = false;
	await advanceTimers(view, 6_000);
	await attempts.until(a => a[a.length - 1] === 200, 8000, "attached again");
	await waitFor(`$("#conn").hidden`);
}, 40_000);
