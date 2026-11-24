import { describe, expect, test } from "bun:test";
import { type SpecElement, specOfElements } from "./message-spec.ts";
import { renderTerminal, useColor } from "./spec-terminal.ts";

const spec = (...els: SpecElement[]) => specOfElements(els);
const MARKERS = /\[(?:done|run|wait|ask|fail)\]/;
const ESC = "\u001b[";
const visible = (s: string) => Bun.stripANSI(s);

describe("renderTerminal", () => {
	test("bold, dim and strikethrough when colour is on, nothing when off", () => {
		const s = spec({ type: "Facts", props: { rows: [{ key: "버전", from: "1.0", to: "1.1" }] } }, { type: "Meta", props: { text: "3초" } });
		const on = renderTerminal(s, { color: true });
		expect(on).toContain(`${ESC}1m버전${ESC}22m`);
		expect(on).toContain(`${ESC}9m1.0${ESC}29m`);
		expect(on).toContain(`${ESC}2m3초${ESC}22m`);
		const off = renderTerminal(s, { color: false });
		expect(off).not.toContain(ESC);
		expect(off).toBe("버전  1.0 → 1.1\n\n3초");
	});
	test("columns align by display width, Korean counted as 2", () => {
		const out = renderTerminal(spec({ type: "Table", props: { rows: [["가나", "x"], ["abcd", "y"], ["a", "z"]] } }), { color: false });
		const cols = out.split("\n").map(l => Bun.stringWidth(l.slice(0, l.lastIndexOf(" ") + 1)));
		expect(new Set(cols).size).toBe(1);
		expect(out.split("\n")[0]).toBe("가나  x");
	});
	test("control characters never reach the terminal, links are shown as url, markers never show", () => {
		const out = renderTerminal(spec({ type: "Text", props: { text: "\u001b]0;pwn\u0007 [x](javascript:alert(1)) [ok](https://a.example)" } }, { type: "Facts", props: { rows: [{ key: "\u001b[2Jk", value: "v" }] } }), { color: true });
		expect(visible(out)).not.toContain("\u001b");
		expect(out).not.toContain("\u0007");
		expect(visible(out)).toContain("ok (https://a.example)");
		expect(out).not.toMatch(MARKERS);
	});
	test("a type without an entry uses its plain form, Files is left out", () => {
		const out = renderTerminal(spec({ type: "Heading", props: { text: "제목" } }, { type: "Files", props: { items: [{ path: "/tmp/a" }] } }), { color: false });
		expect(visible(out)).toContain("제목");
		expect(out).not.toContain("/tmp/a");
	});
	test("a card prints its question, then its own evidence lines, then the options", () => {
		const choice = { type: "Choice", props: { question: "디스크 · 오래된 로그를 지울까요?", evidence: ["로그 폴더 12GB, 어제는 9GB였어요.", "가장 큰 파일: hub.log"], options: [{ n: 1, label: "지워요", desc: "7일 넘은 로그만 지워요" }, { n: 2, label: "둬요" }] } };
		expect(renderTerminal(spec(choice), { color: false })).toBe("디스크 · 오래된 로그를 지울까요?\n로그 폴더 12GB, 어제는 9GB였어요.\n가장 큰 파일: hub.log\n1) 지워요\n   7일 넘은 로그만 지워요\n2) 둬요");
	});
	test("NO_COLOR and a pipe turn colour off", () => {
		expect(useColor({}, true)).toBe(true);
		expect(useColor({ NO_COLOR: "1" }, true)).toBe(false);
		expect(useColor({}, false)).toBe(false);
	});
});
