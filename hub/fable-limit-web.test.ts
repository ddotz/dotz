import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// 사용량 → the Claude card draws a model's own weekly row (Fable) under the weekly row like the other limits, and the tightest-limit
// strip keeps reading the 5-hour/weekly windows, never the scoped one.
const lim = (id: string, label: string, used: number, extra: object = {}) => ({ id, label, window: "7d", used, limit: 100, remaining: 100 - used, unit: "percent", resets_at: null, status: "ok", ...extra });
const WEEKLY = lim("anthropic:7d", "Claude 7 Day", 59);
const SCOPED = lim("anthropic:7d:fable", "Claude 7 Day (Fable)", 90, { scope: "Fable", active: false });
let limits: object[] = [WEEKLY, SCOPED];
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/quota" && req.method === "GET") return json({ fetched_at: Date.now(), providers: [{ provider: "anthropic", account: "me@example.com", plan: "Max 5x", limits }], unavailable: [] });
	},
});
afterAll(() => hub.stop());

let v: View;
const q = async <T = unknown>(code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
async function open(rows: object[]) {
	limits = rows;
	v ??= await hub.view({ width: 390, height: 844 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/#usage`);
	await opened;
	await waitFor(v, `typeof go === "function" && typeof S !== "undefined" && S`);
	await run(v, `go("usage")`);
	await waitFor(v, `document.querySelector("#usage .lim")`, 5000);
}
const rows = () => q<string[][]>(`return [...document.querySelectorAll("#usage .lim")].map(r => [r.querySelector(".k").textContent, r.querySelector("b").textContent]);`);

test("the scoped row sits right under the weekly row and reads like it", async () => {
	await open([WEEKLY, SCOPED]);
	expect(await rows()).toEqual([["7일 한도", "41% 남음"], ["7일 한도 (Fable)", "10% 남음"]]);
});

test("without a scoped row the card draws as before", async () => {
	await open([WEEKLY]);
	expect(await rows()).toEqual([["7일 한도", "41% 남음"]]);
});

test("the tightest-limit strip reads the weekly window, not the scoped one", async () => {
	await open([WEEKLY, SCOPED]);
	await waitFor(v, `document.querySelector("#ustrip .ulab")`, 5000);
	expect(await q(`return document.querySelector("#ustrip .ulab").textContent`)).toContain("41%");
});
