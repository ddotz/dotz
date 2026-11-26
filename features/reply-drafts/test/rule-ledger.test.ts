import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeSettings } from "../../../hub/app-settings.ts";
import { runRules } from "../bin/rules.ts";
import { journalEntries, restoreEntry } from "../lib/curate.ts";
import { draftRules } from "../lib/draft-rules.ts";
import { addRecord, migrateLedger, readLedger, undoLedger } from "../lib/ledger.ts";
import { learn } from "../lib/learn.ts";
import { learnLine } from "../lib/learn-line.ts";
import { loadStyle, paths, toneFile } from "../lib/settings.ts";
import { setupEnv } from "./helpers.ts";

// The one rule ledger (rules.json): a sentence is one record, narrower scopes win and newer ones at equal scope, instances inherit at read time, never a copy. Anonymous fixture text.
const env = setupEnv();
afterAll(env.cleanup);
const NOW = new Date("2026-11-20T00:00:00.000Z");
const ITEM = { kind: "mail", from: "Kim <a@example.com>", text: "일정 문의" } as const;
const calm = { now: () => NOW, learnCall: () => async () => JSON.stringify({ replaces: [] }) };

beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [join(env.dir, "custom"), join(env.dir, "config.json")]) rmSync(p, { force: true, recursive: true });
});

const write = (file: string, text: string) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));
const at = (ms: number) => new Date(NOW.getTime() + ms);
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name))).sort() : []);

test("one sentence is one record: learning it twice, or for mail while two instances exist, leaves one that both instances read", async () => {
	const line = "끝인사는 짧게 써 줘";
	await learnLine({ app: "mail" }, line, "correction", calm);
	await learnLine({ app: "mail" }, line, "correction", calm);
	await learnLine({ app: "mail-2" }, "다른 앱만의 줄", "correction", calm);
	const mine = readLedger().filter(r => r.text.includes(line));
	expect(mine).toHaveLength(1);
	expect(mine[0]).toMatchObject({ kind: "correction", scope: { app: "mail" }, state: "on" });
	for (const app of ["mail", "mail-2", "mail-3"]) expect(loadStyle({ app }).corrections.filter(c => c.includes(line))).toHaveLength(1);
	expect(loadStyle({ app: "mail-3" }).corrections.filter(c => c.includes("다른 앱만의"))).toHaveLength(0);
	expect(existsSync(paths.toneDir())).toBe(false);
});

test("the narrower scope wins a conflict, at equal scope the newer one", () => {
	const mail = { app: "mail" }, box = { app: "mail", room: "b1" };
	addRecord({ text: "죄송", kind: "ban", scope: mail, by: "test", at: at(0) });
	addRecord({ text: "정중하게 죄송하다고 말해요", kind: "tone", scope: box, by: "test", at: at(-5000) });
	expect(loadStyle(box).forbidden).not.toContain("죄송");
	expect(loadStyle(mail).forbidden).toContain("죄송");
	expect(draftRules({ app: "mail", room: "b1" }, ITEM).checkStyle().forbidden).not.toContain("죄송");
	// equal scope: the newer decides
	addRecord({ text: "감사합니다", kind: "ban", scope: mail, by: "test", at: at(10) });
	addRecord({ text: "끝에 감사합니다를 꼭 써요", kind: "tone", scope: mail, by: "test", at: at(20) });
	expect(loadStyle(mail).forbidden).not.toContain("감사합니다");
	expect(loadStyle(mail).rules).toContain("끝에 감사합니다를 꼭 써요");
	addRecord({ text: "안녕하세요", kind: "ban", scope: mail, by: "test", at: at(40) });
	addRecord({ text: "첫 줄에 안녕하세요를 써요", kind: "tone", scope: mail, by: "test", at: at(30) });
	expect(loadStyle(mail).forbidden).toContain("안녕하세요");
	expect(loadStyle(mail).rules).not.toContain("첫 줄에 안녕하세요를 써요");
});

test("effective rules are a view of the ledger and name the winner of a conflict", async () => {
	addRecord({ text: "죄송", kind: "ban", scope: { app: "mail" }, by: "test", at: at(0) });
	const box = addRecord({ text: "정중하게 죄송하다고 말해요", kind: "tone", scope: { app: "mail", room: "b1" }, by: "test", at: at(5) }).record;
	const { rules, conflicts } = await draftRules({ app: "mail", room: "b1" }, ITEM).effective();
	const hit = conflicts.find(c => c.why === "ban-in-rule");
	expect(hit?.winner).toBeDefined();
	expect(rules[hit!.winner!]!.text).toBe(box.text);
	expect(rules.find(r => r.text === box.text)?.source).toMatchObject({ file: paths.ledger(), id: box.id });
});

