import { describe, expect, test } from "bun:test";
import { CONFIRM_WORD, EXIT, parseArgs, restartCommand, statusCommand, type Deps } from "./dotz-ctl.ts";
import { SSH_KEYCHAIN_LINE, sshKeychainFinding, type KeychainProbe } from "./ssh-keychain.ts";
import { forceCall, startCall, type ServiceEnv } from "./service-ctl.ts";
import { LABEL } from "./service.ts";

const BOOT_MS = 1_790_000_000_000;
const TOKEN = "tok-secret-value";
const sha = (c: string) => c.repeat(40);
const ver = (release: string, c: string) => ({ release, commit: { sha: sha(c), short: c.repeat(8) } });

type Mode = "up" | "down" | "hung";
type World = {
	mode: Mode;
	boot: string;
	t: number;
	running: ReturnType<typeof ver>;
	disk: ReturnType<typeof ver>;
	busy: string[];
	state: unknown;
	pid?: number;
	loaded: boolean;
	startCode: number;
	phase?: (w: World) => void;
	onStart?: (w: World) => void;
	onRestart?: (w: World) => void;
	calls: string[][];
	fetches: { path: string; method: string; timed: boolean; token?: string }[];
	lines: string[];
	answers: string[];
	tty: { in: boolean; out: boolean };
	asked: number;
};

const idleState = { runs: { main: { kind: "working" }, a: { kind: "working" }, b: { kind: "waiting" }, c: { kind: "done" } }, work: [{ status: "running" }, { status: "done" }], auth: [] };

function world(over: Partial<World> = {}): World {
	return {
		mode: "up", boot: BOOT_MS.toString(36), t: BOOT_MS + 3_600_000, running: ver("261111.2", "a"), disk: ver("261111.2", "a"), busy: [], state: idleState,
		pid: undefined, loaded: true, startCode: 0, calls: [], fetches: [], lines: [], answers: [], tty: { in: true, out: true }, asked: 0, ...over,
	};
}

const serviceEnv = (platform: string): ServiceEnv => ({ platform, uid: 501, home: "/home/u" });

function deps(w: World, platform = "darwin"): Deps {
	const e = serviceEnv(platform);
	return {
		dir: "/data",
		port: 7420,
		token: TOKEN,
		service: e,
		env: {},
		fetch: async (url, init) => {
			w.phase?.(w);
			const path = new URL(url).pathname + new URL(url).search;
			w.fetches.push({ path, method: String(init.method), timed: init.signal instanceof AbortSignal, token: (init.headers as Record<string, string>)["x-dotz-token"] });
			if (w.mode === "down") throw new TypeError("connection refused");
			if (w.mode === "hung") throw new DOMException("timed out", "TimeoutError");
			const json = (b: unknown) => new Response(JSON.stringify(b));
			if (path === "/api/health") return json({ ok: true });
			if (path.startsWith("/api/state")) return json(w.state);
			if (path === "/api/update") return json({ boot: w.boot, running: w.running, disk: w.disk, lastCheck: { incomingTotal: 0 }, job: null, busy: w.busy });
			if (path === "/api/gateway/restart") {
				w.onRestart?.(w);
				return json({ ok: true, output: "gateway restarts when idle" });
			}
			return new Response("", { status: 404 });
		},
		exec: async argv => {
			w.calls.push(argv);
			const manager = argv[0];
			if ((manager === "launchctl" && argv[1] === "print") || (manager === "systemctl" && argv[2] === "show")) {
				if (!w.loaded) return { code: manager === "launchctl" ? 113 : 1, out: "not found" };
				return manager === "launchctl"
					? { code: 0, out: `${LABEL} = {\n\tstate = ${w.pid ? "running" : "not running"}\n\t${w.pid ? `pid = ${w.pid}\n\t` : ""}last exit code = 1\n}` }
					: { code: 0, out: `LoadState=loaded\nActiveState=${w.pid ? "active" : "failed"}\nSubState=x\nMainPID=${w.pid ?? 0}\nExecMainStatus=1\nResult=exit-code` };
			}
			w.onStart?.(w);
			return { code: w.startCode, out: w.startCode ? "launchctl: Bootstrap failed: 5: Input/output error" : "" };
		},
		now: () => w.t,
		sleep: async ms => {
			w.t += ms;
		},
		out: line => w.lines.push(line),
		tail: file => (file.endsWith("gateway.err.log") ? ["ERRLOG-LINE-A", "ERRLOG-LINE-B"] : ["HUBLOG-LINE-A"]),
		tty: () => w.tty,
		ask: async () => {
			w.asked++;
			return w.answers.shift() ?? "";
		},
	};
}

