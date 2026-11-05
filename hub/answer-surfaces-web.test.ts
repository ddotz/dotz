import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, json, on } from "./test-web.ts";

// One format reads the same on every surface: a model's text reaches the screen through answerNode (web/js/02-answer-shapes.js), never through a second
// parser. Each format is rendered on each surface with the page's real functions and compared with the main chat; a raw mark left on a surface fails, and so
// does a new caller of mdNode, which is how a surface bypasses the shared path.
const JS = join(import.meta.dir, "..", "web", "js");
// Who may draw text without shapes, and how many calls each holds: the owner's own words, a document, a model's thinking, a raw original, a question line, another computer's text.
const PLAIN_MD = { "15-attachments.js": 2, "17-state-refresh.js": 1, "01-peer-msg.js": 2, "11-resultcard.js": 1, "12-terminal-view.js": 1, "10-decision-card.js": 5, "11-todo-strip.js": 3, "02-answer-shapes.js": 1 };

test("mdNode and mdHtml have no new caller: a model's text goes through answerNode", () => {
	const calls: Record<string, number> = {};
	for (const file of readdirSync(JS)) {
		if (file === "02-basic-markdown.js") continue;
		const n = (readFileSync(join(JS, file), "utf8").match(/\bmd(?:Node|Html)\(/g) ?? []).length;
		if (n) calls[file] = n;
	}
	expect(calls).toEqual(PLAIN_MD);
});

const FORMATS: Record<string, [string, string]> = {
	labels: ["앨범을 고쳤어요. 끝이에요.\n\n- **원인:** 늦었어요.\n- **고친 것:** 줄였어요.", ".ans-keys"],
	times: ["오늘 일정이에요.\n\n- 09:30 치과\n- 13:00 점심", ".rc-rows"],
	bundle: ["묶어 봤어요.\n\n**남음**\n- **배송:** 늦어요.\n\n**처리함**\n- **환불:** 끝났어요.", ".ans-secs"],
	table: ["두 개예요.\n\n| | 기본 | 넉넉 |\n|---|---|---|\n| 요금 | 1 | 2 |", ".ans-tb"],
	steps: ["이렇게 해요.\n\n1. 꺼요.\n2. 켜요.", ".ans-steps"],
	evidence: ["고쳤어요.\n\n근거: 테스트 24개 통과", ".ans-ev"],
	files: ["정리했어요.\n\n[file] /files/요약.pdf", ".ans-files"],
	list: ["찾았어요.\n\n```목록\n운영 | 김 | 10:42\n가족 | 엄마\n```", ".mlist"],
};
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
await view.navigate(`${hub.origin}/`);
await waitFor(`typeof msgNode === "function" && S`);

const ts = "2026-11-05T01:00:00.000Z";
const notice = (text: string, kind = "worklog") => `({ id: "n1", kind: ${JSON.stringify(kind)}, title: "작업 기록", tone: "", text: ${JSON.stringify(text)}, src: "worklog", open: "worklog", at: "${ts}", ts: "${ts}", updated: "${ts}" })`;
const out = (text: string, extra = "") => `{ ts: "${ts}", kind: "out", source: "orchestrator", target: "web", text: ${JSON.stringify(text)}${extra} }`;
// Each surface as the page draws it: an expression that gives the node, or the nodes, of one message.
const SURFACES: Record<string, (text: string) => string> = {
	"main chat": text => `msgNode(${out(text)})`,
	"project chat": text => `msgNode(${out(text).replace('"web"', '"ch:123"')})`,
	"session answer": text => `msgNode(${out(text).replace('"web"', '"lane:a"').replace('"orchestrator"', '"lane:a"')})`,
	"session report": text => `msgNode({ ts: "${ts}", kind: "lane_report", source: "lane:a", lane: "a", text: ${JSON.stringify(text)} })`,
	"report with a decision": text => `msgNode(${out(`[ask] ${text}\n\n결정: 넣을까요?\n**1) 넣기**\n오늘 나가요.\n**2) 미루기**\n내일 나가요.`)})`,
	"notice sheet": text => `el("div", {}, ...ntBody(${notice(text)}))`,
	"monitoring card": text => `monNoticeNode(${notice(text, "watch")})`,
	"monitoring decision": text => `monDecisionNode({ ...${notice(`${text}\n\n결정: 넣을까요?\n**1) 넣기**\n오늘 나가요.\n**2) 미루기**\n내일 나가요.`, "decision")}, title: "넣을까요?", decision: { state: "open", to: "main", options: [{ n: 1, label: "넣기" }, { n: 2, label: "미루기" }] } })`,
};
const drawn = (expr: string, sel: string) => ev<number>(view, `(() => { const box = document.createElement("div"); document.body.append(box); box.append(...[${expr}].flat().filter(Boolean)); const n = box.querySelectorAll(${JSON.stringify(sel)}).length; box.remove(); return n; })()`);

