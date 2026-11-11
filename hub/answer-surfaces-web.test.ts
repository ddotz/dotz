import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, json, on } from "./test-web.ts";

// One format reads the same on every surface: a model's text reaches the screen through answerNode (web/js/02-answer-shapes.js), never through a second
// parser. Each format is rendered on each surface with the page's real functions and compared with the main chat; a raw mark left on a surface fails, and so
// does a new caller of mdNode, which is how a surface bypasses the shared path.
const JS = join(import.meta.dir, "..", "web", "js");
// Who may draw text without shapes, and how many calls each holds: the owner's own words, a document, a model's thinking, a raw original, a question line.
const PLAIN_MD = { "15-attachments.js": 2, "17-state-refresh.js": 1, "11-resultcard.js": 1, "12-terminal-view.js": 1, "10-decision-card.js": 5, "11-todo-strip.js": 3, "02-answer-shapes.js": 1 };

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
	"bold over code": ["고쳤어요.\n\n**`hub/a.ts` 고침:** 끝났어요.", "b"],
	rule: ["앞 문단이에요.\n\n---\n\n뒤 문단이에요.", "hr"],
	numbers: ["정리했어요.\n\n- 전체 파일: 42개\n- 남은 일: 3건", ".ans-keys"],
	changes: ["빨라졌어요.\n\n- 승인 목록: 5,308ms → 36ms\n- 채팅: 263ms → 154ms", ".ans-keys .nw-chg s"],
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
	"peer message": text => { const e = `{ ts: "${ts}", kind: "message", via: "맥미니", target: "web", text: ${JSON.stringify(text)} }`; return `peerMsgCard(${e}, peerMsgOf(${e}), "12:00")`; },
	"monitoring decision": text => `monDecisionNode({ ...${notice(`${text}\n\n결정: 넣을까요?\n**1) 넣기**\n오늘 나가요.\n**2) 미루기**\n내일 나가요.`, "decision")}, title: "넣을까요?", decision: { state: "open", to: "main", options: [{ n: 1, label: "넣기" }, { n: 2, label: "미루기" }] } })`,
};
const shown = (expr: string) => ev<string>(view, `(() => { const box = document.createElement("div"); document.body.append(box); box.append(...[${expr}].flat().filter(Boolean)); const t = box.innerText; box.remove(); return t; })()`);
const drawn = (expr: string, sel: string) => ev<number>(view, `(() => { const box = document.createElement("div"); document.body.append(box); box.append(...[${expr}].flat().filter(Boolean)); const n = box.querySelectorAll(${JSON.stringify(sel)}).length; box.remove(); return n; })()`);

for (const [surface, draw] of Object.entries(SURFACES)) {
	for (const [format, [text, sel]] of Object.entries(FORMATS)) {
		if ((surface === "report with a decision" || surface === "peer message") && format === "files") continue;   // a peer's file lives on that computer: no chip
		test(`${format} on ${surface} is the shared shape`, async () => {
			expect(await drawn(draw(text), sel)).toBeGreaterThan(0);
		});
	}
}

// The words of the gateway around a sentence, as stored: each is drawn on each surface. The sentence stays, the word never shows, a code span or not.
const CONTROL: Record<string, string> = {
	"[later] opening in code": "`[later]` 이동이 끝나면 등록할게요.\n\n[later]",
	"[later] closing in code": "이동이 끝나면 등록할게요.\n\n`[later]`",
	"[later] after the sentence": "이동이 끝나면 등록할게요. [later]",
	"[later] bare, leading": "[later] 이동이 끝나면 등록할게요.",
	"[keepalive]": "`[keepalive]` 이동이 끝나면 등록할게요.",
	"[done] in code": "`[done]` 이동이 끝나면 등록할게요.",
	"[ask] closing": "이동이 끝나면 등록할게요. `[ask]`",
	"a lone dash": "이동이 끝나면 등록할게요.\n\n-",
	"[gateway check]": "[gateway check] [done] 이동이 끝나면 등록할게요.",
	"[dotz gateway] line": "[dotz gateway] 이동이 끝나면 등록할게요.",
	"[orchestrator-guard] line": "[orchestrator-guard] 이동이 끝나면 등록할게요.",
	"For the bot": "이동이 끝나면 등록할게요.\n\nFor 땃쥐: 재시작",
	"project info": "이동이 끝나면 등록할게요.\n<project-info>{\"name\":\"a\"}</project-info>",
};
const LEAK = /\[(?:later|keepalive|done|ask|run|fail|gateway check|dotz gateway|orchestrator-guard|file)\]|For 땃쥐|project-info|(?:^|\n)\s*-\s*$/;
for (const [surface, draw] of Object.entries(SURFACES)) {
	for (const [word, text] of Object.entries(CONTROL)) {
		test(`${word} on ${surface} shows only the sentence`, async () => {
			const seen = await shown(draw(text));
			expect(seen).toContain("이동이 끝나면 등록할게요");
			expect(seen).not.toMatch(LEAK);
		});
	}
}

