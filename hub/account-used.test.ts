// The account requests really use: OmO skips a blocked account, so the pick (pin, rule or manual) is not always the one used.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aliasesFile } from "./account-alias.ts";
import { decisionsFile, rulesFile, setManual } from "./account-rules.ts";
import { resetStickyForTest, stickyAccount, switchesFile } from "./account-sticky.ts";
import { accountsBody, accountsRoute, announceUsedChanges } from "./accounts-api.ts";
import { authFile } from "./apikey-policy.ts";
import { DATA_DIR } from "./config.ts";
import { listNotices } from "./notices.ts";
import { subscriptionAccount, usedAccount } from "./usage-account.ts";

const MIN = 60_000;
const poolFile = () => join(process.env.OMO_CODING_AGENT_DIR!, "credential-pool-state.json");
const files = () => [authFile(), poolFile(), join(DATA_DIR, "account.json"), switchesFile(), rulesFile(), decisionsFile(), aliasesFile()];
type Slot = { lastSuccessAt?: number; blockReason?: string; blockedUntil?: number };

function auth(names: string[], pinned?: string): void {
	writeFileSync(authFile(), JSON.stringify({ "anthropic-subscription": { accounts: names.map(name => ({ name, access: "fake" })), ...(pinned ? { pinned } : {}) } }));
}
function slots(s: Record<string, Slot>): void {
	writeFileSync(poolFile(), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots: s } } } } }));
}
const limited = (until: number): Slot => ({ blockReason: "rate_limit", blockedUntil: until });
const usedNotices = () => listNotices(300).items.filter(n => n.key?.startsWith("account-used:"));

beforeEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});
afterEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});

test("usedAccount: the pick while usable, else the latest successful usable account, else the pick", () => {
	const names = ["default", "miseol-shared"];
	const last = (n: string) => (n === "miseol-shared" ? 5 : 1);
	expect(usedAccount("default", names, () => false, last)).toBe("default");
	expect(usedAccount("default", names, n => n === "default", last)).toBe("miseol-shared");
	expect(usedAccount("default", names, () => true, last)).toBe("default");
	expect(usedAccount(undefined, names, () => false, last)).toBe("miseol-shared");
});

test("the usage numbers follow the account requests really use, not the blocked pick", () => {
	const now = Date.now();
	auth(["default", "miseol-shared"], "default");
	slots({ default: limited(now + 60 * MIN), "miseol-shared": { lastSuccessAt: now } });
	expect(subscriptionAccount(authFile(), now, "default")?.name).toBe("miseol-shared");
	slots({ default: { lastSuccessAt: now }, "miseol-shared": { lastSuccessAt: now - MIN } });
	expect(subscriptionAccount(authFile(), now, "default")?.name).toBe("default");
});

test("/api/accounts: current is the account really used; a blocked 고정 pick keeps the requests and says it waits", () => {
	const now = Date.now();
	auth(["default", "miseol-shared"], "default");
	slots({ default: limited(now + 60 * MIN), "miseol-shared": { lastSuccessAt: now } });
	setManual("default");
	const b = accountsBody(now);
	expect(b.accounts.filter(a => a.current).map(a => a.name)).toEqual(["default"]);
	expect(b.used).toMatchObject({ name: "default" });
	expect(b.chosen).toMatchObject({ name: "default", source: "manual", blocked: "rate_limit", used_instead: null });
	expect(b.chosen!.blocked_until).toBe(new Date(now + 60 * MIN).toISOString());
	const d = b.accounts.find(a => a.name === "default")!;
	expect(d).toMatchObject({ current: true, blocked: "rate_limit" });
	// a later day reads as a clock the owner can read, never "10. 23."
	expect(d.blocked_tag).toMatch(/\d{2}:\d{2}/);
	expect(d.blocked_tag).not.toMatch(/\d+\.\s/);
	expect(b.accounts.find(a => a.name === "miseol-shared")!.blocked_tag).toBeNull();
	expect(b.accounts.find(a => a.name === "miseol-shared")!.current).toBe(false);

	// not blocked: the pick is the account used and nothing is redirected
	slots({ default: { lastSuccessAt: now }, "miseol-shared": {} });
	const ok = accountsBody(now + 2 * MIN);
	expect(ok.accounts.filter(a => a.current).map(a => a.name)).toEqual(["default"]);
	expect(ok.chosen).toMatchObject({ name: "default", used_instead: null, blocked: null });
});

test("a change of the account used is no notice (owner 2026-10-23: not needed), whoever made it", async () => {
	announceUsedChanges();
	const now = Date.now();
	auth(["default", "miseol-shared"]);
	slots({ default: { lastSuccessAt: now }, "miseol-shared": {} });
	const before = usedNotices().length;
	expect(stickyAccount(now)).toBe("default");
	expect(usedNotices().length).toBe(before); // the first pick is no change

	slots({ default: limited(now + 600 * MIN), "miseol-shared": { lastSuccessAt: now } });
	stickyAccount(now + MIN);
	stickyAccount(now + 2 * MIN);
	expect(stickyAccount(now + 3 * MIN)).toBe("miseol-shared");
	expect(usedNotices().length).toBe(before);

	const res = await accountsRoute(new Request("http://x/api/accounts/use", { method: "POST", body: JSON.stringify({ account: "default" }) }), new URL("http://x/api/accounts/use"));
	expect(res?.status).toBe(200);
	expect(usedNotices().length).toBe(before);
});
