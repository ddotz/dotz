import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../bin/voice.ts";
import { cellOfText } from "../lib/cells.ts";
import { reportLines, runChecks } from "../lib/check.ts";
import { extractFacts } from "../lib/facts.ts";
import { type Correction, latestPerCell } from "../lib/learn.ts";
import { endingOf } from "../lib/measure.ts";
import { voicePaths, writeAtomic } from "../lib/store.ts";
import { noDeps, sized, synth, tempDir, writeFiles } from "./synth.ts";

const setup = () => {
	const base = tempDir();
	const root = join(base, "state");
	const call = (...argv: string[]) => run(argv, root, noDeps(base));
	return { base, root, call, file: (name: string) => join(base, name) };
};

test("다른 사람 목소리는 결과 글도 고친 문장도 저장하지 않고, learn에는 --before가 필요해요", async () => {
	const { base, root, call, file } = setup();
	writeFiles(join(base, "others"), { "a.md": sized("opinion", 600, 1), "b.md": sized("opinion", 600, 2) });
	writeFiles(base, {
		"bot.txt": "정말 굉장히 아름다운 풍경입니다. 골목 가게 앞에 낙엽이 쌓였다.",
		"fixed.txt": "아주 대단히 멋있는 모습입니다. 동네 가게 앞에 낙엽이 쌓였다.",
	});
	await call("needs", "add", "--cell", "medium-opinion");
	expect((await call("scope", "add", "--type", "folder", "--path", join(base, "others"), "--kind", "other", "--voice", "x")).code).toBe(0);
	expect((await call("analyze")).code).toBe(0);

	expect((await call("check", "--result", file("bot.txt"), "--voice", "x")).code).toBe(0);
	expect(existsSync(voicePaths(root, "x").lastResult)).toBe(false);
	expect((await call("learn", "--after", file("fixed.txt"), "--voice", "x", "--cell", "short-story")).code).toBe(1);

	expect((await call("learn", "--before", file("bot.txt"), "--after", file("fixed.txt"), "--voice", "x", "--cell", "short-story")).code).toBe(0);
	const raw = readFileSync(voicePaths(root, "x").corrections, "utf8");
	expect(raw).not.toContain("낙엽");
	expect(raw).not.toContain("굉장히");
	const saved: Correction[] = raw.trim().split("\n").map(l => JSON.parse(l));
	expect(saved.length).toBeGreaterThan(0);
	expect(saved.every(c => c.from === "" && c.to === "")).toBe(true);
	const subs = saved.flatMap(c => c.sigs).filter(s => s.startsWith("sub:"));
	expect(subs).toContain("sub:골목>동네");
	expect(subs.every(s => s.slice(4).split(">").every(side => side.length <= 12))).toBe(true);
	const brief = (await call("brief", "--request", "글 써 줘", "--voice", "x", "--cell", "short-story")).lines.join("\n");
	expect(brief).not.toContain("낙엽");
});

test("learn은 --cell이 없으면 마지막 brief의 칸을 쓰고, 두 번 나온 고침은 그 칸의 규칙이 돼요", async () => {
	const { base, call, file } = setup();
	const pairs = [["골목 가게 앞에 낙엽이 쌓였다.", "동네 가게 앞에 낙엽이 쌓였다."], ["골목 가게 문이 닫혀 있었다.", "동네 가게 문이 닫혀 있었다."]];
	expect(pairs.every(([, after]) => cellOfText(after ?? "") !== "short-guide")).toBe(true);
	await call("brief", "--request", "안내문 써 줘", "--cell", "short-guide");
	for (const [i, [before, after]] of pairs.entries()) {
		writeFiles(base, { [`b${i}.txt`]: before ?? "", [`a${i}.txt`]: after ?? "" });
		const learned = await call("learn", "--before", file(`b${i}.txt`), "--after", file(`a${i}.txt`));
		expect(learned.lines[0]).toContain("short-guide");
	}
	const next = (await call("brief", "--request", "안내문 써 줘", "--cell", "short-guide")).lines.join("\n");
	expect(next).toContain('고쳐 쓴 말: "골목" -> "동네"');
});

