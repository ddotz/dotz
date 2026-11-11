// The day note with synthetic sessions in temp folders only; the model, the clock and the sleep are injected, no real omo runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt, buildNote, chainVariant, collectInput, type Known, latestNote, mainSessionFiles, noteWindow, resolveQuick, type Resolution, runDayNote, type RunDeps, validate } from "./day-note.ts";
import { cfg } from "./config.ts";
import { daysDir, kstDay, NOTE_MAX_CHARS, noteFile, parseNote, yesterdayNote } from "./day-note-format.ts";
import { recallText } from "./orchestrator-parts.ts";
import { rmSync } from "node:fs";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 19, 36);
const DAY = "2026-11-10";
const SESSION = "abcd1234-0000-4000-8000-000000000000";

let base = "", dir = "", sessionFile = "", stateFile = "";
let n = 0;
const entry = (role: string, text: string, ts: string): string => JSON.stringify({ type: "message", id: `e${++n}`, timestamp: ts, message: { role, content: [{ type: "text", text }] } });
const exchange = (msg: string, ask: string, answer: string, ts: string): string[] => [entry("user", `[dotz inbox] web msg=${msg} from tester\n${ask}`, ts), entry("assistant", answer, ts)];

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "day-note-"));
	dir = join(base, "days");
	stateFile = join(base, "state.json");
	sessionFile = join(base, "main.jsonl");
	writeFileSync(stateFile, JSON.stringify({ open_tasks: [{ id: "t-open-1", what: "finish the report" }] }));
	const header = JSON.stringify({ type: "session", version: 3, id: SESSION, timestamp: "2026-11-09T00:00:00.000Z", cwd: "/home/x/.dotz" });
	const compaction = JSON.stringify({ type: "compaction", timestamp: "2026-11-10T10:00:00.000Z", summary: "SUMMARY-IN-WINDOW commit abc1234def" });
	const oldCompaction = JSON.stringify({ type: "compaction", timestamp: "2026-11-01T10:00:00.000Z", summary: "SUMMARY-TOO-OLD" });
	writeFileSync(sessionFile, [header, oldCompaction, compaction, ...exchange("m1", "please fix the build", "fixed it, token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "2026-11-10T03:00:00.000Z"), ...exchange("m2", "ancient question", "ancient answer", "2026-11-01T03:00:00.000Z")].join("\n") + "\n");
});

const collect = (extra: Partial<Parameters<typeof collectInput>[0]> = {}) => collectInput({ files: [sessionFile], start: NOW - 24 * HOUR, end: NOW, stateFile, secrets: [], ...extra });

describe("noteWindow", () => {
	test("starts where the previous note ended, else 24 h back, at most 72 h; the day is the Seoul date of the start", () => {
		expect(noteWindow(NOW, NOW - 10 * HOUR).start).toBe(NOW - 10 * HOUR);
		expect(noteWindow(NOW).start).toBe(NOW - 24 * HOUR);
		expect(noteWindow(NOW, NOW - 200 * HOUR).start).toBe(NOW - 72 * HOUR);
		expect(noteWindow(NOW, NOW + HOUR).start).toBe(NOW - 24 * HOUR);
		expect(noteWindow(NOW).day).toBe(DAY);
		expect(noteWindow(Date.UTC(2026, 10, 10, 14, 59) + 24 * HOUR).day).toBe("2026-11-10");
	});
});

describe("collectInput", () => {
	test("reads the exchanges and the newest compaction summary of the window only, and masks secrets", () => {
		const c = collect({ secrets: ["fixed it"] });
		expect(c.text).toContain("please fix the build");
		expect(c.text).toContain("SUMMARY-IN-WINDOW");
		expect(c.text).toContain("t-open-1");
		expect(c.text).not.toContain("ancient");
		expect(c.text).not.toContain("SUMMARY-TOO-OLD");
		expect(c.text).not.toContain("sk-ant-api03");
		expect(c.text).not.toContain("fixed it");
		expect(c.pairs).toBe(1);
		expect(c.known.msgs.has("m1")).toBe(true);
		expect(c.known.sessions.has("abcd1234#L4")).toBe(true);
		expect(c.known.tasks.has("t-open-1")).toBe(true);
	});

	test("carries the open items of the previous note and lets their sources through", () => {
		const previous = parseNote(buildNote({ day: "2026-11-09", start: NOW - 48 * HOUR, end: NOW - 24 * HOUR, writer: "w" }, [{ key: "open", lines: ["- the old open item (src: web old-msg-1)"] }]))!;
		const c = collect({ previous });
		expect(c.text).toContain("the old open item");
		expect(validate("## open\n- the old open item (src: web old-msg-1)", c.known).sections).toHaveLength(1);
	});

	test("no exchange and no summary in the window leaves nothing to write", () => {
		const c = collect({ start: NOW - HOUR });
		expect(c.pairs).toBe(0);
		expect(c.summary).toBe(false);
	});
});

describe("kstDay", () => {
	test("the day follows the given time zone, not a fixed one", () => {
		expect(kstDay(NOW, "Asia/Seoul")).toBe("2026-11-11");
		expect(kstDay(NOW, "America/Los_Angeles")).toBe("2026-11-10");
	});
});

describe("validate", () => {
	const known: Known = { msgs: new Set(["m1"]), sessions: new Set(["abcd1234#L4"]), tasks: new Set(["t1"]), stamps: new Set(), srcs: new Set(), text: "commit abc1234def" };

	test("keeps a line whose source is in the input and drops the rest", () => {
		const reply = [
			"## done",
			"- good line (src: web m1)",
			"- no source at all",
			`- ${"x".repeat(201)} (src: web m1)`,
			"- source not in the input (src: web nope-999)",
			"- session line (src: session abcd1234#L4)",
			"- missing session line (src: session abcd1234#L99)",
			"- task line (src: task t1)",
			"- commit line (src: commit abc1234def)",
			"- made up commit (src: commit deadbeef0)",
		].join("\n");
		const r = validate(reply, known);
		expect(r.sections).toEqual([{ key: "done", lines: ["- good line (src: web m1)", "- session line (src: session abcd1234#L4)", "- task line (src: task t1)", "- commit line (src: commit abc1234def)"] }]);
		expect(r.dropped).toBe(5);
	});

	test("a decided line needs a message id and owner words of at most 80 characters", () => {
		const r = validate(`## decided\n- the owner said "keep it" (src: web m1)\n- the owner said "${"y".repeat(81)}" (src: web m1)\n- decided with no message (src: task t1)`, known);
		expect(r.sections[0]!.lines).toEqual(['- the owner said "keep it" (src: web m1)']);
	});

	test("open keeps 8 lines and lessons 3; a heading the writer made up is taken by its place", () => {
		const lines = (k: number) => Array.from({ length: k }, (_, i) => `- line ${i} (src: web m1)`).join("\n");
		const r = validate(`## open\n${lines(10)}\n## a made up heading\n${lines(1)}\n## c\n${lines(1)}\n## d\n${lines(1)}\n## lessons\n${lines(5)}`, known);
		expect(r.sections.map(s => [s.key, s.lines.length])).toEqual([["open", 8], ["done", 1], ["decided", 1], ["know", 1], ["lessons", 3]]);
	});

	test("a reply with no valid line gives no section", () => {
		expect(validate("## done\n- nothing cited", known).sections).toEqual([]);
		expect(validate("no list at all", known).sections).toEqual([]);
	});
});

describe("buildNote", () => {
	const meta = { day: DAY, start: NOW - 24 * HOUR, end: NOW, writer: "writer-x" };

	test("round-trips through the parser, sections in design order, empty ones left out", () => {
		const text = buildNote(meta, [{ key: "know", lines: ["- k (src: web m1)"] }, { key: "open", lines: ["- o (src: web m1)"] }]);
		const note = parseNote(text)!;
		expect(note.day).toBe(DAY);
		expect(note.windowStart).toBe(meta.start);
		expect(note.windowEnd).toBe(NOW);
		expect(note.writer).toBe("writer-x");
		expect(note.sections.map(s => s.key)).toEqual(["know", "open"]);
	});

	test("over 6,000 characters whole lines go from the last section upward", () => {
		const long = (tag: string, k: number) => Array.from({ length: k }, (_, i) => `- ${tag}${i} ${"w".repeat(150)} (src: web m1)`);
		const text = buildNote(meta, [{ key: "open", lines: long("o", 8) }, { key: "done", lines: long("d", 30) }, { key: "lessons", lines: long("l", 3) }]);
		expect(text.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
		const note = parseNote(text)!;
		expect(note.sections.find(s => s.key === "lessons")).toBeUndefined();
		expect(note.sections.find(s => s.key === "open")!.lines).toHaveLength(8);
		expect(note.sections.find(s => s.key === "done")!.lines.length).toBeGreaterThan(0);
	});

	test("no line, no file text", () => {
		expect(buildNote(meta, [])).toBe("");
	});
});

describe("model of the run", () => {
	const doctor = (rungs: unknown[]) => JSON.stringify({ categories: [{ name: "other", rungs: [] }, { name: "quick", rungs }] });
	const rungs = [
		{ model: "pinned-by-owner", source: "omo.json", state: "primary" },
		{ model: "gpt-x-fast", source: "built-in", state: "no-login", providers: ["chatgpt-subscription"] },
		{ model: "anthropic-subscription/claude-haiku-5-5", source: "built-in", state: "not-reached" },
		{ model: "other-model", source: "built-in", state: "not-reached", providers: ["p"] },
	];
	const bundle = 'x{haiku:"claude-haiku-5-5",luna:"gpt-x-fast"}y quick:[{providers:["a"],model:FAM.luna,variant:"low"},{providers:["b"],model:FAM.haiku,variant:"medium"},{providers:["c"],model:"other-model"}],z';
	const deps = (over: Partial<{ code: number; out: string; bundle: string | undefined }> = {}) => ({
		exec: async () => ({ code: over.code ?? 0, out: over.out ?? doctor(rungs) }),
		bundle: () => ("bundle" in over ? over.bundle : bundle),
	});

	test("takes the first built-in rung with a login, skipping the omo.json override, with the effort of OmO's chain", async () => {
		expect(await resolveQuick(deps())).toEqual({ selector: "anthropic-subscription/claude-haiku-5-5:medium" });
	});

	test("a login on the first built-in rung moves the choice there, as OmO's order says", async () => {
		const first = rungs.map(r => (r.model === "gpt-x-fast" ? { ...r, state: "not-reached" } : r));
		expect(await resolveQuick(deps({ out: doctor(first) }))).toEqual({ selector: "chatgpt-subscription/gpt-x-fast:low" });
	});

	test("a rung without an effort in the chain gets none", () => {
		expect(chainVariant(bundle, "other-model")).toEqual({});
		expect(chainVariant(bundle, "not-in-chain")).toBeUndefined();
		expect(chainVariant("no chain here", "other-model")).toBeUndefined();
	});

	test("anything unreadable gives a reason and no selector", async () => {
		for (const bad of [deps({ code: 2 }), deps({ out: "not json" }), deps({ out: doctor([]) }), deps({ bundle: undefined }), deps({ bundle: "quick:[{providers:[\"a\"],model:FAM.nope}]" })]) {
			const r: Resolution = await resolveQuick(bad);
			expect("reason" in r).toBe(true);
		}
	});
});

describe("a run", () => {
	let calls: { system: string; text: string; model: string }[];
	let logs: string[];
	let reply: string;
	let fail: boolean;
	let resolved: number;
	let on: boolean;
	let pinned: string;
	let resolution: Resolution;
	const run = (): RunDeps => ({
		now: () => NOW,
		on: () => on,
		pinned: () => pinned,
		fallback: () => "worker/model:high",
		dir,
		stateFile,
		files: since => mainSessionFiles(since, [base], "/home/x/.dotz").concat(since < 0 ? [] : [sessionFile]),
		secrets: () => [],
		resolve: async () => (resolved++, resolution),
		call: async (system, text, o) => {
			calls.push({ system, text, model: o.model });
			if (fail) throw new Error("boom");
			return { text: reply, inputTokens: 1200, outputTokens: 80, ms: 450 };
		},
		language: () => "en",
		log: l => logs.push(l),
	});
	const sleeps: number[] = [];
	const sleep = async (ms: number) => void sleeps.push(ms);

	beforeEach(() => {
		calls = [];
		logs = [];
		sleeps.length = 0;
		reply = "## done\n- fixed the build for the owner (src: web m1)\n## know\n- the report is still open (src: task t-open-1)";
		fail = false;
		resolved = 0;
		on = true;
		pinned = "";
		resolution = { selector: "anthropic-subscription/claude-haiku-5-5:medium" };
	});

	test("writes the note to the day's file with the resolved model and logs one line", async () => {
		const a = await runDayNote(run(), sleep, NOW + 4 * 60_000);
		expect(a.kind).toBe("written");
		const file = noteFile(DAY, dir);
		const note = parseNote(readFileSync(file, "utf8"))!;
		expect(note.sections.map(s => s.key)).toEqual(["done", "know"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.model).toBe("anthropic-subscription/claude-haiku-5-5:medium");
		expect(calls[0]!.text).toContain("please fix the build");
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("written");
		expect(logs[0]).toContain("1200 in/80 out");
		expect(latestNote(dir)?.day).toBe(DAY);
	});

	test("off: no call, no file, no log line", async () => {
		on = false;
		const a = await runDayNote(run(), sleep, NOW + 4 * 60_000);
		expect(a).toEqual({ kind: "skipped", reason: "off" });
		expect(calls).toHaveLength(0);
		expect(existsSync(noteFile(DAY, dir))).toBe(false);
		expect(logs).toEqual([]);
	});

	test("a file already there for the day is not rewritten and costs no call", async () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(noteFile(DAY, dir), "KEEP ME");
		const a = await runDayNote(run(), sleep, NOW + 4 * 60_000);
		expect(a.kind).toBe("skipped");
		expect(calls).toHaveLength(0);
		expect(readFileSync(noteFile(DAY, dir), "utf8")).toBe("KEEP ME");
		expect(logs[0]).toContain("skipped");
	});

	test("a failed call writes no file, is retried with a doubling wait and ends before the deadline", async () => {
		fail = true;
		const a = await runDayNote(run(), sleep, NOW + 4 * 60_000);
		expect(a.kind).toBe("skipped");
		expect(existsSync(noteFile(DAY, dir))).toBe(false);
		expect(sleeps).toEqual([30_000, 60_000, 120_000]);
		expect(calls).toHaveLength(4);
		expect(resolved).toBe(1);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("boom");
	});

	test("a retry does not start when its wait plus the call timeout would pass the deadline", async () => {
		fail = true;
		let clock = NOW;
		const a = await runDayNote({ ...run(), now: () => clock }, async ms => void (clock += ms), NOW + 100_000);
		expect(a.kind).toBe("skipped");
		expect(calls).toHaveLength(2);
	});

	test("a reply with no valid line writes no file and is not retried", async () => {
		reply = "## done\n- nothing cited";
		const a = await runDayNote(run(), sleep, NOW + 4 * 60_000);
		expect(a.kind).toBe("skipped");
		expect(existsSync(noteFile(DAY, dir))).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("a pinned model wins and OmO is not asked; an unresolvable quick chain falls back to the worker model and the log line says so", async () => {
		pinned = "some/pinned:low";
		await runDayNote(run(), sleep, NOW + 4 * 60_000);
		expect(calls[0]!.model).toBe("some/pinned:low");
		expect(resolved).toBe(0);
		rmFile();
		pinned = "";
		resolution = { reason: "omo doctor exited 2" };
		calls = [];
		logs = [];
		await runDayNote(run(), sleep, NOW + 4 * 60_000);
		expect(calls[0]!.model).toBe("worker/model:high");
		expect(logs[0]).toContain("omo doctor exited 2");
	});

	test("no exchange and no summary in the window: skipped without a call", async () => {
		const quiet = { ...run(), files: () => [] as string[] };
		const a = await attempt(quiet, async () => ({ model: "m", label: "m" }));
		expect(a).toEqual({ kind: "skipped", reason: `${DAY}: no input` });
		expect(calls).toHaveLength(0);
	});

	const rmFile = () => {
		writeFileSync(noteFile(DAY, dir), "");
		utimesSync(noteFile(DAY, dir), 1, 1);
		Bun.spawnSync(["rm", noteFile(DAY, dir)]);
	};
});

describe("mainSessionFiles", () => {
	test("reads the folder named for the data folder, files written since the window began", () => {
		const folder = join(base, "--home-x-.dotz--");
		mkdirSync(folder);
		const fresh = join(folder, "fresh.jsonl");
		const stale = join(folder, "stale.jsonl");
		writeFileSync(fresh, "");
		writeFileSync(stale, "");
		utimesSync(stale, 1, 1);
		mkdirSync(join(base, "--home-x-.dotz-lanes-a--"));
		writeFileSync(join(base, "--home-x-.dotz-lanes-a--", "lane.jsonl"), "");
		expect(mainSessionFiles(statSync(fresh).mtimeMs - 1000, [base, join(base, "nope")], "/home/x/.dotz")).toEqual([fresh]);
	});
});

describe("the pointer to yesterday's note in a new session's first prompt", () => {
	const holder = cfg as { day_note?: { enabled?: boolean } };
	const file = () => noteFile(kstDay(Date.now() - 24 * HOUR), daysDir());
	const writeYesterday = () => {
		mkdirSync(daysDir(), { recursive: true });
		writeFileSync(file(), "x");
	};
	afterEach(() => {
		delete holder.day_note;
		rmSync(file(), { force: true });
	});

	test("off, or no note for yesterday: the text is what it was; on with the note: one more line names the file", () => {
		const plain = recallText("");
		writeYesterday();
		expect(recallText("")).toBe(plain);
		holder.day_note = { enabled: true };
		const withNote = recallText("");
		expect(withNote).toBe(`${plain}\n${withNote.split("\n").at(-1)}`);
		expect(withNote.split("\n").at(-1)).toContain(file());
		rmSync(file());
		expect(recallText("")).toBe(plain);
		expect(yesterdayNote(Date.now(), daysDir())).toBeUndefined();
	});
});
