import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPayloads, buildSingle } from "./discord-format.ts";
import { dropForLine } from "./forline.ts";
import { classify } from "./push.ts";
import { parseTone, previewSource, stripMarkers } from "./tone.ts";

// Machine markers ([run] [done] [lane recovery] [dotz inbox] ...) are data for parsers, never text for the owner (owner 2026-10-23).
// One table drives the hub formatter (tone.ts) and the web copy (web/js/02-basic-markdown.js) so the two cannot drift.
const TABLE: [string, string][] = [
	["[done] 끝났어요", "끝났어요"],
	["[run]   시작했어요", "시작했어요"],
	["[blocked] 권한이 필요해요", "권한이 필요해요"],
	["[partial] 절반만 했어요", "절반만 했어요"],
	["[done] [lane recovery] 다시 시작했어요", "다시 시작했어요"],
	["[lane exited] 프로세스가 종료됐어요", "프로세스가 종료됐어요"],
	["[lane error] overloaded", "overloaded"],
	["[dotz inbox] web from local\n안녕", "web from local\n안녕"],
	["[dotz gateway] 연결 확인입니다", "연결 확인입니다"],
	["[orchestrator-guard] Open worker state", "Open worker state"],
	["[지금 도는 것]\n- a", "\n- a"],
	["[system] 알림", "알림"],
	["[attachment] a.png /tmp/a.png", "a.png /tmp/a.png"],
	["[attachment] 이미지1: a.png /tmp/a.png", "이미지1: a.png /tmp/a.png"],
	["[이미지1] 여기가 깨졌어요", "[이미지1] 여기가 깨졌어요"],
	["[ok | 12ms] 결과", "결과"],
	["[owner via web] 안녕", "안녕"],
	["**[blocked]** 막혔어요", "막혔어요"],
	["- [fail] 실패했어요", "- ❌ 실패했어요"],
	["**[fail]** 막혔어요", "❌ 막혔어요"],
	["요약 줄\n[fail] 둘째 줄", "요약 줄\n❌ 둘째 줄"],
	["끝났어요. [fail]", "끝났어요. ❌"],
	["**세션 a**: [fail] 멈췄어요", "**세션 a**: ❌ 멈췄어요"],
	["- [fail]: 설명", "- ❌ 설명"],
	["요약\n[fail] 원인은:", "요약\n❌ 원인은:"],
	["#56은 `[fail]` 알림이 갈 수 있어요.", "#56은 실패 알림이 갈 수 있어요."],
	["줄 중간 [done], [fail] 언급", "줄 중간 완료, 실패 언급"],
	["**세션 a**: [done] 끝", "**세션 a**: 끝"],
	["첫 줄\n[later]\n마지막", "첫 줄\n\n마지막"],
	["[file] /tmp/a.png\n본문", "본문"],
	// content stays
	["[1] 각주 하나", "[1] 각주 하나"],
	["[x] 할 일", "[x] 할 일"],
	["[링크](https://a.b) 보세요", "[링크](https://a.b) 보세요"],
	["결과는 [done] 입니다", "결과는 완료 입니다"],
	["`[fail]` 표시를 고쳤어요.", "`[fail]` 표시를 고쳤어요."],
	["파일은 [done].ts 예요", "파일은 [done].ts 예요"],
	["결과([fail])에서 멈췄어요", "결과(실패)에서 멈췄어요"],
	["줄 중간 [fail],다음", "줄 중간 실패,다음"],
	["그 턴은 `[fail]`로 끝나요.", "그 턴은 `[fail]`로 끝나요."],
	["Re: [Fwd] 제목", "Re: [Fwd] 제목"],
	["[Re: 안녕하세요] 제목", "[Re: 안녕하세요] 제목"],
	["```\n[done] 코드 안\n[file] x\n```", "```\n[done] 코드 안\n[file] x\n```"],
	["const a = [1, 2];", "const a = [1, 2];"],
	["`[later]` 이동이 끝나요.", "이동이 끝나요."],
	["이동이 끝나요. `[later]`", "이동이 끝나요."],
	["이동이 끝나요. [later]", "이동이 끝나요."],
	["그 턴은 `[later]`로 끝나요.", "그 턴은 `[later]`로 끝나요."],
	["`[later]` 표시를 고쳤어요.", "`[later]` 표시를 고쳤어요."],
	["- `[later]`: 미루는 표식", "- `[later]`: 미루는 표식"],
	["[gateway check] [done] 안 됐어요", "안 됐어요"],
	["[web:alert] 멈췄어요", "멈췄어요"],
	["진행 중: [ask] 옮겨요", "진행 중: 옮겨요"],
];

// The hub keeps these lines in stripMarkers for the orchestrator's raw read; its owner surfaces run dropForLine, the page does both in one.
const FOR_LINES: [string, string][] = [
	["옮겼어요.\n**For 땃쥐:** 재시작", "옮겼어요."],
	["옮겼어요.\n\n-# For 땃쥐: 재시작", "옮겼어요."],
	["옮겼어요.\n- 땃쥐 몫: 없음", "옮겼어요."],
];

