import { expect, test } from "bun:test";
import { backupBranch, hasSecret } from "./backup.ts";

test("hasSecret skips sentence keys but still flags secret-named fields", () => {
	const titles = { "Check the active tab before a FIDO/OnePass approval": "tab check first", "Never use an API key while the auth is pinned": "no API key" };
	expect(hasSecret(JSON.stringify(titles))).toBe(false);
	expect(hasSecret(JSON.stringify({ discord: { bot_token: "abcdef123456" } }))).toBe(true);
	expect(hasSecret(JSON.stringify({ token_file: "~/.dotz/secrets/x" }))).toBe(false);
});

test("backupBranch gives each computer its own branch, never main", () => {
	expect(backupBranch("owner-Mac-mini.local")).toBe("backup/owner-mac-mini");
	expect(backupBranch("Owner-MacBook-Pro.local.")).toBe("backup/owner-macbook-pro");
	expect(backupBranch("owner-mac-mini")).not.toBe(backupBranch("owner-macbookpro"));
});

test("backupBranch sanitizes odd or empty hostnames", () => {
	expect(backupBranch("my box/../x")).toBe("backup/my-box");
	expect(backupBranch("")).toBe("backup/install");
	expect(backupBranch("...")).toBe("backup/install");
});
