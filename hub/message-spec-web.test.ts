import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMessageSpecWeb } from "./gen-message-spec-web.ts";
import { deriveBasicSpec, deriveSpec } from "./message-spec-derive.ts";

const shipped = readFileSync(join(import.meta.dir, "..", "web/js/01-message-spec.js"), "utf8");

test("the page's copy is this code, and runs to the same answers", async () => {
	expect(shipped).toBe(await buildMessageSpecWeb());
	const web = new Function(`${shipped}; return { deriveSpec, deriveBasicSpec };`)() as { deriveSpec: typeof deriveSpec; deriveBasicSpec: typeof deriveBasicSpec };
	for (const t of ["정리했어요.\n\n1. 열기\n2. 누르기\n\n근거: 로그 · 파일", "- **응답:** 5,308ms → 36ms\n- **상태:** 정상", "네, 알겠어요.", "| a | b |\n|---|---|\n| 1 | 2 |", "출처:\n- 예시: https://example.com/a\n- https://example.com/b", "```목록\n# 방\n가족 | 단체\n```"]) {
		expect(web.deriveSpec(t)).toEqual(deriveSpec(t));
		expect(web.deriveBasicSpec(t)).toEqual(deriveBasicSpec(t));
	}
});
