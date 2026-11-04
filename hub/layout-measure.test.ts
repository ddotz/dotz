// Planted pages through one shared view: each of the six checks fails on a page built to break it and stays quiet on a clean one, driving the
// page-side measure functions directly. The last test runs every screen at both widths against hub/layout-baseline.json.
// The full screens run takes about 7 s here (two views, 26 screen visits), well under the 20 s that would have kept it a script only.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_FILE, CHECKS, compareBaseline, installMeasures, itemKey, measureScreens, readBaseline, runChecks, SCREENS, WIDTHS, type Check, type Item } from "./layout-measure.ts";

setDefaultTimeout(60_000);   // a WebView start takes seconds under parallel load
const dir = mkdtempSync(join(tmpdir(), "layout-measure-"));
const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { view.close(); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
// Loads the planted body, installs the measures, waits two frames, and returns the items of one check.
async function measure(body: string, check: Check): Promise<Item[]> {
	const file = join(dir, `p${n++}.html`);
	writeFileSync(file, `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px/24px sans-serif">${body}`);
	await view.navigate(Bun.pathToFileURL(file).href);
	await installMeasures(view);
	await view.evaluate(`new Promise(r => document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))`);
	return runChecks(view, { screen: "planted", width: 390, scope: "body" }, [check]);
}
const bad = (items: Item[]) => items.filter(i => i.bad);

const CARD = "background:#e8eaf0;width:240px;height:48px";

test("cramped: text pressed against its filled box fails, padded text and exempt boxes stay quiet", async () => {
	const tight = bad(await measure(`<div style="${CARD};padding:0 2px;box-sizing:border-box">가나다라 마바사</div>`, "cramped"));
	expect(tight).toHaveLength(1);
	expect(tight[0]!.detail).toMatch(/L[0-3]\b/);
	const edge = bad(await measure(`<p style="margin:0 2px">이 문장은 화면 가장자리에 붙어 있는 긴 글이에요</p>`, "cramped"));
	expect(edge.map(i => i.el)).toEqual([expect.stringContaining("@edge")]);

	expect(bad(await measure(`<div style="${CARD};padding:12px 16px;box-sizing:border-box">가나다라 마바사</div><p style="margin:0 16px">이 문장은 화면 가장자리에서 충분히 떨어져 있어요</p>`, "cramped"))).toEqual([]);
	// a bar (fixed), a scroller whose text runs on past the edge, and a small box are not looked at
	expect(bad(await measure(`<div style="position:fixed;top:0;left:0;width:300px;height:40px;background:#ddd;padding:0 1px;box-sizing:border-box">고정 막대 안의 글</div>
		<div style="${CARD};overflow-x:auto;white-space:nowrap;padding:0 2px;box-sizing:border-box">가로로 스크롤하는 아주 긴 글자 상자 안의 글</div>
		<div style="background:#ddd;width:60px;height:24px;padding:0 1px;box-sizing:border-box">작은 칩</div>`, "cramped"))).toEqual([]);
});

test("field-height: a field and a button of different height in one row fail, equal ones and far-apart ones do not", async () => {
	const row = (field: number, button: number, gap = 8) => `<div style="display:flex;gap:${gap}px;width:380px"><input style="height:${field}px;box-sizing:border-box;width:120px"><button style="height:${button}px;box-sizing:border-box">저장</button></div>`;
	const off = await measure(row(40, 32), "field-height");
	expect(bad(off)).toHaveLength(1);
	expect(off[0]!.value).toBeCloseTo(8, 1);
	expect(await measure(row(36, 36), "field-height")).toHaveLength(1);
	expect(bad(await measure(row(36, 36), "field-height"))).toEqual([]);
	expect((await measure(row(40, 32, 60), "field-height"))).toEqual([]);
	// a one-row textarea (the chat composer) is a field too, a two-row one is not; a button.sel beside a field is a button
	const area = (rows: number, button: number) => `<div style="display:flex;align-items:flex-start;gap:8px;width:380px"><textarea rows="${rows}" style="padding:4px 8px;box-sizing:border-box;width:200px;font:16px/24px sans-serif"></textarea><button style="height:${button}px;box-sizing:border-box">보내기</button></div>`;
	const one = await measure(area(1, 44), "field-height");
	expect(bad(one)).toHaveLength(1);
	expect(one[0]!.value).toBeCloseTo(10, 1);
	expect(await measure(area(2, 44), "field-height")).toEqual([]);
	const sel = await measure(`<div style="display:flex;gap:8px;width:380px"><input style="height:36px;box-sizing:border-box;width:120px"><button class="sel" style="height:36px;box-sizing:border-box">형식: 전체</button></div>`, "field-height");
	expect(sel).toHaveLength(1);
	expect(bad(sel)).toEqual([]);
});

test("concentric: an inner radius that is not outer radius minus inset fails, the concentric one and a pseudo-element indicator are judged too", async () => {
	const nest = (inner: number) => `<div style="width:240px;padding:8px;box-sizing:border-box;border-radius:16px;background:#e8eaf0"><div style="height:32px;border-radius:${inner}px;background:#99a8ff"></div></div>`;
	expect(bad(await measure(nest(16), "concentric")).map(i => i.value)).toEqual([8]);
	expect(bad(await measure(nest(8), "concentric"))).toEqual([]);

	const pill = (r: number) => `<style>.seg{position:relative;width:240px;height:40px;border-radius:20px;background:#e8eaf0}.seg::before{content:"";position:absolute;left:4px;top:4px;width:110px;height:32px;border-radius:${r}px;background:#99a8ff}</style><div class="seg"></div>`;
	const wrong = bad(await measure(pill(2), "concentric"));
	expect(wrong).toHaveLength(1);
	expect(wrong[0]!.el).toContain("::before");
	expect(bad(await measure(pill(16), "concentric"))).toEqual([]);
	// flush against a clipping outer box, the outer curve is the inner one
	expect(bad(await measure(`<div style="width:240px;border-radius:16px;overflow:hidden;background:#e8eaf0"><div style="height:32px;background:#99a8ff"></div></div>`, "concentric"))).toEqual([]);
	// a circle (a round send button, a status dot, an avatar) has no concentric shape to keep, a fully round pill wider than tall is judged
	const inner = (w: number, h: number) => `<div style="width:240px;padding:8px;box-sizing:border-box;border-radius:16px;background:#e8eaf0"><div style="width:${w}px;height:${h}px;border-radius:999px;background:#99a8ff"></div></div>`;
	expect(await measure(inner(32, 32), "concentric")).toEqual([]);
	expect(bad(await measure(inner(100, 32), "concentric")).map(i => i.value)).toEqual([8]);
	expect(bad(await measure(inner(36, 32), "concentric")).map(i => i.value)).toEqual([8]);
});

test("left-edges: lines 1-3px apart are near-tangent, a card's own indentation is counted in the card", async () => {
	const p = (x: number) => `<p style="margin:0 0 0 ${x}px">왼쪽 줄 맞춤</p>`;
	const tangent = await measure(p(20) + p(20) + p(22), "left-edges-tangent");
	expect(tangent).toHaveLength(1);
	expect(tangent[0]!.value).toBeCloseTo(2, 0);
	expect(await measure(p(20) + p(20) + p(20), "left-edges-tangent")).toEqual([]);
	expect(await measure(p(20) + p(20) + p(40) + p(40), "left-edges-tangent")).toEqual([]);

	// six start lines of two items each in one container is too many; the same six spread over cards is not
	const six = [20, 44, 68, 92, 116, 140].map(x => p(x) + p(x)).join("");
	const crowded = await measure(six, "left-edges");
	expect(bad(crowded).map(i => i.value)).toEqual([6]);
	const cards = [20, 44, 68, 92, 116, 140].map(x => `<div style="background:#eef;margin:8px 0 8px ${x}px;width:200px">${p(0)}${p(0)}</div>`).join("");
	expect(bad(await measure(cards, "left-edges"))).toEqual([]);

	// a meta column to the right of a row (a timestamp, a value) is not a start line: titles on one line, times on two near lines beside them
	const row = (time: number) => `<div style="display:flex"><span style="margin-left:20px">제목 줄</span><span style="margin-left:${time}px">12:30</span></div>`;
	const meta = [row(140), row(140), row(142), row(142)].join("");
	expect((await measure(meta, "left-edges")).map(i => i.value)).toEqual([1]);
	expect(await measure(meta, "left-edges-tangent")).toEqual([]);
	// the same texts stacked, not beside each other, are start lines and are counted
	expect((await measure(p(20) + p(20) + p(140) + p(140) + p(142) + p(142), "left-edges-tangent"))).toHaveLength(1);

	// a pane (an <aside>, an overflow-y scroller) is its own container: two panes side by side are measured apart
	const lines = (x0: number) => [10, 34, 58].map(x => p(x0 + x) + p(x0 + x)).join("");
	const panes = `<div style="display:flex"><aside style="width:180px">${lines(0)}</aside><div style="width:180px;height:400px;overflow-y:auto">${lines(0)}</div></div>`;
	expect((await measure(panes, "left-edges")).map(i => i.value)).toEqual([3, 3]);
});

test("icon-center: an icon off the text line's centre fails, a centred one does not", async () => {
	const row = (align: string, top: number) => `<div style="display:flex;align-items:${align}"><svg width="16" height="16" style="margin-top:${top}px"><circle cx="8" cy="8" r="7"/></svg><span style="margin-left:6px">상태 이름</span></div>`;
	const off = await measure(row("flex-start", 7), "icon-center");
	expect(bad(off)).toHaveLength(1);
	expect(off[0]!.value).toBeGreaterThan(1);
	const ok = await measure(row("center", 0), "icon-center");
	expect(ok).toHaveLength(1);
	expect(bad(ok)).toEqual([]);
	// an icon beside a block of two lines is centred on the block, not on a line: not measured
	expect(await measure(`<div style="display:flex;align-items:center"><svg width="16" height="16"><circle cx="8" cy="8" r="7"/></svg><div style="margin-left:6px"><div>첫째 줄</div><div>둘째 줄</div></div></div>`, "icon-center")).toEqual([]);
});

test("row-height: stacked single-line rows of one kind with different heights fail, multi-line rows are left out", async () => {
	const rows = (...h: number[]) => `<div>${h.map(x => `<div class="row" style="height:${x}px;display:flex;align-items:center">한 줄짜리 행</div>`).join("")}</div>`;
	const off = await measure(rows(40, 40, 52), "row-height");
	expect(bad(off)).toHaveLength(1);
	expect(off[0]!.value).toBe(12);
	expect(bad(await measure(rows(40, 40, 40), "row-height"))).toEqual([]);
	const wrapped = `<div>${[40, 40, 40].map(x => `<div class="row" style="height:${x}px;display:flex;align-items:center">한 줄짜리 행</div>`).join("")}<div class="row" style="width:80px;padding:4px 0">줄이 넘쳐서 여러 줄이 되는 행이에요</div></div>`;
	expect(bad(await measure(wrapped, "row-height"))).toEqual([]);
	expect(await measure(rows(40, 52), "row-height")).toEqual([]);
});

test("every screen at both widths against hub/layout-baseline.json: no new bad item, no stale key, every screen reached", async () => {
	const names = SCREENS.map(s => s.name);
	const { items, unreached, stray } = await measureScreens(names, WIDTHS);
	expect(unreached).toEqual([]);
	expect(stray).toEqual([]);
	expect(new Set(items.map(i => i.check))).toEqual(new Set(CHECKS));   // a check that measured nothing reads nothing
	const { added, stale } = compareBaseline(items, readBaseline(BASELINE_FILE), { screens: names, widths: WIDTHS });
	expect({ added, stale }).toEqual({ added: [], stale: [] });
	expect(itemKey(items[0]!)).toMatch(/^[a-z-]+\|[a-z-]+\|\d+\|/);
});
