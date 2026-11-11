import { describe, expect, test } from "bun:test";
import { systemDeny } from "./systemdeny.ts";

describe("systemDeny: the dotz command", () => {
	test("the forced restart is refused in every spelling an agent's shell could use", () => {
		for (const cmd of [
			"dotz restart --force",
			"dotz restart --wait 5 --force",
			"/Users/x/.dotz/bin/dotz restart --force",
			"bun onboard/dotz-ctl-cli.ts restart --force",
			"cd wt && DOTZ_DIR=/d dotz restart --force",
		]) expect(systemDeny(cmd)).toBeDefined();
	});

	test("plain restart, status and the other forms stay allowed: they never cut running work", () => {
		for (const cmd of ["dotz restart", "dotz restart --wait 5", "dotz status", "dotz last", "dotz --print", "dotz restart && echo --force", "echo --force; dotz status"]) expect(systemDeny(cmd)).toBeUndefined();
	});

	test("the older kills are still refused", () => {
		expect(systemDeny("launchctl kickstart -k gui/501/dev.dotz.gateway")).toBeDefined();
		expect(systemDeny("pkill -f hub/main")).toBeDefined();
	});
});