const SHARED = ["2026-11-01: 인사는 한 줄로 써요", "2026-11-02: 날짜는 숫자로 적어요"];
test("migration: shared copies become one record, the difference stays with its app, undo restores every file byte for byte", () => {
	const tone = (app: string, extra: string[] = []) => `## 정체성\n\n- 짧게 쓰는 사람이에요\n\n## 예시\n\n- 네 알겠어요\n\n## 고친 점\n\n${[...SHARED, ...extra].map(l => `- ${l}`).join("\n")}\n`;
	write(toneFile({ app: "mail" }), tone("mail"));
	write(toneFile({ app: "mail-2" }), tone("mail-2", ["2026-11-03: 이 앱만 서명을 붙여요"]));
	write(toneFile({ app: "mail-3" }), tone("mail-3"));
	const defaults = "끝에 감사 인사를 해요\n첨부는 본문에 알려요";
	write(paths.config(), `${JSON.stringify({ enabled: true, apps: {}, draftDefaults: { mail: defaults, "mail-2": defaults, "mail-3": `${defaults}\n제목은 그대로 써요` } }, null, 2)}\n`);
	const before = new Map(files(join(env.dir, "custom")).map(f => [f, readFileSync(join(env.dir, "custom", f))]));
	const done = migrateLedger(env.dir);
	expect(done).toBeDefined();
	const on = readLedger(env.dir).filter(r => r.state === "on");
	for (const s of [...SHARED, ...defaults.split("\n")]) expect(on.filter(r => r.text === s)).toMatchObject([{ scope: { app: "mail" } }]);
	expect(on.filter(r => r.text.includes("서명"))).toMatchObject([{ scope: { app: "mail-2" } }]);
	expect(on.filter(r => r.text.includes("제목은"))).toMatchObject([{ scope: { app: "mail-3" }, kind: "instruction" }]);
	for (const app of ["mail", "mail-2", "mail-3"]) {
		const md = readFileSync(toneFile({ app }), "utf8");
		expect(md).toContain("짧게 쓰는 사람이에요");
		expect(md).toContain("네 알겠어요");
		expect(md).not.toContain("## 고친 점");
	}
	expect(JSON.parse(readFileSync(paths.config(), "utf8")).draftDefaults).toBeUndefined();
	const again = readFileSync(paths.ledger());
	expect(migrateLedger(env.dir)).toBeUndefined();
	expect(readFileSync(paths.ledger()).equals(again)).toBe(true);
	expect(undoLedger(env.dir)).toBeDefined();
	expect(existsSync(paths.ledger())).toBe(false);
	const afterFiles = files(join(env.dir, "custom")).filter(f => !f.includes("ledger-backup"));
	expect(afterFiles).toEqual([...before.keys()]);
	for (const [f, buf] of before) expect(readFileSync(join(env.dir, "custom", f)).equals(buf)).toBe(true);
});

test("migrate --preview shows the lines that would move and the records the ledger would get, and writes no file", () => {
	write(toneFile({ app: "mail" }), "## 정체성\n\n- 짧게 쓰는 사람이에요\n\n## 고친 점\n\n- 2026-11-01: 인사는 한 줄로 써요\n");
	write(paths.config(), `${JSON.stringify({ enabled: true, apps: {}, draftDefaults: { mail: "끝에 감사 인사를 해요" } }, null, 2)}\n`);
	const snapshot = () => files(env.dir).map(f => [f, readFileSync(join(env.dir, f)).toString("hex")]);
	const before = snapshot();
	const out = runRules(["migrate", "--preview"], env.dir);
	expect(out.code).toBe(0);
	const text = out.lines.join("\n");
	for (const s of ["2026-11-01: 인사는 한 줄로 써요", "끝에 감사 인사를 해요", "mail · correction · 1줄", "mail · instruction · 1줄"]) expect(text).toContain(s);
	expect(snapshot()).toEqual(before);
	expect(existsSync(paths.ledger(env.dir))).toBe(false);
	expect(migrateLedger(env.dir)?.records).toBe(2);
});

test("curate keeps on + merged: two replaced lines are merged into the new record and one comes back with restoreEntry", async () => {
	const key = { app: "mail" };
	for (const [i, t] of ["2026-11-01: 인사는 길게 써요", "2026-11-02: 인사는 정중하게 써요", "2026-11-03: 날짜는 숫자로 적어요"].entries()) addRecord({ text: t, kind: "correction", scope: key, by: "test", at: at(i) });
	const before = readLedger().length;
	const call = () => async () => JSON.stringify({ replaces: [{ id: "C1", why: "overridden" }, { id: "C2", why: "same" }] });
	const learned = await learnLine(key, "인사는 한 줄로 써요", "correction", { now: () => NOW, learnCall: call });
	expect(learned.replaced).toHaveLength(2);
	const all = readLedger();
	expect(all).toHaveLength(before + 1);
	const fresh = all.find(r => r.text.endsWith("인사는 한 줄로 써요"))!;
	const merged = all.filter(r => r.state === "merged");
	expect(merged.map(r => r.into)).toEqual([fresh.id, fresh.id]);
	expect(all.filter(r => r.state === "on")).toHaveLength(2);
	const entry = journalEntries().find(e => e.line.includes("정중하게"))!;
	expect(restoreEntry(entry.n, NOW)?.put).toBe(true);
	expect(readLedger().filter(r => r.state === "on")).toHaveLength(3);
});

test("a correction that contradicts a 기본 규칙 line turns that setting off, journals it, says what changed, and the journal undoes it", async () => {
	writeSettings(env.dir, "mail", { draft_default: "끝에 감사합니다로 마무리해요" });
	const setting = readLedger().find(r => r.kind === "instruction")!;
	expect(setting).toMatchObject({ scope: { app: "mail" }, state: "on" });
	const call = () => async () => JSON.stringify({ replaces: [{ id: "R1", why: "overridden" }] });
	const keys = { channel: { app: "mail" } };
	const got = await learn({ source: "revise", ref: "R1", keys, words: "끝에 감사합니다는 쓰지 말고 바로 끝내" }, { now: () => NOW, learnCall: call });
	expect(got.text).toContain("끝에 감사합니다로 마무리해요");
	expect(got.text).toContain("→");
	const off = readLedger().find(r => r.id === setting.id)!;
	expect(off.state).toBe("off");
	expect(off.into).toBeDefined();
	const entry = journalEntries().find(e => e.line === setting.text)!;
	expect(entry).toBeDefined();
	restoreEntry(entry.n, NOW);
	expect(readLedger().find(r => r.id === setting.id)?.state).toBe("on");
	expect(statSync(paths.ledger()).isFile()).toBe(true);
});
