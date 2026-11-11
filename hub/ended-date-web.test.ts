import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The start date on a row of the 끝난 세션 list (web/js/01-core.js kstShort), run on the real source text: KST, mm.dd for this year,
// yy.mm.dd for another year, every part two digits, and nothing for a value that is not a date.
const read = (file: string) => readFileSync(join(import.meta.dir, "..", "web", "js", file), "utf8");
const core = read("01-core.js");
const line = (src: string, name: string) => new RegExp(`^const ${name} = .*$`, "m").exec(src)![0];
const block = (src: string, name: string) => new RegExp(`^const ${name} = [\\s\\S]*?\\n};\\n`, "m").exec(src)![0];
const NOW = Date.parse("2026-11-09T03:00:00Z"); // 12:00 on 11/9 in KST
const FakeDate = class extends Date { static now = () => NOW; };
const kstShort = new Function("Date", `${line(core, "KST")}${line(core, "KST_YMD")}${line(core, "ymdOf")}${block(core, "kstShort")}return kstShort;`)(FakeDate) as (t: unknown) => string;

test("a start date is mm.dd this year and yy.mm.dd another year, in KST", () => {
	expect(kstShort("2026-11-09T03:00:00Z")).toBe("11.09");
	expect(kstShort("2026-01-05T00:00:00Z")).toBe("01.05");
	expect(kstShort("2026-12-31T14:59:59Z")).toBe("12.31");
	expect(kstShort("2026-12-31T15:00:00Z")).toBe("27.01.01");   // already 1 January in Seoul
	expect(kstShort("2025-12-31T14:59:59Z")).toBe("25.12.31");
	expect(kstShort("2025-12-31T15:00:00Z")).toBe("01.01");   // 1 January 2026 in Seoul is this year
	expect(kstShort("not a date")).toBe("");
});