const text = (w: World) => w.lines.join("\n");
const serviceCalls = (w: World) => w.calls.filter(c => !(c[1] === "print" || c[2] === "show"));
const mutating = (w: World) => serviceCalls(w).filter(c => c.includes("-k") || c.includes("restart") || c.includes("bootout") || c.includes("start") || c.includes("kickstart") || c.includes("bootstrap"));

describe("dotz status", () => {
	test("an answering gateway: exit 0, version, commit, start time facts, no token, every call has a timeout", async () => {
		const w = world({ running: ver("261111.2", "a"), disk: ver("261112.1", "b") });
		expect(await statusCommand(deps(w))).toBe(EXIT.ok);
		const out = text(w);
		expect(out).toContain("261111.2");
		expect(out).toContain("aaaaaaaa");
		expect(out).toContain("261112.1");
		expect(out).not.toContain(TOKEN);
		expect(w.fetches.length).toBeGreaterThan(0);
		expect(w.fetches.every(f => f.timed && f.method === "GET")).toBe(true);
		expect(w.calls).toEqual([]);
	});

	test("a usage-limit pause and a billing/auth block show as different facts, and an update on disk differs from a current one", async () => {
		const shown = async (main: object, lanes: object = {}) => {
			const w = world({ state: { runs: { main, ...lanes }, work: [], auth: [] } });
			await statusCommand(deps(w));
			return w.lines;
		};
		const rate = await shown({ kind: "limited", reason: "rate", detail: "2026-11-16T01:00:59.769Z" });
		const owner = await shown({ kind: "limited", reason: "owner" });
		const free = await shown({ kind: "working" });
		expect(new Set([rate.join("\n"), owner.join("\n"), free.join("\n")]).size).toBe(3);
		const lanes = await shown({ kind: "working" }, { x: { kind: "limited", reason: "rate" }, y: { kind: "limited", reason: "rate" } });
		expect(lanes.join("\n")).toContain("2");
	});

	test("a gateway that is down: exit 3 with the service view and the log tails", async () => {
		const w = world({ mode: "down", loaded: true, pid: undefined });
		expect(await statusCommand(deps(w))).toBe(EXIT.notRunning);
		const out = text(w);
		expect(out).toContain("ERRLOG-LINE-B");
		expect(out).toContain("HUBLOG-LINE-A");
		expect(out).toContain("launchd");
		expect(mutating(w)).toEqual([]);
	});

	test("a service that is not even loaded is also 'not running'", async () => {
		const w = world({ mode: "down", loaded: false });
		expect(await statusCommand(deps(w))).toBe(EXIT.notRunning);
	});

	test("a process alive that does not answer: exit 4, its pid and the log tails; nothing is touched", async () => {
		const w = world({ mode: "hung", pid: 4242 });
		expect(await statusCommand(deps(w))).toBe(EXIT.notAnswering);
		const out = text(w);
		expect(out).toContain("4242");
		expect(out).toContain("ERRLOG-LINE-A");
		expect(mutating(w)).toEqual([]);
	});

	test("Linux asks the systemd user unit instead", async () => {
		const w = world({ mode: "hung", pid: 777 });
		expect(await statusCommand(deps(w, "linux"))).toBe(EXIT.notAnswering);
		expect(w.calls[0].slice(0, 3)).toEqual(["systemctl", "--user", "show"]);
		expect(text(w)).toContain("777");
	});
});

