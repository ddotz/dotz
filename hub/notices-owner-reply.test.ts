import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { emit } from "./events.ts";
import { resetNoticesForTest, type Notice } from "./notices.ts";

const ts = () => new Date().toISOString();
const stored = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));
const ask = () => emit("outbox", { ts: ts(), kind: "out", source: "orchestrator", target: "web", text: "[ask] 보고서를 언제 보낼까요?\n결정: 보고서를 언제 보낼까요?\n**1) 오늘**\n**2) 내일**" });
const owner = (text: string) => emit("inbox", { ts: ts(), kind: "message", source: "web", channel: "web", text });
const state = () => stored().find(n => n.kind === "decision")!.decision!;

beforeEach(resetNoticesForTest);

test("an unrelated message leaves a decision with options open", () => {
	ask();
	owner("그건 그렇고 날씨 어때?");
	expect(state().state).toBe("open");
});

test("an answer by number, numbered label or label text closes it", () => {
	for (const text of ["2", "2)", "2번", "2) 내일", "내일", "내일, 부탁해요"]) {
		resetNoticesForTest();
		ask();
		owner(text);
		expect({ text, state: state().state }).toEqual({ text, state: "answered" });
	}
});

test("plain words pointing at an option's number close it", () => {
	for (const text of ["1번으로 해", "1로 하자", "2번", "ㄱㄱ 1로", "2) 그걸로 해요", "2번 부탁해요", "1이요"]) {
		resetNoticesForTest();
		ask();
		owner(text);
		expect({ text, state: state().state }).toEqual({ text, state: "answered" });
	}
});

test("another subject, even one holding a number that matches an option, leaves it open", () => {
	for (const text of ["그건 그렇고 날씨 어때?", "맥북도 재시작했어요.", "1시에 재시작했어요", "2분 뒤에 다시 해줘", "1 시간 뒤에 봐요", "2026-11-10에 보내요", "1.5배로 해줘"]) {
		resetNoticesForTest();
		ask();
		owner(text);
		expect({ text, state: state().state }).toEqual({ text, state: "open" });
	}
});

test("a number that is no option, or a label inside another sentence, leaves it open", () => {
	ask();
	owner("7");
	owner("내일 날씨 어때?");
	expect(state().state).toBe("open");
});
