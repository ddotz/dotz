import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, fixPageNow, waitFor } from "./test-web.ts";

// The start date on a row of the 끝난 세션 list (web/js/01-core.js kstShort), called on the real page: KST, mm.dd for this year,
// yy.mm.dd for another year, every part two digits, and nothing for a value that is not a date.
const NOW = Date.parse("2026-11-09T03:00:00Z"); // 12:00 on 11/9 in KST
const hub = fakeHub();
afterAll(() => hub.stop());
const view = await hub.view({}, "/");
await waitFor(view, `typeof kstShort === "function" && S`);
await fixPageNow(view, NOW);
const kstShort = (t: string) => ev<string>(view, `kstShort(${JSON.stringify(t)})`);

test("a start date is mm.dd this year and yy.mm.dd another year, in KST", async () => {
	expect(await kstShort("2026-11-09T03:00:00Z")).toBe("11.09");
	expect(await kstShort("2026-01-05T00:00:00Z")).toBe("01.05");
	expect(await kstShort("2026-12-31T14:59:59Z")).toBe("12.31");
	expect(await kstShort("2026-12-31T15:00:00Z")).toBe("27.01.01");   // already 1 January in Seoul
	expect(await kstShort("2025-12-31T14:59:59Z")).toBe("25.12.31");
	expect(await kstShort("2025-12-31T15:00:00Z")).toBe("01.01");   // 1 January 2026 in Seoul is this year
	expect(await kstShort("not a date")).toBe("");
});
