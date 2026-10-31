// The self-service helper against a fake computer: every exec is recorded and answered here, nothing real runs.
import { expect, test } from "bun:test";
import { allowWhile, grantPermission, type Host, PANES, realHost, restartApp } from "./selfserve.ts";

test("under bun test the real host refuses anything that would touch the real UI or system", async () => {
	for (const argv of [["open", "-g", PANES.fda], ["osascript", "-e", "1"], ["/usr/bin/tccutil", "reset", "All"], ["killall", "Aside"], ["launchctl", "list"]])
		await expect(realHost.exec(argv)).rejects.toThrow("refused under test");
});

function fake(o: { platform?: NodeJS.Platform; toggle?: string; allow?: boolean; onToggle?: () => void } = {}) {
	const runs: string[][] = [];
	let sleeps = 0;
	const h: Host = {
		platform: o.platform ?? "darwin",
		sleep: async () => void sleeps++,
		exec: async argv => {
			runs.push(argv);
			if (argv[0] === "osascript" && argv.length === 7) {
				o.onToggle?.();
				return { code: 0, stdout: `${o.toggle ?? "error"}\n`, stderr: "" };
			}
			if (argv[0] === "osascript" && argv[2] === "JavaScript") return { code: 0, stdout: o.allow ? "clicked\n" : "none\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { h, runs, sleeps: () => sleeps };
}

test("off macOS a permission step is skipped without running anything", async () => {
	const f = fake({ platform: "linux" });
	expect(await grantPermission(f.h, { key: "fda", row: "bun", check: async () => false })).toEqual({ status: "skipped", tried: [] });
	expect(f.runs).toEqual([]);
});

test("an already granted permission touches nothing", async () => {
	const f = fake();
	expect((await grantPermission(f.h, { key: "accessibility", row: "bun", check: async () => true })).status).toBe("granted");
	expect(f.runs).toEqual([]);
});

test("the bot opens the exact pane, presses the app's switch and finishes without the owner", async () => {
	let on = false;
	const f = fake({ toggle: "toggled", onToggle: () => (on = true) });
	const r = await grantPermission(f.h, { key: "fda", row: "bun", path: "/x/bun", check: async () => on });
	expect(r).toEqual({ status: "granted", tried: ["pane", "toggle:toggled"] });
	expect(f.runs[0]).toEqual(["open", "-g", PANES.fda]);
	expect(f.runs[1]!.slice(0, 4)).toEqual(["osascript", "-l", "JavaScript", "-e"]);
	expect(f.runs[1]!.slice(5)).toEqual(["bun", "/x/bun"]);
});

test("macOS refusing the switch ends with one exact owner step, after every try, with no sleep after the last", async () => {
	const f = fake({ toggle: "refused" });
	let checks = 0;
	const r = await grantPermission(f.h, { key: "accessibility", row: "bun", path: "/x/bun", tries: 3, check: async () => (checks++, false) });
	expect(r.status).toBe("needs-owner");
	expect(r.step).toContain("손쉬운 사용");
	expect(r.step).toContain("/x/bun");
	expect(checks).toBe(4);
	expect(f.sleeps()).toBe(2);
});

test("a pressed switch that still waits names the password or Touch ID sheet as the only step", async () => {
	const f = fake({ toggle: "toggled" });
	const r = await grantPermission(f.h, { key: "fda", row: "bun", tries: 1, check: async () => false });
	expect(r.step).toContain("Touch ID");
});

test("nested panes (Automation, Files and Folders) are opened but no switch is pressed there", async () => {
	for (const key of ["automation", "files"] as const) {
		const f = fake({ toggle: "toggled" });
		await grantPermission(f.h, { key, row: "bun", tries: 1, check: async () => false });
		expect(f.runs.filter(a => a.length === 7)).toEqual([]);
		expect(f.runs[0]).toEqual(["open", "-g", PANES[key]]);
	}
});

test("a permission prompt answered by the bot's Allow click counts as granted", async () => {
	let allowed = false;
	const f = fake({ allow: true });
	const exec = f.h.exec;
	f.h.exec = async argv => {
		const r = await exec(argv);
		if (r.stdout.startsWith("clicked")) allowed = true;
		return r;
	};
	const r = await grantPermission(f.h, { key: "automation", row: "bun", check: async () => allowed });
	expect(r).toEqual({ status: "granted", tried: ["pane", "allow"] });
});

test("allowWhile keeps pressing Allow until the probe is done, then stops", async () => {
	const f = fake();
	let finish!: () => void;
	const done = new Promise<void>(r => (finish = r));
	f.h.sleep = async () => {
		if (f.runs.length >= 2) finish();
	};
	await allowWhile(f.h, done);
	const clicks = f.runs.length;
	expect(clicks).toBeGreaterThanOrEqual(2);
	await f.h.sleep(0);
	expect(f.runs.length).toBe(clicks);
});

test("restartApp quits the app, waits for it to exit, and reopens it in the background", async () => {
	let up = true;
	const runs: string[][] = [];
	const h: Host = {
		platform: "darwin",
		sleep: async () => {},
		exec: async argv => {
			runs.push(argv);
			if (argv[0] === "osascript") up = false;
			if (argv[0] === "open") up = true;
			return { code: argv[0] === "pgrep" && !up ? 1 : 0, stdout: "", stderr: "" };
		},
	};
	expect(await restartApp(h, "Aside")).toBe(true);
	expect(runs.map(a => a[0])).toEqual(["osascript", "pgrep", "pgrep", "open", "pgrep"]);
	expect(runs.find(a => a[0] === "open")).toEqual(["open", "-g", "-j", "-a", "Aside"]);
});
