// "한도", the lane budget gate and the 429 resume time read the limits of the account dotz's agents really run on: under
// OmO that is OmO's pinned subscription account (e.g. host-shared), not omp's login (the owner's default).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetStickyForTest } from "./account-sticky.ts";
import { setManual } from "./account-rules.ts";
import { anthropicUsage, forgetAccountUsage, onQuota, QUOTA_REFRESH_MS, quota, refreshQuota, resetQuotaForTest } from "./providers.ts";
import { AccountUsage, cliTokensSettled, limitsOf, limitsText, MIN_REFRESH_MS, resetCliTokensForTest, setKeychainReaderForTest, subscriptionAccount, subscriptionAccounts } from "./usage-account.ts";

const agentDir = process.env.OMO_CODING_AGENT_DIR!;
const auth = (sub: Record<string, unknown>) => writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "anthropic-subscription": { type: "oauth", ...sub } }));
const pool = (slots: Record<string, unknown>) => writeFileSync(join(agentDir, "credential-pool-state.json"), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots } } } } }));
const FAR = Date.now() + 365 * 86400e3;
const accounts = [{ name: "default", access: "tok-default", expires: FAR }, { name: "host-shared", access: "tok-host", expires: FAR }];
const body = (five: number, week: number) => ({ five_hour: { utilization: five, resets_at: "2030-01-01T05:00:00Z" }, seven_day: { utilization: week, resets_at: "2030-01-07T00:00:00Z" }, seven_day_opus: null });
const realFetch = globalThis.fetch;
// A read held from an earlier test (or the sticky pick it left) would answer from cache instead of the fake fetch.
beforeEach(() => {
	resetStickyForTest();
	resetQuotaForTest();
	for (const a of accounts) forgetAccountUsage(a.name);
});
afterEach(() => {
	globalThis.fetch = realFetch;
	pool({});
});

test("under OmO the limits are the pinned account's, read with its own token, and the answer names it", async () => {
	auth({ pinned: "host-shared", accounts });
	const seen: string[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const token = String((init.headers as Record<string, string>).authorization);
		seen.push(token);
		return Response.json(token === "Bearer tok-host" ? body(66, 67) : body(2, 22));
	}) as typeof fetch;
	const r = await anthropicUsage("orchestrator");
	expect(seen).toEqual(["Bearer tok-host"]);
	expect(r?.account).toBe("host-shared");
	expect(r?.limits.find(l => l.id === "anthropic:5h")?.amount.remaining).toBe(34);
	expect(r?.limits.find(l => l.id === "anthropic:7d")?.amount.used).toBe(67);
	const text = limitsText(r!, Date.now());
	expect(text).toContain("host-shared");
	expect(text).toContain("66.0% used");
});

test("after an account switch the quota is the new account's, not the pinned or cached one", async () => {
	auth({ pinned: "host-shared", accounts });
	const seen: string[] = [];
	let fiveOfDefault = 2;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const token = String((init.headers as Record<string, string>).authorization);
		seen.push(token);
		return Response.json(token === "Bearer tok-host" ? body(37, 11) : body(fiveOfDefault, 22));
	}) as typeof fetch;
	const fiveOf = async () => {
		// a switch refreshes the usage in the background (main.ts onAccountSwitch)
		const q = await refreshQuota();
		const p = q.providers.find(x => x.provider === "anthropic");
		return { account: p?.account, five: p?.limits.find(l => l.id === "anthropic:5h")?.used };
	};
	try {
		expect(await fiveOf()).toEqual({ account: "host-shared", five: 37 });
		// the owner picks the other account in the web app (POST /api/accounts/use)
		setManual("default");
		expect(await fiveOf()).toEqual({ account: "default", five: 2 });
		expect(seen.at(-1)).toBe("Bearer tok-default");
		// a switch drops the new account's hold, so its next read is fresh instead of up to 2 minutes old
		fiveOfDefault = 9;
		forgetAccountUsage("default");
		expect(await fiveOf()).toEqual({ account: "default", five: 9 });
		// and back
		setManual("host-shared");
		expect(await fiveOf()).toEqual({ account: "host-shared", five: 37 });
	} finally {
		setManual(undefined);
		resetStickyForTest();
	}
});

test("unpinned: the pool's account that is not blocked and last succeeded", () => {
	auth({ accounts });
	pool({ default: { blockReason: "rate_limit", blockedUntil: Date.now() + 3600e3, lastSuccessAt: 5 }, "host-shared": { lastSuccessAt: 1 } });
	expect(subscriptionAccount()?.name).toBe("host-shared");
	pool({ default: { lastSuccessAt: 5 }, "host-shared": { lastSuccessAt: 1 } });
	expect(subscriptionAccount()?.name).toBe("default");
	expect(subscriptionAccount()?.pinned).toBe(false);
});

