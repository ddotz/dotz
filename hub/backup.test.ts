import { expect, test } from "bun:test";
import { backupBranch } from "./backup.ts";

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
