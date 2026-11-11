import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, classifyModelError, classifyToolError, failureReport, wakeOf } from "./failure-report.ts";

const root = mkdtempSync(join(tmpdir(), "failure-report-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = new Date().getTime(); // the preload freezes Date.now, but file mtimes are real
const iso = (agoMin = 5) => new Date(NOW - agoMin * 60e3).toISOString();
const line = (message: object, type = "message") => `${JSON.stringify({ type, timestamp: iso(), message })}\n`;
const user = (text: string) => line({ role: "user", content: text });
const call = (id: string, name: string, args: object = {}) => ({ type: "toolCall", id, name, arguments: args });
const turn = (tokens: number, content: object[], stopReason = "toolUse", extra: object = {}) => line({ role: "assistant", content, usage: { totalTokens: tokens }, stopReason, ...extra });
const result = (id: string, name: string, text: string, isError = false) => line({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });
const say = (text: string) => ({ type: "text", text });

const write = (file: string, ...lines: string[]) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, lines.join(""));
};
const worker = (home: string, id: string, ...lines: string[]) =>
	write(join(home, ".omo/agent/projects/p-1/senpi-task/children", id, "sessions", id, `2026-11-05T00-00-00-000Z_${id.padStart(8, "0")}.jsonl`), ...lines);

// Home with: a main session (a repeated call, three tool errors, one empty keepalive wake), four workers (finished, token cap, cut mid-tool, cut by error)
// that sit only under projects/ (not in any task-stores.json), and a hub.log with a restart, a replay of 3 prompts and one old line.
// Copy `c` of the session set: same shape and numbers, own file and worker ids, so adding a copy doubles the volume and leaves every share alone.
function addCopy(home: string, c: number) {
	write(
		join(home, `.omo/agent/sessions/--tmp-proj--/2026-11-05T00-00-00-000Z_aaaaaaa${c}-0000-0000-0000-000000000000.jsonl`),
		user("[keepalive] tick"),
		turn(100, [say("ok")], "stop"),
		user("[dotz inbox] web: hello"),
		turn(400, [call("c1", "eval", { code: "1" })]),
		result("c1", "eval", "fine"),
		turn(400, [call("c2", "eval", { code: "1" })]),
		result("c2", "eval", "ENOENT: no such file or directory, access '/tmp/x'", true),
		turn(300, [call("c3", "edit", {})]),
		result("c3", "edit", "Could not find the exact text in a.ts", true),
		turn(300, [call("c4", "eval", { code: "2" })]),
		result("c4", "eval", "Blocked by dotz (custom plugin acme): no explicit OK", true),
		turn(0, [], "error", { errorMessage: "429 usage limit" }),
		turn(200, [say("done and dusted")], "stop"),
	);
	const w = (n: number) => `st_${n}_${c}`;
	worker(home, w(1), user("go"), turn(1000, [call("w1", "read")]), result("w1", "read", "data"), turn(500, [say("finished the job")], "stop"));
	worker(home, w(2), user("go"), turn(2000, [call("w2", "todo")]), result("w2", "todo", "[fail] dotz task token cap: this worker has used 9,000K tokens over 3 turns (cap 8,000K)", true), turn(10, [say("[fail] cap")], "stop"));
	worker(home, w(3), user("go"), turn(700, [call("w3", "eval")]));
	worker(home, w(4), user("go"), turn(300, [say("half")]), turn(0, [], "error", { errorMessage: "stream closed" }));
}
const hubLog = (home: string, ...extra: string[]) =>
	appendFileSync(join(home, ".dotz/hub.log"), [`${iso()} gateway restart (2 request(s) coalesced, waited 3s)\n`, `${iso()} replaying 3 unanswered prompt(s) from before the restart\n`, ...extra].join(""));
function fixture(name: string) {
	const home = join(root, name);
	addCopy(home, 0);
	write(join(home, ".dotz/hub.log"), `${new Date(NOW - 40 * 86400e3).toISOString()} gateway restart (1 request(s) coalesced, waited 1s)\n`);
	hubLog(home);
	return home;
}
const run = (home: string, now = NOW) => failureReport({ home, dataDir: join(home, ".dotz"), days: 7, now });
const cls = (rows: { name: string; count: number; tokens: number }[], name: string) => rows.find(r => r.name === name);

describe("classifiers", () => {
	test("tool errors fall into the six causes", () => {
		expect(classifyToolError("Worker brief rejected by the guard: no observable done-condition")).toBe("얇은 브리프");
		expect(classifyToolError("INTERRUPTED: the consuming run ended")).toBe("런타임 끊김");
		expect(classifyToolError("Blocked by dotz (custom plugin acme)")).toBe("정책 차단");
		expect(classifyToolError("Command timed out after 30s")).toBe("기한 초과");
		expect(classifyToolError("Validation failed for tool eval")).toBe("입력 오류");
		expect(classifyToolError("ENOENT: no such file or directory")).toBe("낡은 경로·선택자");
		expect(classifyToolError("Command exited with code 1")).toBe("기타");
	});
	test("model errors and wake sources", () => {
		expect(classifyModelError("All Claude accounts are blocked (rate limit)")).toBe("429·한도");
		expect(classifyModelError("HTTP 529 overloaded")).toBe("과부하·5xx");
		expect(wakeOf("[dotz inbox] lane: report")).toBe("inbox:lane-report");
		expect(wakeOf("[keepalive] x")).toBe("keepalive");
	});
});

