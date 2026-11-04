import { afterAll, expect, test } from "bun:test";
import { ev as evOn, fakeHub, json, run, waitFor } from "./test-web.ts";

// Switching screens: a conversation already in the store is shown at once and refreshed behind it, and one drawn and unchanged keeps its rows.
const out = (target: string, ts: string, text: string) => ({ kind: "out", source: "orchestrator", target, ts, text });
const OLD = out("alert", "2026-11-04T01:00:00.000Z", "지난 알림이에요");
const NEW = out("alert", "2026-11-04T02:00:00.000Z", "새로 온 알림이에요");
let alertBody = [OLD];
let holdAlert: Promise<void> = Promise.resolve();
let release = () => {};

const hub = fakeHub({
	api: async (_req, url) => {
		if (url.pathname !== "/api/history") return undefined;
		const t = url.searchParams.get("target");
		if (t === "alert") { await holdAlert; return json({ events: alertBody }); }
		if (t === "worklog") return json({ events: [] });
		return json({ events: [out(t ?? "", "2026-11-04T00:00:00.000Z", "안녕하세요")] });
	},
});
afterAll(() => hub.stop());
const timelineText = `document.querySelector("#timeline").innerText`;

test("a conversation left and reopened with nothing new keeps its rows; one that got a message while away draws it", async () => {
	const v = await hub.view({}, "/");
	const ev = <T>(x: string) => evOn<T>(v, x);
	await run(v, `go("chat")`);
	await waitFor(v, `document.querySelector("#timeline [data-ts]")`);
	await run(v, `window.__row = document.querySelector("#timeline [data-ts]"); go("home"); go("chat")`);
	expect(await ev<boolean>(`window.__row.isConnected`)).toBe(true);
	await run(v, `go("home"); ingestMsg({ kind: "out", source: "orchestrator", target, ts: "2026-11-04T03:00:00.000Z", text: "자리 비운 사이에 왔어요" }); go("chat")`);
	expect(await ev<boolean>(`window.__row.isConnected`)).toBe(false);
	expect(await ev<string>(timelineText)).toContain("자리 비운 사이에 왔어요");
});

test("back from the background a cached conversation shows at once, and the refresh behind it adds the new message in place", async () => {
	const v = await hub.view({}, "/");
	await run(v, `openTarget("alert", "chat")`);
	await waitFor(v, `document.querySelector("#timeline").innerText.includes("지난 알림이에요")`);
	await run(v, `go("chat", "main")`);
	await waitFor(v, `target === "main" && document.querySelector("#timeline [data-ts]")`);
	alertBody = [OLD, NEW];
	holdAlert = new Promise(res => { release = res; });
	await run(v, `resync(); openTarget("alert", "chat"); window.__seen = document.querySelector("#timeline").innerText`);
	const seen = await evOn<string>(v, `window.__seen`);
	expect(seen).toContain("지난 알림이에요");
	expect(seen).not.toContain("불러오는 중");
	release();
	await waitFor(v, `document.querySelector("#timeline").innerText.includes("새로 온 알림이에요")`);
	expect(await evOn<string>(v, timelineText)).toContain("지난 알림이에요");
});
