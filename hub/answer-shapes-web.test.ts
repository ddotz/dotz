import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// An assistant answer drawn by its written shape (web/js/02-answer-shapes.js), in a headless browser: each shape's trigger, the text it falls back to,
// the markdown a copied selection gives, and that an answer never turns from text into a card after it is on screen.
const ts = (n: number) => `2026-11-04T08:${String(10 + n).padStart(2, "0")}:00.000Z`;
const answer = (text: string, extra: object = {}) => ({ kind: "out", source: "orchestrator", target: "web", text, ...extra });
const LABELS = "- **원인:** 썸네일이 늦게 만들어졌어요.\n- **고친 것:** 원본을 줄여서 먼저 보여 줘요.";
const cases: Record<string, object> = {
	labels: answer(`앨범을 고쳤어요. 새로고침하면 돼요.\n\n${LABELS}\n\n내일 다시 볼게요.`),
	wordy: answer("- **원인:** 새로 올린 사진의 썸네일이 만들어지기 전에 목록을 먼저 불러와서 빈 칸으로 보였어요.\n- **확인:** 봤어요."),
	oneItem: answer("하나예요.\n\n- **원인:** 늦었어요."),
	nested: answer("- **원인:** 늦었어요.\n  - 세부 내용이에요.\n- **고친 것:** 줄였어요."),
	mixed: answer("- **원인:** 늦었어요.\n- 라벨 없는 줄이에요."),
	talk: answer("네, 그렇게 하면 돼요. 내일 다시 볼게요."),
	gateway: answer(LABELS, { source: "gateway" }),
	started: answer(`\u23f3 시작했어요.\n\n${LABELS}`),
	relay: answer(LABELS, { relay: true }),
	alreadyBold: answer(`**앨범을 고쳤어요. 새로고침**하면 돼요.\n\n${LABELS}`),
	version: answer(`v1.2 버전에서 고쳤어요. 끝이에요.\n\n${LABELS}`),
	files: answer("가계부를 정리했어요. 식비가 늘었어요.\n\n[file] /files/가계부.xlsx\n[file] /files/요약.pdf\n\n근거: 카드 212건 대조 · 빠진 건 없음"),
	picture: answer("사진이에요.\n\n[file] /files/앨범.png"),
	evidence: answer("고쳤어요. 끝이에요.\n\n근거: `a1b2c3d` · 테스트 24개 통과"),
	evidenceMid: answer("고쳤어요. 끝이에요.\n\n근거: 로그를 봤어요.\n\n내일 다시 볼게요."),
	bundle: answer("문의를 묶어 봤어요. 둘은 남았어요.\n\n**아직 남음**\n- **배송 늦음 (6회):** 주말 주문이 몰렸어요.\n\n**처리함**\n- **영수증 재발급 (4회):** 바로 받을 수 있어요.\n- **비밀번호 찾기:** 스팸함으로 갔어요.\n\n오늘 안에 볼게요."),
	loneTitle: answer("**아직 남음**\n- **배송 늦음:** 주말 주문이 몰렸어요."),
	titleOverText: answer("**아직 남음**\n- 라벨 없는 줄이에요.\n- 또 하나예요."),
	steps: answer("다시 연결하려면 이렇게 해 주세요.\n\n1. 전원을 꺼요.\n2) 버튼을 눌러요.\n3. 다시 찾아요."),
	oneStep: answer("1. 전원을 꺼요."),
	table: answer("두 요금제예요. 기본형이 나아요.\n\n| | 기본형 | 넉넉형 |\n|---|---|---|\n| 월 요금 | 19,000원 | 33,000원 |\n| 데이터 | 20GB | 무제한 |"),
	wideTable: answer("| a | b | c | d | e | f |\n|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 |"),
	noHeader: answer("| 월 요금 | 19,000원 |\n| 데이터 | 20GB |"),
	user: { kind: "in", source: "web", target: "web", text: LABELS },
	last: answer("끝이에요."),
};
const names = Object.keys(cases);
const events = names.map((n, i) => ({ ts: ts(i), ...cases[n] }));
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? events : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
const page = async <T>(expr: string) => (await view.evaluate(`JSON.stringify(${expr})`).then(s => JSON.parse(s as string))) as T;
const msg = (name: string) => `document.querySelector('[data-ts="${ts(names.indexOf(name))}"]')`;
const count = (name: string, sel: string) => page<number>(`${msg(name)}.querySelectorAll(${JSON.stringify(sel)}).length`);
const lead = (name: string) => page<string | null>(`${msg(name)}.querySelector(".ans-lead")?.textContent ?? null`);
const copied = (sel: string) => page<string>(`(() => { const s = getSelection(); s.selectAllChildren(${sel}); const t = s.toString(); s.removeAllRanges(); return t; })()`);
const lines = (t: string) => t.trim().split(/\n+/).map(l => l.trim());

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof openTarget === "function" && S`);
await view.evaluate(`(openTarget("main", "chat"), 0)`);
await waitFor(`${msg("last")} !== null`);

test("two or more label lines are key-column rows in one card, the closing paragraph stays text", async () => {
	expect(await count("labels", ".ans-card .rc-row")).toBe(2);
	expect(await count("labels", ".ans-card")).toBe(1);
	expect(await count("labels", "li")).toBe(0);
	expect(await page<string[]>(`[...${msg("labels")}.querySelectorAll(".rc-k")].map(e => e.textContent)`)).toEqual(["원인", "고친 것"]);
	expect(await page<string>(`${msg("labels")}.querySelector(".ans-card ~ p").textContent`)).toBe("내일 다시 볼게요.");
});

test("the first sentence is the one bold thing of a shaped answer", async () => {
	expect(await lead("labels")).toBe("앨범을 고쳤어요.");
	expect(await count("labels", ".ans-lead")).toBe(1);
	expect(await lead("version")).toBe("v1.2 버전에서 고쳤어요.");
});

test("a long value stacks the label over the value on a phone", async () => {
	const left = await page<number[]>(`[".rc-k", ".rc-w"].map(s => Math.round(${msg("wordy")}.querySelector(s).getBoundingClientRect().left))`);
	expect(left[0]).toBe(left[1]);
	expect(await page<boolean>(`document.documentElement.scrollWidth > innerWidth`)).toBe(false);
});

test("no card for a single item, a nested or a mixed list, or a conversation line", async () => {
	for (const n of ["oneItem", "nested", "mixed", "talk"]) {
		expect(await count(n, ".ans-card")).toBe(0);
		expect(await lead(n)).toBeNull();
	}
	expect(await count("oneItem", "li")).toBe(1);
	expect(await count("nested", "li")).toBe(3);
});

test("a mark open across the cut keeps the paragraph as written", async () => {
	expect(await lead("alreadyBold")).toBeNull();
	expect(await count("alreadyBold", ".ans-card")).toBe(1);
});

test("only a finished assistant answer gets shapes", async () => {
	for (const n of ["gateway", "started", "relay", "user"]) expect(await count(n, ".ans-card")).toBe(0);
});

test("a copied selection gives the lines as written", async () => {
	expect(lines(await copied(`${msg("labels")}.querySelector(".md")`))).toEqual(["앨범을 고쳤어요. 새로고침하면 돼요.", "- **원인:** 썸네일이 늦게 만들어졌어요.", "- **고친 것:** 원본을 줄여서 먼저 보여 줘요.", "내일 다시 볼게요."]);
});

test("[file] lines are rows in one card with the name first, the evidence line under them", async () => {
	expect(await count("files", ".ans-files .fitem")).toBe(2);
	expect(await page<string[]>(`[...${msg("files")}.querySelectorAll(".ans-files .fi-n")].map(e => e.textContent)`)).toEqual(["가계부.xlsx", "요약.pdf"]);
	expect(await page<string[]>(`[...${msg("files")}.querySelectorAll(":scope > *")].map(e => e.className.split(" ")[0]).slice(-2)`)).toEqual(["mfiles", "ans-ev"]);
	expect(await lead("files")).toBe("가계부를 정리했어요.");
});

test("a picture keeps its thumbnail", async () => {
	expect(await count("picture", ".ans-files")).toBe(0);
	expect(await count("picture", ".mfiles")).toBe(1);
});

test("a last 근거: line is small pieces and turns the lead on; with text after it, it stays a meta line", async () => {
	expect(await page<string[]>(`[...${msg("evidence")}.querySelectorAll(".ans-ev > span:not(.mlist-url)")].map(e => e.textContent)`)).toEqual(["a1b2c3d", "테스트 24개 통과"]);
	expect(await lead("evidence")).toBe("고쳤어요.");
	expect(await count("evidenceMid", ".ans-ev")).toBe(0);
	expect(await count("evidenceMid", "p.meta")).toBe(1);
	expect(await lead("evidenceMid")).toBeNull();
});

test("a copied selection gives the [file] and 근거: lines as written", async () => {
	expect(lines(await copied(msg("files"))).slice(-3)).toEqual(["[file] /files/가계부.xlsx", "[file] /files/요약.pdf", "근거: 카드 212건 대조 · 빠진 건 없음"]);
});

test("titles over label lists share one card, the count on the right", async () => {
	expect(await count("bundle", ".ans-card")).toBe(1);
	expect(await page<string[]>(`[...${msg("bundle")}.querySelectorAll(".ans-card .rc-sh")].map(e => e.querySelector(":scope > span:not(.mlist-url)").textContent)`)).toEqual(["아직 남음", "처리함"]);
	expect(await page<string[]>(`[...${msg("bundle")}.querySelectorAll(".ans-card .ans-li")].map(e => [e.querySelector(".rc-k").textContent, e.querySelector(".ans-n")?.textContent ?? ""].join("|"))`)).toEqual(["배송 늦음|6회", "영수증 재발급|4회", "비밀번호 찾기|"]);
	expect(await lead("bundle")).toBe("문의를 묶어 봤어요.");
});

test("a lone title with one item, or a title over a plain list, stays as written", async () => {
	expect(await count("loneTitle", ".ans-card")).toBe(0);
	expect(await page<string>(`${msg("loneTitle")}.querySelector("p b").textContent`)).toBe("아직 남음");
	expect(await count("titleOverText", ".ans-card")).toBe(0);
	expect(await count("titleOverText", "li")).toBe(2);
	expect(await count("titleOverText", "p b")).toBe(1);
});

test("a copied bundle gives its title and lines as written", async () => {
	expect(lines(await copied(`${msg("bundle")}.querySelector(".ans-card")`))).toEqual(["**아직 남음**", "- **배송 늦음 (6회):** 주말 주문이 몰렸어요.", "**처리함**", "- **영수증 재발급 (4회):** 바로 받을 수 있어요.", "- **비밀번호 찾기:** 스팸함으로 갔어요."]);
});

test("numbered lines are steps with their number in a small cell", async () => {
	expect(await count("steps", ".ans-steps .rc-row")).toBe(3);
	expect(await page<string[]>(`[...${msg("steps")}.querySelectorAll(".rc-k")].map(e => e.textContent)`)).toEqual(["1", "2", "3"]);
	expect(await count("steps", "ol")).toBe(0);
	expect(await count("oneStep", ".ans-card")).toBe(0);
	expect(await count("oneStep", "ol")).toBe(1);
});

test("a table of five columns or fewer wraps in a card, its first column a row label", async () => {
	expect(await count("table", ".ans-tb table")).toBe(1);
	expect(await count("table", "tbody th")).toBe(2);
	expect(await page<boolean>(`(t => t.scrollWidth <= t.clientWidth)(${msg("table")}.querySelector(".ans-tb"))`)).toBe(true);
});

test("a wider table or one with no header stays today's table", async () => {
	for (const n of ["wideTable", "noHeader"]) {
		expect(await count(n, ".ans-card")).toBe(0);
		expect(await count(n, ".tbl table")).toBe(1);
	}
});

test("copied steps and a copied table give the lines as written", async () => {
	expect(lines(await copied(`${msg("steps")}.querySelector(".ans-card")`))).toEqual(["1. 전원을 꺼요.", "2) 버튼을 눌러요.", "3. 다시 찾아요."]);
	expect(lines(await copied(`${msg("table")}.querySelector(".ans-card")`))).toEqual(["| | 기본형 | 넉넉형 |", "|---|---|---|", "| 월 요금 | 19,000원 | 33,000원 |", "| 데이터 | 20GB | 무제한 |"]);
});
