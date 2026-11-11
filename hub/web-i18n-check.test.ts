import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, firstBaseline, lowered, stripJs, type Baseline } from "./web-i18n-check.ts";

const HAN = "\uD55C\uAE00";
let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

function fixture(files: Record<string, string>): string {
	dir = mkdtempSync(join(tmpdir(), "dotz-i18n-"));
	for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), text); }
	return dir;
}
const base = (files: Baseline["files"] = {}): Baseline => ({ files, enHangulKeys: [], unusedKeyPrefixes: {} });
const GOOD = {
	"web/i18n/ko/a.json": JSON.stringify({ "a.go": "가기", "a.n": { other: "{n}개" } }),
	"web/i18n/en/a.json": JSON.stringify({ "a.go": "Go", "a.n": { one: "{n} item", other: "{n} items" } }),
	"web/js/x.js": `const t = TX("a.go") + TX("a.n", { n: 2 });\n`,
};
const problems = (files: Record<string, string>, b = base()) => check(fixture(files), b).problems.join("\n");

test("a consistent pair of catalogs that code uses passes", () => {
	expect(problems(GOOD)).toBe("");
});

test("Hangul in a comment is free, Hangul in a string is counted per file", () => {
	expect(stripJs(`// ${HAN}\nconst a = "${HAN}"; /* ${HAN} */ const b = \`${HAN}\${"x"}\`;`)).not.toContain("// ");
	const text = `// ${HAN}\nconst a = "${HAN}"; /* ${HAN} */ const b = 1;\n`;
	expect(check(fixture({ ...GOOD, "web/js/y.js": text }), base()).counts["web/js/y.js"]).toBe(1);
});

test("a regex literal holding a slash does not swallow the line after it", () => {
	const text = `const re = /[a/]${HAN}/; const s = "${HAN}";\n`;
	expect(check(fixture({ ...GOOD, "web/js/y.js": text }), base()).counts["web/js/y.js"]).toBe(2);
});

test("ratchet: more Hangul than the baseline fails, fewer asks for --update, equal passes", () => {
	const files = { ...GOOD, "web/js/y.js": `const a = "${HAN}";\n` };
	const at = (count: number, why = "agent-text parsing") => base({ "web/js/y.js": { count, why } });
	expect(problems(files, at(1))).toBe("");
	expect(problems(files, at(0))).toContain("web/js/y.js: 1 Hangul runs");
	expect(problems(files, at(2))).toContain("--update");
	expect(problems(files, base())).toContain("web/js/y.js: 1 Hangul runs");
	expect(problems(files, at(5, "pending"))).toBe("");
});

test("a non-zero baseline entry needs a why", () => {
	const files = { ...GOOD, "web/js/y.js": `const a = "${HAN}";\n` };
	expect(problems(files, base({ "web/js/y.js": { count: 1, why: " " } }))).toContain("needs a `why`");
});

test("lowered only goes down and drops a file at zero, a pending file follows its count; the first baseline marks everything pending", () => {
	const b = base({ "a.js": { count: 5, why: "pending" }, "b.js": { count: 2, why: "keys" }, "c.js": { count: 1, why: "pending" }, "d.js": { count: 1, why: "pending" } });
	const next = lowered({ "a.js": 3, "b.js": 9, "d.js": 4, "e.js": 2 }, b);
	expect(next.files).toEqual({ "a.js": { count: 3, why: "pending" }, "b.js": { count: 2, why: "keys" }, "d.js": { count: 4, why: "pending" } });
	expect(firstBaseline({ "a.js": 4 }).files["a.js"]).toEqual({ count: 4, why: "pending" });
});

test("catalog parity: a missing key, a placeholder that differs, Hangul in en, a Korean particle in en", () => {
	const ko = JSON.stringify({ "a.go": "{x}", "a.two": "둘", "a.three": "{w+은/는}" });
	const en = JSON.stringify({ "a.go": "{y}", "a.three": `${HAN} {w+is/are}` });
	const out = problems({ ...GOOD, "web/i18n/ko/a.json": ko, "web/i18n/en/a.json": en, "web/js/x.js": `TX("a.go"); TX("a.two"); TX("a.three");` });
	expect(out).toContain("web/i18n/en/a.json lacks a.two");
	expect(out).toContain("a.go: placeholders differ");
	expect(out).toContain("a.three: Hangul in an en value");
	expect(out).toContain("Korean particle form is for ko only");
});

test("a joining word fails: a value that starts with a space, or ends with one in one language only; a label with a trailing space in both passes", () => {
	const with2 = (ko: Record<string, string>, en: Record<string, string>) => problems({ ...GOOD, "web/i18n/ko/a.json": JSON.stringify(ko), "web/i18n/en/a.json": JSON.stringify(en), "web/js/x.js": `TX("a.j");` });
	expect(with2({ "a.j": "\uC640" }, { "a.j": " and " })).toContain("a.j: edge spaces");
	expect(with2({ "a.j": "\uC640 " }, { "a.j": " and " })).toContain("a.j: edge spaces");
	expect(with2({ "a.j": "\uB05D" }, { "a.j": "end " })).toContain("a.j: edge spaces");
	expect(with2({ "a.j": "\uC774\uB984 " }, { "a.j": "Name " })).toBe("");
	expect(with2({ "a.j": "{a}\uC640 {b}" }, { "a.j": "{a} and {b}" })).toBe("");
});

test("an area file without a twin, and a bad key, fail", () => {
	const out = problems({ ...GOOD, "web/i18n/ko/b.json": JSON.stringify({ "Bad Key": "x" }) });
	expect(out).toContain("web/i18n/ko/b.json has no en twin");
	expect(out).toContain("key must be lowercase dotted words");
});

test("used and unused keys: code naming a missing key fails, a catalog key nothing uses fails unless its prefix is allowed", () => {
	const files = { ...GOOD, "web/js/x.js": `TX("a.go"); TX("a.missing");` };
	const out = problems(files);
	expect(out).toContain("key a.missing is not in web/i18n/ko");
	expect(out).toContain("key a.n is not used anywhere in code");
	expect(check(fixture(files), { ...base(), unusedKeyPrefixes: { "a.n": "later" } }).problems.join("\n")).not.toContain("a.n is not used");
});

test("a {{key}} token in index.html counts as use, and a missing one fails", () => {
	const html = `<html lang="ko"><body><b aria-label="{{a.go}}">{{a.n}}</b></body></html>`;
	expect(problems({ ...GOOD, "web/js/x.js": "", "web/index.html": html })).toBe("");
	expect(problems({ ...GOOD, "web/js/x.js": "", "web/index.html": `${html}{{a.nope}}` })).toContain("key a.nope is not in web/i18n/ko");
});