describe("dotz restart: the gateway answers", () => {
	const restarting = (w: World, o: { busyPolls?: number; downMs?: number } = {}) => {
		const newBoot = (BOOT_MS + 7_200_000).toString(36);
		let asked: number | undefined;
		w.onRestart = x => {
			asked = x.t;
		};
		w.phase = x => {
			if (asked === undefined) return;
			const since = x.t - asked;
			if (since < (o.busyPolls ?? 6) * 2_000) x.busy = ["lane x", "orchestrator background workers (1)"];
			else if (since < (o.busyPolls ?? 6) * 2_000 + (o.downMs ?? 10_000)) x.mode = "down";
			else {
				x.mode = "up";
				x.boot = newBoot;
				x.running = ver("261112.1", "c");
				x.busy = [];
			}
		};
	};

	test("it asks the safe route once, waits through the busy and the down phase, and prints the new version; it never touches the service manager", async () => {
		const w = world();
		restarting(w, { busyPolls: 10 });
		expect(await restartCommand(deps(w), { force: false })).toBe(EXIT.ok);
		expect(w.fetches.filter(f => f.method === "POST").map(f => f.path)).toEqual(["/api/gateway/restart"]);
		expect(text(w)).toContain("261112.1");
		expect(text(w)).toContain("lane x");
		expect(serviceCalls(w)).toEqual([]);
		expect(w.fetches.every(f => f.timed)).toBe(true);
		expect(w.fetches.find(f => f.method === "POST")?.token).toBe(TOKEN);
		expect(text(w)).not.toContain(TOKEN);
	});

	test("a wait that runs out is exit 5, says the request stays queued, and still touches nothing", async () => {
		const w = world({ busy: ["lane x"] });
		w.onRestart = () => undefined;
		expect(await restartCommand(deps(w), { force: false, waitMin: 1 })).toBe(EXIT.waitedOut);
		expect(w.fetches.filter(f => f.method === "POST")).toHaveLength(1);
		expect(serviceCalls(w)).toEqual([]);
		expect(w.t).toBeGreaterThanOrEqual(BOOT_MS + 3_600_000 + 60_000);
	});

	test("--force on an answering gateway is ignored: no confirmation asked, no forced call", async () => {
		const w = world({ pid: 4242 });
		restarting(w);
		expect(await restartCommand(deps(w), { force: true })).toBe(EXIT.ok);
		expect(w.asked).toBe(0);
		expect(serviceCalls(w)).toEqual([]);
	});

	test("a gateway that went down and is not brought back by its service is started once after the silence limit", async () => {
		const w = world({ pid: undefined });
		const newBoot = (BOOT_MS + 7_200_000).toString(36);
		let asked: number | undefined;
		w.onRestart = x => {
			asked = x.t;
		};
		w.phase = x => {
			if (asked !== undefined && x.mode === "up" && x.t - asked > 4_000) x.mode = "down";
		};
		w.onStart = x => {
			x.mode = "up";
			x.boot = newBoot;
			x.phase = undefined;
		};
		expect(await restartCommand(deps(w), { force: false })).toBe(EXIT.ok);
		expect(serviceCalls(w)).toEqual([startCall(serviceEnv("darwin"), true)]);
	});

	test("it will not request a restart when the current state cannot be read", async () => {
		const w = world();
		const d = deps(w);
		const original = d.fetch;
		d.fetch = async (url, init) => (new URL(url).pathname === "/api/update" ? new Response("{}", { status: 500 }) : original(url, init));
		expect(await restartCommand(d, { force: false })).toBe(EXIT.failed);
		expect(w.fetches.filter(f => f.method === "POST")).toEqual([]);
	});
});

