import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../bin/voice.ts";
import { analyze } from "../lib/cmd-analyze.ts";
import { copyCheck, decodeHashes, encodeHashes, gramHashes } from "../lib/copycheck.ts";
import { addTarget } from "../lib/targets.ts";
import { writeNeeds } from "../lib/voices.ts";
import { noDeps, sized, tempDir, writeFiles } from "./synth.ts";

const SALT = 12345;
const THEIRS = "은하수 정류장의 마지막 열차는 언제나 조금 늦게 도착하고 승객들은 그 느림을 사랑했다";
const MINE = "새벽 시장의 상인들은 손난로를 돌려 쥐고 조용히 웃으며 오래된 저울 위에 하루의 첫 무게를 올려 놓았고 그 무게는 누구에게도 들키지 않은 약속처럼 가벼웠다";
const sources = [
	{ voice: "타인", kind: "other" as const, hashes: new Set(gramHashes(THEIRS, SALT)) },
	{ voice: "나", kind: "self" as const, hashes: new Set(gramHashes(MINE, SALT)) },
];
const check = (result: string, known: string[] = []) => copyCheck({ result, known, sources, salt: SALT });

describe("베끼기", () => {
	test("다른 사람 글을 30자 넘게 옮기면 막혀요", () => {
		const r = check(`오늘은 이렇게 시작합니다. ${THEIRS}. 그 뒤는 제 이야기예요.`);
		expect(r.blocks).toHaveLength(1);
		expect(r.blocks[0]?.chars).toBeGreaterThanOrEqual(30);
		expect(check("은하수 정류장의 마지막 열차는 언제나").blocks).toEqual([]);
	});

	test("초안이나 재료에 이미 있던 구절은 세지 않아요", () => {
		expect(check(THEIRS, [`재료: ${THEIRS}`]).blocks).toEqual([]);
	});

	test("내 글은 60자 이상 겹칠 때만 경고하고 막지 않아요", () => {
		const warned = check(MINE);
		expect([warned.warns.length, warned.blocks.length]).toEqual([1, 0]);
		expect(check(MINE.slice(0, 40)).warns).toEqual([]);
	});

	test("해시는 소금에 따라 달라지고 되돌려 읽혀요", () => {
		const hashes = gramHashes(THEIRS, SALT);
		expect(gramHashes(THEIRS, SALT + 1)).not.toEqual(hashes);
		expect(decodeHashes(encodeHashes(hashes))).toEqual(new Set(hashes));
	});

	test("다른 사람 글은 해시와 통계만 남고 원문은 어디에도 저장되지 않아요", async () => {
		const state = tempDir();
		const folder = join(tempDir(), "글");
		writeFiles(folder, { "a.txt": `${THEIRS}. ${sized("opinion", 200, 1)}` });
		writeNeeds(state, ["short-opinion"]);
		addTarget(state, { type: "folder", kind: "other", voice: "타인", path: folder, asked: false });
		expect((await analyze(state, undefined, noDeps(state))).code).toBe(0);
		const scratch = tempDir();
		writeFiles(scratch, { "복사.txt": `${THEIRS}.` });
		expect((await run(["check", "--result", join(scratch, "복사.txt"), "--voice", "타인"], state, noDeps(state))).code).toBe(3);
		const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
		const stored = files(state);
		expect(stored.some(f => f.includes("texts"))).toBe(false);
		expect(stored.some(f => readFileSync(f, "utf8").includes("정류장"))).toBe(false);
		expect(stored.some(f => f.endsWith("hashes.json"))).toBe(true);
	});
});
