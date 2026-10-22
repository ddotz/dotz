import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askDefaults } from "./ask-options.ts";
import { CONFIG_FILE } from "./config.ts";
import { decisionsOf } from "./notices.ts";

const ev = (text: string, extra: Record<string, unknown> = {}) => ({ ts: "2050-06-01T00:00:00.000Z", kind: "out", source: "orchestrator", target: "th:1300000000000000001", text, ...extra });
const labels = (o: { n: number; label: string; rec: boolean }[]) => o.map(x => [x.n, x.label, x.rec]);

test("a thread [ask] with a choice block makes a notice with the block's options", () => {
	const ds = decisionsOf(ev("[ask] 답장 초안을 만들었어요.\n결정: 답장\n**1) 보내기** ← 추천\n그대로 보내요\n**2) 미루기**\n내일 다시 물어봐요", { conv: "mail:abc" }));
	expect(ds).toHaveLength(1);
	expect(ds[0]!.to).toBe("mail:abc");
	expect(labels(ds[0]!.options)).toEqual([
		[1, "보내기", true],
		[2, "미루기", false],
	]);
});

test("a yes / no [ask] without a choice block gets 1) 네 2) 아니요, and 아니요 asks for detail", () => {
	const ds = decisionsOf(ev("[ask] 지원팀 메일은 정리했어요. 감사 답장 한 통만 남았어요. 진행해도 될까요?"));
	expect(ds).toHaveLength(1);
	expect(labels(ds[0]!.options)).toEqual([
		[1, "네", true],
		[2, "아니요", false],
	]);
	expect(ds[0]!.options[1]!.detail).toBe(true);
	expect(ds[0]!.assumed).toBe(true);
});

test("a send question with a known draft id gets the draft-approval options", () => {
	expect(askDefaults("[ask] 감사 답장 초안이에요. 보내도 될까요 (d-42)?").map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
	expect(askDefaults("[ask] 초안 id: d-42\n이대로 보내도 될까요?").map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
	expect(askDefaults("[ask] 감사 답장 한 통만 남았어요. 보내도 될까요?").map(o => o.label)).toEqual(["네", "아니요"]);
});

test("an open question or a message without a question gets no default options", () => {
	expect(askDefaults("[ask] 어떤 사이즈로 살까요?")).toEqual([]);
	expect(askDefaults("[ask] 받는 사람 주소를 알려 주세요")).toEqual([]);
	expect(askDefaults("[ask] 확인이 필요해요.\n```\nrun?\n```")).toEqual([]);
});

test("a stored open question without options gets the same defaults on load, and the file is not rewritten", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-askopts-"));
	copyFileSync(CONFIG_FILE, join(dir, "config.json"));
	const at = new Date().toISOString();
	const stored = JSON.stringify([
		{ id: "aaaaaaa1", ts: at, updated: at, kind: "decision", tone: "ask", title: "보내도 될까요?", text: "감사 답장 한 통만 남았어요. 보내도 될까요?", open: "main", src: "main", at, key: "dec:main:x", read: false, decision: { options: [], to: "main", reply_to: at, group: 1, state: "open" } },
	]);
	writeFileSync(join(dir, "notices.json"), stored);
	const run = Bun.spawnSync([process.execPath, "-e", `const m = await import("./hub/notices.ts"); console.log(JSON.stringify(m.listNotices().items.map(n => n.decision?.options.map(o => o.label)))); process.exit(0);`], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DOTZ_DIR: dir } });
	expect(run.exitCode).toBe(0);
	expect(JSON.parse(run.stdout.toString().trim().split("\n").pop()!)).toEqual([["네", "아니요"]]);
	expect(readFileSync(join(dir, "notices.json"), "utf8")).toBe(stored);
});
