import { beforeEach, expect, test } from "bun:test";
import { orgLimits, parseOrgLimits, resetOrgLimitsForTest, sumAdmin } from "./org-limits.ts";

const HEADERS = {
	"anthropic-ratelimit-requests-limit": "1000", "anthropic-ratelimit-requests-remaining": "999", "anthropic-ratelimit-requests-reset": "2026-10-22T06:02:58Z",
	"anthropic-ratelimit-tokens-limit": "2400000", "anthropic-ratelimit-tokens-remaining": "0", "anthropic-ratelimit-tokens-reset": "2026-10-22T06:02:58Z",
	"anthropic-ratelimit-input-tokens-limit": "2000000", "anthropic-ratelimit-input-tokens-remaining": "x",
};

beforeEach(resetOrgLimitsForTest);

test("parses the org-level ratelimit headers into limit rows", () => {
	const limits = parseOrgLimits(new Headers(HEADERS));
	expect(limits.map(l => l.id)).toEqual(["anthropic-org:requests", "anthropic-org:tokens", "anthropic-org:input-tokens"]);
	expect(limits[0]).toMatchObject({ limit: 1000, remaining: 999, used: 1, resets_at: Date.parse("2026-10-22T06:02:58Z"), status: "ok" });
	expect(limits[1]).toMatchObject({ remaining: 0, used: 2400000, status: "exhausted" });
	expect(limits[2]).toMatchObject({ limit: 2000000, remaining: null, used: null, resets_at: null });
	expect(parseOrgLimits(new Headers())).toEqual([]);
});

test("sums admin usage tokens and cost cents", () => {
	const usage = { data: [{ results: [{ uncached_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 3 } }] }, { results: [{ uncached_input_tokens: 1, output_tokens: 2 }] }] };
	const cost = { data: [{ results: [{ amount: "150.5" }, { amount: "49.5" }] }] };
	expect(sumAdmin(usage, cost)).toEqual({ input_tokens: 19, output_tokens: 9, cost_usd: 2 });
	expect(sumAdmin({}, {})).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: null });
});

test("caches the result for 10 minutes and names a missing admin key", async () => {
	const urls: string[] = [];
	const fake = (async (url: string) => { urls.push(url); return new Response("{}", { headers: HEADERS }); }) as unknown as typeof fetch;
	const keys = { api: "sk-ant-test", admin: "" };
	const t = Date.now();
	const first = await orgLimits(fake, t, keys);
	await orgLimits(fake, t + 9 * 60_000, keys);
	expect(urls).toEqual(["https://api.anthropic.com/v1/messages"]);
	expect(first.limits.length).toBe(3);
	expect(first.admin).toBeNull();
	expect(first.unavailable).toEqual([{ item: "사용량·비용", reason: "관리자 키(sk-ant-admin)가 필요해요" }]);
	await orgLimits(fake, t + 11 * 60_000, keys);
	expect(urls.length).toBe(2);
});
