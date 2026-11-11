import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// A source list in a chat answer (web/js/02-basic-markdown.js sourceListHtml), drawn in a headless browser: rows with the site and a short
// path, a link inside a sentence left alone, nothing fetched for the rows, no overflow on a phone, and the original URLs in a copied selection.
const URLS = [
	"https://learn.microsoft.com/en-us/samples/microsoft/windows-universal-samples/ocr/",
	"https://github.com/argosopentech/argos-translate",
	"https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec",
	"https://learn.microsoft.com/en-us/windows/ai/apis/phi-silica",
];
const SENTENCE = "자세한 건 [공식 문서](https://example.com/guide)와 https://example.org/a 를 보세요.";
const LAW = "https://casenote.kr/법령/한국예시협회법";
const ts = (n: number) => `2026-11-04T08:${String(10 + n).padStart(2, "0")}:00.000Z`;
const answer = (n: number, text: string) => ({ ts: ts(n), kind: "out", source: "orchestrator", target: "web", text });
const events = [
	answer(0, `${SENTENCE}\n\n출처:\n\n${URLS.join("\n")}`),
	answer(1, `결과예요.\n${URLS[1]}\n${URLS[2]}`),
	answer(2, "참고:\n- [읽어 볼 글](https://www.example.net/post?id=1)\n- https://example.net"),
	answer(3, `한 줄만 있어요.\n${URLS[1]}`),
	answer(4, `${URLS[1]}\n${URLS[2]}\n이어지는 말이에요.`),
	answer(5, `조문에 맞아요.\n\n근거:\n- 한국예시협회법 제31조: ${LAW}/제31조\n- 한국예시협회법 제32조(손실은 적립금으로 먼저 보전): ${LAW}/제32조\n- 한국예시협회법 제23조: ${LAW}/제23조`),
	answer(6, "근거:\n- 규정: https://example.com/a\n- 담당자에게 확인했어요."),
	answer(7, "참고:\n문서 - https://example.org/a\n[글](https://example.org/b)\n1. 책: <https://example.org/c>"),
	answer(8, "문서: https://example.com/a\n글: https://example.com/b"),
	answer(9, "근거:\n- 담당자에게 확인했어요.\n- https://example.com/a\n- https://example.com/b"),
];
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? events : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 412, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
const page = async <T>(expr: string) => (await view.evaluate(`JSON.stringify(${expr})`).then(s => JSON.parse(s as string))) as T;
const lists = `[...document.querySelectorAll(".bm .mlist-src")]`;
const rowsOf = (i: number) => page<{ site: string; sub: string | null; href: string; title: string; target: string; rel: string; letter: string }[]>(`[...${lists}[${i}].querySelectorAll("a.mlist-row")].map(a => ({ site: a.querySelector(".mlist-t").textContent, sub: a.querySelector(".mlist-s")?.textContent ?? null, href: a.getAttribute("href"), title: a.title, target: a.target, rel: a.rel, letter: a.querySelector(".mlist-av").textContent }))`);

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof openTarget === "function" && S`);
await view.evaluate(`(openTarget("main", "chat"), 0)`);
await waitFor(`${lists}.length === 5`);

test("the four URLs under 출처: are rows with site and short path, the full URL behind them", async () => {
	const rows = await rowsOf(0);
	expect(rows.map(r => [r.letter, r.site, r.sub])).toEqual([
		["L", "learn.microsoft.com", "…/windows-universal-samples/ocr"],
		["G", "github.com", "argosopentech/argos-translate"],
		["H", "huggingface.co", "PaddlePaddle/korean_PP-OCRv5_mobile_rec"],
		["L", "learn.microsoft.com", "…/apis/phi-silica"],
	]);
	expect(rows.map(r => r.href)).toEqual(URLS);
	expect(rows.map(r => r.title)).toEqual(URLS);
	expect(rows.every(r => r.target === "_blank" && r.rel.split(" ").includes("noopener"))).toBe(true);
	expect(await page(`${lists}[0].querySelector(".mlist-h").textContent`)).toBe("출처");
});

test("a link inside a sentence stays a plain inline link", async () => {
	const inline = await page<string[]>(`[...document.querySelector(".bm .md p").querySelectorAll("a")].map(a => a.className + "|" + a.textContent + "|" + a.getAttribute("href"))`);
	expect(inline).toEqual(["|공식 문서|https://example.com/guide", "|https://example.org/a|https://example.org/a"]);
});

test("a last run of bare URLs needs two lines; a list with a heading also takes link titles and a bare domain", async () => {
	expect((await rowsOf(1)).map(r => r.href)).toEqual([URLS[1], URLS[2]]);
	expect(await page(`${lists}[1].querySelector(".mlist-h")`)).toBeNull();
	expect((await rowsOf(2)).map(r => [r.site, r.sub])).toEqual([["읽어 볼 글", "example.net · post"], ["example.net", null]]);
	const texts = await page<string[]>(`[...document.querySelectorAll(".bm")].slice(3, 5).map(b => [...b.querySelectorAll(".md a")].filter(a => !a.classList.contains("mlist-row")).length + (b.querySelector(".mlist-src") ? "rows" : ""))`);
	expect(texts).toEqual(["1", "2"]);
});

test("a 근거: heading over 이름: URL lines draws rows with the name first, the site and short path under it", async () => {
	const rows = await rowsOf(3);
	expect(rows.map(r => [r.letter, r.site, r.sub])).toEqual([
		["C", "한국예시협회법 제31조", "casenote.kr · …/한국예시협회법/제31조"],
		["C", "한국예시협회법 제32조(손실은 적립금으로 먼저 보전)", "casenote.kr · …/한국예시협회법/제32조"],
		["C", "한국예시협회법 제23조", "casenote.kr · …/한국예시협회법/제23조"],
	]);
	expect(rows.map(r => r.href)).toEqual([`${LAW}/제31조`, `${LAW}/제32조`, `${LAW}/제23조`]);
	expect(await page(`${lists}[3].querySelector(".mlist-h").textContent`)).toBe("근거");
});

test("list items may have no bullet and may be 이름 - URL, a markdown link or a bare URL in one list", async () => {
	expect((await rowsOf(4)).map(r => [r.site, r.href])).toEqual([["문서", "https://example.org/a"], ["글", "https://example.org/b"], ["책", "https://example.org/c"]]);
});

test("a 근거: list with an item that is no link stays a list, and named lines with no heading stay text", async () => {
	const out = await page<[boolean, number][]>(`[6, 8, 9].map(i => { const b = document.querySelectorAll(".bm")[i]; return [!!b.querySelector(".mlist-src"), b.querySelectorAll(".md a").length]; })`);
	expect(out).toEqual([[false, 1], [false, 2], [false, 2]]);
});

test("rows ask for nothing from the network and stay inside a phone screen", async () => {
	const out = await page<{ fetched: string[]; overflow: number }>(`({ fetched: performance.getEntriesByType("resource").map(e => e.name).filter(n => !n.startsWith(location.origin)), overflow: document.documentElement.scrollWidth - innerWidth })`);
	expect(out.fetched).toEqual([]);
	expect(out.overflow).toBeLessThanOrEqual(0);
	const boxes = await page<number>(`Math.max(...${lists}.flatMap(l => [...l.querySelectorAll("a.mlist-row")].map(a => a.getBoundingClientRect().right))) - innerWidth`);
	expect(boxes).toBeLessThan(0);
});

test("selecting the message copies the original URLs", async () => {
	const text = await page<string>(`(() => { const r = document.createRange(); r.selectNodeContents(${lists}[0]); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
	expect(text.split(/\s+/).filter(w => w.startsWith("https://"))).toEqual(URLS);
});

