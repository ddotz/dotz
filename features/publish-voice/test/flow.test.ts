import { expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { run } from "../bin/voice.ts";
import { rootPaths, voicePaths } from "../lib/store.ts";
import { readProfile } from "../lib/voices.ts";
import { noDeps, sized, tempDir, writeFiles } from "./synth.ts";

const setup = () => {
	const base = tempDir();
	const root = join(base, "state");
	const call = (...argv: string[]) => run(argv, root, noDeps(base));
	const text = async (...argv: string[]) => (await call(...argv)).lines.join("\n");
	return { base, root, call, text, file: (name: string) => join(base, name) };
};

test("status는 비어 있는 첫 단계를 다음: 한 줄로 알려요", async () => {
	const { base, root, call, text } = setup();
	const folder = join(base, "texts");
	writeFiles(folder, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`글-${i}.md`, sized("opinion", 600, i + 1)])));
	const next = async () => (await text("status")).split("\n").at(-1);

	expect(await next()).toContain("다음: needs add");
	await call("needs", "add", "--cell", "medium-opinion");
	expect(await next()).toContain("다음: discover");
	await call("scope", "add", "--type", "folder", "--path", folder);
	expect(await next()).toContain("다음: analyze");

	await call("analyze");
	const builtAt = Date.parse(readProfile(root, "me")?.builtAt ?? "");
	const stamp = (offsetMs: number) => utimesSync(rootPaths(root).scope, new Date(builtAt + offsetMs), new Date(builtAt + offsetMs));
	stamp(-60_000);
	expect(await next()).toContain("다음: 준비됐어요, brief로 쓰면 돼요");
	stamp(60_000);
	expect(await next()).toContain("다음: analyze");
});

test("needs add --audience는 칸이 정해진 뒤에 따로 쓸 수 있고 status와 brief에 나와요", async () => {
	const { call, text } = setup();
	expect((await call("needs", "add", "--audience", "구청 주민")).code).toBe(1);
	await call("needs", "add", "--cell", "medium-opinion");
	const set = await call("needs", "add", "--audience", "구청 주민");
	expect(set.code).toBe(0);
	expect(set.lines.join("\n")).toContain("니즈(계산하는 칸): medium-opinion");
	await call("needs", "add", "--cell", "short-guide");
	expect(await text("status")).toContain("독자: 구청 주민");
	expect(await text("brief", "--request", "안내문 써 줘", "--cell", "short-guide")).toContain("[독자] 구청 주민");
});

test("check는 바뀐 곳을 20쌍까지 80자로 잘라 보여 주고 --json에는 전부 실어요", async () => {
	const { call, file, base } = setup();
	const nouns = Array.from({ length: 25 }, (_, i) => `${"가나다라마바사아자차카타파하".charAt(i % 14)}${"고노도로모보소오조초코토포호".charAt(Math.floor(i / 2) % 14)}${"구누두루무부수우주추쿠투푸후".charAt(i % 14)}`);
	const long = Array.from({ length: 30 }, (_, i) => `길고도${"기니디리미비시이지치키티피히".charAt(i % 14)}긴`).join(" ");
	const draft = [`그러나 ${long} 문장입니다.`, ...nouns.map(n => `그러나 ${n}은 비쌉니다. 오늘은 ${n}도 쉽니다.`)].join("\n");
	writeFiles(base, { "draft.txt": draft, "result.txt": draft.replaceAll("그러나", "하지만") });
	const report = await call("check", "--result", file("result.txt"), "--draft", file("draft.txt"));
	const pairs = report.lines.filter(l => /^ {2}".*" -> ".*"$/.test(l) && l.includes("하지만"));
	expect(pairs).toHaveLength(20);
	expect(report.lines.at(-1)).toBe("  외 6곳");
	const sides = (pairs[0] ?? "").slice(3, -1).split('" -> "');
	expect(sides.every(s => s.length <= 80)).toBe(true);
	const json = JSON.parse((await call("check", "--result", file("result.txt"), "--draft", file("draft.txt"), "--json")).lines[0] ?? "");
	expect(json.changes).toHaveLength(26);
	expect(json.changes[0]).toEqual({ from: expect.stringContaining("그러나"), to: expect.stringContaining("하지만") });
	const clipped = report.lines.filter(l => l.includes("...")).map(l => l.slice(3, -1).split('" -> "'));
	expect(clipped.length).toBeGreaterThan(0);
	expect(clipped.flat().every(s => s.length <= 80)).toBe(true);
});

test("막힌 결과 뒤에는 learn이 예전 글과 비교하지 않아요", async () => {
	const { root, call, file, base } = setup();
	writeFiles(base, { "old.txt": "지난 글입니다.", "draft.txt": "참가자는 12명이었다.", "bad.txt": "참가자는 30명이었다.", "fixed.txt": "참가자는 열두 명이었다." });
	expect((await call("check", "--result", file("old.txt"))).code).toBe(0);
	expect(existsSync(voicePaths(root, "me").lastResult)).toBe(true);
	expect((await call("check", "--result", file("bad.txt"), "--draft", file("draft.txt"))).code).toBe(3);
	expect(existsSync(voicePaths(root, "me").lastResult)).toBe(false);
	expect((await call("learn", "--after", file("fixed.txt"), "--cell", "medium-opinion")).code).toBe(1);
});

test("learn은 --before가 없으면 check가 저장한 결과를 쓰고, 둘 다 없으면 쉬운 말로 실패해요", async () => {
	const { root, call, file, base } = setup();
	writeFiles(base, { "bot.txt": "그러나 비용만 따지는 것은 문제입니다.", "fixed.txt": "하지만 비용만 따지는 것은 문제입니다." });
	const none = await call("learn", "--after", file("fixed.txt"), "--cell", "medium-opinion");
	expect(none.code).toBe(1);
	expect(none.lines[0]).toContain("--before");
	await call("check", "--result", file("bot.txt"));
	expect(readFileSync(voicePaths(root, "me").lastResult, "utf8")).toBe("그러나 비용만 따지는 것은 문제입니다.");
	const learned = await call("learn", "--after", file("fixed.txt"), "--cell", "medium-opinion");
	expect(learned.code).toBe(0);
	expect(learned.lines[0]).toContain("고침 1건");
	expect(existsSync(voicePaths(root, "me").corrections)).toBe(true);
});
