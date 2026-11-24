import { beforeEach, expect, test } from "bun:test";
import { cardBlock } from "./choices.ts";
import { emit } from "./events.ts";
import { resetNoticesForTest } from "./notices.ts";
import { openDecisionNotices } from "./notices-bell.ts";
import { say } from "./notices-read.ts";
import { items, reconcileStored } from "./notices-store.ts";
import { runState } from "./runstate.ts";

const card = (subject: string, question: string, evidence: string[]) =>
	cardBlock({ subject, question, evidence, options: [{ name: "네", result: "그렇게 해요" }, { name: "아니요", result: "그대로 둬요" }] });
const LEAD = "메인 점검: 정할 것이 2가지 있어요.";
const EVIDENCE = ["로그 폴더 12GB, 어제는 9GB였어요.", "가장 큰 파일: `logs/hub.log`"];
const TEXT = `[ask] ${LEAD}\n\n${card("디스크", "오래된 로그를 지울까요?", EVIDENCE)}\n\n${card("토큰", "바꿀까요?", [])}`;
const post = () => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: TEXT });

beforeEach(resetNoticesForTest);

test("a card's notice carries its evidence lines, its text is those lines then the lead with no 결정: line, and the page gets both in the same words", () => {
	post();
	const stored = items.filter(n => n.kind === "decision");
	expect(stored.map(n => [n.title, n.decision!.evidence, n.text])).toEqual([
		["디스크 · 오래된 로그를 지울까요?", EVIDENCE, `${EVIDENCE.join("\n")}\n\n${LEAD}`],
		["토큰 · 바꿀까요?", undefined, LEAD],
	]);
	expect(say(EVIDENCE[1]!)).not.toBe(EVIDENCE[1]);
	const shown = openDecisionNotices().find(n => n.title === stored[0]!.title);
	expect(shown!.decision!.evidence).toEqual(EVIDENCE.map(say));
	expect(shown!.text.startsWith(`${EVIDENCE.map(say).join("\n")}\n\n`)).toBe(true);
	expect(runState({ status: "idle", ask: { text: stored[0]!.text, at: stored[0]!.at! }, now: Date.now() }).detail).not.toContain("결정:");
});

test("a redraw on start sets each card's evidence from its message again, and takes it off a card that has none", () => {
	post();
	const [disk, token] = items.filter(n => n.kind === "decision");
	disk!.decision!.evidence = ["지난 판의 줄"];
	token!.decision!.evidence = ["남은 줄"];
	reconcileStored();
	expect(disk!.decision!.evidence).toEqual(EVIDENCE);
	expect(token!.decision).not.toHaveProperty("evidence");
});
