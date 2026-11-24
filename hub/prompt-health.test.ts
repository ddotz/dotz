import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fc from "fast-check";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { evidenceLines, type Finding } from "./doctor-types.ts";
import { ENFORCED_RULES } from "./enforced-rules.ts";
import { LESSONS_MAX_BYTES } from "./prompt-budget.ts";
import { msg } from "./i18n.ts";
import { editLines, enforcedFindings, promptGrowth, promptHealth, readState, ruleCard, RULES_MAX_CHARS } from "./prompt-health.ts";

const root = mkdtempSync(join(tmpdir(), "prompt-health-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir = "";
let n = 0;
beforeEach(() => {
	dir = join(root, `d${n++}`);
	mkdirSync(dir, { recursive: true });
});

const DAY = 24 * 3600_000;
const t0 = Date.UTC(2026, 10, 1);
const setRules = (text: string) => writeFileSync(join(dir, "RULES.md"), text);
const run = (day: number) => promptHealth({ now: t0 + day * DAY, dataDir: dir, home: root }) as Finding[];
const keys = (found: Finding[]) => found.map(f => f.key).sort();
const sizeKeys = (found: Finding[]) => keys(found).filter(k => k.startsWith("prompt:size:"));

test("the first run only stores the baseline and reports nothing", () => {
	setRules("a".repeat(1000));
	expect(keys(run(0))).toEqual([]);
	expect(readState(dir)?.baseline.rules.chars).toBe(1000);
});

test("growth past both thresholds gives a finding with the growth as its level", () => {
	setRules("a".repeat(1000));
	run(0);
	setRules("a".repeat(7000));
	const found = run(1);
	const rules = found.find(f => f.key === "prompt:size:rules");
	expect(rules?.level).toBe(6000);
	expect(rules?.area).toBe("prompt");
	expect(rules?.evidence.join("\n")).toContain("1000");
	expect(rules?.evidence.join("\n")).toContain("7000");
	expect(rules?.evidence.join("\n")).toContain("2026-11-01");
	expect(promptGrowth(readState(dir)!)).toBe(true);
});

test("growth below the thresholds reports nothing", () => {
	setRules("a".repeat(1000));
	run(0);
	setRules("a".repeat(1900));
	expect(sizeKeys(run(1))).toEqual([]);
	expect(promptGrowth(readState(dir)!)).toBe(false);
});

test("a part grown by a share but not by enough characters stays quiet", () => {
	setRules("a".repeat(100));
	run(0);
	setRules("a".repeat(900));
	expect(sizeKeys(run(1))).toEqual([]);
});

test("a shrink moves the baseline down without a finding, and later growth counts from the lower baseline", () => {
	setRules("a".repeat(5000));
	run(0);
	setRules("a".repeat(1000));
	expect(sizeKeys(run(1))).toEqual([]);
	expect(readState(dir)?.baseline.rules).toEqual({ chars: 1000, at: t0 + DAY });
	setRules("a".repeat(3000));
	expect(sizeKeys(run(2))).toContain("prompt:size:rules");
});

test("a rule that code enforces is reported by file and line while a line writes it out, carried as a deletion, and not after the line is removed", () => {
	setRules("- keep replies short\n- never run launchctl kickstart on the gateway\n");
	run(0);
	const found = run(1), m = msg();
	const hit = found.find(f => f.key === "prompt:enforced:gateway-restart");
	expect(hit?.change).toEqual({ file: join(dir, "RULES.md"), line: 2, from: "- never run launchctl kickstart on the gateway", to: "" });
	expect(hit?.evidence).toEqual([`${m.doctor.ruleKind} · ${m.promptAt("RULES.md", 2)}`, m.promptDelete("- never run launchctl kickstart on the gateway"), m.promptGuard(m.promptGuardGatewayRestart, "hub/systemdeny.ts")]);
	expect(hit?.decide?.question).not.toMatch(/RULES\.md|systemdeny/);
	expect(hit?.decide?.options.map(o => o.name)).toEqual([m.promptRemove, m.promptKeep]);
	expect(hit?.decide?.options[0]!.result).toBe(m.promptRemoveResult("RULES.md"));
	expect(keys(found).filter(k => k.startsWith("prompt:enforced:"))).toEqual(["prompt:enforced:gateway-restart"]);
	setRules("- keep replies short\n");
	expect(keys(run(2)).filter(k => k.startsWith("prompt:enforced:"))).toEqual([]);
});

test("a blocked-command entry is the guard itself and is never proposed for removal; a long line is cut on the card at a word, whole in change", () => {
	const entry = "## Blocked commands\n- deny: some-cli --big | fable only when the owner asked\n";
	const long = `- fable only when the owner asked; ${"word ".repeat(30)}tail-marker`;
	setRules(`## Rules\n${long}\n\n${entry}`);
	run(0);
	const hit = run(1).find(f => f.key === "prompt:enforced:expensive-model");
	expect(hit?.change).toMatchObject({ line: 2, from: long, to: "" });
	expect(hit?.evidence.join("\n")).not.toContain("tail-marker");
	expect(hit?.evidence[1]!.startsWith(msg().promptDelete(""))).toBe(true);
	expect(hit?.evidence[1]!.slice(msg().promptDelete("").length)).toMatch(/^- fable only when the owner asked; (word )+word…$/);
	expect(hit?.evidence.every(l => [...l].length <= 120)).toBe(true);
	expect(hit?.evidence[0]!.startsWith(msg().doctor.ruleKind)).toBe(true);
	expect(`${hit?.decide?.subject} · ${hit?.decide?.question}`).toMatch(new RegExp(`^${msg().doctor.texts.rules} 'fable only when[^']*'.* · ${msg().doctor.ruleQuestion.replace("?", "\\?")}$`));
	expect([...`${hit?.decide?.subject} · ${hit?.decide?.question}`].length).toBeLessThanOrEqual(40);
	setRules(entry);
	expect(keys(run(2)).filter(k => k.startsWith("prompt:enforced:"))).toEqual([]);
});

test("a feature body line is named by its feature.md and its line in that file", () => {
	setRules("- keep replies short\n");
	mkdirSync(join(dir, "features", "gw"), { recursive: true });
	writeFileSync(join(dir, "features", "gw", "feature.md"), "---\nname: gw\nwhat: gateway care\ntrigger: 메시지 도착\nstage: s\n---\nNever run launchctl kickstart on the gateway.\n");
	run(0);
	const hit = run(1).find(f => f.key === "prompt:enforced:gateway-restart");
	expect(hit?.change).toEqual({ file: join(dir, "features", "gw", "feature.md"), line: 7, from: "Never run launchctl kickstart on the gateway.", to: "" });
	expect(hit?.evidence[0]).toContain(msg().promptAt(join("features", "gw", "feature.md"), 7));
});

test("a line written twice in its file is not proposed: there is no one line to delete, and one log line says so", () => {
	const line = "- never run launchctl kickstart on the gateway", lines: string[] = [];
	setRules(`${line}\n${line}\n`);
	run(0);
	expect(keys(run(1)).filter(k => k.startsWith("prompt:enforced:"))).toEqual([]);
	expect(enforcedFindings([{ path: join(dir, "RULES.md"), file: "RULES.md", lines: [line, line] }], t0, l => lines.push(l))).toEqual([]);
	expect(lines).toEqual(["prompt health: no card for the enforced rule gateway-restart: RULES.md: it is in RULES.md more than once"]);
});

test("a rule written twice in RULES.md and once in LESSONS.md is proposed at its LESSONS.md line, and no log line says it got no card", () => {
	const line = "- never run launchctl kickstart on the gateway", lines: string[] = [];
	setRules(`${line}\n${line}\n`);
	writeFileSync(join(dir, "LESSONS.md"), `- lesson one\n${line}\n`);
	run(0);
	expect(run(1).find(f => f.key === "prompt:enforced:gateway-restart")?.change).toEqual({ file: join(dir, "LESSONS.md"), line: 2, from: line, to: "" });
	const sources = [{ path: join(dir, "RULES.md"), file: "RULES.md", lines: [line, line] }, { path: join(dir, "LESSONS.md"), file: "LESSONS.md", lines: ["- lesson one", line] }];
	expect(enforcedFindings(sources, t0, l => lines.push(l)).map(f => f.change?.file)).toEqual([join(dir, "LESSONS.md")]);
	expect(lines).toEqual([]);
});

test("when git cannot be run, the enforced card is still made, without the undo sentence", () => {
	setRules("- keep replies short\n- never run launchctl kickstart on the gateway\n");
	mkdirSync(join(dir, ".git"));
	const git = spyOn(Bun, "spawnSync").mockImplementation(() => {
		throw new Error('Executable not found in $PATH: "git"');
	});
	try {
		const hit = run(0).find(f => f.key === "prompt:enforced:gateway-restart");
		expect(hit?.decide?.options[0]!.result).toBe(msg().promptRemoveResult("RULES.md"));
	} finally {
		git.mockRestore();
	}
});

test("a feature line holding {repo} that writes out an enforced rule is found at its line", () => {
	setRules("- keep replies short\n");
	mkdirSync(join(dir, "features", "gw"), { recursive: true });
	const raw = "Never run launchctl kickstart on the gateway; use `{repo}/bin/dotz restart`.";
	writeFileSync(join(dir, "features", "gw", "feature.md"), `---\nname: gw\nwhat: gateway care\ntrigger: 메시지 도착\nstage: s\n---\n${raw}\n`);
	run(0);
	expect(run(1).find(f => f.key === "prompt:enforced:gateway-restart")?.change).toEqual({ file: join(dir, "features", "gw", "feature.md"), line: 7, from: raw, to: "" });
});

test("an open task in state.json is not a rule: its words never raise an enforced-rule finding", () => {
	setRules("- keep replies short\n");
	const next = "다음에 한도로 멈추고 형이 한쪽에서 리셋권을 쓰면 다른 쪽 hub.log에 'usage limit lifted'가 찍히는지 확인";
	writeFileSync(join(dir, "state.json"), JSON.stringify({ open_tasks: [{ id: "limit-roundtrip-check", what: "한도 왕복 확인", next }] }));
	run(0);
	expect(keys(run(1)).filter(k => k.startsWith("prompt:enforced:"))).toEqual([]);
});

test("a prompt file over its cap is reported once per file", () => {
	writeFileSync(join(dir, "LESSONS.md"), "l".repeat(LESSONS_MAX_BYTES + 1));
	setRules("r".repeat(RULES_MAX_CHARS + 5));
	const found = run(0);
	expect(keys(found).filter(k => k.startsWith("prompt:cap:"))).toEqual(["prompt:cap:LESSONS.md", "prompt:cap:RULES.md"]);
	expect(found.find(f => f.key === "prompt:cap:RULES.md")?.level).toBe(5);
	writeFileSync(join(dir, "LESSONS.md"), "l".repeat(LESSONS_MAX_BYTES));
	setRules("r".repeat(RULES_MAX_CHARS));
	expect(keys(run(1)).filter(k => k.startsWith("prompt:cap:"))).toEqual([]);
});

test("a corrupt state file starts over as a first run", () => {
	setRules("a".repeat(1000));
	writeFileSync(join(dir, "prompt-health.json"), "{not json");
	expect(keys(run(0))).toEqual([]);
	expect(readState(dir)?.baseline.rules.chars).toBe(1000);
});

const samples: Record<string, string> = {
	"limit-stop": "Stop the session when the usage limit is below 10%.",
	"expensive-model": "Use Fable only when the owner asks.",
	"gateway-restart": "Never run launchctl kickstart -k gui/501/dev.dotz.gateway.",
	"brief-done-when": "Every brief must have a Done when line.",
	"session-min-hours": "A session under 1 hour is refused.",
	"recommend-mark": "Never put a recommended mark on an option.",
	"telemetry-off": "Turn off telemetry at start.",
};

test("every enforced rule names an existing guard and matches its sample line", () => {
	const repo = join(import.meta.dir, "..");
	expect(new Set(ENFORCED_RULES.map(r => r.id)).size).toBe(ENFORCED_RULES.length);
	for (const rule of ENFORCED_RULES) {
		const [path, line] = rule.guard.split(":");
		expect(existsSync(join(repo, path))).toBe(true);
		if (line) expect(readFileSync(join(repo, path), "utf8").split("\n").length).toBeGreaterThanOrEqual(Number(line));
		expect(rule.match.test(samples[rule.id] ?? "")).toBe(true);
	}
});

test("every enforced rule's card names in plain words what already enforces it, its own words, not only the guard file", () => {
	const m = msg(), change = { file: join(dir, "RULES.md"), line: 1, from: "x", to: "" };
	const words: Record<string, string> = {
		"limit-stop": m.promptGuardLimitStop,
		"expensive-model": m.promptGuardExpensiveModel,
		"gateway-restart": m.promptGuardGatewayRestart,
		"brief-done-when": m.promptGuardBriefDoneWhen,
		"session-min-hours": m.promptGuardSessionMinHours,
		"recommend-mark": m.promptGuardRecommendMark,
		"telemetry-off": m.promptGuardTelemetryOff,
	};
	expect(new Set(Object.values(words)).size).toBe(ENFORCED_RULES.length);
	for (const rule of ENFORCED_RULES) {
		const guard = rule.guard.split(":")[0]!, last = ruleCard({ rule: rule.id, guard, shown: "RULES.md", change }).evidence.at(-1);
		expect(last).toBe(m.promptGuard(words[rule.id]!, guard));
	}
});

test("over every shipped MODE line with a clause added at its end, in its middle and at its start, the card's before and after never read the same", () => {
	const saved = cfg.identity, same: string[] = [];
	try {
		for (const [language, file, clause] of [["ko", "MODE.ko.md", "끝에 붙인 말이에요."], ["en", "MODE.md", "Added words here."]] as const) {
			cfg.identity = { ...cfg.identity, name: cfg.identity?.name ?? "sample-1", language };
			const m = msg();
			for (const from of readFileSync(join(import.meta.dir, "..", file), "utf8").split("\n").filter(l => l.trim().length > 10)) {
				const words = from.split(" "), mid = Math.floor(words.length / 2);
				for (const to of [`${from} ${clause}`, [...words.slice(0, mid), clause, ...words.slice(mid)].join(" "), `${clause} ${from}`]) {
					const lines = evidenceLines(editLines("K", "F", { file: "/x", line: 1, from, to }), m.doctor.more);
					if (lines[1]!.slice(m.promptBefore("").length) === lines[2]!.slice(m.promptAfter("").length)) same.push(`${file}: ${from}`);
					expect(lines.every(l => [...l].length <= 120)).toBe(true);
				}
			}
		}
	} finally {
		cfg.identity = saved;
	}
	expect(same).toEqual([]);
});

const shownPart = (line: string, label: string): string => {
	const text = line.slice(label.length);
	return text.slice(text.startsWith("…") ? 1 : 0).replace(/…$/, "");
};
const holds = (full: string, body: string, at: number): boolean => {
	for (let i = full.indexOf(body); i >= 0; i = full.indexOf(body, i + 1)) if (i <= at && at < i + body.length) return true;
	return false;
};

test("over every shipped MODE line of 70+ characters with a long path put in, one character of the path changed: before and after differ, are not empty and both show the changed character", () => {
	const saved = cfg.identity, bad: string[] = [];
	const path = "/Users/example/Library/Application_Support/dotz/features/reply.md";
	try {
		for (const [language, file] of [["ko", "MODE.ko.md"], ["en", "MODE.md"]] as const) {
			cfg.identity = { ...cfg.identity, name: cfg.identity?.name ?? "sample-1", language };
			const m = msg(), squashed = readFileSync(join(import.meta.dir, "..", file), "utf8").split("\n").map(l => l.replace(/\s+/g, " ").trim());
			for (const line of new Set(squashed.filter(l => [...l].length >= 70))) {
				for (const [near, offset] of [[60, 10], [60, 30], [90, 10], [90, 30]] as const) {
					const space = line.lastIndexOf(" ", near), at = space > 20 ? space : near;
					const from = `${line.slice(0, at)} ${path} ${line.slice(at)}`.replace(/\s+/g, " ").trim(), q = from.indexOf(path) + offset;
					const to = `${from.slice(0, q)}${from[q] === "Q" ? "R" : "Q"}${from.slice(q + 1)}`;
					const lines = evidenceLines(editLines("K", "F", { file: "/x", line: 1, from, to }), m.doctor.more);
					const before = shownPart(lines[1]!, m.promptBefore("")), after = shownPart(lines[2]!, m.promptAfter(""));
					if (before === after || !before || !after || !holds(from, before, q) || !holds(to, after, q)) bad.push(`${file} ${near}/${offset}: ${lines[1]} | ${lines[2]}`);
					expect(lines.every(l => [...l].length <= 120)).toBe(true);
				}
			}
		}
	} finally {
		cfg.identity = saved;
	}
	expect(bad).toEqual([]);
});

test("a window opens at the earliest word that lets the change show, never later than shortly before it, cuts inside a word too long to show, and fills the room when the change is at the end", () => {
	const m = msg(), room = 120 - Math.max([...m.promptBefore("")].length, [...m.promptAfter("")].length);
	const from = `- see ${"x".repeat(20)} ${"/very/long/path".repeat(10)} old tail words`, to = from.replace(" old ", " new "), q = from.indexOf(" old ") + 1;
	const [, b, a] = evidenceLines(editLines("K", "F", { file: "/x", line: 1, from, to }), m.doctor.more);
	expect(shownPart(b!, m.promptBefore(""))).toContain(from.slice(q - 16, q + 3));
	expect(shownPart(a!, m.promptAfter(""))).toContain(to.slice(q - 16, q + 3));
	const url = `- link: https://example.com/${"a".repeat(130)}/b?q=1 here.`, at = 50, changed = `${url.slice(0, at)}Z${url.slice(at + 1)}`;
	const [, ub, ua] = evidenceLines(editLines("K", "F", { file: "/x", line: 1, from: url, to: changed }), m.doctor.more);
	expect([shownPart(ub!, m.promptBefore("")), shownPart(ua!, m.promptAfter(""))].map(s => s.startsWith("- link: https://") && s.length > at)).toEqual([true, true]);
	expect(shownPart(ua!, m.promptAfter(""))[at]).toBe("Z");
	const cut = `- ${"every rule line here is long enough ".repeat(4)}the owner reads DROPPED words after it ${"and the line goes on ".repeat(3)}END`;
	const [, cb, ca] = evidenceLines(editLines("K", "F", { file: "/x", line: 1, from: cut, to: cut.replace("DROPPED ", "") }), m.doctor.more);
	expect([shownPart(cb!, m.promptBefore("")).includes("reads DROPPED words"), shownPart(ca!, m.promptAfter("")).includes("reads words")]).toEqual([true, true]);
	const long = `- ${"every rule line here is long enough ".repeat(6)}END-OF-LINE`;
	const [, , end] = evidenceLines(editLines("K", "F", { file: "/x", line: 1, from: long, to: `${long} too` }), m.doctor.more);
	expect([...end!].length - [...m.promptAfter("")].length).toBeGreaterThan(room - 8);
});

test("a long line changed in two places far apart shows each changed stretch in its before and after, with … between them; a change in one place shows as before", () => {
	const saved = cfg.identity;
	try {
		cfg.identity = { ...saved, name: saved?.name ?? "sample-1", language: "ko" };
		const to = "- 메인 세션은 질문과 조회와 한 파일짜리 작은 수정만 직접 하고, 여러 단계이거나 길거나 시끄럽거나 나눌 수 있는 일은 워커에게 맡겨요. 워커에게 일을 맡길 때는 브리프에 완료 조건을 적고, 한 워커에는 모듈 하나만 맡기며, 결과 패치는 직접 읽은 뒤 적용하고, 리뷰가 필요한 패치는 100줄이 넘을 때만 리뷰어에게 먼저 보내요. 보안 패치는 언제나 보안 리뷰어에게 보내요.";
		const one = to.replace("100줄이 넘을 때만 리뷰어에게 먼저 보내요. 보안 패치는 언제나 보안 리뷰어에게 보내요.", "300줄이 넘을 때만 리뷰어에게 먼저 보내요."), two = one.replace("한 파일짜리", "두 파일짜리");
		const [, b, a, ...rest] = editLines("서로 맞지 않음", "RULES.md", { file: "/x/RULES.md", line: 12, from: two, to });
		expect([b, a].every(l => [...l!].length <= 120)).toBe(true);
		expect([b!.includes("두 파일짜리"), b!.includes("300줄이"), a!.includes("한 파일짜리"), a!.includes("100줄이"), a!.includes("보안 패치는")]).toEqual([true, true, true, true, true]);
		expect([b!.includes(" … "), a!.includes(" … ")]).toEqual([true, true]);
		expect(rest).toEqual([]);
		expect(editLines("서로 맞지 않음", "RULES.md", { file: "/x/RULES.md", line: 12, from: one, to }).slice(1)).toEqual([
			"전: …완료 조건을 적고, 한 워커에는 모듈 하나만 맡기며, 결과 패치는 직접 읽은 뒤 적용하고, 리뷰가 필요한 패치는 300줄이 넘을 때만 리뷰어에게 먼저 보내요.",
			"후: …완료 조건을 적고, 한 워커에는 모듈 하나만 맡기며, 결과 패치는 직접 읽은 뒤 적용하고, 리뷰가 필요한 패치는 100줄이 넘을 때만 리뷰어에게 먼저 보내요. 보안 패치는 언제나 보안 리뷰어에게 보내요.",
		]);
	} finally {
		cfg.identity = saved;
	}
});

test("changes of a long line too far apart for one line each: the places that fit are shown, the rest counted on their own line; for generated two-place edits every place is shown or counted and every line fits", () => {
	const m = msg(), word = (i: number) => `word${String(i).padStart(2, "0")}`, big = (c: string) => c.repeat(45);
	const words = Array.from({ length: 60 }, (_, i) => word(i)), from = `- ${words.join(" ")}`;
	const to = `- ${words.map((w, i) => ([5, 25, 45].includes(i) ? big(String.fromCharCode(65 + i / 5)) : w)).join(" ")}`;
	const [more, b, a, ...rest] = editLines("K", "F", { file: "/x", line: 1, from, to });
	expect([b!.includes(word(5)), a!.includes(big("B"))]).toEqual([true, true]);
	expect(more).toBe(`K · ${m.promptAt("F", 1)} · ${m.promptMoreChanges(2)}`);
	expect(rest).toEqual([]);
	fc.assert(
		fc.property(fc.array(fc.constantFrom("a", "rule", "답장은", "짧게", "`x`", "/p/q"), { minLength: 30, maxLength: 80 }), fc.nat(), fc.nat(), fc.constantFrom("Q", "새말", "/r/s/t"), (ws, p, q, put) => {
			const i = p % ws.length, j = (i + 10 + (q % 20)) % ws.length, lo = Math.min(i, j), hi = Math.max(i, j);
			fc.pre(hi - lo >= 8);
			const before = ws.join(" "), after = ws.map((w, k) => (k === lo || k === hi ? `${w}${put}` : w)).join(" ");
			const lines = editLines("K", "F", { file: "/x", line: 1, from: before, to: after });
			const shownAfter = lines[2]!, counted = lines[0]!.endsWith(m.promptMoreChanges(1));
			expect(lines.every(l => [...l].length <= 120)).toBe(true);
			expect(lines.length).toBe(3);
			expect(shownAfter.split(put).length - 1 >= 2 || counted).toBe(true);
		}),
		{ numRuns: 300 },
	);
});

test("for generated lines with long unbroken runs and one edit anywhere, the shown before and after differ, are not empty, fit the line limit and both hold the first changed character", () => {
	const m = msg(), flat = (s: string) => s.replace(/\s+/g, " ").trim();
	const token = fc.oneof(fc.constantFrom("a", "the", "rule", "never", "답장은", "짧게", "-", "`x`"), fc.integer({ min: 20, max: 160 }).map(n => "/p".repeat(n)));
	const edit = fc.oneof(fc.constantFrom("Q", " new", "/q/r", " "), fc.constant(""));
	fc.assert(
		fc.property(fc.array(token, { minLength: 1, maxLength: 40 }), fc.nat(), fc.nat({ max: 12 }), edit, (tokens, where, drop, put) => {
			const from = tokens.join(" "), at = where % (from.length + 1), to = `${from.slice(0, at)}${put}${from.slice(at + drop)}`;
			fc.pre(flat(to) !== "" && flat(to) !== flat(from));
			const a = [...flat(from)], b = [...flat(to)];
			let q = 0;
			while (q < a.length && q < b.length && a[q] === b[q]) q++;
			const lines = evidenceLines(editLines("K", "F", { file: "/x", line: 1, from, to }), m.doctor.more);
			const before = shownPart(lines[1]!, m.promptBefore("")), after = shownPart(lines[2]!, m.promptAfter(""));
			expect([before === after, before === "", after === "", lines.every(l => [...l].length <= 120)]).toEqual([false, false, false, true]);
			expect([q >= a.length || holds(a.join(""), before, q), q >= b.length || holds(b.join(""), after, q)]).toEqual([true, true]);
		}),
		{ numRuns: 400 },
	);
});
