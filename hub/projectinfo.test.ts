import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { fileRoute } from "./files.ts";
import { loadProjectInfo, mergeProjectInfo, projectFiles, projectInfoContext, recordProjectInfo, removeProjectInfo } from "./projectinfo.ts";
import { stripHandoff } from "./tone.ts";
import { channelContext } from "./workchannels.ts";

const block = (...lines: string[]) => `답이에요\n\n<project-info>\n${lines.join("\n")}\n</project-info>`;

test("the owner never sees the block, closed or cut off", () => {
	expect(stripHandoff(block("next: 확인"))).toBe("답이에요");
	expect(stripHandoff("답이에요\n<project-info>\nnext: 확인")).toBe("답이에요");
	expect(stripHandoff("그대로예요")).toBe("그대로예요");
});

test("summary and next lists replace, decisions add once, and drop takes one back", () => {
	let i = mergeProjectInfo(undefined, "summary: 처음\ndecided: 가\nnext: 하나\nnext: 둘\nblocked: 막힘", "t1");
	i = mergeProjectInfo(i, "summary: 나중\ndecided: 가\ndecided: 나\nnext: 셋\nblocked:", "t2");
	expect(i.summary).toBe("나중");
	expect(i.decided.map(d => d.text)).toEqual(["가", "나"]);
	expect(i.next).toEqual(["셋"]);
	expect(i.blocked).toEqual([]);
	expect(mergeProjectInfo(i, "drop: 가", "t3").decided.map(d => d.text)).toEqual(["나"]);
});

test("a line with a path or file name stays off the page; a file line keeps its path behind a plain name", () => {
	const i = mergeProjectInfo(undefined, "decided: README.md에 적어요\nresult: ~/.dotz/projects/a/b.txt 만들었어요\nnext: `bun test` 돌리기\nfile: 설계 메모 | /tmp/a/README.md\nfile: README.md | /tmp/b", "t");
	expect(i.decided).toEqual([]);
	expect(i.results).toEqual([]);
	expect(i.next).toEqual([]);
	expect(i.files.map(f => [f.label, f.path])).toEqual([["설계 메모", "/tmp/a/README.md"]]);
});

test("the same block twice changes nothing, so the page is not told twice", () => {
	const text = block("decided: 정했어요", "next: 다음 일");
	expect(recordProjectInfo("ch:101", text)).toBe(true);
	expect(recordProjectInfo("ch:101", text)).toBe(false);
	expect(recordProjectInfo("ch:101", "블록 없는 답")).toBe(false);
	expect(recordProjectInfo("ch:102", block("이건 필드가 아니에요"))).toBe(false);
	expect(loadProjectInfo()["ch:102"]).toBeUndefined();
	removeProjectInfo("ch:101");
	expect(loadProjectInfo()["ch:101"]).toBeUndefined();
});

test("a preference said in a project reaches every later message, with no setup too", () => {
	expect(channelContext("103")).not.toContain("결론부터");
	recordProjectInfo("ch:103", block("summary: 설계 중이에요", "pref: 답은 결론부터"));
	const ctx = channelContext("103");
	expect(ctx).toContain("결론부터");
	expect(ctx).toContain("설계 중이에요");
	expect(ctx).toContain("<project-info>");
});

test("a key file of a project opens from its page, and only a listed one", async () => {
	const dir = join(DATA_DIR, "projects", "open-test"), memo = join(dir, "README.md"), other = join(dir, "other.md");
	mkdirSync(dir, { recursive: true });
	writeFileSync(memo, "메모");
	writeFileSync(other, "다른 글");
	recordProjectInfo("ch:105", block(`file: 설계 메모 | ${memo}`));
	const head = async (p: string) => (await fileRoute(new Request("http://x/api/file", { method: "HEAD" }), new URL(`http://x/api/file?path=${encodeURIComponent(p)}`), [], new Set(projectFiles()))).status;
	expect(await head(memo)).toBe(200);
	expect(await head(other)).toBe(403);
});

test("what every message carries stays small however much the project keeps", () => {
	const long = "가".repeat(190);
	const lines = Array.from({ length: 12 }, (_, n) => `pref: ${n}${long}`);
	recordProjectInfo("ch:104", block(`summary: ${long}`, ...lines, "next: 다음", "blocked: 막힘"));
	expect(projectInfoContext("ch:104").length).toBeLessThan(900);
});
