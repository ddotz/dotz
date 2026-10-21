import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AccountSwitch, accountView, decide, dropNoops, MAX_LOG_LINES, onSwitch, PIN_ENV, readPool, resetStickyForTest, stickyAccount, stickyEnv, switchesFile } from "./account-sticky.ts";
import { authFile } from "./apikey-policy.ts";
import { DATA_DIR } from "./config.ts";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const MIN = 60_000;
const poolFile = () => join(process.env.OMO_CODING_AGENT_DIR!, "credential-pool-state.json");

function auth(names: string[], pinned?: string): void {
	writeFileSync(authFile(), JSON.stringify({ "anthropic-subscription": { accounts: names.map(name => ({ name, access: "x" })), ...(pinned ? { pinned } : {}) } }));
}
function slots(s: Record<string, { lastSuccessAt?: number; blockReason?: string; blockedUntil?: number }>): void {
	writeFileSync(poolFile(), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots: s } } } } }));
}

let seen: AccountSwitch[] = [];
beforeEach(() => {
	for (const f of [authFile(), poolFile(), join(DATA_DIR, "account.json"), switchesFile()]) rmSync(f, { force: true });
	resetStickyForTest();
	seen = [];
	onSwitch(s => seen.push(s));
});
afterEach(() => resetStickyForTest());

test("stays on its account when another one answered more recently", () => {
	auth(["default", "second"]);
	slots({ default: { lastSuccessAt: T0 }, second: { lastSuccessAt: T0 - MIN } });
	expect(stickyAccount(T0)).toBe("default");
	slots({ default: { lastSuccessAt: T0 }, second: { lastSuccessAt: T0 + 5 * MIN } });
	expect(stickyAccount(T0 + 6 * MIN)).toBe("default");
	expect(stickyEnv(T0 + 7 * MIN)).toEqual({ [PIN_ENV]: "default" });
	expect(seen).toEqual([]);
	const log = readFileSync(switchesFile(), "utf8").trim().split("\n").map(l => JSON.parse(l));
	expect(log.map(s => s.kind)).toEqual(["start"]);
});

test("a limit moves it, logged with the reason, and it does not drift back when the limit ends", () => {
	auth(["default", "second"]);
	slots({ default: { lastSuccessAt: T0 } });
	expect(stickyAccount(T0)).toBe("default");
	slots({ default: { lastSuccessAt: T0, blockReason: "rate_limit", blockedUntil: T0 + 60 * MIN }, second: {} });
	expect(stickyAccount(T0 + MIN)).toBe("second");
	expect(seen).toHaveLength(1);
	expect(seen[0]).toMatchObject({ from: "default", to: "second", kind: "limit" });
	expect(seen[0].reason).toContain("rate_limit");
	// The limit is over: default is usable again, second still is, so dotz stays.
	expect(stickyAccount(T0 + 90 * MIN)).toBe("second");
	expect(seen).toHaveLength(1);
	const view = accountView();
	expect(view.account).toBe("second");
	expect(view.switches.map(s => s.kind)).toEqual(["limit", "start"]);
});

test("blocked with nothing else usable: stays (OmO's own fallback and the pause handle it)", () => {
	auth(["default"]);
	slots({ default: { blockReason: "rate_limit", blockedUntil: T0 + 60 * MIN } });
	expect(decide("default", readPool(authFile(), T0), T0)).toEqual({ account: "default" });
});

test("the owner pinning another account switches; unpinning keeps it", () => {
	auth(["default", "second"]);
	slots({ default: { lastSuccessAt: T0 } });
	expect(stickyAccount(T0)).toBe("default");
	auth(["default", "second"], "second");
	expect(stickyAccount(T0 + MIN)).toBe("second");
	expect(seen.map(s => [s.kind, s.from, s.to])).toEqual([["owner", "default", "second"]]);
	auth(["default", "second"]);
	expect(stickyAccount(T0 + 2 * MIN)).toBe("second");
	expect(seen).toHaveLength(1);
});

test("an account that left the pool is replaced", () => {
	expect(decide("old", { names: ["default"], blocked: {}, lastSuccess: {} })).toMatchObject({ account: "default", change: { kind: "gone", from: "old" } });
});

const sw = (to: string, from?: string, kind: AccountSwitch["kind"] = from ? "limit" : "start", n = 0): AccountSwitch => ({ at: new Date(T0 + n * MIN).toISOString(), ...(from ? { from } : {}), to, kind, reason: "r" });
const switchLines = () => (existsSync(switchesFile()) ? readFileSync(switchesFile(), "utf8").trim().split("\n").map(l => JSON.parse(l) as AccountSwitch) : []);

test("a restart on the same account adds no entry and keeps the account's since time", () => {
	auth(["default", "second"]);
	slots({ default: { lastSuccessAt: T0 } });
	expect(stickyAccount(T0)).toBe("default");
	const since = accountView().since;
	expect(switchLines()).toHaveLength(1);
	// restart with account.json: nothing changes
	resetStickyForTest();
	expect(stickyAccount(T0 + 5 * MIN)).toBe("default");
	expect(switchLines()).toHaveLength(1);
	// restart that lost account.json: the "start" lands on the account the last record already names
	rmSync(join(DATA_DIR, "account.json"), { force: true });
	resetStickyForTest();
	expect(stickyAccount(T0 + 10 * MIN)).toBe("default");
	expect(switchLines()).toHaveLength(1);
	expect(accountView().switches).toHaveLength(1);
	expect(accountView().since).toBeDefined();
	expect(since).toBe(new Date(T0).toISOString());
});

test("dropNoops removes switches that land on the account already in use; the view and the API never show them", () => {
	const list = [sw("default"), sw("default", undefined, "start", 1), sw("second", "default", "limit", 2), sw("second", "second", "owner", 3), sw("second", undefined, "start", 4), sw("default", "second", "owner", 5)];
	expect(dropNoops(list).map(s => [s.from, s.to])).toEqual([[undefined, "default"], ["default", "second"], ["second", "default"]]);
	auth(["default", "second"]);
	slots({ default: { lastSuccessAt: T0 } });
	writeFileSync(switchesFile(), `${list.map(s => JSON.stringify(s)).join("\n")}\n`);
	writeFileSync(join(DATA_DIR, "account.json"), JSON.stringify({ account: "default", since: sw("default").at }));
	expect(accountView().switches.map(s => s.to)).toEqual(["default", "second", "default"]);
});

test("the switch log keeps its last 20 lines, trimmed on write", () => {
	const seed = Array.from({ length: 30 }, (_, i) => sw(i % 2 ? "b" : "a", i ? (i % 2 ? "a" : "b") : undefined, i ? "owner" : "start", i));
	writeFileSync(switchesFile(), `${seed.map(s => JSON.stringify(s)).join("\n")}\n`);
	writeFileSync(join(DATA_DIR, "account.json"), JSON.stringify({ account: "b", since: seed[29].at }));
	auth(["a", "b"]);
	slots({ a: { lastSuccessAt: T0 }, b: { blockReason: "rate_limit", blockedUntil: T0 + 60 * MIN } });
	expect(stickyAccount(T0 + 40 * MIN)).toBe("a");
	const lines = switchLines();
	expect(lines).toHaveLength(MAX_LOG_LINES);
	expect(lines.at(-1)).toMatchObject({ from: "b", to: "a", kind: "limit" });
	expect(lines[0].at).toBe(seed[11].at);
});

test("no subscription accounts: no pin in the spawn env, nothing written", () => {
	expect(stickyEnv(T0)).toEqual({});
	expect(existsSync(switchesFile())).toBe(false);
});
