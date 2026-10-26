import { afterEach, expect, test } from "bun:test";
import { cfg } from "./config.ts";
import { routeSettings } from "./routes-settings.ts";

// 설정 → API 월 한도: one 저장 either applies fully or not at all. A key that is refused must not leave the new limit saved behind an error.
const saved = cfg.api_budget;
afterEach(() => {
	cfg.api_budget = saved;
});
const put = (b: unknown) => {
	const url = new URL("http://x/api/api-budget");
	return routeSettings(new Request(url, { method: "PUT", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), url, ["api", "api-budget"]);
};

test("a refused admin key leaves the monthly limit as it was; a good limit alone is saved", async () => {
	const before = (await (await put({ monthly_usd: 40 }))!.json()).monthly_usd;
	expect(before).toBe(40);
	const r = (await put({ monthly_usd: 75, admin_key: "not-an-admin-key" }))!;
	expect(r.status).toBe(400);
	const after = (await (await routeSettings(new Request("http://x/api/api-budget"), new URL("http://x/api/api-budget"), ["api", "api-budget"]))!.json()).monthly_usd;
	expect(after).toBe(40);
});
