// hub/message-spec-derive.ts: which ``` opens a code block.
import { expect, test } from "bun:test";
import { deriveBasicSpec } from "./message-spec-derive.ts";

const blocks = (text: string) => {
	const spec = deriveBasicSpec(text);
	return spec.elements[spec.root]!.children!.map(id => spec.elements[id]!).map(e => [e.type, e.props] as const);
};
const codes = (text: string) => blocks(text).filter(([type]) => type === "Code").map(([, props]) => props);

test("a fence opens only at the start of a line; ``` inside a sentence stays text", () => {
	expect(blocks("웹 채팅이 ```목록 블록을 그려요.\n- 다음 줄").map(([type]) => type)).not.toContain("Code");
	expect(blocks("앞 글\n```목록\n# 제목\n가족 | 단체\n```\n뒤 글").map(([type]) => type)).toEqual(["Text", "Rows", "Text"]);
	expect(codes("```sh\nls -la\n```")).toEqual([{ code: "ls -la", lang: "sh" }]);
	expect(blocks("text\n  ```\na\nb```\nafter")).toEqual([["Text", { text: "text" }], ["Code", { code: "a\nb" }], ["Text", { text: "after" }]]);
	expect(blocks("intro\n```js\nx\n```\noutro")).toEqual([["Text", { text: "intro" }], ["Code", { code: "x", lang: "js" }], ["Text", { text: "outro" }]]);
});
