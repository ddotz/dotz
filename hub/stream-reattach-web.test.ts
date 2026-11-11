import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { advanceSettled, advanceTimers, ev, fakeHub, inbox, json, on, run } from "./test-web.ts";
import { broadcast, sseResponse } from "./events.ts";

// A stream the gateway drops and the page attaches again changes nothing the owner sees, and a hidden page keeps its stream with one tiny request a minute.
const at = (n: number) => `2026-11-10T01:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`;
const history = Array.from({ length: 60 }, (_, i) => (i % 3 === 0
	? { ts: at(i), kind: "message", source: "web", target: "web", mid: `m${i}`, text: `질문 ${i}: 어제 정리한 일을 다시 알려 주세요` }
	: { ts: at(i), kind: "out", source: "orchestrator", target: "web", text: `답 ${i}: 정리한 일은 세 가지예요. 첫째는 목록 화면이고 둘째는 설정 화면이에요.` }));

const opens = inbox<{ last: string | null; live: string | null }>();
const closes = inbox<number>();
const reqs = inbox<string>();
const vouched = inbox<string | null>();
const ends = new Set<() => void>();
let forceReset = false;
const enc = new TextEncoder();

async function events(req: Request, url: URL): Promise<Response> {
	const last = req.headers.get("last-event-id") ?? url.searchParams.get("last");
	opens.push({ last, live: url.searchParams.get("live") });
	const src = sseResponse(forceReset ? "other-1" : last, req.signal).body!.getReader();
	const end = () => void src.cancel();
	ends.add(end);
	const body = new ReadableStream<Uint8Array>({
		async pull(c) { const r = await src.read(); if (r.done) { ends.delete(end); c.close(); } else c.enqueue(enc.encode(r.value)); },
		cancel() { ends.delete(end); closes.push(1); return src.cancel(); },
	});
	return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

const hub = fakeHub({
	slowTimers: true,
	api: (req, url) => {
		reqs.push(url.pathname);
		if (url.pathname === "/api/health") vouched.push(req.headers.get("x-dotz-live"));
		if (url.pathname === "/api/events") return events(req, url);
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: history });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(view);
const SHOTS = process.env.SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const look = () => ev<Record<string, unknown>>(view, `({
	rows: [...tl.querySelectorAll("[data-ts]")].map(n => n.dataset.ts).join(","),
	scroll: Math.round(timeline.scrollTop),
	draft: ta.value,
	conn: !$("#conn").hidden,
	banner: window.__banner,
	toasts: document.querySelectorAll(".snack, .toast, .ntf-box > *").length,
	removed: window.__removed,
	kept: window.__kept.every(n => n.isConnected),
})`);
const shot = async (name: string) => {
	await waitFor(`document.getAnimations().every(a => a.playState !== "running")`);
	const png = Buffer.from(await (await view.screenshot()).arrayBuffer());
	if (SHOTS) await Bun.write(join(SHOTS, name), png);
	return png;
};
const setVisible = (visible: boolean) => run(view, `window.__vis = ${visible ? '"visible"' : '"hidden"'}; document.dispatchEvent(new Event("visibilitychange"))`);

async function ready() {
	opens.length = 0; closes.length = 0; forceReset = false;
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await opens.until(a => a.length >= 1);
	await run(view, `
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis });
		Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__vis !== "visible" });
		window.__vis = "visible";
		openTarget("main", "chat");`);
	await waitFor(`tl.querySelectorAll("[data-ts]").length >= 60`);
	// The other reads the open started (state, activity, notices) draw and may stick the view to the bottom when they land: scroll only after they have.
	await advanceSettled(view, 0);
	await run(view, `
		ta.value = "보내지 않은 초안 글"; ta.dispatchEvent(new Event("input", { bubbles: true }));
		timeline.scrollTop = 300;
		document.head.append(Object.assign(document.createElement("style"), { textContent: "* { caret-color: transparent !important }" }));
		window.__conn = []; const real = window.setConn; window.setConn = ok => { window.__conn.push(ok ? "T" : "F"); return real(ok); };
		window.__banner = 0; new MutationObserver(() => { if (!$("#conn").hidden) window.__banner++; }).observe($("#conn"), { attributes: true });
		window.__removed = 0; window.__kept = [...tl.querySelectorAll("[data-ts]")];
		new MutationObserver(ms => { for (const m of ms) window.__removed += m.removedNodes.length; }).observe(tl, { childList: true, subtree: true });`);
	await waitFor(`Math.round(timeline.scrollTop) === 300 && chatStick === false`);
}

for (const [name, reset] of [["the gateway ends the stream and the page attaches it again", false], ["the gap is too long to replay and the gateway sends a reset", true]] as const) {
	test(`${name}: nothing on screen changes`, async () => {
		await ready();
		const before = await look(), pngBefore = await shot(`before-${reset ? "reset" : "drop"}.png`);
		const n = opens.length, mark = reqs.length, seen = await ev<number>(view, `window.__conn.length`);
		forceReset = reset;
		for (const end of [...ends]) end();
		await opens.until(a => a.length >= n + 1, 2000, "stream attached again before the browser's own wait");
		// The drop (F) and the open that follows it (T), not a T from an earlier state read. A reset makes the page read its state again: that request is what
		// virtual time must not overtake (its 2 s wait would show the banner), so it is awaited before time moves.
		await waitFor(`window.__conn.slice(${seen}).join("").includes("FT")`);
		if (reset) await reqs.until(r => r.slice(mark).includes("/api/state"), 2000, "the state read after the reset");
		await advanceSettled(view, 10_000);
		const after = await look(), pngAfter = await shot(`after-${reset ? "reset" : "drop"}.png`);
		expect(after).toEqual(before);
		expect(after.conn).toBe(false);
		expect(after.toasts).toBe(0);
		expect(pngAfter.equals(pngBefore)).toBe(true);
	}, 40_000);
}

test("a hidden page keeps its stream and its tab title count rises, vouching once a minute and polling nothing else", async () => {
	await ready();
	const n = opens.length, live = opens[0]!.live;
	await setVisible(false);
	await advanceTimers(view, 120_000);
	await vouched.until(v => v.length >= 1, 5000, "the first vouching request");
	await waitFor(`!apiGets.has("/api/health")`);
	const first = vouched.length, mark = reqs.length;
	for (let minute = 1; minute <= 5; minute++) {
		await advanceTimers(view, 60_000);
		await vouched.until(v => v.length >= first + minute, 5000, "one vouching request for the minute");
		await waitFor(`!apiGets.has("/api/health")`);
	}
	await view.evaluate(`fetch("/api/probe").then(() => 1)`);
	expect(reqs.slice(mark).filter(p => p !== "/api/probe")).toEqual(Array(5).fill("/api/health"));
	expect(vouched.slice(first).every(v => v === live)).toBe(true);
	broadcast({ ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web", text: "숨은 탭에서 받은 답이에요" });
	await waitFor(`document.title.startsWith("(1)")`);
	await setVisible(true);
	expect(opens.length).toBe(n);
}, 40_000);
