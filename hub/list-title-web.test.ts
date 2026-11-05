import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, waitFor } from "./test-web.ts";

// A long list title stays on one line and fades at its end, a title that fits never reaches the fade (web/css/25-list-title.css). Measured
// on the real stylesheet: the mask fades the last --sp-5 of the box, so a title that fits must end at or before that line.
const hub = fakeHub({});
afterAll(() => hub.stop());

const LONG = "다음 주 월요일까지 company에 제출할 분기 예산 집행 현황 보고서 초안 검토 요청 건에 대한 회신과 후속 일정 조율";
const measure = (selector: string) => `(() => {
	const e = document.querySelector(${JSON.stringify(selector)}), s = getComputedStyle(e), box = e.getBoundingClientRect(), r = document.createRange();
	r.selectNodeContents(e);
	return { lines: Math.round(box.height / parseFloat(s.lineHeight)), fadeFrom: box.right - parseFloat(s.getPropertyValue("--sp-5")), textEnd: r.getBoundingClientRect().right, cut: e.scrollWidth > e.clientWidth, mask: s.maskImage !== "none" };
})()`;
const row = (cls: string, title: string) => `<div class="li" style="width:300px"><span class="tx"><span class="hd ${cls}">${title}</span></span></div>
	<span class="hr" style="display:block;width:300px"><span class="hn1"><span class="nm ${cls}">${title}</span><span class="tag">알림</span></span></span>`;

test("an attachment's name in an open mail fades like any list title", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	await waitFor(v, `getComputedStyle(document.documentElement).getPropertyValue("--sp-5").trim() === "20px"`);
	await v.evaluate(`document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(`<div style="width:300px"><span class="mr-fname long">${LONG}</span></div>`)}), 0`);
	expect(await ev<{ lines: number; cut: boolean; mask: boolean }>(v, measure(".mr-fname.long"))).toMatchObject({ lines: 1, cut: true, mask: true });
});

test("a long title fades on one line, a short one stays clear of the fade, in a full-width and a shrink-to-fit box", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	await waitFor(v, `getComputedStyle(document.documentElement).getPropertyValue("--sp-5").trim() === "20px"`);
	await v.evaluate(`document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(row("long", LONG) + row("short", "짧은 제목"))}), 0`);
	for (const sel of [".hd.long", ".nm.long"]) {
		const m = await ev<{ lines: number; cut: boolean; mask: boolean }>(v, measure(sel));
		expect(m).toMatchObject({ lines: 1, cut: true, mask: true });
	}
	for (const sel of [".hd.short", ".nm.short"]) {
		const m = await ev<{ lines: number; cut: boolean; textEnd: number; fadeFrom: number }>(v, measure(sel));
		expect(m).toMatchObject({ lines: 1, cut: false });
		expect(m.textEnd).toBeLessThanOrEqual(m.fadeFrom + 0.5);
	}
});
