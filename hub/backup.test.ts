import { expect, test } from "bun:test";
import { backupBranch } from "./backup.ts";

test("backupBranch gives each computer its own branch, never main", () => {
	expect(backupBranch("hyuns-Mac-mini.local")).toBe("backup/hyuns-mac-mini");
	expect(backupBranch("Hyuns-MacBook-Pro.local.")).toBe("backup/hyuns-macbook-pro");
	expect(backupBranch("hyuns-mac-mini")).not.toBe(backupBranch("hyuns-macbookpro"));
});

test("backupBranch sanitizes odd or empty hostnames", () => {
	expect(backupBranch("my box/../x")).toBe("backup/my-box");
	expect(backupBranch("")).toBe("backup/install");
	expect(backupBranch("...")).toBe("backup/install");
});
