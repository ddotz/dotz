import { beforeEach, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { brokenCount, ownerText } from "./owner-text.ts";

// An [ask] the orchestrator writes in the shapes the model really uses: bold and numbered "결정:" headings, context under the heading, options as list
// items with a bold name. Each "결정:" block is one decision with its own title and exactly its written options.
const ts = () => new Date().toISOString();
const send = (text: string) => emit("outbox", { ts: ts(), kind: "out", source: "orchestrator", target: "web", text });
const cards = () => listNotices().items.filter(n => n.decision);
const shape = (n: ReturnType<typeof cards>[number]) => [n.title, n.decision!.options.map(o => [o.label, o.desc])];

beforeEach(resetNoticesForTest);

const TWO_WITH_QUOTE = [
	"[ask] 오늘 정할 것 둘만 추렸어요.",
	"",
	"**1) 결정: 남은 옛 기록을 지원팀에 지워 달라고 할까요?**",
	"맥락 한 줄이에요.",
	"- **1) 제가 요청 내기**: 양식에 아래 글을 내요.",
	"- **2) 직접 내기**: 아래 글을 붙여 넣으면 돼요.",
	"- **3) 그대로 두기**: 지금 상태로 남아요.",
	"",
	"> 받는이: Support Team",
	"> 제목: Please remove a cached item",
	">",
	"> Body line one.",
	"",
	"**2) 결정: 다른 작업은 여기서 닫을까요?**",
	"맥락 한 줄이에요.",
	"- **1) 여기서 닫기**: 닫고 끝내요.",
	"- **2) 다시 재기**: 한 번 더 재요.",
	"- **3) 미루기**: 2주 뒤에 봐요.",
	"",
	"번호로 답해 주세요(예: 1-1, 2-1).",
].join("\n");

test("two numbered bold 결정 blocks with a quote between them are two decisions, each with its own title and options, and no send card", () => {
	const before = brokenCount();
	send(TWO_WITH_QUOTE);
	const got = cards();
	expect(got.map(shape).sort()).toEqual(
		[
			["남은 옛 기록을 지원팀에 지워 달라고 할까요?", [["제가 요청 내기", "양식에 아래 글을 내요."], ["직접 내기", "아래 글을 붙여 넣으면 돼요."], ["그대로 두기", "지금 상태로 남아요."]]],
			["다른 작업은 여기서 닫을까요?", [["여기서 닫기", "닫고 끝내요."], ["다시 재기", "한 번 더 재요."], ["미루기", "2주 뒤에 봐요."]]],
		].sort(),
	);
	expect(got.every(n => n.decision!.group === 2 && !n.decision!.draft)).toBe(true);
	expect(brokenCount()).toBe(before);
});

test("a bold 결정 heading with context and bold-named list options is one decision with the three written options", () => {
	const before = brokenCount();
	send(
		[
			"[ask] 요청을 냈어요. 알아 둘 것이 둘 있어요.",
			"- 첫째 항목이에요.",
			"- 둘째 항목이에요.",
			"",
			"**결정: 이 일은 여기서 닫을까요?**",
			"맥락 한 줄이에요.",
			"- **1) 여기서 닫기**: 어색한 초안이 보이면 사례를 주세요.",
			"- **2) 판정 받기** 카드로 다시 요청해요.",
			"- **3) 다시 재기**: 2주 뒤에 한 번 더 재요.",
		].join("\n"),
	);
	expect(cards().map(shape)).toEqual([
		["이 일은 여기서 닫을까요?", [["여기서 닫기", "어색한 초안이 보이면 사례를 주세요."], ["판정 받기", "카드로 다시 요청해요."], ["다시 재기", "2주 뒤에 한 번 더 재요."]]],
	]);
	expect(brokenCount()).toBe(before);
});

test("a real send approval (quoted draft with a recipient line, then exactly 보내기 / 고치기 / 보내지 않기) still gives its draft card", () => {
	send(
		[
			"[ask] 초안이에요.",
			"> 받는이: person@example.com",
			"> 제목: 안부",
			">",
			"> 안녕하세요, 잘 지내시죠?",
			"",
			"결정: 이 초안을 보낼까요? (job-1)",
			"**1) 보내기**",
			"그대로 보내요",
			"**2) 고치기 …**",
			"무엇을 고칠지 알려 주세요",
			"**3) 보내지 않기**",
			"보내지 않아요",
		].join("\n"),
	);
	const got = cards();
	expect(got.length).toBe(1);
	expect(got[0]!.decision!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
	expect(got[0]!.decision!.draft?.to).toBe("person@example.com");
});

test("a mail-looking quote inside a decision with other options stays as written", () => {
	const text = ["[ask] 참고용 글이에요.", "", "결정: 이 글을 쓸까요?", "**1) 쓰기**", "바로 써요", "**2) 접기**", "접어 둬요", "", "> 받는이: Support Team", "> 제목: Hello", ">", "> 본문: 안녕하세요", "> 첨부: a.pdf (1KB)"].join("\n");
	const out = ownerText(text);
	expect(out.split("\n").filter(l => l.startsWith(">"))).toEqual(text.split("\n").filter(l => l.startsWith(">")));
});

test("a numbered report above a yes / no question is not a list of options: the question keeps its two assumed answers", () => {
	send(["[ask] 정리했어요.", "1) 첫째를 고쳤어요", "2) 둘째를 고쳤어요", "", "이대로 합칠까요?"].join("\n"));
	const got = cards();
	expect(got.length).toBe(1);
	expect(got[0]!.decision!.options.length).toBe(2);
	expect(got[0]!.decision!.assumed).toBe(true);
});

test("a 결정 block whose numbered options cannot be read keeps its text, is counted as broken, and gets no invented 네 / 아니요", () => {
	const before = brokenCount();
	const text = ["[ask] 확인이 필요해요.", "", "결정: 이 일은 여기서 닫을까요?", "- **1) 읽을 수 있어요**: 설명이에요.", "- **2)**: 이름이 없어요."].join("\n");
	send(text);
	expect(brokenCount()).toBe(before + 1);
	const got = cards();
	expect(got.length).toBe(1);
	expect(got[0]!.decision!.options).toEqual([]);
	expect(ownerText(text).split("\n").slice(-2)).toEqual(text.split("\n").slice(-2));
});
