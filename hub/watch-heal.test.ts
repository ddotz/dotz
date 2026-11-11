// Self-healing of a failing watch script: the classifier, the file a watch may have fixed, and the flow through the real watch module.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, DATA_DIR } from "./config.ts";
import { type FailClass, type NotifyInfo, classifyFailure, healTarget } from "./watch-heal.ts";
import { addWatch, allWatches, removeWatch, runWatch, setHealedHandler, setHealHandler, startWatches, type Watch } from "./watch.ts";
import { watchIssueLine } from "./watchtext.ts";

const TYPE_ERROR = "TypeError: Cannot read properties of null (reading 'click')\n    at run (/srv/check.js:12:34)";

const cases: [string, { output: string; code?: number; timedOut?: boolean; kind?: string }, FailClass][] = [
	["fetch failed shaped as a TypeError is the network's", { output: "TypeError: fetch failed" }, "outside"],
	["a null element is the script's", { output: TYPE_ERROR }, "script"],
	["the script asks for a heal", { output: "DOTZ_FAIL script\nselector moved", kind: "script" }, "script"],
	["an approval is the owner's", { output: "DOTZ_FAIL approval", kind: "approval" }, "owner"],
	["a declared kind is outside", { output: "DOTZ_FAIL outage", kind: "outage" }, "outside"],
	["a timeout is not fixed", { output: "TypeError: x is null\n(killed after 120 s)", timedOut: true }, "unknown"],
	["connection refused", { output: "Error: connect ECONNREFUSED 127.0.0.1:80" }, "outside"],
	["a server error", { output: "request failed: HTTP 503" }, "outside"],
	["a lost login", { output: "logged out: the check page answered signed out" }, "owner"],
	["a lost login in Korean", { output: "로그인이 풀렸어요" }, "owner"],
	["unauthorized", { output: "status 401 Unauthorized" }, "owner"],
	["the word login alone is not the owner's", { output: "로그인 탭 준비 실패: TypeError: tab is null" }, "script"],
	["a missing command", { output: "zsh: command not found: jq", code: 127 }, "script"],
	["a python traceback", { output: "Traceback (most recent call last):\n  File \"a.py\", line 1" }, "script"],
	["a stack line of a failed exit", { output: "boom\n    at main (/srv/check.js:3:9)" }, "script"],
	["nothing known", { output: "something odd happened" }, "unknown"],
];
test.each(cases)("classifyFailure: %s", (_name, c, expected) => {
	expect(classifyFailure({ output: c.output, code: c.code ?? 1, timedOut: c.timedOut ?? false, kind: c.kind ?? "fail" })).toBe(expected);
});

const temp = () => mkdtempSync(join(tmpdir(), "dotz-heal-"));
const textFile = (path: string, body = "#!/bin/sh\nexit 1\n") => {
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
};

test("healTarget names the file a watch runs and refuses what must not be touched", () => {
	const pkg = temp(), data = temp(), work = temp();
	mkdirSync(join(data, "secrets"));
	const own = textFile(join(work, "check.sh"));
	const shipped = textFile(join(pkg, "hub-check.sh"));
	const secret = textFile(join(data, "secrets", "token.sh"));
	const link = join(work, "link.sh");
	symlinkSync(shipped, link);
	const big = join(work, "big.sh");
	writeFileSync(big, "x".repeat(64 * 1024 + 1));
	const bin = join(work, "bin.dat");
	writeFileSync(bin, Buffer.from([1, 0, 2]));
	const t = (w: Partial<Watch> & { command: string }) => healTarget(w, pkg, data);
	expect(t({ command: own, script: own })).toEqual({ file: own });
	expect(t({ command: "bash -lc './check.sh --flag' && echo", cwd: work })).toEqual({ file: join(work, "check.sh") });
	expect(t({ command: `/usr/bin/env bash ${own}` })).toEqual({ file: own });
	expect(t({ command: "echo hi" })).toEqual({ refuse: "none" });
	expect(t({ command: shipped, script: shipped })).toEqual({ refuse: "shipped" });
	expect(t({ command: link, script: link })).toEqual({ refuse: "shipped" });
	expect(t({ command: `sh ${secret}` })).toEqual({ refuse: "secret" });
	expect(t({ command: "session check https://x.example", session: { url: "https://x.example" } as Watch["session"] })).toEqual({ refuse: "session" });
	expect(t({ command: big, script: big })).toEqual({ refuse: "size" });
	expect(t({ command: bin, script: bin })).toEqual({ refuse: "text" });
});