test("read only: an expired token is reported, never used; a 429 holds the account until its retry-after", async () => {
	let now = 1_000_000;
	let calls = 0;
	let status = 429;
	const u = new AccountUsage(async () => {
		calls++;
		return status === 429 ? new Response("", { status: 429, headers: { "retry-after": "600" } }) : Response.json(body(10, 20));
	}, () => now);
	expect((await u.report({ name: "x", pinned: true, token: "t", expiresAt: now - 1 })).problem).toBe("expired");
	expect(calls).toBe(0);
	const acct = { name: "y", pinned: true, token: "t", expiresAt: null };
	const first = await u.report(acct);
	expect(first.problem).toBe("rate_limited");
	expect(first.retryAt).toBe(now + 600_000);
	status = 200;
	now += MIN_REFRESH_MS * 2;
	expect((await u.report(acct, true)).problem).toBe("rate_limited");
	expect(calls).toBe(1);
	now += 600_000;
	const after = await u.report(acct, true);
	expect(after.problem).toBeUndefined();
	expect(after.limits.map(l => l.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
	expect(calls).toBe(2);
});

test("limitsOf skips windows the answer leaves null", () => {
	expect(limitsOf({ five_hour: { utilization: 12.34, resets_at: null }, seven_day: null }).map(l => [l.id, l.amount.used])).toEqual([["anthropic:5h", 12.3]]);
});

test("a Claude CLI login is read with the token the CLI keeps for its account dir", () => {
	const dirId = "b".repeat(32);
	const dir = join(agentDir, "anthropic-subscription-claude", dirId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-cli", expiresAt: FAR } }));
	resetCliTokensForTest();
	auth({ accounts: [{ name: "default", source: "login", store: "claude-cli", dirId }, { name: "gone", store: "claude-cli", dirId: "c".repeat(32) }] });
	expect(subscriptionAccount()).toMatchObject({ name: "default", token: "tok-cli", expiresAt: FAR });
	expect(subscriptionAccounts().map(a => a.name)).toEqual(["default"]);
});

test("GET /api/quota answers from the last read without asking again; an old one starts one background read whose change is pushed", async () => {
	auth({ pinned: "host-shared", accounts });
	let five = 40;
	let calls = 0;
	globalThis.fetch = (async () => (calls++, Response.json(body(five, 11)))) as typeof fetch;
	const fiveOf = (q: Awaited<ReturnType<typeof quota>>) => q.providers.find(p => p.provider === "anthropic")?.limits.find(l => l.id === "anthropic:5h")?.used;
	const first = await quota();
	expect([fiveOf(first), calls]).toEqual([40, 1]);
	expect(await quota(first.fetched_at + QUOTA_REFRESH_MS - 1)).toBe(first);
	expect(calls).toBe(1);
	const pushed = new Promise<Awaited<ReturnType<typeof quota>>>(resolve => onQuota(resolve));
	five = 55;
	forgetAccountUsage("host-shared");
	// past the refresh time the old answer still comes at once; the read runs behind it
	expect(await quota(first.fetched_at + QUOTA_REFRESH_MS)).toBe(first);
	expect(fiveOf(await pushed)).toBe(55);
	expect(fiveOf(await quota())).toBe(55);
	expect(calls).toBe(2);
});

test.if(process.platform === "darwin")("a keychain-only Claude CLI token is read off the caller's path, once per dir, and an expired one is not re-read on every call", async () => {
	const dirId = "d".repeat(32);
	auth({ accounts: [{ name: "cli", store: "claude-cli", dirId }] });
	resetCliTokensForTest();
	let reads = 0;
	let expires = FAR;
	setKeychainReaderForTest(async () => (reads++, JSON.stringify({ claudeAiOauth: { accessToken: "tok-kc", expiresAt: expires } })));
	try {
		expect(subscriptionAccounts()).toEqual([]);
		expect(subscriptionAccounts()).toEqual([]);
		expect(reads).toBe(1);
		await cliTokensSettled();
		expect(subscriptionAccounts().map(a => a.token)).toEqual(["tok-kc"]);
		expect(reads).toBe(1);
		// expired: the cached token answers; the keychain is asked again only after the recheck time, in the background
		resetCliTokensForTest();
		reads = 0;
		expires = Date.now() - 1;
		setKeychainReaderForTest(async () => (reads++, JSON.stringify({ claudeAiOauth: { accessToken: "tok-old", expiresAt: expires } })));
		subscriptionAccounts();
		await cliTokensSettled();
		const now = Date.now();
		for (let i = 0; i < 5; i++) expect(subscriptionAccount(undefined, now)?.token).toBe("tok-old");
		expect(reads).toBe(1);
		expect(subscriptionAccount(undefined, now + 20_000)?.token).toBe("tok-old");
		await cliTokensSettled();
		expect(reads).toBe(2);
	} finally {
		resetCliTokensForTest();
	}
});
