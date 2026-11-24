import { beforeEach, expect, test } from "bun:test";
import { cardBlock } from "./choices.ts";
import { doctorKo } from "./doctor-text.ts";
import { lineSubject } from "./doctor-types.ts";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { openDecisionNotices } from "./notices-bell.ts";
import { readable, say } from "./notices-read.ts";
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

const FROM = "- 게이트웨이는 launchctl kickstart 전에 `git push` 하고 ~/Code/dotz/hub/main.ts 를 확인해요.";
const TO = "- 게이트웨이는 launchctl kickstart 전에 `git push` 하지 말고 ~/Code/dotz/hub/main.ts 를 확인해요.";
const EDIT_EV = ["낡은 줄 · RULES.md 7번째 줄", `전: ${FROM}`, `후: ${TO}`];
const WATCH_EV = ["멈춘 곳: ~/Code/sample-shop/hub/watch.ts 에서 3번 실패했어요"];
const EDIT_SUBJECT = lineSubject(doctorKo, "/Users/runner/.dotz/RULES.md", FROM, "고칠까요?");
const gatewayCard = (id: string, subject: string, question: string, evidence: string[], meta?: Record<string, unknown>) =>
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target: "alert", wk: "doctor", text: `[ask] 아침 점검이에요.\n\n${card(subject, question, evidence)}`, card_ids: [id], ...(meta ? { card_meta: { [id]: meta } } : {}) });

test("a card that proposes an instruction edit reaches the owner with the file's own words, title quote included; a monitor card's path is still said plainly", () => {
	gatewayCard("prompt:review:a1b2c3", EDIT_SUBJECT, "고칠까요?", EDIT_EV, { edit: { file: "/Users/runner/.dotz/RULES.md", line: 7, from: FROM, to: TO } });
	gatewayCard("prompt:enforced:d4e5f6", EDIT_SUBJECT, "지울까요?", [`지울 줄: ${FROM}`]);
	gatewayCard("watches:sample-shop", "샘플 상점 모니터", "다시 볼까요?", WATCH_EV);
	const listed = listNotices(300).items, of = (id: string) => listed.find(n => n.decision?.card_id === id)!;
	const review = of("prompt:review:a1b2c3"), enforced = of("prompt:enforced:d4e5f6"), watch = of("watches:sample-shop");
	expect(review.decision!.evidence).toEqual(EDIT_EV);
	expect(review.text.startsWith(`${EDIT_EV.join("\n")}\n\n`)).toBe(true);
	expect(enforced.decision!.evidence).toEqual([`지울 줄: ${FROM}`]);
	expect(review.title).toBe(`${EDIT_SUBJECT} · 고칠까요?`);
	expect(review.title).toContain("'게이트웨이는 launchctl");
	expect([...review.title].length).toBeLessThanOrEqual(40);
	const stored = items.find(n => n.decision?.card_id === "prompt:review:a1b2c3")!;
	expect(readable(stored).decision!.evidence).toEqual(EDIT_EV);
	expect(readable(stored).title).toBe(stored.title);
	expect(say(WATCH_EV[0]!)).not.toBe(WATCH_EV[0]);
	expect(watch.decision!.evidence).toEqual(WATCH_EV.map(say));
});
