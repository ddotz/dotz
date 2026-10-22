import { expect, test } from "bun:test";
import { backupBranch } from "./backup.ts";

test("backupBranch gives each computer its own branch, never main", () => {
	expect(backupBranch("host.local")).toBe("backup/host");
	expect(backupBranch("someone-MacBook-Pro.local.")).toBe("backup/someone-macbook-pro");
	expect(backupBranch("host")).not.toBe(backupBranch("host"));
});

test("backupBranch sanitizes odd or empty hostnames", () => {
	expect(backupBranch("my box/../x")).toBe("backup/my-box");
	expect(backupBranch("")).toBe("backup/install");
	expect(backupBranch("...")).toBe("backup/install");
});
