// The real step machine against a fake world: runner, gateway, ports and clock. Nothing real runs, nothing leaves a temp dir.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { readCards } from "../custom.ts";
import { loadFeatureDirs } from "../featuredirs.ts";
import { atomicWrite, type Deps, cardFile, featureFile, readJson, readState, runOnboarding, watchScriptPath } from "./onboard.ts";
import { type KakaoConfig, kakaoPaths, type LoginStatus } from "./types.ts";

const REPO = join(import.meta.dir, "..", "..");
const EXEC = "/fake/bin/bun";
const PANE_FDA = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const PANE_AX = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const PASSWORD = "pw-secret-77";
const DBKEY = "dbkey-secret-99";
const OK = { code: 0, stdout: "", stderr: "" };

type Opts = { target?: string; sqlcipher?: boolean; kmsg?: boolean; fdaAfter?: number; axAfter?: number; answer?: boolean; login?: LoginStatus[]; dataDir?: string };

function world(o: Opts = {}) {
	const root = mkdtempSync(join(tmpdir(), "kk-onb-"));
	const paths = kakaoPaths(o.dataDir ?? join(root, "data"), join(root, "home"));
	const w = {
		paths,
		t: 0,
		sleeps: 0,
		fda: false,
		ax: false,
		creds: false,
		answer: o.answer ?? true,
		installed: true,
		cleared: 0,
		events: [] as string[],
		runs: [] as string[][],
		calls: [] as { method: string; path: string; body?: any; fdaGranted?: boolean }[],
		auths: new Map<string, { kind: string; status: string }>(),
		watches: [] as any[],
		logins: [...(o.login ?? [])],
		keychain: new Map<string, string>(),
		fdaAfter: o.fdaAfter as number | undefined,
		axAfter: o.axAfter as number | undefined,
	};
	w.fdaAfter ??= 2;
	w.axAfter ??= 4;
	const sends = () => w.calls.filter(c => c.path === "/api/send");
	const asks = (kind: string) => w.calls.filter(c => c.path === "/api/auth" && c.method === "POST" && c.body.kind === kind);
	const deps: Deps = {
		paths,
		repo: REPO,
		execPath: EXEC,
		brew: "brew",
		target: o.target ?? "chat",
		pid: 100,
		isAlive: pid => pid === 4242,
		now: () => w.t,
		sleep: async ms => {
			w.t += ms;
			w.sleeps++;
			if (w.fdaAfter !== undefined && w.sleeps === w.fdaAfter) {
				w.fda = true;
				w.events.push("fda-granted");
			}
			if (w.axAfter !== undefined && w.sleeps === w.axAfter) {
				w.ax = true;
				w.events.push("ax-granted");
			}
		},
		runner: async argv => {
			w.runs.push(argv);
			const k = argv.join(" ");
			if (argv[0] === "/bin/ls") return w.fda ? OK : { code: 1, stdout: "", stderr: "ls: Library: Operation not permitted" };
			if (k === "brew list --versions sqlcipher") return o.sqlcipher ? { ...OK, stdout: "sqlcipher 4.6.1\n" } : { ...OK, code: 1 };
			if (argv[0] === "open") w.events.push(argv[2] === PANE_AX ? `open-ax(fda=${w.fda})` : `open:${argv[2]}`);
			return OK;
		},
		hub: {
			post: async (path, body: any) => {
				w.calls.push({ method: "POST", path, body, fdaGranted: w.fda });
				if (path === "/api/auth") {
					const id = `a${w.auths.size + 1}`;
					w.auths.set(id, { kind: body.kind, status: "pending" });
					w.events.push(`ask:${body.kind}(fda=${w.fda})`);
					return { status: 200, json: { id } };
				}
				if (path === "/api/watches") {
					w.watches.push({ id: "w1", ...body });
					return { status: 200, json: { ok: true } };
				}
				return { status: 200, json: { delivered: true } };
			},
			get: async path => {
				w.calls.push({ method: "GET", path });
				if (path === "/api/watches") return { status: 200, json: w.watches };
				const id = path.split("/")[3]!.split("?")[0]!;
				const a = w.auths.get(id);
				if (!a) return { status: 404, json: { error: "unknown request" } };
				if (a.status === "pending") {
					if (w.answer && a.kind === "secret") {
						a.status = "entered";
						w.keychain.set("id", "someone");
						w.keychain.set("password", PASSWORD);
					} else w.t += 55_000;
				}
				return { status: 200, json: { id, status: a.status } };
			},
			patch: async (path, body) => {
				w.calls.push({ method: "PATCH", path, body });
				return { status: 200, json: {} };
			},
			del: async path => {
				w.calls.push({ method: "DELETE", path });
				return { status: 200, json: {} };
			},
		},
		ports: {
			hasKmsg: () => o.kmsg ?? false,
			appInstalled: async () => w.installed,
			accessibilityGranted: async () => w.ax,
			hasCredentials: async () => w.creds,
			importAuthFile: async () => {
				w.creds = true;
				return true;
			},
			clearCredentials: async () => {
				w.cleared++;
				w.creds = false;
			},
			login: async () => ({ status: w.logins.shift() ?? "ok" }),
			resumeAfterConfirm: async () => ({ status: "ok" as const }),
			derive: async () => {
				w.keychain.set("dbkey", DBKEY);
				return { dbPath: "/fake/KakaoTalk/db", userId: 42 };
			},
			readCounts: async () => ({ rooms: 3, draftable: 2, maxLogId: "9" }),
		},
	};
	return { w, deps, sends, asks };
}

