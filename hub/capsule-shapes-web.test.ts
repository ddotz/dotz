import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, waitFor } from "./test-web.ts";

// web/DESIGN.md 상태·필터·화면 탭, measured on the real stylesheet in a headless browser at 390px, light and dark: a status is a tone dot and a
// word with no tinted capsule and its text is >= 4.5:1 on the card; a filter row is one segmented track (segments touch, one track colour, the
// chosen one a filled cell); a screen tab has no fill, the chosen one a 2px underline, and every tab is a 44px tall hit area.
const hub = fakeHub();
afterAll(() => hub.stop());

const PROBE = `(() => {
	const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	const rgba = c => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
	const over = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3]));
	const backdrop = n => { const layers = []; for (let e = n; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((b, c) => over(c, b), [255, 255, 255]); };
	const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
	const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round((x + 0.05) / (y + 0.05) * 100) / 100; };
	const box = el("div", { class: "card", id: "cap-probe" },
		el("div", {}, ...["ok", "warn", "err", "pri", "unreplied"].map(t => el("span", { class: "tag " + t, text: "상태" })), el("span", { class: "tag", text: "메타" })),
		el("div", {}, el("span", { class: "mon-ptag err", text: "실패" }), el("span", { class: "mon-ptag pri", text: "진행 중" })),
		el("div", { class: "cv-task" }, el("span", { class: "ct-pill pri" }, el("span", { class: "dot pri" }), "진행 중")),
		el("div", { class: "mr-filter" }, el("button", { class: "mr-f on", text: "전체" }), el("button", { class: "mr-f", text: "안 읽음" }), el("button", { class: "mr-f", text: "답장 필요" })),
		el("div", { class: "mx-tabs" }, el("button", { class: "mx-tab on", text: "전체" }), el("button", { class: "mx-tab", text: "업무" })));
	document.body.append(box);
	const status = [...box.querySelectorAll(".tag, .mon-ptag, .ct-pill")].map(n => {
		const s = getComputedStyle(n), b = getComputedStyle(n, "::before");
		const dot = (b.content !== "none" && b.content !== "normal" && rgba(b.backgroundColor)[3] > 0) || !!n.querySelector(":scope > .dot");
		return { cls: n.className, bg: rgba(s.backgroundColor)[3], dot, toned: n.className.split(" ").length > 1, contrast: ratio(rgba(s.color), backdrop(n.parentElement)) };
	});
	const segs = [...box.querySelectorAll(".mr-f")].map(n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n), b = getComputedStyle(n, "::before"); return { l: r.left, r: r.right, t: r.top, h: r.height, bg: s.backgroundColor, on: n.classList.contains("on"), cell: rgba(b.backgroundColor)[3] }; });
	const tabs = [...box.querySelectorAll(".mx-tab")].map(n => { const s = getComputedStyle(n); return { on: n.classList.contains("on"), bg: rgba(s.backgroundColor)[3], line: /inset/.test(s.boxShadow) && /-2px/.test(s.boxShadow), h: n.getBoundingClientRect().height }; });
	box.remove();
	return { status, segs, tabs };
})()`;

type Probe = {
	status: { cls: string; bg: number; dot: boolean; toned: boolean; contrast: number }[];
	segs: { l: number; r: number; t: number; h: number; bg: string; on: boolean; cell: number }[];
	tabs: { on: boolean; bg: number; line: boolean; h: number }[];
};

for (const theme of ["light", "dark"]) {
	test(`status, filter and screen tab shapes (${theme}, 390px)`, async () => {
		const v = await hub.view({ width: 390, height: 844 }, "/");
		await waitFor(v, `typeof el === "function" && document.readyState === "complete"`);
		await v.evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}), 0`);
		const p = await ev<Probe>(v, PROBE);

		for (const s of p.status) {
			expect({ cls: s.cls, bg: s.bg }).toEqual({ cls: s.cls, bg: 0 });
			if (s.toned) expect({ cls: s.cls, dot: s.dot }).toEqual({ cls: s.cls, dot: true });
			expect({ cls: s.cls, ok: s.contrast >= 4.5, contrast: s.contrast }).toMatchObject({ cls: s.cls, ok: true });
		}

		for (let i = 1; i < p.segs.length; i++) {
			expect(Math.abs(p.segs[i].l - p.segs[i - 1].r)).toBeLessThan(1);
			expect(p.segs[i].t).toBe(p.segs[0].t);
			expect(p.segs[i].bg).toBe(p.segs[0].bg);
		}
		expect(p.segs.find(s => s.on)!.cell).toBeGreaterThan(0);
		expect(p.segs.filter(s => !s.on).every(s => s.cell === 0)).toBe(true);

		for (const t of p.tabs) {
			expect(t.bg).toBe(0);
			expect(t.line).toBe(t.on);
			expect(t.h).toBeGreaterThanOrEqual(44);
		}
	});
}
