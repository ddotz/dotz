import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { runRules } from "../bin/rules.ts";
import { paths } from "../lib/settings.ts";
import { setupEnv } from "./helpers.ts";

// bin/rules.ts, the 자동 초안 규칙 CLI the bot runs: it writes the same store the settings screen does. Names are placeholders.
const env = setupEnv();
afterAll(() => env.cleanup());
beforeEach(() => rmSync(paths.config(), { force: true }));
const stored = () => JSON.parse(readFileSync(paths.config(), "utf8"));

test("add, edit, default and remove go through the settings store and print what the owner reads", () => {
	expect(runRules(["list"]).lines).toEqual(["mail 기본 규칙: 없음", "자동 초안 규칙이 없어요"]);
	const add = runRules(["add", "--name", "자료 요청", "--when", "자료를 보내 달라는 메일", "--how", "첨부하고 짧게 인사", "--file", "a.pdf", "--file", "~/b.pdf"]);
	expect(add).toEqual({ code: 0, lines: ["규칙을 만들었어요", "r1 [켜짐] 자료 요청\n  언제: 자료를 보내 달라는 메일\n  어떻게: 첨부하고 짧게 인사\n  붙일 파일: a.pdf, ~/b.pdf"] });
	expect(runRules(["edit", "--off", "r1", "--no-files"]).code).toBe(0);
	expect(stored().draftRules.mail).toEqual([{ id: "r1", name: "자료 요청", when: "자료를 보내 달라는 메일", how: "첨부하고 짧게 인사", files: [], on: false }]);
	expect(runRules(["add", "--name", "견학 문의", "--when", "견학 날짜를 묻는 메일", "--off"]).lines[1]).toBe("r2 [꺼짐] 견학 문의\n  언제: 견학 날짜를 묻는 메일");
	expect(runRules(["default", "--set", "존댓말로 짧게"]).lines).toEqual(["기본 규칙을 저장했어요: 존댓말로 짧게"]);
	expect(runRules(["default"]).lines).toEqual(["mail 기본 규칙: 존댓말로 짧게"]);
	expect(runRules(["remove", "r1"]).lines).toEqual(["규칙 r1 자료 요청을(를) 지웠어요"]);
	expect(stored().draftRules.mail.map((r: { id: string }) => r.id)).toEqual(["r2"]);
	expect(runRules(["default", "--clear"]).code).toBe(0);
	expect(stored().draftDefaults.mail).toBe("");
});

test("a bad request changes nothing: missing fields, an unknown id, a non-mail app, a value the store refuses", () => {
	expect(runRules(["add", "--name", "x"]).code).toBe(2);
	expect(runRules(["edit", "r7", "--off"])).toEqual({ code: 1, lines: ["규칙 r7을(를) 찾지 못했어요"] });
	expect(runRules(["list", "--app", "kakao"]).code).toBe(2);
	expect(runRules(["add", "--name", "이름이 스무 자를 훌쩍 넘어 버리는 아주 긴 규칙 이름", "--when", "x"])).toMatchObject({ code: 1, lines: [expect.stringContaining("이름")] });
	expect(runRules(["bogus"]).code).toBe(2);
	expect(() => readFileSync(paths.config())).toThrow();
});