test("a sentence with a colon stays a list, and words around an arrow are not a change", async () => {
	const prose = "정리했어요.\n\n- 앱 알림: 설정에 종류마다 줄 하나예요.\n- 답글: 초안을 쓰고 기다려요.";
	expect(await drawn(SURFACES["main chat"]!(prose), ".ans-keys")).toBe(0);
	const flow = "정리했어요.\n\n- 앱 알림: 설정 → 앱 · 알림\n- 답글: 초안 필요 → 확인 대기";
	expect(await drawn(SURFACES["main chat"]!(flow), ".nw-chg")).toBe(0);
});

// Owner 2026-11-11: a sentence that only holds "28 → 173px" was drawn with everything before the arrow struck through.
test("a sentence that holds an arrow is a plain row, and a short before → after is still a change", async () => {
	const sentence = "- **메일**: 폰에서 \"전체\" 큰 제목 줄을 없애 첫 메일이 78px쯤 올라왔어요. 폰에서 같은 스레드 목록이 화면 밖으로 넘치던 것, 좁은 창에서 제목이 잘리던 것(28 → 173px)도 같이 고쳤어요.";
	expect(await drawn(SURFACES["main chat"]!(`고쳤어요.\n\n${sentence}\n- **상태:** 정상`), "s")).toBe(0);
	expect(await drawn(SURFACES["main chat"]!(`고쳤어요.\n\n${sentence}\n- **상태:** 정상`), ".ans-keys .rc-row")).toBe(2);
	expect(await shown(SURFACES["main chat"]!(`고쳤어요.\n\n${sentence}\n- **상태:** 정상`))).toContain("(28 → 173px)도 같이 고쳤어요.");
	const changes = "빨라졌어요.\n\n- 응답 시간: 445.8 → 52.4ms\n- 통과: 7461 → 7498\n- 버전: 261110.1 → 261111.1";
	expect(await drawn(SURFACES["main chat"]!(changes), ".nw-chg s")).toBe(3);
});

test("an id in brackets goes and a channel tag never shows raw on any surface", async () => {
	const text = "알림 워커(st_01a1a07f)가 <#1500000000005984746>에 올렸어요.";
	for (const [surface, draw] of Object.entries(SURFACES)) {
		const seen = await shown(draw(text));
		expect(`${surface}: ${seen}`).toContain("알림 워커가");
		expect(`${surface}: ${seen}`).not.toMatch(/st_|<#|<>|ch:|\d{10}/);
	}
	expect(await drawn(SURFACES["main chat"]!(text), 'a[href="#chat/ch:1500000000005984746"]')).toBe(1);
});

test("a bare worker id reads as a word with its particle and a code word stays whole on every surface", async () => {
	const text = "끊겼던 st_01a1ab97을 st_01a1a6f2, st_01a1a6f3 패치로 확인했어요. task_send로 이어 가요.";
	for (const [surface, draw] of Object.entries(SURFACES)) {
		const seen = await shown(draw(text));
		expect(`${surface}: ${seen}`).toContain("끊겼던 워커를 워커 2개 패치로 확인했어요. task_send로 이어 가요.");
		expect(`${surface}: ${seen}`).not.toMatch(/st_/);
	}
});

test("a bare channel id in a chat line links to the channel, a quoted command keeps it", async () => {
	const line = "대기 중: conversation session ch:1500000000005984746, 명령 DOTZ_APPROVAL_CONV=ch:1500000000005984747 끝";
	expect(await drawn(SURFACES["main chat"]!(line), 'a[href="#chat/ch:1500000000005984746"]')).toBe(1);
	expect(await shown(SURFACES["main chat"]!(line))).toContain("DOTZ_APPROVAL_CONV=ch:1500000000005984747");
});

test("a code span that talks about a control word is kept on every surface", async () => {
	const text = "그 턴은 `[later]`로 끝나고 `[done]`은 이모지로 나가요.";
	for (const [surface, draw] of Object.entries(SURFACES)) {
		const box = await shown(draw(text));
		expect(`${surface}: ${box.includes("[later]") && box.includes("[done]")}`).toBe(`${surface}: true`);
	}
});

test("a preview and an activity row read a control word the same", async () => {
	for (const text of Object.values(CONTROL)) {
		expect(await ev<string>(view, `convPreview(${JSON.stringify(text)})`)).not.toMatch(LEAK);
		expect(await ev<string>(view, `friendlyLine(${JSON.stringify(text)})`)).not.toMatch(LEAK);
	}
	expect(await ev<boolean>(view, `isLaterText("\`[later]\`")`)).toBe(true);
});

test("a title above the body keeps the one bold thing", async () => {
	expect(await drawn(SURFACES["main chat"]!(FORMATS.labels![0]), ".ans-lead")).toBe(1);
	for (const s of ["notice sheet", "monitoring card", "monitoring decision"]) expect(await drawn(SURFACES[s]!(FORMATS.labels![0]), ".ans-lead")).toBe(0);
});

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
	expect(await shown(`el("div", { text: monSummary(${notice(text)}, []) })`)).not.toMatch(RAW);
	expect(await ev<string>(view, `friendlyLine(${JSON.stringify(text)})`)).not.toMatch(RAW);
});