describe("failureReport", () => {
	const r = run(fixture("report"));

	test("workers outside task-stores.json are counted and sorted by outcome", () => {
		expect(r.files.workers).toBe(4);
		expect(cls(r.workers, "끝냄")).toMatchObject({ count: 1, tokens: 1500 });
		expect(cls(r.workers, "토큰 상한")).toMatchObject({ count: 1, tokens: 2010 });
		expect(cls(r.workers, "도구 도중 끊김")).toMatchObject({ count: 1, tokens: 700 });
		expect(cls(r.workers, "오류로 끊김")).toMatchObject({ count: 1, tokens: 300 });
		expect(r.workers.map(w => w.name)).toEqual(["토큰 상한", "끝냄", "도구 도중 끊김", "오류로 끊김"]);
	});

	test("tool errors are charged to the turn that made the call, repeats to the repeating call", () => {
		expect(cls(r.toolErrors, "낡은 경로·선택자")).toMatchObject({ count: 1, tokens: 400 });
		expect(cls(r.toolErrors, "입력 오류")).toMatchObject({ count: 1, tokens: 300 });
		expect(cls(r.toolErrors, "정책 차단")).toMatchObject({ count: 1, tokens: 300 });
		expect(cls(r.toolErrors, "런타임 끊김")).toMatchObject({ count: 1, tokens: 2000 });
		expect(cls(r.repeats, "eval")).toMatchObject({ count: 1, tokens: 400 });
	});

	test("error turns, wakes and hub.log counters", () => {
		expect(cls(r.errorTurns, "429·한도")?.count).toBe(1);
		expect(cls(r.errorTurns, "프로세스·스트림")?.count).toBe(1);
		expect(r.wakes.find(w => w.name === "keepalive")).toMatchObject({ count: 1, tokens: 100, noop: 1, lost: 100 });
		expect(cls(r.hubLog, "재시작: 게이트웨이")?.count).toBe(1);
		expect(cls(r.hubLog, "재생: 못 받은 프롬프트")?.count).toBe(3);
	});

	test("the loss table is sorted by tokens and tool output is counted per tool", () => {
		const tokens = r.lost.map(l => l.tokens);
		expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
		expect(r.lost[0]?.name).toBe("워커 토큰 상한");
		expect(cls(r.toolOutput, "eval")?.count).toBe(3);
	});
});

describe("late wake failures", () => {
	// A worker that answered and stopped, then died on a follow-up wake, is finished; a worker whose last real turn died is cut.
	const home = join(root, "late");
	const lateError = { errorMessage: "native binary failed to launch" };
	worker(home, "st_a", user("go"), turn(1000, [call("a1", "read")]), result("a1", "read", "data"), turn(500, [say("answer")], "stop"), user("follow up"), turn(0, [], "error", lateError));
	worker(home, "st_b", user("go"), turn(800, [say("answer")], "stop"), user("follow up"), turn(400, [call("b1", "read")]), turn(0, [], "error", lateError));
	worker(home, "st_c", user("go"), turn(900, [call("c1", "read")]), result("c1", "read", "data"), turn(0, [], "error", lateError));
	const r = run(home);

	test("a normal stop followed by a failed wake is finished, and the error class holds only the turns after the stop", () => {
		expect(cls(r.workers, "끝냄")).toMatchObject({ count: 2, tokens: 1500 + 800 });
		expect(cls(r.workers, "오류로 끊김")).toMatchObject({ tokens: 400 + 900 });
	});

	test("a worker whose last real turn died is still cut", () => {
		expect(cls(r.workers, "오류로 끊김")?.count).toBe(2); // st_b's late turn and all of st_c
		expect(cls(r.lost, "워커 끝냄")).toBeUndefined();
		expect(cls(r.errorTurns, "기타")?.count).toBe(3); // the failed wakes stay visible as model errors
	});
});

describe("repeats", () => {
	test("identical consecutive calls count from the second one", () => {
		const home = join(root, "repeat");
		write(join(home, ".omo/agent/sessions/--tmp-proj--/2026-11-05T00-00-00-000Z_bbbbbbbb-0000-0000-0000-000000000000.jsonl"),
			turn(100, [call("a", "bash_output", { id: 1 })]), result("a", "bash_output", "x"),
			turn(150, [call("b", "bash_output", { id: 1 })]), result("b", "bash_output", "x"),
			turn(150, [call("c", "bash_output", { id: 1 })]), result("c", "bash_output", "x"));
		expect(cls(run(home).repeats, "bash_output")).toMatchObject({ count: 2, tokens: 300 });
	});
});

