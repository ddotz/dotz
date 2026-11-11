import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { i18nPrelude } from "./web-i18n.ts";

// The time left until a usage window or the API budget resets, and the clock time it falls on (web/js/01-core.js leftText and rel, on the
// 사용량 and 계정 screens), run on the real source text: rounded down to the two largest units, so 6 days 23 hours 59 minutes reads
// 6일 23시간, never 7일; the clock is KST like every other time in the app, whatever zone this machine is in.
const read = (file: string) => readFileSync(join(import.meta.dir, "..", "web", "js", file), "utf8");
const core = read("01-core.js"), needsYou = read("09-needs-you.js");
const fn = (name: string) => new RegExp(`^function ${name}\\b[\\s\\S]*?\\n}\\n`, "m").exec(core)![0];
const line = (src: string, name: string) => new RegExp(`^const ${name} = .*$`, "m").exec(src)![0];
const block = (src: string, name: string) => new RegExp(`^const ${name} = [\\s\\S]*?\\n};\\n`, "m").exec(src)![0];
const NOW = Date.parse("2026-11-09T03:00:00Z"); // 12:00 on 11/9 in KST
const FakeDate = class extends Date { static now = () => NOW; };
const { leftText, rel } = new Function("Date", `${i18nPrelude()}${line(core, "KST")}${line(core, "KST_YMD")}${line(core, "ymdOf")}${line(core, "KST_LOCAL")}${block(core, "kstShort")}${line(core, "REL_HM")}${line(needsYou, "KST_DAY")}${line(needsYou, "kstDay")}${fn("leftText")}${fn("rel")}return { leftText, rel };`)(FakeDate) as { leftText: (ms: number) => string; rel: (at: number) => string };
const M = 60_000, H = 60 * M, D = 24 * H;

test("the time left is rounded down to days and hours, hours and minutes, or minutes", () => {
	expect(leftText(6 * D + 23 * H + 59 * M)).toBe("6일 23시간");
	expect(leftText(6 * D + 23 * H + 59 * M + 59_999)).toBe("6일 23시간");
	expect(leftText(7 * D)).toBe("7일");
	expect(leftText(D)).toBe("1일");
	expect(leftText(D - 1)).toBe("23시간 59분");
	expect(leftText(3 * H + 12 * M + 59_000)).toBe("3시간 12분");
	expect(leftText(H)).toBe("1시간");
	expect(leftText(H - 1)).toBe("59분");
	expect(leftText(59 * M)).toBe("59분");
	expect(leftText(M)).toBe("1분");
});

test("a reset says how long until it and at what KST clock time (the date too when not today), and a reset at or past now says it is resetting", () => {
	expect(rel(NOW + 6 * D + 23 * H + 59 * M)).toBe("6일 23시간 후 초기화 (11.16 11:59)");
	expect(rel(NOW + 59 * M + 59_000)).toBe("59분 후 초기화 (12:59)");
	expect(rel(NOW + 2 * H + 18 * M)).toBe("2시간 18분 후 초기화 (14:18)");
	expect(rel(NOW + 11 * H + 5 * M)).toBe("11시간 5분 후 초기화 (23:05)");
	expect(rel(NOW + 12 * H)).toBe("12시간 후 초기화 (11.10 00:00)");
	expect(rel(NOW + 21 * H + 5 * M)).toBe("21시간 5분 후 초기화 (11.10 09:05)");
	expect(rel(NOW + 54 * D + 21 * H + 5 * M)).toBe("54일 21시간 후 초기화 (27.01.03 09:05)");   // another year in front: yy.mm.dd
	expect(rel(NOW + 30_000)).toBe("1분 안에 초기화");
	expect(rel(NOW)).toBe("초기화 중");
	expect(rel(NOW - 5 * M)).toBe("초기화 중");
});
