import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aliasesFile } from "./account-alias.ts";
import { decisionsFile, rulesFile } from "./account-rules.ts";
import { type AccountSwitch, onSwitch, resetStickyForTest, stickyAccount, switchesFile } from "./account-sticky.ts";
import { accountsRoute } from "./accounts-api.ts";
import { authFile } from "./apikey-policy.ts";
import { DATA_DIR } from "./config.ts";
import { ownPinFile } from "./omo-pin.ts";

const poolFile = () => join(dirname(authFile()), "credential-pool-state.json");
const backups = () => readdirSync(dirname(authFile())).filter(f => f.startsWith("auth.json.dotz-pin-backup-"));
const files = () => [authFile(), poolFile(), join(DATA_DIR, "account.json"), switchesFile(), rulesFile(), decisionsFile(), aliasesFile(), ownPinFile(), `${authFile()}.lock`, ...backups().map(f => join(dirname(authFile()), f))];

// OmO writes the store as JSON.stringify(data, null, 2) with no trailing newline.
const store = (extra: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) => ({
	"anthropic-subscription": { access: "sentinel", refresh: "sentinel", accounts: [{ name: "default", access: "tok-default", refresh: "ref-default", expires: 1 }, { name: "work", access: "tok-work", refresh: "ref-work", expires: 2 }], ...sub },
	anthropic: { key: "sk-test-key" },
	...extra,
});
const writeStore = (data: unknown) => writeFileSync(authFile(), JSON.stringify(data, null, 2), { mode: 0o640 });
const text = () => readFileSync(authFile(), "utf8");
const use = (account: string) => accountsRoute(new Request("http://x/api/accounts/use", { method: "POST", body: JSON.stringify({ account }) }), new URL("http://x/api/accounts/use"));

let switches: AccountSwitch[] = [];
beforeEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
	switches = [];
	onSwitch(s => switches.push(s));
});
afterEach(() => {
	for (const f of files()) rmSync(f, { force: true });
	resetStickyForTest();
});

test("an owner pick writes pinned; every other key and every token stays byte-identical, mode and backup kept", async () => {
	const before = store();
	writeStore(before);
	const original = text();
	const res = await use("work");
	expect(res?.status).toBe(200);
	expect(text()).toBe(JSON.stringify(store({}, { pinned: "work" }), null, 2));
	expect(statSync(authFile()).mode & 0o777).toBe(0o640);
	expect(backups()).toHaveLength(1);
	expect(readFileSync(join(dirname(authFile()), backups()[0]), "utf8")).toBe(original);
	expect(statSync(join(dirname(authFile()), backups()[0])).mode & 0o777).toBe(0o600);
	// a second change on the same day keeps the day's first backup
	await use("default");
	expect(JSON.parse(text())["anthropic-subscription"].pinned).toBe("default");
	expect(backups()).toHaveLength(1);
	expect(readFileSync(join(dirname(authFile()), backups()[0]), "utf8")).toBe(original);
});

test("clearing the pick removes pinned and nothing else", async () => {
	const original = JSON.stringify(store(), null, 2);
	writeStore(store({}, { pinned: "work" }));
	await use("default");
	expect(JSON.parse(text())["anthropic-subscription"].pinned).toBe("default");
	await use("auto");
	expect(text()).toBe(original);
	expect(readdirSync(dirname(authFile())).filter(f => f.endsWith(".tmp"))).toEqual([]);
	expect(readdirSync(dirname(authFile()))).not.toContain("auth.json.lock");
});

test("dotz's own pin is not announced as 'the owner pinned X in OmO' (usable pick and blocked pick)", async () => {
	writeStore(store());
	expect(stickyAccount()).toBeDefined();
	switches = [];
	await use("work");
	await use("default");
	expect(stickyAccount()).toBe("default");
	// the pick is blocked: dotz falls through to the automatic layer while OmO's pin names the blocked account
	const blocked = Date.now() + 3_600_000;
	writeStore(store({}, { accounts: [{ name: "default", access: "tok-default", refresh: "ref-default", expires: 1, blockedUntil: blocked, blockReason: "rate_limit", blockedAt: Date.now() }, { name: "work", access: "tok-work", refresh: "ref-work", expires: 2 }], pinned: "default" }));
	expect(stickyAccount()).toBe("work");
	expect(switches.filter(s => s.kind === "owner")).toEqual([]);
	expect(switches.map(s => s.kind)).not.toContain("owner");
});

test("a pin the owner sets in OmO himself is still noticed", async () => {
	writeStore(store());
	await use("default");
	await use("auto");
	switches = [];
	writeStore(store({}, { pinned: "work" }));
	expect(stickyAccount()).toBe("work");
	expect(switches.map(s => s.kind)).toEqual(["owner"]);
});