describe("--check", () => {
	const th = { pct: 25, minTokens: 1_000_000, minCount: 10 };

	test("quiet on the second run, one line when a class grows, quiet on a corrupt state", () => {
		const home = fixture("check");
		const state = join(root, "check-state.json");
		expect(check(run(home), state, th)).toEqual([]);
		expect(check(run(home), state, th)).toEqual([]);

		worker(home, "st_9", user("go"), turn(100, [call("g1", "todo")]), result("g1", "todo", "[fail] dotz task token cap: this worker has used 9,000K tokens", true), turn(2_400_000, [say("[fail] over cap")], "stop"));
		const grown = check(run(home), state, th);
		expect(grown).toHaveLength(1);
		expect(grown[0]).toContain("워커 토큰 상한");
		const [, before, after] = grown[0]!.match(/비중 ([\d.]+)% → ([\d.]+)%/)!.map(Number);
		expect(after!).toBeGreaterThan(before! * 1.25);
		expect(check(run(home), state, th)).toEqual([]);

		writeFileSync(state, "{not json");
		expect(check(run(home), state, th)).toEqual([]);
		expect(check(run(home), state, th)).toEqual([]);
	});

	test("a missing state file is a first run, and a count-only class needs minCount", () => {
		const home = fixture("check-count");
		const state = join(root, "nested", "count-state.json");
		expect(check(run(home), state, th)).toEqual([]);
		appendFileSync(join(home, ".dotz/hub.log"), Array.from({ length: 12 }, () => `${iso()} gateway restart (1 request(s) coalesced, waited 1s)\n`).join(""));
		const grown = check(run(home), state, th);
		expect(grown).toHaveLength(1);
		expect(grown[0]).toContain("재시작: 게이트웨이");
	});

	test("a busy window with the same shares prints nothing, however much the volume grew", () => {
		const home = fixture("check-busy");
		const state = join(root, "busy-state.json");
		const low = { pct: 25, minTokens: 1, minCount: 1 }; // floors out of the way: only the share decides
		const quiet = run(home);
		expect(check(quiet, state, low)).toEqual([]);
		addCopy(home, 1);
		hubLog(home);
		const busy = run(home);
		expect(busy.tokens).toBe(quiet.tokens * 2);
		expect(busy.turns).toBe(quiet.turns * 2);
		expect(check(busy, state, low)).toEqual([]);
	});

	test("a count-only class is judged per turn: more of them in a longer window is quiet, a jump past the turn rate prints", () => {
		const home = fixture("check-rate");
		const state = join(root, "rate-state.json");
		const low = { pct: 25, minTokens: 1, minCount: 1 };
		expect(check(run(home), state, low)).toEqual([]);
		worker(home, "st_s", user("go"), ...Array.from({ length: 20 }, () => turn(10, [say("x")], "stop")), turn(0, [], "error", { errorMessage: "stream closed" }));
		expect(check(run(home), state, low).filter(l => l.startsWith("모델 오류 프로세스·스트림"))).toEqual([]); // 1 -> 2 errors while the turns grew about as much
		worker(home, "st_t", user("go"), ...Array.from({ length: 10 }, () => turn(0, [], "error", { errorMessage: "stream closed" })));
		const grown = check(run(home), state, low).filter(l => l.startsWith("모델 오류 프로세스·스트림"));
		expect(grown).toHaveLength(1);
		expect(grown[0]).toMatch(/건수 2 → 12, 1천 턴당 [\d.]+ → [\d.]+/);
	});

	test("a baseline from before the totals existed is replaced without output", () => {
		const home = fixture("check-old");
		const state = join(root, "old-state.json");
		writeFileSync(state, JSON.stringify({ version: 1, at: iso(), classes: { "워커 토큰 상한": { count: 0, tokens: 0 } } }));
		expect(check(run(home), state, th)).toEqual([]); // the old file would have called the cap class "new" and fired
		const next = JSON.parse(readFileSync(state, "utf8"));
		expect(next).toMatchObject({ version: 2, tokens: run(home).tokens, turns: run(home).turns });
		expect(check(run(home), state, th)).toEqual([]);
	});

	test("the command prints nothing on a first and a repeated run", () => {
		const home = fixture("cli");
		const state = join(root, "cli-state.json");
		const args = ["bun", join(import.meta.dir, "failure-report.ts"), "--check", "--state", state];
		for (let i = 0; i < 2; i++) {
			const p = Bun.spawnSync(args, { env: { ...process.env, HOME: home }, timeout: 120_000 });
			expect({ code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }).toEqual({ code: 0, out: "", err: "" });
		}
	});
});
