import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAliases, setAlias } from "./account-alias.ts";
import { removeAccount } from "./accounts-api.ts";
import { readRules, setManual, setOrder } from "./account-rules.ts";
import { authFile } from "./apikey-policy.ts";

// 계정 삭제: a dead login leaves OmO's store and every trace dotz keeps of it; the last account is a sign-out, not a removal.
const put = (accounts: string[], pinned?: string) => {
	mkdirSync(dirname(authFile()), { recursive: true });
	writeFileSync(authFile(), JSON.stringify({ "anthropic-subscription": { type: "oauth", ...(pinned ? { pinned } : {}), accounts: accounts.map(name => ({ name, access: "t" })) }, anthropic: { type: "api_key", key: "k" } }, null, 2));
};
const store = () => JSON.parse(readFileSync(authFile(), "utf8"));

// The OmO store is shared by every test file of the run: a left-behind API key moves later runtime tests onto it.
const original = existsSync(authFile()) ? readFileSync(authFile(), "utf8") : null;
afterAll(() => {
	for (const f of readdirSync(dirname(authFile()))) if (f.startsWith("auth.json.dotz-delete-")) rmSync(join(dirname(authFile()), f));
	if (original === null) rmSync(authFile(), { force: true });
	else writeFileSync(authFile(), original);
});

test("deleting the pinned dead account removes it from OmO, clears the pin, the pick, the order and the alias, and keeps a copy", () => {
	put(["imported-anthropic", "anthropic"], "imported-anthropic");
	setManual("imported-anthropic");
	setOrder(["imported-anthropic", "anthropic"]);
	setAlias("imported-anthropic", "옛 계정");
	expect(removeAccount("imported-anthropic")).toBe("deleted");
	const s = store();
	expect(s["anthropic-subscription"].accounts.map((a: { name: string }) => a.name)).toEqual(["anthropic"]);
	expect(s["anthropic-subscription"].pinned).toBeUndefined();
	expect(s.anthropic).toEqual({ type: "api_key", key: "k" });
	expect(readRules().manual).toBeUndefined();
	expect(readRules().order).toEqual(["anthropic"]);
	expect(readAliases()["imported-anthropic"]).toBeUndefined();
	expect(readdirSync(dirname(authFile())).some(f => f.startsWith("auth.json.dotz-delete-"))).toBe(true);
});

test("an unknown account is missing and the last account is refused, both without touching the store", () => {
	put(["anthropic"]);
	const before = readFileSync(authFile(), "utf8");
	expect(removeAccount("nobody")).toBe("missing");
	expect(removeAccount("anthropic")).toBe("last");
	expect(readFileSync(authFile(), "utf8")).toBe(before);
	expect(existsSync(authFile())).toBe(true);
});