describe("dotz restart: the gateway is not running", () => {
	test("macOS, agent loaded without a process: kickstart without -k, then waits until it answers", async () => {
		const w = world({ mode: "down", loaded: true });
		w.onStart = x => {
			x.mode = "up";
		};
		expect(await restartCommand(deps(w), { force: false })).toBe(EXIT.ok);
		expect(serviceCalls(w)).toEqual([startCall(serviceEnv("darwin"), true)]);
		expect(w.fetches.filter(f => f.method === "POST")).toEqual([]);
	});

	test("macOS, agent not loaded: bootstrap of the installed plist in the gui domain", async () => {
		const w = world({ mode: "down", loaded: false });
		w.onStart = x => {
			x.mode = "up";
		};
		expect(await restartCommand(deps(w), { force: false })).toBe(EXIT.ok);
		expect(serviceCalls(w)).toEqual([startCall(serviceEnv("darwin"), false)]);
		expect(serviceCalls(w)[0][0]).toBe("launchctl");
		expect(serviceCalls(w)[0][2]).toBe("gui/501");
	});

	test("Linux and WSL: systemctl --user start", async () => {
		const w = world({ mode: "down", loaded: true });
		w.onStart = x => {
			x.mode = "up";
		};
		expect(await restartCommand(deps(w, "linux"), { force: false })).toBe(EXIT.ok);
		expect(serviceCalls(w)).toEqual([startCall(serviceEnv("linux"), true)]);
	});

	test("a failed start is exit 3 with the error log tail", async () => {
		const w = world({ mode: "down", loaded: false, startCode: 5 });
		expect(await restartCommand(deps(w), { force: false })).toBe(EXIT.notRunning);
		expect(text(w)).toContain("ERRLOG-LINE-B");
	});

	test("a start that never answers gives up after a bound, exit 3 with the log tails", async () => {
		const w = world({ mode: "down", loaded: true });
		expect(await restartCommand(deps(w), { force: false })).toBe(EXIT.notRunning);
		expect(text(w)).toContain("HUBLOG-LINE-A");
		expect(w.t - (BOOT_MS + 3_600_000)).toBeLessThan(300_000);
	});
});

describe("dotz restart: a process is alive but does not answer", () => {
	test("by default nothing is killed: exit 4, what was found and the exact flag", async () => {
		const w = world({ mode: "hung", pid: 4242 });
		expect(await restartCommand(deps(w), { force: false })).toBe(EXIT.notAnswering);
		expect(text(w)).toContain("4242");
		expect(text(w)).toContain("dotz restart --force");
		expect(mutating(w)).toEqual([]);
		expect(w.asked).toBe(0);
	});

	test("--force without a terminal is refused before any question or call", async () => {
		for (const tty of [{ in: false, out: false }, { in: true, out: false }, { in: false, out: true }]) {
			const w = world({ mode: "hung", pid: 4242, tty, answers: [CONFIRM_WORD] });
			expect(await restartCommand(deps(w), { force: true })).toBe(EXIT.forceRefused);
			expect(w.asked).toBe(0);
			expect(mutating(w)).toEqual([]);
		}
	});

	test("--force at a terminal with the wrong or an empty confirmation does nothing", async () => {
		for (const typed of ["", "yes", "RESTART now"]) {
			const w = world({ mode: "hung", pid: 4242, answers: [typed] });
			expect(await restartCommand(deps(w), { force: true })).toBe(EXIT.forceRefused);
			expect(w.asked).toBe(1);
			expect(mutating(w)).toEqual([]);
		}
	});

	test("--force at a terminal with the typed word kills and restarts through the service manager, then waits for the answer", async () => {
		for (const platform of ["darwin", "linux"]) {
			const w = world({ mode: "hung", pid: 4242, answers: [` ${CONFIRM_WORD} `] });
			w.onStart = x => {
				x.mode = "up";
			};
			expect(await restartCommand(deps(w, platform), { force: true })).toBe(EXIT.ok);
			expect(serviceCalls(w)).toEqual([forceCall(serviceEnv(platform))]);
		}
	});
});

describe("arguments", () => {
	test("status takes nothing; restart takes --force and --wait <minutes>; anything else is the usage", () => {
		expect(parseArgs(["status"])).toEqual({ cmd: "status" });
		expect(parseArgs(["restart"])).toEqual({ cmd: "restart", force: false, waitMin: undefined });
		expect(parseArgs(["restart", "--force", "--wait", "5"])).toEqual({ cmd: "restart", force: true, waitMin: 5 });
		for (const bad of [[], ["status", "--force"], ["restart", "--wait"], ["restart", "--wait", "0"], ["restart", "-f"], ["stop"]]) expect(parseArgs(bad)).toEqual({ cmd: "usage" });
	});
});

