// web/js/02-basic-markdown.js mdHtml: which ``` opens a code block.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "web", "js", "02-basic-markdown.js"), "utf8");
const re = new Function(`return ${src.match(/split\((\/\(\?:\^[^\n]*\/)\);/)![1]};`)() as RegExp;
// [text, lang, code, text, ...] like mdHtml
const fences = (s: string) => s.split(re).flatMap((p, i) => (i % 3 === 1 ? [{ lang: p, code: s.split(re)[i + 1] }] : []));

test("a fence opens only at the start of a line; ``` inside a sentence stays text", () => {
	expect(fences("웹 채팅이 ```목록 블록을 그려요.\n- 다음 줄")).toEqual([]);
	expect(fences("앞 글\n```목록\n# 제목\n가족 | 단체\n```\n뒤 글")).toEqual([{ lang: "목록", code: "# 제목\n가족 | 단체\n" }]);
	expect(fences("```sh\nls -la\n```")).toEqual([{ lang: "sh", code: "ls -la\n" }]);
	expect(fences("text\n  ```\na\nb```\nafter")).toEqual([{ lang: "", code: "a\nb" }]);
	const parts = "intro\n```js\nx\n```\noutro".split(re);
	expect([parts[0], parts[3]]).toEqual(["intro", "\noutro"]);
});
