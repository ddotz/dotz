import { describe, expect, test } from "bun:test";
import { LABEL, servicePath, UNIT } from "./service.ts";
import { callEnv, forceCall, managerOf, parseState, queryCall, startCall, type ServiceEnv } from "./service-ctl.ts";

const mac: ServiceEnv = { platform: "darwin", uid: 501, home: "/home/u" };
const linux: ServiceEnv = { platform: "linux", uid: 1000, home: "/home/u" };

describe("service manager calls", () => {
	test("macOS addresses the gui/<uid> domain with an explicit target, so an SSH session (no GUI session of its own) reaches the agent", () => {
		expect(queryCall(mac)).toEqual(["launchctl", "print", `gui/501/${LABEL}`]);
		expect(startCall(mac, true)).toEqual(["launchctl", "kickstart", `gui/501/${LABEL}`]);
		expect(startCall(mac, false)).toEqual(["launchctl", "bootstrap", "gui/501", servicePath({ home: mac.home }, "darwin")]);
		expect(forceCall(mac)).toEqual(["launchctl", "kickstart", "-k", `gui/501/${LABEL}`]);
	});

	test("starting never kills: only the forced call carries -k or restart", () => {
		for (const env of [mac, linux]) {
			for (const loaded of [true, false]) expect(startCall(env, loaded).join(" ")).not.toMatch(/ -k |restart|bootout|stop/);
			expect(forceCall(env).join(" ")).toMatch(/ -k |restart/);
		}
	});

	test("Linux and WSL use the systemd user unit by its installed name", () => {
		expect(managerOf("linux")).toBe("systemd");
		expect(queryCall(linux).slice(0, 4)).toEqual(["systemctl", "--user", "show", UNIT]);
		expect(startCall(linux, false)).toEqual(["systemctl", "--user", "start", UNIT]);
		expect(forceCall(linux)).toEqual(["systemctl", "--user", "restart", UNIT]);
	});

	test("an SSH shell without a user bus gets one from the uid; an existing one is kept; macOS needs none", () => {
		expect(callEnv(linux, {})).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" });
		expect(callEnv(linux, { XDG_RUNTIME_DIR: "/x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/y" })).toEqual({ XDG_RUNTIME_DIR: "/x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/y" });
		expect(callEnv(mac, {})).toEqual({});
	});
});

describe("service state", () => {
	test("launchd: a running agent has its pid and last exit; a loaded agent without pid is not running; an unloaded one is not loaded", () => {
		const running = parseState("launchd", { code: 0, out: `${LABEL} = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}` });
		expect(running).toMatchObject({ loaded: true, pid: 4242, state: "running", lastExit: "0" });
		const idle = parseState("launchd", { code: 0, out: `${LABEL} = {\n\tstate = not running\n\tlast exit status = 256\n}` });
		expect(idle).toMatchObject({ loaded: true, pid: undefined, lastExit: "256" });
		expect(parseState("launchd", { code: 113, out: "Could not find service" })).toMatchObject({ loaded: false, error: "Could not find service" });
	});

	test("systemd: MainPID 0 is no process; a failed exit shows; a bus that cannot be reached is not loaded", () => {
		const up = parseState("systemd", { code: 0, out: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=777\nExecMainStatus=0\nResult=success" });
		expect(up).toMatchObject({ loaded: true, pid: 777, state: "active/running", lastExit: undefined });
		const dead = parseState("systemd", { code: 0, out: "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=1\nResult=exit-code" });
		expect(dead).toMatchObject({ loaded: true, pid: undefined });
		expect(dead.lastExit).toContain("exit-code");
		expect(parseState("systemd", { code: 1, out: "Failed to connect to bus: No medium found" })).toMatchObject({ loaded: false });
	});
});
