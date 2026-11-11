import { expect, test } from "bun:test";
import { systemLanguage } from "./language.ts";

// bun reports en-US on a Korean Mac whatever the system language is, so on macOS the language list (AppleLanguages) is read first.
const apple = (first: string) => () => `(\n    "${first}",\n    "en-US"\n)\n`;

test("the macOS language list wins over the Intl locale", () => {
	expect(systemLanguage(apple("ko-KR"))).toBe("ko");
	expect(systemLanguage(apple("ja-JP"))).toBe("ja");
	expect(systemLanguage(apple("zh-Hans-KR"))).toBe("zh");
});

test("without a macOS list (other systems, or defaults failing) the locale is used as before", () => {
	const intl = Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0].toLowerCase();
	expect(systemLanguage(() => undefined)).toBe(intl);
	expect(systemLanguage(() => "(\n)\n")).toBe(intl);
});