test("happy path: installs only what is missing, batches the ask, opens one pane at a time, ends with the files in place", async () => {
	const { w, deps, sends, asks } = world();
	const r = await runOnboarding(deps);
	expect(r.outcome).toBe("done");

	const brewInstalls = w.runs.filter(a => a[0] === "brew" && a[1] === "install");
	expect(brewInstalls).toEqual([["brew", "install", "sqlcipher"], ["brew", "install", "channprj/tap/kmsg"]]);

	expect(w.runs.filter(a => a[0] === "open")).toEqual([["open", "-g", PANE_FDA], ["open", "-g", PANE_AX]]);
	const ev = w.events;
	expect(ev.indexOf("ask:secret(fda=false)")).toBeGreaterThanOrEqual(0);
	expect(ev.indexOf("ask:secret(fda=false)")).toBeLessThan(ev.indexOf("fda-granted"));
	expect(ev.indexOf("open-ax(fda=true)")).toBeGreaterThan(ev.indexOf("fda-granted"));
	expect(asks("secret")).toHaveLength(1);
	expect(asks("secret")[0]!.body).toMatchObject({ site: "kakao", fields: ["username", "password"], target: "chat", timeout_minutes: 30 });

	const combined = sends().find(c => c.body.text.includes(EXEC))!;
	expect(combined.fdaGranted).toBe(false);
	for (const part of [EXEC, "[ask]"]) expect(combined.body.text).toContain(part);

	for (const c of sends()) expect(c.body).toMatchObject({ target: "chat", update_key: "kakao-setup" });
	const texts = sends().map(c => c.body.text as string);
	texts.forEach((t, i) => expect(t).not.toBe(texts[i - 1]));
	const last = texts.at(-1)!;
	expect(last.split("\n")).toHaveLength(4);
	expect(last.startsWith("[done] 카톡 연결이 끝났어요")).toBe(true);

	expect(readJson<KakaoConfig>(w.paths.config)).toEqual({ enabled: true, dbPath: "/fake/KakaoTalk/db", userId: 42, settle_seconds: 20, max_per_run: 10, exclude_chats: [], watch_chats: [], auto_draft_chats: [] });
	expect(readState(w.paths)).toMatchObject({ status: "done", target: "chat", counts: { rooms: 3, draftable: 2 } });

	const script = watchScriptPath(w.paths);
	expect(statSync(script).mode & 0o777).toBe(0o755);
	const sh = readFileSync(script, "utf8");
	expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
	expect(sh).toContain("pgrep -xq KakaoTalk");
	expect(sh).toContain(`exec '${EXEC}' '${join(REPO, "hub", "kakao", "watch.ts")}'`);
	const watchPost = w.calls.find(c => c.path === "/api/watches" && c.method === "POST")!;
	expect(watchPost.body).toEqual({ name: "kakao-new", script, every_minutes: 1, on: "match", pattern: ".", to: "orchestrator", timeout_seconds: 60, retry: { app: [5, 15, 30], fda: [], db: [10, 30] } });

	const card = JSON.parse(readFileSync(cardFile(w.paths), "utf8"));
	expect(card).toMatchObject({ title: "카톡", view: "kv", every_minutes: 5 });
	expect(card.command).toContain("status --json");
	expect(card.actions.map((a: any) => a.label)).toEqual(["다시 로그인", "설정 이어서", "끄기"]);

	const feature = readFileSync(featureFile(w.paths), "utf8");
	expect(feature).toMatch(/^enabled: true$/m);
	expect(feature).not.toMatch(/^enabled: false$/m);
	expect(loadFeatureDirs(w.paths.dataDir).features.find(f => f.id === "kakao")!.enabled).toBe(true);

	const everything = JSON.stringify([w.calls, w.runs]);
	expect(everything).not.toContain(PASSWORD);
	expect(everything).not.toContain(DBKEY);
});

test("nothing is installed when sqlcipher and kmsg are already there", async () => {
	const { w, deps } = world({ sqlcipher: true, kmsg: true, fdaAfter: 0 });
	w.fda = true;
	w.ax = true;
	await runOnboarding(deps);
	expect(w.runs.filter(a => a[0] === "brew" && a[1] === "install")).toEqual([]);
	expect(w.runs.filter(a => a[0] === "open")).toEqual([]);
});