test("the words of a source row can be selected, and a click with text selected in the row does not open it", async () => {
	expect(await page<string[]>(`[".mlist-h", ".mlist-main", ".mlist-t", ".mlist-s"].map(q => { const c = getComputedStyle(${lists}[0].querySelector(q)); return c.userSelect || c.webkitUserSelect; })`)).not.toContain("none");
	const prevented = await page<boolean[]>(`(() => {
		const row = ${lists}[0].querySelector("a.mlist-row"), sel = getSelection(), out = [];
		sel.removeAllRanges();
		const probe = ev => { out.push(ev.defaultPrevented); ev.preventDefault(); };
		document.addEventListener("click", probe);
		row.click();
		sel.selectAllChildren(row.querySelector(".mlist-t"));
		row.click();
		sel.removeAllRanges();
		document.removeEventListener("click", probe);
		return out;
	})()`);
	expect(prevented).toEqual([false, true]);
});

test("a pressed row is no link, so a drag from its words selects them; a real click opens it only while nothing is selected", async () => {
	expect(await page<(string | null)[]>(`(() => {
		const row = ${lists}[0].querySelector("a.mlist-row"), words = row.querySelector(".mlist-t"), href = () => row.getAttribute("href"), press = (type, button = 0) => words.dispatchEvent(new MouseEvent(type, { bubbles: true, button }));
		press("mousedown", 2);
		const right = href();
		press("mouseup", 2);
		press("mousedown");
		document.querySelector("textarea, input")?.dispatchEvent(new FocusEvent("blur"));
		const pressed = href();
		press("mouseup");
		return [right, pressed, href()];
	})()`)).toEqual([URLS[0], null, URLS[0]]);
	await view.evaluate(`void (window.__probe = ev => { if (ev.target.closest?.(".mlist-src a.mlist-row")) { (window.__opened ??= []).push(!ev.defaultPrevented); ev.preventDefault(); } }, document.addEventListener("click", window.__probe))`);
	const word = ".mlist-src a.mlist-row .mlist-t";
	const { x, y } = await page<{ x: number; y: number }>(`(() => { const el = document.querySelector(${JSON.stringify(word)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; })()`);
	// view.click resolves when the input is sent, not when the page has handled it: each step waits for the page to see its click
	// before the next selection, or a slow page reads __opened before any click arrived
	const clicks = (n: number) => waitFor(`(window.__opened ?? []).length === ${n}`);
	await view.click(x, y);
	await clicks(1);
	const select = `getSelection().selectAllChildren(document.querySelector(${JSON.stringify(word)}))`;
	await view.evaluate(select);
	await view.click(x, y);
	await clicks(2);
	await view.evaluate(select);
	await view.click(x + 40, y + 20);
	await waitFor(`getSelection().isCollapsed`);
	await view.click(x, y);
	await clicks(4);
	const opened = await page<boolean[]>(`window.__opened`);
	await view.evaluate(`void (document.removeEventListener("click", window.__probe), getSelection().removeAllRanges())`);
	expect(opened).toEqual([true, false, false, true]);
});
