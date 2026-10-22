import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aliasesFile } from "./account-alias.ts";
import { decisionsFile, rulesFile, setManual } from "./account-rules.ts";
import { PIN_ENV, resetStickyForTest, stickyAccount, stickyEnv, switchesFile } from "./account-sticky.ts";
import { accountsBody } from "./accounts-api.ts";
import { authFile } from "./apikey-policy.ts";
import { DATA_DIR } from "./config.ts";
import { subscriptionAccount } from "./usage-account.ts";

// 2026-10-22: the owner picked `default` in dotz while OmO's auth.json pinned `miseol-shared`. `default` was blocked only in
// auth.json (the account entry); the pool state still held an elapsed block. dotz showed `default`, OmO ran on `miseol-shared`.
const NOW = Date.parse("2026-10-22T14:00:00Z");
const MIN = 60_000;
const BLOCKED_UNTIL = Date.parse("2026-10-22T16:00:00Z"); // 01:00 KST on the 23rd
const poolFile = () => join(process.env.OMO_CODING_AGENT_DIR!, "credential-pool-state.json");
const files = () => [authFile(), poolFile(), join(DATA_DIR, "account.json"), switchesFile(), rulesFile(), decisionsFile(), aliasesFile()];

function writeAuth(opts: { defaultBlockedUntil?: number; pinned?: string }): void {
	const blocked = opts.defaultBlockedUntil ? { blockedUntil: opts.defaultBlockedUntil, blockReason: "rate_limit", blockedAt: NOW - MIN } : {};
	writeFileSync(authFile(), JSON.stringify({ "anthropic-subscription": { accounts: [{ name: "default", access: "x", ...blocked }, { name: "miseol-shared", access: "y" }], ...(opts.pinned ? { pinned: opts.pinned } : {}) } }));
	// the pool state only holds an old, elapsed block for default and the shared account's recent success
	writeFileSync(poolFile(), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots: { default: { blockReason: "rate_limit", blockedUntil: NOW - 3 * 86_400_000 }, "miseol-shared": { lastSuccessAt: NOW - MIN } } } } } } }));
}

beforeEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});
afterEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});

test("hard pin miseol + manual pick default, default blocked in auth.json: shown, pinned and used account are all miseol", () => {
	writeAuth({ defaultBlockedUntil: BLOCKED_UNTIL, pinned: "miseol-shared" });
	setManual("default");
	const shown = stickyAccount(NOW);
	expect(shown).toBe("miseol-shared");
	expect(stickyEnv(NOW)).toEqual({ [PIN_ENV]: "miseol-shared" });
	expect(subscriptionAccount(authFile(), NOW, shown)).toMatchObject({ name: "miseol-shared", pinned: true });
	const body = accountsBody(NOW);
	expect(body.accounts.find(a => a.name === "default")).toMatchObject({ current: false, blocked: "rate_limit", blocked_until: new Date(BLOCKED_UNTIL).toISOString() });
	expect(body.accounts.find(a => a.name === "miseol-shared")?.current).toBe(true);
	expect(body.manual_text).toContain("한도에 걸려서");
	expect(body.manual_text).toContain("01:00까지 못 써요");
	expect(body.manual_text).toContain("miseol-shared");
});

test("hard pin miseol + manual pick default, default usable: the pick is shown and used (dotz's pin outranks OmO's stored pin)", () => {
	writeAuth({ pinned: "miseol-shared" });
	setManual("default");
	const shown = stickyAccount(NOW);
	expect(shown).toBe("default");
	expect(stickyEnv(NOW)).toEqual({ [PIN_ENV]: "default" });
	expect(subscriptionAccount(authFile(), NOW, shown)).toMatchObject({ name: "default", pinned: false, sticky: true });
	const body = accountsBody(NOW);
	expect(body.accounts.find(a => a.name === "default")).toMatchObject({ current: true, blocked: null });
	expect(body.manual_text).not.toContain("못 써요");
});

test("the manual pick takes effect again once the auth.json block has elapsed", () => {
	writeAuth({ defaultBlockedUntil: BLOCKED_UNTIL, pinned: "miseol-shared" });
	setManual("default");
	expect(stickyAccount(NOW)).toBe("miseol-shared");
	expect(stickyAccount(BLOCKED_UNTIL + MIN)).toBe("default");
});