test("a missing Homebrew stops at the first step with the one install command", async () => {
	const { w, deps } = world();
	const run = deps.runner;
	deps.runner = async argv => (argv[1] === "--version" ? { code: 127, stdout: "", stderr: "" } : run(argv));
	const r = await runOnboarding(deps);
	expect(r.state!.stoppedAt).toMatchObject({ step: "deps" });
	expect(r.state!.stoppedAt!.action).toContain("raw.githubusercontent.com/Homebrew/install");
	expect(w.calls.filter(c => c.path === "/api/auth")).toHaveLength(0);
});

test("a device confirmation posts exactly one approve ask and closes it afterwards", async () => {
	const { w, deps, asks } = world({ login: ["confirm"], sqlcipher: true, kmsg: true });
	const r = await runOnboarding(deps);
	expect(r.outcome).toBe("done");
	expect(asks("approve")).toHaveLength(1);
	expect(w.calls.some(c => c.method === "DELETE" && c.path === "/api/auth/a2")).toBe(true);
});

test("a second rejected login stops at login and never retries (account-lock protection)", async () => {
	const { w, deps, asks } = world({ login: ["bad_credentials", "bad_credentials", "ok"], sqlcipher: true, kmsg: true });
	const r = await runOnboarding(deps);
	expect(r.outcome).toBe("stopped");
	expect(r.state!.stoppedAt).toMatchObject({ step: "login" });
	expect(w.cleared).toBe(2);
	expect(asks("secret")).toHaveLength(2);
	expect(w.logins).toEqual(["ok"]);
	expect(w.calls.filter(c => c.path === "/api/send").at(-1)!.body.text.startsWith("[fail]")).toBe(true);
});

test("a permission timeout stops there; the re-run resumes at that step without repeating work or re-asking", async () => {
	const { w, deps, sends, asks } = world({ fdaAfter: -1, axAfter: -1, answer: false });
	const first = await runOnboarding(deps);
	expect(first.outcome).toBe("stopped");
	expect(first.state!.stoppedAt).toMatchObject({ step: "permissions" });
	expect(first.state!.steps).toMatchObject({ deps: "done", app: "done", ask: "done" });
	expect(asks("secret")).toHaveLength(1);
	const texts = sends().map(c => c.body.text as string);
	texts.forEach((t, i) => expect(t).not.toBe(texts[i - 1]));
	expect(readState(w.paths)!.status).toBe("stopped");

	w.fda = true;
	w.ax = true;
	w.answer = true;
	w.runs.length = 0;
	const second = await runOnboarding(deps);
	expect(second.outcome).toBe("done");
	expect(w.runs.filter(a => a[0] === "brew")).toEqual([]);
	expect(asks("secret")).toHaveLength(1);
	expect(sends().at(-1)!.body.text.startsWith("[done]")).toBe(true);
});

test("a setup that is already running (pid alive) exits without touching anything", async () => {
	const { w, deps } = world();
	atomicWrite(w.paths.onboard, JSON.stringify({ status: "running", steps: {}, started: "x", pid: 4242 }));
	const r = await runOnboarding(deps);
	expect(r.outcome).toBe("running");
	expect(w.runs).toEqual([]);
	expect(w.calls).toEqual([]);
});

test("a work-channel target routes the watch to that channel; an existing watch is kept and un-paused", async () => {
	const { w, deps } = world({ target: "ch:123", sqlcipher: true, kmsg: true });
	w.fda = true;
	w.ax = true;
	w.watches.push({ id: "w9", name: "kakao-new", script: watchScriptPath(w.paths), channels: ["123"], paused: true });
	await runOnboarding(deps);
	expect(w.calls.filter(c => c.path === "/api/watches" && c.method === "POST")).toEqual([]);
	expect(w.calls.some(c => c.method === "PATCH" && c.path === "/api/watches/w9" && c.body.paused === false)).toBe(true);
	expect(w.calls.filter(c => c.path === "/api/send").every(c => c.body.target === "ch:123")).toBe(true);

	const other = world({ target: "ch:123", sqlcipher: true, kmsg: true });
	other.w.fda = true;
	other.w.ax = true;
	await runOnboarding(other.deps);
	expect(other.w.calls.find(c => c.path === "/api/watches" && c.method === "POST")!.body.channels).toEqual(["123"]);
});

test("the card the setup writes passes the gateway's own card validation", async () => {
	const { w, deps } = world({ dataDir: DATA_DIR, sqlcipher: true, kmsg: true });
	w.fda = true;
	w.ax = true;
	try {
		await runOnboarding(deps);
		const card = readCards().find(c => c.id === "kakao")!;
		expect("error" in card).toBe(false);
		expect((card as any).spec).toMatchObject({ title: "카톡", view: "kv", actions: [{ label: "다시 로그인" }, { label: "설정 이어서" }, { label: "끄기", confirm: true }] });
	} finally {
		// The shared test data dir: the switch, card, config and state this setup wrote would read as the owner's own to later files.
		for (const p of [dirname(featureFile(w.paths)), dirname(cardFile(w.paths)), dirname(w.paths.config), dirname(w.paths.onboard), w.paths.secretFile]) rmSync(p, { recursive: true, force: true });
	}
});
