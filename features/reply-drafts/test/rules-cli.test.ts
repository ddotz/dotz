import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRules } from "../bin/rules.ts";
import { readLedger, textsAt } from "../lib/ledger.ts";
import { paths, toneFile } from "../lib/settings.ts";
import { setupEnv } from "./helpers.ts";

// bin/rules.ts, the 자동 초안 규칙 CLI the bot runs: it writes the same store the settings screen does. Names are placeholders.
const env = setupEnv();
afterAll(() => env.cleanup());
beforeEach(() => {
	rmSync(paths.config(), { force: true });
	rmSync(paths.ledger(), { force: true });
});
const stored = () => JSON.parse(readFileSync(paths.config(), "utf8"));

test("add, edit, default and remove go through the settings store and print what the owner reads", () => {
	expect(runRules(["list"]).lines).toEqual(["mail 기본 규칙: 없음", "자동 초안 규칙이 없어요"]);
	const add = runRules(["add", "--name", "자료 요청", "--when", "자료를 보내 달라는 메일", "--how", "첨부하고 짧게 인사", "--file", "a.pdf", "--file", "~/b.pdf"]);
	expect(add).toEqual({ code: 0, lines: ["규칙을 만들었어요", "r1 [켜짐] 자료 요청\n  언제: 자료를 보내 달라는 메일\n  어떻게: 첨부하고 짧게 인사\n  붙일 파일: a.pdf, ~/b.pdf"] });
	expect(runRules(["edit", "--off", "r1", "--no-files"]).code).toBe(0);
	expect(stored().draftRules.mail).toEqual([{ id: "r1", name: "자료 요청", when: "자료를 보내 달라는 메일", how: "첨부하고 짧게 인사", files: [], on: false }].map(r => ({ ...r, how: "" })));
	expect(textsAt({ app: "mail", request: "r1" }, "request")).toEqual(["첨부하고 짧게 인사"]);
	expect(runRules(["add", "--name", "견학 문의", "--when", "견학 날짜를 묻는 메일", "--off"]).lines[1]).toBe("r2 [꺼짐] 견학 문의\n  언제: 견학 날짜를 묻는 메일");
	expect(runRules(["default", "--set", "존댓말로 짧게"]).lines).toEqual(["기본 규칙을 저장했어요: 존댓말로 짧게"]);
	expect(textsAt({ app: "mail" }, "instruction")).toEqual(["존댓말로 짧게"]);
	expect(runRules(["default"]).lines).toEqual(["mail 기본 규칙: 존댓말로 짧게"]);
	expect(runRules(["remove", "r1"]).lines).toEqual(["규칙 r1 자료 요청을(를) 지웠어요"]);
	expect(stored().draftRules.mail.map((r: { id: string }) => r.id)).toEqual(["r2"]);
	expect(textsAt({ app: "mail", request: "r1" }, "request")).toEqual([]);
	expect(readLedger().find(r => r.kind === "request" && r.scope.request === "r1")?.state).toBe("off");
	expect(runRules(["default", "--clear"]).code).toBe(0);
	expect(textsAt({ app: "mail" }, "instruction")).toEqual([]);
	expect(readLedger().find(r => r.kind === "instruction")?.state).toBe("off");
});

test("a bad request changes nothing: missing fields, an unknown id, a non-mail app, a value the store refuses", () => {
	expect(runRules(["add", "--name", "x"]).code).toBe(2);
	expect(runRules(["edit", "r7", "--off"])).toEqual({ code: 1, lines: ["규칙 r7을(를) 찾지 못했어요"] });
	expect(runRules(["list", "--app", "kakao"]).code).toBe(2);
	expect(runRules(["add", "--name", "이름이 스무 자를 훌쩍 넘어 버리는 아주 긴 규칙 이름", "--when", "x"])).toMatchObject({ code: 1, lines: [expect.stringContaining("이름")] });
	expect(runRules(["bogus"]).code).toBe(2);
	expect(() => readFileSync(paths.config())).toThrow();
});

test("import-style moves a style guide's bullets into the ledger and its examples into the profile, keeps the guide, and import-undo puts it back", () => {
	const guide = join(env.dir, "style-guide.md");
	const md = "# 문체 가이드\n\n## 1. 인사\n\n- 첫 줄은 인사로 시작\n- 소속을 밝힘\n\n## 2. 하지 않는 것\n\n- 서명은 넣지 않음\n\n## 3. 예시\n\n**자료 요청**\n> 안녕하세요.\n> 자료 부탁드립니다.\n\n**확인**\n> 확인 부탁드립니다.\n";
	writeFileSync(guide, md);
	rmSync(toneFile({ app: "co-mail" }), { force: true });
	const out = runRules(["import-style", guide, "--app", "co-mail"]);
	expect(out.code).toBe(0);
	expect(out.lines[0]).toContain("문체 규칙 3개를 rules.json(co-mail)에, 예시 2개를");
	expect(readLedger().filter(r => r.state === "on" && r.scope.app === "co-mail").map(r => [r.kind, r.text])).toEqual([["tone", "첫 줄은 인사로 시작"], ["tone", "소속을 밝힘"], ["tone", "서명은 넣지 않음"]]);
	expect(readFileSync(toneFile({ app: "co-mail" }), "utf8")).toContain("- 안녕하세요. 자료 부탁드립니다.\n- 확인 부탁드립니다.");
	expect(readFileSync(guide, "utf8")).toBe(md);
	expect(runRules(["import-undo"]).code).toBe(0);
	expect(readLedger().some(r => r.state === "on" && r.scope.app === "co-mail")).toBe(false);
	expect(existsSync(toneFile({ app: "co-mail" }))).toBe(false);
	expect(runRules(["import-undo"]).code).toBe(1);
});
