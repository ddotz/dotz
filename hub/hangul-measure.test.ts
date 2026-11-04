// Planted pages through one shared view; the exit codes through the real CLI.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureRuns } from "./hangul-measure.ts";

setDefaultTimeout(30_000);   // a WebView start takes seconds under parallel load
const dir = mkdtempSync(join(tmpdir(), "hangul-measure-"));
const view = new Bun.WebView({ width: 390, height: 900 });
afterAll(() => { view.close(); rmSync(dir, { recursive: true, force: true }); });

const LONG = "가나다라마바사아자차카타파하".repeat(2);
const page = (name: string, body: string) => {
	const file = join(dir, `${name}.html`);
	writeFileSync(file, `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px/24px sans-serif">${body}`);
	return file;
};
const url = (file: string) => Bun.pathToFileURL(file).href;
const summary = async (file: string, text = 100) => (await measureRuns(view, url(file), text > 100 ? [{ width: 390, text }] : [{ width: 390, text: 100 }])).summary;
const SPLIT = `<div style="width:90px;word-break:break-all">${LONG}</div>`;
const CLEAN = `<p style="width:200px;word-break:keep-all">어절 사이에서만 줄을 바꾸는 깨끗한 글이에요</p>`;

test("flags a planted split word", async () => {
	expect((await summary(page("split", SPLIT))).split).toBeGreaterThan(0);
});

test("flags a planted box overflow and page overflow", async () => {
	expect((await summary(page("box", `<div style="width:60px;white-space:nowrap">넘치는 글자가 아주 깁니다</div>`))).overflow).toBe(1);
	const wide = await measureRuns(view, url(page("wide", `<div style="width:600px">옆으로 밀리는 페이지예요</div>`)), [{ width: 390, text: 100 }]);
	expect(wide.report[0]!.found.filter(f => f.page)).toHaveLength(1);
});

test("a clean page passes, with the intended exceptions not counted", async () => {
	const clean = page("clean", `${CLEAN}
		<div id="tl" style="width:90px;word-break:break-all">${LONG}</div>
		<pre style="width:90px;white-space:pre-wrap;word-break:break-all">${LONG}</pre>
		<div style="width:90px;overflow-x:auto;white-space:nowrap">가로로 스크롤하는 긴 글자 상자예요</div>
		<div style="width:90px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">말줄임으로 끝나는 긴 글자 상자예요</div>`);
	expect(await summary(clean)).toEqual({ split: 0, overflow: 0, clip: 0, blocked: 0, orphan: 0 });
});

test("reports an orphan", async () => {
	expect((await summary(page("orphan", `<p style="width:300px">앞줄은 충분히 긴 문장이에요<br>끝</p>`))).orphan).toBe(1);
});

test("--text finds a clipped button and a covered one", async () => {
	const file = page("tap", `<button style="height:24px;padding:0;border:0;overflow:hidden;font-size:16px;line-height:24px">눌러요</button>
		<div style="position:relative;width:200px;height:60px"><button style="position:absolute;left:0;top:0;width:80px;height:30px">아래</button><div style="position:absolute;inset:0"></div></div>`);
	expect(await summary(file, 200)).toMatchObject({ clip: 1, blocked: 1 });
});

test("--text skips a covered button folded inside a closed details, not one in an open details", async () => {
	const folded = (open: string) => `<details${open}><summary>끝난 세션 목록이에요</summary><div style="position:relative;width:60px;height:40px"><button aria-label="삭제" style="width:40px;height:30px"></button><div style="position:absolute;inset:0"></div></div></details>`;
	expect((await summary(page("closed", folded("")), 200)).blocked).toBe(0);
	expect((await summary(page("opened", folded(" open")), 200)).blocked).toBe(1);
});

test("the CLI exits 0 clean, 1 problems, 2 could not run", async () => {
	const cli = (...args: string[]) => Bun.spawn(["bun", join(import.meta.dir, "hangul-measure.ts"), ...args], { stdout: "ignore", stderr: "ignore" }).exited;
	const codes = await Promise.all([cli(page("cli-clean", CLEAN), "390"), cli(page("cli-split", SPLIT), "390"), cli(join(dir, "missing.html"), "390"), cli(page("cli-scope", CLEAN), "390", "--scope", "#nope")]);
	expect(codes).toEqual([0, 1, 2, 2]);
});