// The web file is a classic script: take the strip + parseTone source (TONE_TAGS up to the api section) and run it.
function webFns(): { stripMarkers: (s: string) => string; parseTone: (s: string) => { tone: string; text: string } } {
	const src = readFileSync(join(import.meta.dir, "..", "web", "js", "02-basic-markdown.js"), "utf8");
	const from = src.indexOf("const TONE_TAGS");
	const to = src.indexOf("/* ---------- api ----------");
	return new Function(`const botName = "dotz", escRe = s => s; ${src.slice(from, to)}; return { stripMarkers, parseTone };`)();
}

describe("owner-facing text has no [tag]", () => {
	const web = webFns();
	test("hub stripMarkers: input -> shown text", () => {
		for (const [input, shown] of TABLE) expect([input, stripMarkers(input)]).toEqual([input, shown]);
	});
	test("a For <bot> line goes on the hub and the page alike", () => {
		for (const [input, shown] of FOR_LINES) {
			expect([input, dropForLine(input)]).toEqual([input, shown]);
			expect([input, web.stripMarkers(input).trimEnd()]).toEqual([input, shown]);
		}
	});
	test("web stripMarkers gives the same text as the hub", () => {
		for (const [input, shown] of TABLE) expect([input, web.stripMarkers(input)]).toEqual([input, shown.replace(/❌ /g, "실패: ").replace(/❌/g, "실패")]);
	});
	test("web: a failure marker the tone did not read still draws the failure tag", () => {
		expect(web.parseTone("**[fail]** 막혔어요")).toMatchObject({ tone: "fail", text: "막혔어요" });
		expect(web.parseTone("[fail] **[fail]** 막혔어요")).toMatchObject({ tone: "fail", text: "막혔어요" });
		expect(web.parseTone("[done] [fail] 막혔어요")).toMatchObject({ tone: "done", text: "실패: 막혔어요" });
		expect(parseTone("[done] [fail] 막혔어요")).toEqual({ tone: "done", text: "❌ 막혔어요" });
	});
	test("parseTone keeps the status as data and shows no tag", () => {
		const cases: [string, string | undefined, string][] = [
			["[done] 끝", "done", "끝"],
			["[완료] 끝", "done", "끝"],
			["[ask] 고르세요\n[lane error] x", "ask", "고르세요\nx"],
			["[fail] [dotz gateway] 멈췄어요", "fail", "멈췄어요"],
			["[fail] **[fail]** 막혔어요", "fail", "막혔어요"],
			["[fail]\n[fail] 세부", "fail", "세부"],
			["[blocked] 막힘", undefined, "막힘"],
			["그냥 글", undefined, "그냥 글"],
		];
		for (const [input, tone, text] of cases) {
			const h = parseTone(input), w = web.parseTone(input);
			expect([h.tone, h.text]).toEqual([tone, text]);
			expect([w.tone || undefined, w.text]).toEqual([tone, text]);
		}
	});
	// A bubble takes its file chips from the parsed text (fileLines in 15-attachments.js), so the chat asks parseTone to keep [file] lines;
	// every other caller (previews, lists) still gets them dropped.
	test("web parseTone keeps [file] lines only when asked, for the attachment chips", () => {
		expect(web.parseTone("[ask] 시안\n[file] /a/b.png", true).text).toBe("시안\n[file] /a/b.png");
		expect(web.parseTone("[ask] 시안\n[file] /a/b.png").text).toBe("시안");
	});
});

describe("Discord posts and push text have no [tag]", () => {
	const shown = (t: string) => buildPayloads(t).map(b => b.content).join("\n");
	test("outbound formatter: status becomes the leading emoji, other markers vanish", () => {
		expect(shown("[done] 끝났어요")).toBe("✅ 끝났어요");
		expect(shown("[run] [lane recovery] 다시 시작")).toBe("⏳ 다시 시작");
		expect(shown("[blocked] 권한이 필요해요")).toBe("권한이 필요해요");
		expect(shown("[lane exited] 프로세스가 종료됐어요")).toBe("프로세스가 종료됐어요");
		expect(shown("[dotz inbox] 새 메일")).toBe("새 메일");
		expect(shown("[later]")).toBe("");
		expect(shown("**세션 a**: [done] 끝")).toBe("**세션 a**: 끝");
		expect(shown("[1] 각주")).toBe("[1] 각주");
		expect(shown("**[fail]** 막혔어요")).toBe("❌ 막혔어요");
		expect(shown("[fail] ❌ 빌드")).toBe("❌ 빌드");
		expect(buildSingle("요약 줄\n[fail] 둘째 줄").content).toBe("요약 줄\n❌ 둘째 줄");
		expect(buildSingle("[ask] 고를까요?").content).toBe("❓ 고를까요?");
		expect(buildSingle("[partial] 일부만").content).toBe("일부만");
	});
	test("web push body", () => {
		const m = classify({ ts: "2026-10-23T00:00:00.000Z", kind: "lane_report", lane: "a", text: "[done] [lane recovery] 끝냈어요 [1]" });
		expect(m?.body).toBe("끝냈어요 [1]");
		expect(m?.title).toMatch(/^(?!a · ).+ · 완료$/);
		const p = classify({ ts: "2026-10-23T00:00:00.000Z", kind: "out", source: "gateway", target: "alert", text: "[fail] [dotz gateway] 한도가 찼어요" });
		expect(p?.body).toBe("한도가 찼어요");
	});
	test("a lone [later] still previews as the background line", () => {
		expect(previewSource("[later]")).toBe("백그라운드 작업 중");
	});
});
