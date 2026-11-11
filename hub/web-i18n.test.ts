import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundle, setAppLang } from "./webapp.ts";
import { diskReader, fillPage, formatter, injectedConsts, mapReader, resolveView, setCatalogProvider, webText, type View } from "./web-i18n.ts";

afterEach(() => { setAppLang("ko"); setCatalogProvider(undefined); });

const view = (lang: string, catalog: View["catalog"]): View => ({ lang, catalog });
const web = (rel: string) => readFileSync(join(import.meta.dir, "..", "web", rel), "utf8");

test("TX fills variables, picks plural forms, and leaves a missing key and an unknown variable as they are", () => {
	const { TX } = formatter(view("en", { "t.one": "{a} and {b}", "t.n": { one: "{n} item", other: "{n} items" } }));
	expect(TX("t.one", { a: "x", b: 2 })).toBe("x and 2");
	expect(TX("t.one", { a: "x" })).toBe("x and {b}");
	expect(TX("t.n", { n: 1 })).toBe("1 item");
	expect(TX("t.n", { n: 3 })).toBe("3 items");
	expect(TX("t.nope")).toBe("t.nope");
});

test("Korean particles follow the last syllable", () => {
	const { TX } = formatter(view("ko", { "t.p": "{w+을/를} {w+으로/로}" }));
	expect(TX("t.p", { w: "\uBB38\uC11C" })).toBe("\uBB38\uC11C\uB97C \uBB38\uC11C\uB85C");
	expect(TX("t.p", { w: "\uC9D1" })).toBe("\uC9D1\uC744 \uC9D1\uC73C\uB85C");
	expect(TX("t.p", { w: "\uC11C\uC6B8" })).toBe("\uC11C\uC6B8\uC744 \uC11C\uC6B8\uB85C");
});

test("txInLang: Korean needs Hangul, every other language takes any text", () => {
	expect(formatter(view("ko", {})).txInLang("plain english")).toBe(false);
	expect(formatter(view("ko", {})).txInLang("\uC548\uB155")).toBe(true);
	expect(formatter(view("en", {})).txInLang("plain english")).toBe(true);
	expect(formatter(view("en", {})).txInLang("  ")).toBe(false);
});

test("the language is ko for ko and en for the rest, until a provider has a catalog for it", () => {
	const reader = mapReader(new Map([["i18n/ko/a.json", '{"a.x":"k"}'], ["i18n/en/a.json", '{"a.x":"e"}']]));
	expect(resolveView("ko-KR", reader)).toEqual({ lang: "ko", catalog: { "a.x": "k" } });
	expect(resolveView("de", reader)).toEqual({ lang: "en", catalog: { "a.x": "e" } });
	setCatalogProvider(l => (l === "de" ? { "a.x": "d" } : undefined));
	expect(resolveView("de", reader)).toEqual({ lang: "de", catalog: { "a.x": "d" } });
	expect(resolveView("fr", reader).lang).toBe("en");
});

test("the bundle carries the catalog right after WEB_BUILD, and the language follows setAppLang", () => {
	const ko = bundle("js").text;
	expect(ko.startsWith('"use strict";\nconst WEB_BUILD = "')).toBe(true);
	expect(ko.split("\n")[2]).toBe(injectedConsts(resolveView("ko", diskReader())));
	setAppLang("en");
	const en = bundle("js").text;
	expect(en.split("\n")[2]).toBe(injectedConsts(resolveView("en", diskReader())));
	expect(en.split("\n")[2]).toContain('const I18N_LANG = "en"');
	expect(en).not.toBe(ko);
});

test("the English page is lang=en and holds no Hangul outside comments", () => {
	const view = resolveView("en", diskReader());
	const page = fillPage(web("index.html"), view.lang, view.catalog);
	expect(page).toContain('<html lang="en">');
	expect(page).not.toMatch(/\{\{[a-z0-9_.]+\}\}/);
	const body = page.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
	expect(body).not.toMatch(/[\uAC00-\uD7A3]/);
});

test("webText speaks the app language", () => {
	expect(webText("shell.sw.reply_sent")).toBe(webText("shell.sw.reply_sent", {}, resolveView("ko", diskReader())));
	setAppLang("en");
	expect(webText("shell.sw.reply_sent")).toBe(webText("shell.sw.reply_sent", {}, resolveView("en", diskReader())));
	expect(webText("shell.sw.reply_sent")).not.toBe(webText("shell.sw.reply_sent", {}, resolveView("ko", diskReader())));
});