test("없는 목소리와 틀린 칸 이름은 실패하고 이유를 말해요", async () => {
	const { call } = setup();
	const noVoice = await call("brief", "--request", "글 써 줘", "--voice", "ghost");
	expect([noVoice.code, noVoice.lines.join("")]).toEqual([1, expect.stringContaining("ghost")]);
	expect((await call("route", "--request", "글 써 줘", "--voice", "ghost")).code).toBe(1);
	const badCell = await call("brief", "--request", "글 써 줘", "--cell", "nope");
	expect([badCell.code, badCell.lines.join("")]).toEqual([1, expect.stringContaining("short-guide")]);
	expect((await call("learn", "--after", "/nowhere", "--cell", "nope")).code).toBe(1);
});

test("고침 기록은 칸마다 최근 200개만 남기고, 깨진 줄은 파일 이름을 대며 실패해요", async () => {
	const fix = (cell: Correction["cell"], n: number): Correction => ({ run: `r${n}`, ts: "2026-01-01T00:00:00Z", cell, kind: "style", from: `${n}`, to: "", sigs: [] });
	const many = [...Array.from({ length: 250 }, (_, n) => fix("short-guide", n)), fix("short-story", 0), fix("short-story", 1)];
	const kept = latestPerCell(many);
	expect(kept.filter(c => c.cell === "short-guide").map(c => c.from)).toEqual(Array.from({ length: 200 }, (_, n) => `${n + 50}`));
	expect(kept.filter(c => c.cell === "short-story")).toHaveLength(2);

	const { root, call } = setup();
	const path = voicePaths(root, "me").corrections;
	writeAtomic(path, `${JSON.stringify(fix("short-guide", 1))}\n깨진 줄\n`);
	await expect(call("brief", "--request", "안내문 써 줘", "--cell", "short-guide")).rejects.toThrow(path);
});

test("아주 긴 초안은 사실 대조와 베끼기 결과를 돌려주고 목록 둘만 빼요", async () => {
	const { base, call, file } = setup();
	const draft = synth("story", 3200, 7);
	writeFiles(base, { "draft.txt": draft, "result.txt": draft.replaceAll("나는", "저는") });
	const out = await call("check", "--result", file("result.txt"), "--draft", file("draft.txt"), "--json");
	const report = JSON.parse(out.lines[0] ?? "");
	expect(report).toMatchObject({ mode: "edit", omitted: true, changes: [], blocked: false });
	expect(report.review).toBeUndefined();
	expect(report.copy).toBeDefined();
	const lines = reportLines(runChecks({ result: draft, draft, sources: [], salt: 1 }));
	expect(lines.some(l => l.includes("글이 길어서"))).toBe(true);
});

test("빠진 문장, 새 낱말, 확인할 것은 30개까지만 보이고 나머지는 외 N개로 줘요", () => {
	const syllable = (i: number) => String.fromCharCode(0xac00 + i * 11);
	const draft = Array.from({ length: 35 }, (_, i) => `${syllable(i)}${syllable(i + 400)}${syllable(i + 800)}을 봅니다.`).join("\n");
	const lines = reportLines(runChecks({ result: "전혀 다른 글입니다.", draft, sources: [], salt: 1 }));
	expect(lines.filter(l => l.startsWith("  검토: 빠진 문장 후보 \""))).toHaveLength(30);
	expect(lines).toContain("  검토: 빠진 문장 후보 외 5개");
	const confirm = reportLines(runChecks({ result: Array.from({ length: 35 }, (_, i) => `${i + 10}명`).join(", "), sources: [], salt: 1 }));
	expect(confirm.find(l => l.includes("확인할 것"))).toMatch(/외 \d+개$/);
});

test("-죠는 해요체이고, 한 시대는 시각이 아니지만 한 시에·한 시쯤은 시각이에요", () => {
	expect(endingOf("그렇죠.")).toBe("haeyo");
	expect(extractFacts("한 시대의 일이다.").numbers).toEqual([]);
	for (const s of ["한 시에 만나요.", "한 시쯤 갑니다."]) expect(extractFacts(s).numbers).toHaveLength(1);
});

test("긴 목록이 든 brief도 숫자는 30개까지만 보여요", async () => {
	const { base, call, file } = setup();
	writeFileSync(join(base, "draft.txt"), Array.from({ length: 35 }, (_, i) => `${i + 10}명이 왔습니다.`).join("\n"));
	const out = (await call("brief", "--request", "다듬어 줘", "--draft", file("draft.txt"), "--cell", "short-guide")).lines.join("\n");
	expect(out).toMatch(/- 숫자: .* 외 \d+개/);
});
