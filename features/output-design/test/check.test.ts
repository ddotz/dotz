import { expect, test } from "bun:test";
import { join } from "node:path";
import { RULES } from "../bin/check.ts";

const FEATURE = join(import.meta.dir, "..");
const CHECK = join(FEATURE, "bin", "check.ts");
const FIX = join(import.meta.dir, "fixtures");

async function run(...args: string[]) {
	const p = Bun.spawn(["bun", CHECK, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return { out, code };
}

test("좋은 예는 위반 없이 0으로 끝나요", async () => {
	const r = await run(join(FIX, "good.html"), "--json");
	const j = JSON.parse(r.out);
	expect({ code: r.code, violations: j.violations }).toEqual({ code: 0, violations: [] });
	expect(j.score).toBe(100);
	expect(j.ran).toEqual(["390 라이트", "390 다크", "1280 라이트", "1280 다크"]);
	expect(j.notes.join(" ")).toContain("바꿔 끼워");
}, 120_000);

test("나쁜 예는 심어 둔 규칙을 모두 짚고 1로 끝나요", async () => {
	const r = await run(join(FIX, "bad.html"), "--json");
	const j = JSON.parse(r.out);
	expect(r.code).toBe(1);
	const found = new Set<string>(j.violations.map((v: { rule: string }) => v.rule));
	const missing = Object.keys(RULES).filter(k => !found.has(k));
	expect(missing).toEqual([]);
	expect(j.score).toBeLessThan(70);
}, 120_000);

test("나쁜 예 위반은 규칙, 경로, 잰 값을 한 줄로 보여 줘요", async () => {
	const r = await run(join(FIX, "bad.html"));
	const lines = r.out.split("\n").filter(l => l.startsWith("["));
	expect(lines.length).toBeGreaterThan(10);
	for (const l of lines) expect(l).toMatch(/^\[[a-z-]+\] .+ \| .+ \| .+/);
	expect(r.out).toMatch(/점수 \d+\/100/);
}, 120_000);

test("열리지 않는 주소와 없는 파일은 3으로 막혀요", async () => {
	expect((await run("http://127.0.0.1:1/")).code).toBe(3);
	expect((await run(join(FIX, "없음.html"))).code).toBe(3);
	expect((await run()).code).toBe(2);
}, 120_000);