describe("dotz status: an SSH shell that cannot read the keychain login", () => {
	const DIR_ID = "a".repeat(32);
	const AGENT = "/Users/you/.omo/agent";
	const CRED = `${AGENT}/anthropic-subscription-claude/${DIR_ID}/.credentials.json`;
	const auth = JSON.stringify({ "anthropic-subscription": { accounts: [{ name: "default", store: "claude-cli", dirId: DIR_ID }] } });
	const BLOCKED = { code: 36, out: "User interaction is not allowed." };
	type Over = { platform?: string; env?: Record<string, string>; files?: string[]; authText?: string | undefined; reply?: { code: number; out: string } | undefined };
	const probe = (o: Over = {}) => {
		const calls: { argv: string[]; ms: number }[] = [];
		const p: KeychainProbe = {
			platform: o.platform ?? "darwin",
			env: o.env ?? { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" },
			home: "/Users/you",
			read: file => (file === `${AGENT}/auth.json` && "authText" in o ? o.authText : file === `${AGENT}/auth.json` ? auth : undefined),
			exists: file => (o.files ?? []).includes(file),
			security: async (argv, ms) => {
				calls.push({ argv, ms });
				return "reply" in o ? o.reply : BLOCKED;
			},
		};
		return { p, calls };
	};

	test("SSH, the login only in the keychain, the read refused: the finding, from one bounded call that never asks for the secret", async () => {
		const { p, calls } = probe();
		expect(await sshKeychainFinding(p)).toBe("ssh-keychain-unreadable");
		expect(calls).toHaveLength(1);
		expect(calls[0].argv[0]).toBe("security");
		expect(calls[0].argv).not.toContain("-w");
		expect(calls[0].ms).toBeLessThanOrEqual(2_000);
	});

	test("SSH_TTY alone also counts as an SSH shell", async () => {
		expect(await sshKeychainFinding(probe({ env: { SSH_TTY: "/dev/ttys001" } }).p)).toBe("ssh-keychain-unreadable");
	});

	test("not an SSH shell, not macOS, or a login file the agent can read: nothing, and no security process", async () => {
		for (const o of [{ env: {} }, { platform: "linux" }, { files: [CRED] }]) {
			const { p, calls } = probe(o);
			expect(await sshKeychainFinding(p)).toBeUndefined();
			expect(calls).toEqual([]);
		}
	});

	test("no Claude login in auth.json, or one that needs a new sign-in: nothing", async () => {
		for (const authText of [undefined, "not json", "{}", JSON.stringify({ "anthropic-subscription": { accounts: [{ name: "x", store: "claude-cli", dirId: DIR_ID, signInRequired: true }] } })]) {
			const { p, calls } = probe({ authText });
			expect(await sshKeychainFinding(p)).toBeUndefined();
			expect(calls).toEqual([]);
		}
	});

	test("a readable keychain, an unrelated failure, a missing answer (timeout): nothing", async () => {
		for (const reply of [{ code: 0, out: "Keychain is fine" }, { code: 44, out: "The specified item could not be found." }, undefined]) {
			expect(await sshKeychainFinding(probe({ reply }).p)).toBeUndefined();
		}
	});

	test("dotz status shows the line once for the finding, and never when there is none; the exit code stays the gateway's", async () => {
		const shown = async (o: Over) => {
			const w = world();
			const d = { ...deps(w), keychain: probe(o).p };
			const code = await statusCommand(d);
			return { code, count: w.lines.filter(l => l === SSH_KEYCHAIN_LINE).length };
		};
		expect(await shown({})).toEqual({ code: EXIT.ok, count: 1 });
		expect(await shown({ env: {} })).toEqual({ code: EXIT.ok, count: 0 });
		const w = world({ mode: "down" });
		expect(await statusCommand({ ...deps(w), keychain: probe().p })).toBe(EXIT.notRunning);
		expect(w.lines.filter(l => l === SSH_KEYCHAIN_LINE)).toHaveLength(1);
	});
});
