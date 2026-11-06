import { expect, test } from "bun:test";

// The launchd gateway has no /usr/sbin on PATH; machineHost must still find scutil there.
test.skipIf(process.platform !== "darwin")("machineHost reads LocalHostName with a limited PATH", () => {
	const expected = Bun.spawnSync(["/usr/sbin/scutil", "--get", "LocalHostName"]).stdout.toString().trim();
	const r = Bun.spawnSync([process.execPath, "-e", 'import { machineHost } from "./hub/hostname.ts"; console.log(machineHost());'], {
		cwd: import.meta.dir + "/..",
		env: { PATH: "/usr/bin:/bin" },
	});
	expect(r.stdout.toString().trim()).toBe(expected);
});
