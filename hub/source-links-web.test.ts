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
const ts = (n: number) => `2026-11-04T08:${String(10 + n).padStart(2, "0")}:00.000Z`;
const answer = (n: number, text: string) => ({ ts: ts(n), kind: "out", source: "orchestrator", target: "web", text });
const events = [
	answer(0, `${SENTENCE}\n\n출처:\n\n${URLS.join("\n")}`),
	answer(1, `결과예요.\n${URLS[1]}\n${URLS[2]}`),
	answer(2, "참고:\n- [읽어 볼 글](https://www.example.net/post?id=1)\n- https://example.net"),
	answer(3, `한 줄만 있어요.\n${URLS[1]}`),
	answer(4, `${URLS[1]}\n${URLS[2]}\n이어지는 말이에요.`),
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
await waitFor(`${lists}.length === 3`);

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
	expect((await rowsOf(2)).map(r => [r.site, r.sub])).toEqual([["example.net", "읽어 볼 글"], ["example.net", null]]);
	const texts = await page<string[]>(`[...document.querySelectorAll(".bm")].slice(3).map(b => [...b.querySelectorAll(".md a")].filter(a => !a.classList.contains("mlist-row")).length + (b.querySelector(".mlist-src") ? "rows" : ""))`);
	expect(texts).toEqual(["1", "2"]);
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
	expect(text.split(/\s+/).filter(Boolean)).toEqual(URLS);
});