test("watchIssueLine keeps a short plain first line but never a stack fragment from it", () => {
	const info: NotifyInfo = { cls: "script", log: "/tmp/x/last-fail.log" };
	const plain = watchIssueLine("메일", "failed 2 times in a row (exit 1)", info, "로그인 화면이 바뀌었어요\n    at x (/a.js:1:2)");
	expect(plain.split("\n")).toContain("로그인 화면이 바뀌었어요");
	const mixed = watchIssueLine("메일", "failed 2 times in a row (exit 1)", info, "로그인 실패: 탭 준비 실패:   at <anonymous>:1:204\nError: TypeError: x");
	expect(mixed).not.toContain("<anonymous>");
	expect(mixed).not.toContain("TypeError");
	expect(mixed).toContain("/tmp/x/last-fail.log");
});

type Notice = { reason: string; output: string; info?: NotifyInfo };
const notices: Notice[] = [];
const turns: string[] = [];
const healedNotes: string[] = [];
let onNotice: (() => void) | undefined;
let onHealed: (() => void) | undefined;
beforeAll(() => {
	startWatches((_w, reason, output, _prev, info) => {
		notices.push({ reason, output, info });
		onNotice?.();
	});
});
afterEach(() => {
	for (const w of allWatches()) removeWatch(w.id);
	notices.length = 0;
	turns.length = 0;
	healedNotes.length = 0;
	setHealHandler(() => {});
	setHealedHandler(() => {});
	Reflect.deleteProperty(cfg, "watch");
});
const noteOf = (w: Watch) => join(DATA_DIR, "watches", w.id, "heal-note.txt");
const brokenWatch = (name: string): { script: string; w: Watch } => {
	const script = textFile(join(temp(), "check.sh"), `#!/bin/sh\necho "${TYPE_ERROR.replace(/\n/g, "\\n")}" >&2\nexit 1\n`);
	const w = addWatch({ name, script, on: "fail", to: "alert", every_minutes: 5 }, "");
	return { script, w };
};
const next = (set: (r: () => void) => void) => new Promise<void>(r => set(r));
const state = (name: string) => allWatches().find(w => w.name === name)!.state;

test("a script error is fixed by the heal turn: one 'fixed' line, no alert, no recovered notice", async () => {
	const { script, w } = brokenWatch("heal-ok");
	const healed = next(r => (onHealed = r));
	setHealHandler((watch, turn) => {
		turns.push(turn);
		writeFileSync(script, "#!/bin/sh\necho ok\n");
		setImmediate(() => writeFileSync(noteOf(watch), "selector fixed, the page moved\n"));
	});
	setHealedHandler((_w, note) => {
		healedNotes.push(note);
		onHealed?.();
	});
	await runWatch(w.id);
	expect(turns).toHaveLength(0);
	await runWatch(w.id);
	await healed;
	expect(turns).toHaveLength(1);
	expect(turns[0]).toContain(script);
	expect(healedNotes).toEqual(["selector fixed, the page moved"]);
	expect(notices).toHaveLength(0);
	expect(state("heal-ok")).toMatchObject({ fails: 0, healing: undefined, healN: 1 });
	expect(readFileSync(join(DATA_DIR, "watches", w.id, "last-fail.log"), "utf8")).toContain("TypeError");
	expect(readdirSync(join(DATA_DIR, "watches", w.id, "heal"))).toHaveLength(1);
});

test("a fix that does not work gets two turns in a day, then one plain alert with the log path and no stack", async () => {
	const { w } = brokenWatch("heal-bad");
	const alerted = next(r => (onNotice = r));
	setHealHandler((watch, turn) => {
		turns.push(turn);
		const n = turns.length;
		setImmediate(() => writeFileSync(noteOf(watch), `try ${n}: changed nothing useful\n`));
	});
	setHealedHandler(() => healedNotes.push("unexpected"));
	await runWatch(w.id);
	await runWatch(w.id);
	await alerted;
	expect(turns).toHaveLength(2);
	expect(healedNotes).toHaveLength(0);
	expect(notices).toHaveLength(1);
	const [n] = notices;
	expect(n!.reason).toMatch(/^failed \d+ times in a row/);
	expect(n!.info).toMatchObject({ cls: "script", note: "try 2: changed nothing useful" });
	const text = watchIssueLine("heal bad", n!.reason, n!.info, n!.output);
	expect(text).toContain(n!.info!.log);
	expect(text).not.toContain("    at ");
	expect(text).not.toContain("```");
	expect(state("heal-bad").healing).toBeUndefined();
});

test("with watch.self_heal off the alert goes out at once and no turn is started", async () => {
	Reflect.set(cfg, "watch", { self_heal: false });
	const { w } = brokenWatch("heal-off");
	setHealHandler((_w, turn) => void turns.push(turn));
	await runWatch(w.id);
	await runWatch(w.id);
	expect(turns).toHaveLength(0);
	expect(notices).toHaveLength(1);
	expect(notices[0]!.info?.cls).toBe("script");
	expect(state("heal-off").healing).toBeUndefined();
});
