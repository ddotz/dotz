// The Claude 리셋권 (hub/usage-account.ts claudeResets, hub/claude-reset.ts) against a fake upstream only: the usage GET carries the
// cedar_ember query and a Claude Code user-agent, the count is parsed per kind, and POST /api/quota/reset-credit with provider
// "anthropic" spends one only with confirm: true, after a fresh read. This file's own OmO agent dir holds fake accounts, so no test
// reads the machine's auth.json, keychain or Claude CLI dir; every request goes to the fake, which throws on any other URL.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useClaudeReset } from "./claude-reset.ts";
import { paths } from "./config.ts";
import { forgetAccountUsage, refreshQuota, resetQuotaForTest } from "./providers.ts";
import { routeSettings } from "./routes-settings.ts";
import { AccountUsage, CLAUDE_USAGE_URL, claudeResets } from "./usage-account.ts";

const ORG = "11111111-2222-3333-4444-555555555555";
const DIR_ID = "a".repeat(32);
const realFetch = globalThis.fetch;
const prevAgent = process.env.OMO_CODING_AGENT_DIR;
const agent = mkdtempSync(join(tmpdir(), "dotz-claude-reset-"));
process.env.OMO_CODING_AGENT_DIR = agent;
writeFileSync(
	join(agent, "auth.json"),
	JSON.stringify({
		"anthropic-subscription": {
			type: "oauth",
			pinned: "main",
			accounts: [
				{ name: "main", access: "tok-main", expires: 4_000_000_000_000, dirId: DIR_ID },
				{ name: "no-org", access: "tok-no-org", expires: 4_000_000_000_000 },
				{ name: "old", access: "tok-old", expires: 1_000, refresh: "never-used" },
			],
		},
	}),
);
mkdirSync(join(agent, "anthropic-subscription-claude", DIR_ID), { recursive: true });
writeFileSync(join(agent, "anthropic-subscription-claude", DIR_ID, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: ORG } }));
afterAll(() => {
	globalThis.fetch = realFetch;
	if (prevAgent === undefined) delete process.env.OMO_CODING_AGENT_DIR;
	else process.env.OMO_CODING_AGENT_DIR = prevAgent;
	rmSync(agent, { recursive: true, force: true });
});

