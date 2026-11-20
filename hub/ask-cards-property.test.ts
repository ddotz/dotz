import { expect, test } from "bun:test";
import { normalizeAsk } from "./ask-normalize.ts";
import { decisionsOf } from "./notices-decisions.ts";

const SUBJECTS = ["배포 시각", "알림 문구", "백업 위치", "테스트 범위", "\"따옴표\" 설정", "O'Brien 계정", "$PATH 값", "sample-2 채널", "웹 example.com 주소", "한 줄 요약"];
const ASKS = ["{s}은 어느 쪽으로 할까요?", "{s}는 어떤 방식으로 할까요?", "{s}를 어느 쪽으로 정할까요?", "Which {s} should I pick?"];
const LABELS = ["지금 바로", "내일 아침", "그대로 두기", "새로 만들기", "외장 디스크", "클라우드", "Keep it", "`dry-run` 먼저", "둘 다 끄기"];
const SHAPES = {
	head: (q: string, labels: string[]) => [`결정: ${q}`, ...labels.map((l, i) => `${i + 1}. ${l}`)],
	numbered: (q: string, labels: string[]) => [q, ...labels.map((l, i) => `${i + 1}. ${l}`)],
	bold: (q: string, labels: string[]) => [q, ...labels.map(l => `**${l}**: ${l}을 고르면 그렇게 돼요`)],
};

function rng(seed: number): (n: number) => number {
	let s = seed >>> 0;
	return n => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s % n;
	};
}
const pick = <T>(r: (n: number) => number, xs: readonly T[]): T => xs[r(xs.length)]!;

test("k questions, each with its own list, make k cards with the written options, in any of the three list shapes", () => {
	const r = rng(20261120);
	for (let run = 0; run < 240; run++) {
		const shape = pick(r, Object.keys(SHAPES) as (keyof typeof SHAPES)[]);
		const k = 1 + (run % 4);
		const subjects = [...SUBJECTS].sort(() => r(3) - 1).slice(0, k);
		const asked = subjects.map(s => {
			const pool = [...LABELS].sort(() => r(3) - 1);
			return { question: pick(r, ASKS).replace("{s}", s), labels: pool.slice(0, 2 + r(3)) };
		});
		const intro = pick(r, ["", "작업을 나눠서 정할 게 있어요.\n\n", "sample-2 정리가 끝났어요. 두세 가지만 정해 주시면 돼요.\n\n"]);
		const text = `[ask] ${intro}${asked.map(a => SHAPES[shape](a.question, a.labels).join("\n")).join("\n\n")}`;
		const cards = decisionsOf({ ts: "2026-11-20T00:00:00.000Z", kind: "lane_report", source: "lane:sample-2", lane: "sample-2", text: normalizeAsk(text) });
		const seen = cards.map(c => ({ question: c.title, labels: c.options.map(o => o.label) }));
		expect({ text, seen }).toEqual({ text, seen: asked });
	}
});

test("a question whose list no card can come from still gets its own card next to the card that came out", () => {
	const text = "[ask] 정할 게 두 가지예요.\n\n배포 시각은 어느 쪽으로 할까요?\n- 오늘 밤에 바로 올려요.\n- 내일 아침에 올려요.\n\n결정: 백업 위치는 어디로 할까요?\n**1) 외장 디스크**\n**2) 클라우드**";
	const cards = decisionsOf({ ts: "2026-11-20T00:00:00.000Z", kind: "lane_report", source: "lane:sample-2", lane: "sample-2", text: normalizeAsk(text) });
	expect(cards.map(c => [c.title, c.options.map(o => o.label)])).toEqual([
		["백업 위치는 어디로 할까요?", ["외장 디스크", "클라우드"]],
		["배포 시각은 어느 쪽으로 할까요?", []],
	]);
});

test("a list above a card that explains that card's own options is no second question", () => {
	const text = "[ask] 어느 쪽이 좋을까요?\n- 빠르게: 오늘 끝나요\n- 안전하게: 하루 더 걸려요\n\n결정: sample-2 배포 방식은 어느 쪽으로 할까요?\n**1) 빠르게**\n**2) 안전하게**";
	expect(normalizeAsk(text)).toBe(text);
	const cards = decisionsOf({ ts: "2026-11-20T00:00:00.000Z", kind: "lane_report", source: "lane:sample-2", lane: "sample-2", text: normalizeAsk(text) });
	expect(cards.map(c => c.title)).toEqual(["sample-2 배포 방식은 어느 쪽으로 할까요?"]);
});

test("a question with a list that offers no choice, above or beside the card, makes no second card", () => {
	const card = "결정: sample-2 배포 방식은 어느 쪽으로 할까요?\n**1) 빠르게 배포**\n**2) 안전하게 배포**";
	for (const text of [`[ask] 정리했어요.\n\n무엇이 바뀌나요?\n- 화면 제목\n- 푸시 문구\n\n${card}`, `[ask] 정리했어요.\n\n지금 상태는요?\n**테스트**: 30개 통과\n**배포**: 대기 중\n\n${card}`]) {
		const cards = decisionsOf({ ts: "2026-11-20T00:00:00.000Z", kind: "lane_report", source: "lane:sample-2", lane: "sample-2", text: normalizeAsk(text) });
		expect(cards.map(c => [c.title, c.options.map(o => o.label)])).toEqual([["sample-2 배포 방식은 어느 쪽으로 할까요?", ["빠르게 배포", "안전하게 배포"]]]);
	}
});

test("bold options keep their question, and a bold note under them is no option", () => {
	for (const tail of ["", "\n\n**참고**: 둘 다 롤백 돼요", "\n**추천**: 빠르게"])
		for (const desc of ["오늘 끝나요", "오늘 배포돼요"]) {
			const text = `[ask] 배포 방식은 어느 쪽으로 할까요?\n**빠르게**: ${desc}\n**안전하게**: 하루 더 걸려요${tail}`;
			const cards = decisionsOf({ ts: "2026-11-20T00:00:00.000Z", kind: "lane_report", source: "lane:sample-2", lane: "sample-2", text: normalizeAsk(text) });
			expect({ text, cards: cards.map(c => [c.title, c.options.map(o => o.label)]) }).toEqual({ text, cards: [["배포 방식은 어느 쪽으로 할까요?", ["빠르게", "안전하게"]]] });
		}
});