test("a choice block on a surface that holds no options never shows, a numbered list with no head stays", async () => {
	const text = "앞 문단이에요.\n\n결정: 넣을까요?\n**1) 넣기**\n오늘 나가요.\n**2) 미루기**\n내일 나가요.";
	for (const expr of [SURFACES["monitoring card"]!(text), SURFACES["peer message"]!(text), `monLogRow(${notice(text)}, [])`, `el("div", { text: monSummary(${notice(text)}, []) })`]) {
		const seen = await shown(expr);
		expect(seen).toContain("앞 문단이에요");
		expect(seen).not.toMatch(RAW);
		expect(seen).not.toContain("넣기");
	}
	expect(await shown(SURFACES["monitoring card"]!("순서예요.\n\n1) 꺼요.\n2) 켜요."))).toContain("켜요");
});

test("a decision outside a chat card reads as a sentence, without its label", async () => {
	const text = "[ask] 앞 문단이에요.\n\n결정: 넣을까요?\n**1) 넣기**\n오늘 나가요.\n**2) 미루기**\n내일 나가요.";
	expect(await shown(`msgNode({ ts: "${ts}", kind: "out", source: "orchestrator", target: "worklog", text: ${JSON.stringify(text)} })`)).not.toMatch(RAW);
	expect(await shown(SURFACES["monitoring decision"]!("앞 문단이에요."))).not.toMatch(RAW);
	expect(await ev<string>(view, `choiceBody(${JSON.stringify(text)}, "넣을까요?")`)).toBe("[ask] 앞 문단이에요.");
});

const LIST = "- **기준:** 짧은 글\n- **쓰는 법:** 한마디";
const stored = (text: string, extra = "") => `msgNode({ ts: "${ts}", kind: "out", source: "orchestrator", target: "web", text: ${JSON.stringify(text)}${extra} })`;
// hub/notices-signals.ts stores a result's first three lines with the blank lines gone, so a list follows its sentence directly.
const result = (text: string) => `msgNode({ ts: "${ts}", kind: "result", source: "gateway", target: "web", title: "세션", verified: true, open: "lane:a", text: ${JSON.stringify(text)} })`;

test("a start notice is drawn as an answer, in either way it is written", async () => {
	expect(await drawn(stored(`\u23f3 세션을 시작했어요.\n\n${LIST}`), ".ans-keys")).toBe(1);
	expect(await drawn(stored(`[run] 세션을 시작했어요.\n\n${LIST}`), ".ans-keys")).toBe(1);
});

test("a line that gets replaced stays text: a progress line and a session's own [run]", async () => {
	expect(await drawn(stored(`\u23f3 고치는 중이에요.\n\n${LIST}`, ', update_key: "progress"'), ".ans-card")).toBe(0);
	expect(await drawn(SURFACES["session report"]!(`[run] 고치는 중이에요.\n\n${LIST}`), ".ans-card")).toBe(0);
	expect(await drawn(SURFACES["session answer"]!(`[run] 고치는 중이에요.\n\n${LIST}`), ".ans-card")).toBe(0);
});

test("a gateway result draws its list inside its one card, under the one bold title", async () => {
	const row = result(`끝났어요.\n${LIST}`);
	expect(await drawn(row, ".ccard")).toBe(1);
	expect(await drawn(row, ".ccard .ans-keys .rc-row")).toBe(2);
	expect(await drawn(row, ".ccard .ans-lead")).toBe(0);
	expect(await shown(row)).toContain("세션 끝났어요");
	expect(await shown(result("머지 커밋은 `0aec048e`예요."))).toContain("0aec048e");
});

test("a result cut under a heading drops the heading with nothing below it", async () => {
	const seen = await shown(result("끝났어요.\n판정은 맞았어요.\n**고친 것**"));
	expect(seen).toContain("판정은 맞았어요.");
	expect(seen).not.toContain("고친 것");
});

test("a worklog line edited in place is an answer, a gateway line there is not", async () => {
	const worklog = (source: string) => `msgNode({ ts: "${ts}", kind: "out", source: "${source}", target: "worklog", update_key: "lane:a", text: ${JSON.stringify(`확인됨 · 끝났어요.\n\n${LIST}`)} })`;
	expect(await drawn(worklog("orchestrator"), ".ans-keys")).toBe(1);
	expect(await drawn(worklog("gateway"), ".ans-card")).toBe(0);
});