for (const [surface, draw] of Object.entries(SURFACES)) {
	for (const [format, [text, sel]] of Object.entries(FORMATS)) {
		if (surface === "report with a decision" && format === "files") continue;
		test(`${format} on ${surface} is the shared shape`, async () => {
			expect(await drawn(draw(text), sel)).toBeGreaterThan(0);
		});
	}
}

test("a title above the body keeps the one bold thing", async () => {
	expect(await drawn(SURFACES["main chat"]!(FORMATS.labels![0]), ".ans-lead")).toBe(1);
	for (const s of ["notice sheet", "monitoring card", "monitoring decision"]) expect(await drawn(SURFACES[s]!(FORMATS.labels![0]), ".ans-lead")).toBe(0);
});

const shown = (expr: string) => ev<string>(view, `(() => { const box = document.createElement("div"); document.body.append(box); box.append(...[${expr}].flat().filter(Boolean)); const t = box.innerText; box.remove(); return t; })()`);
const RAW = /\*\*|`|\[(?:done|run|ask|file)\]|(?:^|\n)\s*(?:-#\s|결정\s*:|>\s)|\|\s*-{2,}/;

test("a progress note draws its marks and carries no line of a full message", async () => {
	const note = "[run] `hub/routes.ts`를 고치는 중이에요.\n- **남은 것:** `web/js/app.js`\n[file] /files/요약.pdf\n-# 작은 줄\n> 인용";
	const text = await shown(`msgNode({ ts: "${ts}", kind: "out", source: "lane:a", target: "lane:a", update_key: "n1", text: ${JSON.stringify(note)} })`);
	expect(text).not.toMatch(RAW);
	expect(await drawn(`msgNode({ ts: "${ts}", kind: "out", source: "lane:a", target: "lane:a", update_key: "n1", text: ${JSON.stringify(note)} })`, ".lv code")).toBe(2);
});

test("a progress note that asks is a full message with its card", async () => {
	const ask = "[ask] 정해 주세요.\n\n결정: 넣을까요?\n**1) 넣기**\n오늘 나가요.\n**2) 미루기**\n내일 나가요.";
	expect(await drawn(`msgNode({ ts: "${ts}", kind: "out", source: "lane:a", target: "lane:a", update_key: "n1", text: ${JSON.stringify(ask)} })`, ".lv")).toBe(0);
});

test("a one-line row or a preview is plain words", async () => {
	const text = "[done] 고쳤어요.\n\n-# 지난 주 기준이에요\n결정: 넣을까요?\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[file] /files/요약.pdf";
	expect(await shown(`nscRow(${notice(text)}, "all")`)).not.toMatch(RAW);
	expect(await shown(`msgNode({ ts: "${ts}", kind: "result", title: "세션", open: "lane:a", text: ${JSON.stringify(text)} })`)).not.toMatch(RAW);
	expect(await ev<string>(view, `convPreview(${JSON.stringify(text)})`)).not.toMatch(RAW);
});

test("a decision outside a chat card reads as a sentence, without its label", async () => {
	const text = "[ask] 앞 문단이에요.\n\n결정: 넣을까요?\n**1) 넣기**\n오늘 나가요.\n**2) 미루기**\n내일 나가요.";
	expect(await shown(`msgNode({ ts: "${ts}", kind: "out", source: "orchestrator", target: "worklog", text: ${JSON.stringify(text)} })`)).not.toMatch(RAW);
	expect(await shown(SURFACES["monitoring decision"]!("앞 문단이에요."))).not.toMatch(RAW);
	expect(await ev<string>(view, `choiceBody(${JSON.stringify(text)}, "넣을까요?")`)).toBe("[ask] 앞 문단이에요.");
});
