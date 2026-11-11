import { expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "../bin/voice.ts";
import { noDeps, sized, tempDir, writeFiles } from "./synth.ts";

test("needs, scope, analyze, route, brief, check, learn가 한 흐름으로 돌아요", async () => {
	const base = tempDir();
	const root = join(base, "state");
	const folder = join(base, "texts");
	const deps = noDeps(base);
	const call = (...argv: string[]) => run(argv, root, deps);
	writeFiles(folder, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`글-${i}.md`, sized("opinion", 600, i + 1)])));
	writeFiles(base, {
		"draft.txt": "홍길동 대표는 주민 30%에게 2.6만 원을 나눠 주었다. 행사는 3월 5일에 열렸다.",
		"good.txt": "홍길동 대표는 주민 30%에게 2.6만 원을 나눠 주었습니다. 행사는 3월 5일에 열렸습니다.",
		"bad.txt": "홍길동 대표는 주민 31%에게 2.6만 원을 나눠 주었습니다. 행사는 3월 5일에 열렸습니다.",
		"b1.txt": "그러나 비용만 따지는 것은 문제입니다.",
		"a1.txt": "하지만 비용만 따지는 것은 문제입니다.",
		"b2.txt": "그러나 시장은 아직 남아 있습니다.",
		"a2.txt": "하지만 시장은 아직 남아 있습니다.",
	});
	const f = (name: string) => join(base, name);

	expect((await call("--help")).code).toBe(0);
	expect((await call("needs", "add", "--request", "칼럼 하나 써 줘")).lines.join("\n")).toContain("medium-opinion");
	expect((await call("scope", "add", "--type", "folder", "--path", folder)).code).toBe(0);
	const analyzed = await call("analyze");
	expect(analyzed.code).toBe(0);
	expect(analyzed.lines.join("\n")).toContain("12건 읽음");
	expect(analyzed.lines.join("\n")).toContain("medium-opinion: 충분");

	const route = JSON.parse((await call("route", "--request", "이 글 칼럼으로 다듬어 줘", "--draft", f("draft.txt"))).lines[0] ?? "");
	expect(route).toMatchObject({ fire: true, mode: "edit", cell: "medium-opinion", inNeeds: true });
	const open = JSON.parse((await call("route", "--request", "이 글 다듬어 줘", "--draft", f("draft.txt"))).lines[0] ?? "");
	expect(open).toMatchObject({ cell: "short-story", basis: "요청에 없는 쪽은 초안을 읽어 정했어요" });
	expect(JSON.parse((await call("route", "--request", "이 메일 답장 써 줘")).lines[0] ?? "").fire).toBe(false);

	const brief = await call("brief", "--request", "이 글 칼럼으로 다듬어 줘", "--draft", f("draft.txt"));
	expect(brief.code).toBe(0);
	expect(brief.lines[0]?.startsWith("칸: medium-opinion")).toBe(true);
	expect(brief.lines.join("\n")).toMatch(/\n8\) /);

	expect((await call("check", "--result", f("good.txt"), "--draft", f("draft.txt"))).code).toBe(0);
	const bad = await call("check", "--result", f("bad.txt"), "--draft", f("draft.txt"), "--json");
	expect(bad.code).toBe(3);
	expect(JSON.parse(bad.lines[0] ?? "").blocked).toBe(true);

	await call("learn", "--before", f("b1.txt"), "--after", f("a1.txt"), "--cell", "medium-opinion");
	await call("learn", "--before", f("b2.txt"), "--after", f("a2.txt"), "--cell", "medium-opinion");
	const again = await call("brief", "--request", "칼럼 하나 써 줘");
	expect(again.lines.join("\n")).toContain('고쳐 쓴 말: "그러나" -> "하지만"');
});

test("회사 메일 범위는 종료 코드 3, 없는 명령은 1", async () => {
	const base = tempDir();
	const out = await run(["scope", "add", "--type", "mail", "--account", "kim@corp.example"], join(base, "s"), noDeps(base));
	expect(out.code).toBe(3);
	expect((await run(["nope"], join(base, "s"), noDeps(base))).code).toBe(1);
});