type Json = Record<string, any>;
const grant = (id: string, label: string, ends: string, over: Json = {}): Json => ({ id, label, resets_total: 1, resets_left: 1, ends_at: ends, type: "weekly", usable_now: true, paused: false, ...over });
const GRANTS = [
	grant("fable-12mo", "+1 Fable reset at 12 months tenure", "2030-03-09T07:59:00Z", { type: "full" }),
	grant("free_reset_weekly", "Free limit reset (weekly)", "2029-12-16T04:59:00Z"),
	grant("launch-fable", "Fable reset (Max)", "2030-03-09T07:59:00Z", { type: "full", resets_total: 2, resets_left: 2 }),
	grant("spent", "Fable reset", "2029-01-01T00:00:00Z", { resets_left: 0 }),
];
const usage = (cedar: Json | null = { eligible: true, next_grant_id: "free_reset_weekly", grants: GRANTS }): Json => ({
	five_hour: { utilization: 40, resets_at: "2029-01-01T05:00:00Z" },
	seven_day: { utilization: 100, resets_at: "2029-01-03T00:00:00Z" },
	cedar_ember: cedar,
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: Json };
const RESET_URL = `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`;
function upstream(body: Json, status = 200, resetBody: Json = { result: "reset", resets_left: 0, cleared: ["seven_day"] }): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input), method = init.method ?? "GET";
		calls.push({ url, method, headers: init.headers as Record<string, string>, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
		if (method === "GET" && url === CLAUDE_USAGE_URL) return status === 200 ? Response.json(body) : new Response("", { status });
		if (method === "POST" && url === RESET_URL) return Response.json(resetBody);
		throw new Error(`unexpected request ${method} ${url}`);
	}) as typeof fetch;
	return calls;
}
const resetsCalls = (calls: Call[]) => calls.filter(c => c.method === "POST");
const post = async (b: unknown) => {
	const url = new URL("http://x/api/quota/reset-credit");
	const res = (await routeSettings(new Request(url, { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), url, ["api", "quota", "reset-credit"]))!;
	return { status: res.status, body: (await res.json()) as Json };
};

beforeEach(() => {
	resetQuotaForTest();
	for (const n of ["main", "no-org", "old"]) forgetAccountUsage(n);
});

test("several grants: the count sums what is left, by kind, with the nearest expiry and the grant named next", () => {
	expect(claudeResets(usage(), () => true)).toEqual({
		held: 4,
		usable: true,
		expires_at: Date.parse("2029-12-16T04:59:00Z"),
		kinds: [
			{ kind: "주간", left: 1, expires_at: Date.parse("2029-12-16T04:59:00Z"), usable: true, grant_id: "free_reset_weekly" },
			{ kind: "Fable", left: 3, expires_at: Date.parse("2030-03-09T07:59:00Z"), usable: true, grant_id: "fable-12mo" },
		],
		grant: { id: "free_reset_weekly", kind: "주간" },
	});
	// no org id known locally: shown, not usable
	expect(claudeResets(usage(), () => false)).toMatchObject({ held: 4, usable: false });
});

test("each kind carries its own expiry, usability and the grant to spend for it", () => {
	const kinds = (r: ReturnType<typeof claudeResets>) => r?.kinds.map(k => [k.kind, k.left, k.usable, k.grant_id]);
	expect(kinds(claudeResets(usage(), () => true))).toEqual([["주간", 1, true, "free_reset_weekly"], ["Fable", 3, true, "fable-12mo"]]);
	expect(kinds(claudeResets(usage(), () => false))?.map(k => k[2])).toEqual([false, false]);
	const noWeekly = GRANTS.map(g => (g.id === "free_reset_weekly" ? { ...g, usable_now: false } : g));
	expect(kinds(claudeResets(usage({ eligible: true, next_grant_id: "launch-fable", grants: noWeekly }), () => true))).toEqual([["주간", 1, false, undefined], ["Fable", 3, true, "launch-fable"]]);
});

test("null (no query), ineligible with no grants and a missing block show nothing", () => {
	expect(claudeResets(usage(null), () => true)).toBeUndefined();
	expect(claudeResets(usage({ eligible: false, ineligible_reason: "surface", grants: [] }), () => true)).toBeUndefined();
	expect(claudeResets({ five_hour: { utilization: 1 } }, () => true)).toBeUndefined();
	// ineligible for now but holding some: the count shows and cannot be used
	expect(claudeResets(usage({ eligible: false, ineligible_reason: "cooldown", grants: GRANTS }), () => true)).toMatchObject({ held: 4, usable: false });
});

test("the usage GET asks for cedar_ember with a Claude Code user-agent, and only reads", async () => {
	const calls = upstream(usage());
	const r = await new AccountUsage().report({ name: "main", pinned: true, token: "tok-main", expiresAt: null });
	expect(calls.length).toBe(1);
	expect(calls[0]?.method).toBe("GET");
	expect(new URL(calls[0]!.url).searchParams.get("cedar_ember")).toBe("1");
	expect(new URL(calls[0]!.url).searchParams.get("skip_spend")).toBe("1");
	expect(calls[0]?.headers["user-agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
	expect(calls[0]?.headers["x-app"]).toBe("cli");
	expect(r.resets).toMatchObject({ held: 4, usable: true, grant: { id: "free_reset_weekly" } });
	expect(r.limits.map(l => l.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
});

test("401 and an expired token: no count, and nothing but the one GET (no refresh)", async () => {
	const calls = upstream(usage(), 401);
	const r = await new AccountUsage().report({ name: "main", pinned: true, token: "tok-main", expiresAt: null });
	expect(r.problem).toBe("expired");
	expect(r.resets).toBeUndefined();
	expect(calls.map(c => [c.method, c.url])).toEqual([["GET", CLAUDE_USAGE_URL]]);
	const none = upstream(usage());
	const old = await new AccountUsage().report({ name: "old", pinned: false, token: "tok-old", expiresAt: 1_000 });
	expect(old.resets).toBeUndefined();
	expect(none).toEqual([]);
});

test("the route refuses without confirm: true or a grant, and asks the upstream nothing", async () => {
	const calls = upstream(usage());
	for (const b of [{ provider: "anthropic", account: "main", grant_id: "free_reset_weekly" }, { provider: "anthropic", account: "main", grant_id: "free_reset_weekly", confirm: "true" }, { provider: "anthropic", account: "main", confirm: true }, { provider: "anthropic" }])
		expect((await post(b)).status).toBe(400);
	expect(calls).toEqual([]);
});

test("with confirm: true it reads afresh and sends one reset for that grant to the account's organization", async () => {
	const calls = upstream(usage());
	expect(await post({ provider: "anthropic", account: "main", grant_id: "launch-fable", confirm: true })).toEqual({ status: 200, body: { ok: true, outcome: "reset", left: 3 } });
	const used = resetsCalls(calls);
	expect(used.length).toBe(1);
	expect(used[0]?.url).toBe(RESET_URL);
	expect(used[0]?.headers).toMatchObject({ authorization: "Bearer tok-main" });
	expect(used[0]?.body).toMatchObject({ program: "cedar_ember", grant_id: "launch-fable" });
	expect(used[0]?.body?.request_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	expect(calls.findIndex(c => c.method === "GET")).toBeLessThan(calls.indexOf(used[0]!));
	// the route started a usage re-read; it settles here, while the fake upstream still answers
	await refreshQuota();
});

test("an answer to the reset that is not one of the known outcomes is not a success: an error answer, no ok, no count", async () => {
	for (const known of ["reset", "nothing_to_reset", "not_limited", "no_credit", "already_redeemed", "already_used", "cooldown"]) {
		upstream(usage(), 200, { result: known });
		const r = await post({ provider: "anthropic", account: "main", grant_id: "launch-fable", confirm: true });
		expect([known, r.status, r.body.ok]).toEqual([known, 200, true]);
		await refreshQuota();
	}
	for (const odd of [{ result: "" }, { result: "brand_new_outcome" }, {}, { result: null }, { result: 1 }]) {
		const calls = upstream(usage(), 200, odd);
		const r = await post({ provider: "anthropic", account: "main", grant_id: "launch-fable", confirm: true });
		expect(resetsCalls(calls).length).toBe(1);
		expect(r.status).not.toBe(200);
		expect(r.body.ok).toBeUndefined();
		expect(r.body.left).toBeUndefined();
		expect(typeof r.body.error).toBe("string");
	}
});

test("confirmed but spent, unknown, expired or without an org id: refused, no reset sent", async () => {
	const cases: [Json, Json, number?][] = [
		[usage(), { grant_id: "spent" }],
		[usage(), { grant_id: "no-such-grant" }],
		[usage({ eligible: true, grants: [grant("free_reset_weekly", "weekly", "2029-12-16T04:59:00Z", { usable_now: false })] }), { grant_id: "free_reset_weekly" }],
		[usage(), { grant_id: "free_reset_weekly" }, 401],
		[usage(), { account: "old", grant_id: "free_reset_weekly" }],
		[usage(), { account: "no-org", grant_id: "free_reset_weekly" }],
	];
	for (const [body, b, status] of cases) {
		const calls = upstream(body, status);
		expect((await post({ provider: "anthropic", account: "main", confirm: true, ...b })).status).toBe(409);
		expect(resetsCalls(calls)).toEqual([]);
	}
});

test("the reset POST names Claude Code like the usage GET does (the server judges both by surface)", async () => {
	const calls = upstream(usage());
	await post({ provider: "anthropic", account: "main", grant_id: "launch-fable", confirm: true });
	const get = calls.find(c => c.method === "GET")!, used = resetsCalls(calls);
	expect(used.length).toBe(1);
	expect(used[0]?.headers["user-agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
	expect(used[0]?.headers["user-agent"]).toBe(get.headers["user-agent"]);
	await refreshQuota();
});

test("ineligible is a refusal: 409, no ok, the pass count unchanged, the reason carried to the owner", async () => {
	for (const reason of [{ ineligible_reason: "surface" }, { ineligible_reason: "brand_new_reason" }, {}]) {
		const calls = upstream(usage(), 200, { result: "ineligible", ...reason });
		const r = await post({ provider: "anthropic", account: "main", grant_id: "launch-fable", confirm: true });
		expect(resetsCalls(calls).length).toBe(1);
		expect(r.status).toBe(409);
		expect(r.body.ok).toBeUndefined();
		expect(r.body).toMatchObject({ outcome: "ineligible", left: 4 });
		expect(typeof r.body.error).toBe("string");
		if (reason.ineligible_reason === "brand_new_reason") expect(r.body.error).toContain("brand_new_reason");
	}
});

test("the fetch is injectable: useClaudeReset sends through the one it is given and never the global one", async () => {
	const seen: Call[] = [];
	globalThis.fetch = (async () => {
		throw new Error("the global fetch must not be used");
	}) as typeof fetch;
	const fake = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input), method = init.method ?? "GET";
		seen.push({ url, method, headers: init.headers as Record<string, string>, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
		return method === "GET" ? Response.json(usage()) : Response.json({ result: "reset" });
	}) as typeof fetch;
	expect(await useClaudeReset({ provider: "anthropic", account: "main", grant_id: "launch-fable", confirm: true }, fake)).toEqual({ status: 200, body: { ok: true, outcome: "reset", left: 3 } });
	const used = seen.filter(c => c.method === "POST");
	expect(used.map(c => c.url)).toEqual([RESET_URL]);
	expect(used[0]?.headers["user-agent"]).toMatch(/^claude-cli\//);
	expect(used[0]?.body).toMatchObject({ program: "cedar_ember", grant_id: "launch-fable" });
});

test("the reset POST names itself as Claude Code does, and an ineligible answer logs the names of its fields, never their values", async () => {
	const calls = upstream(usage(), 200, { result: "ineligible", extra_note: "tok-secret-value", cooldown_until: null });
	const r = await post({ provider: "anthropic", account: "main", grant_id: "free_reset_weekly", confirm: true });
	expect(r.status).toBe(409);
	const sent = resetsCalls(calls)[0]!;
	expect(sent.headers["x-app"]).toBe("cli");
	expect(sent.headers["user-agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
	expect(sent.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
	expect(sent.body).toMatchObject({ program: "cedar_ember", grant_id: "free_reset_weekly" });
	const logged = readFileSync(paths.log, "utf8");
	expect(logged).toContain("limit reset answer fields: cooldown_until,extra_note,result");
	expect(logged).not.toContain("tok-secret-value");
});

test("a full grant no other name covers is listed as 전체 and can be spent", () => {
	const full = grant("grant-a", "Full limit reset", "2030-01-01T00:00:00Z", { type: "full" });
	expect(claudeResets(usage({ eligible: true, next_grant_id: "grant-a", grants: [full] }), () => true)?.kinds).toEqual([{ kind: "전체", left: 1, expires_at: Date.parse("2030-01-01T00:00:00Z"), usable: true, grant_id: "grant-a" }]);
	const clearsBoth = grant("grant-b", "Reset", "2030-01-01T00:00:00Z", { type: "other", clears: ["five_hour", "seven_day"] });
	expect(claudeResets(usage({ eligible: true, next_grant_id: "grant-b", grants: [clearsBoth] }), () => true)?.kinds[0]).toMatchObject({ kind: "전체", grant_id: "grant-b" });
});

test("a reset that took lifts the limit for that account; every other answer lifts nothing", async () => {
	const lifted: string[] = [];
	const press = async (result: string) => {
		upstream(usage(), 200, { result });
		return useClaudeReset({ provider: "anthropic", account: "main", grant_id: "free_reset_weekly", confirm: true }, undefined, async a => void lifted.push(a));
	};
	expect((await press("reset")).status).toBe(200);
	expect(lifted).toEqual(["main"]);
	for (const r of ["not_limited", "cooldown", "already_used", "ineligible", "something_new"]) await press(r);
	expect(lifted).toEqual(["main"]);
	// a lift that throws must not turn the spent reset into an error answer
	upstream(usage(), 200, { result: "reset" });
	const failing = await useClaudeReset({ provider: "anthropic", account: "main", grant_id: "free_reset_weekly", confirm: true }, undefined, async () => { throw new Error("boom"); });
	expect(failing.status).toBe(200);
});
