// Which gateway alerts reach the owner: an all-clear is quiet, the same alert again is a repeat (hub/alert-gate.ts).
import { beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { alertRepeatsFile, quietAlert, REPEAT_MS, repeatAlert } from "./alert-gate.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { alert } from "./outbound.ts";

beforeEach(() => rmSync(alertRepeatsFile(), { force: true }));

test("an all-clear line is quiet; a stop, a cost change, a warning and a question are not", () => {
	for (const t of [
		"땃쥐: 모델 제공자가 다시 연결됐어요. 멈춰 있던 일을 이어서 처리해요.",
		"땃쥐: API 키 사용 끝: 오케스트레이터가 anthropic/claude-opus-5-5(구독)으로 돌아왔어요.",
		"땃쥐: 원래 모델(claude-opus-5-5)로 되돌렸어요",
		"모델 복귀: anthropic/claude-sonnet-5 → anthropic/claude-opus-5-5 (한도가 풀렸어요)",
		"[kakao-new] 다시 정상이에요",
		"[kakao-new] recovered",
		"토큰 누수 점검 (10-22 04:30~10-23 04:30): 합계 9.1M 토큰 $4.10, 경고 0건",
	])
		expect(quietAlert(t)).toBe(true);
	for (const t of [
		"땃쥐: 사용량 한도에 걸려서 멈췄어요. 한도 리셋 직후인 10. 23. (금) 오전 01:01부터 다시 시도해요.",
		"땃쥐: API 키 사용 시작: 구독이 사용 한도에 걸려서 오케스트레이터가 anthropic/claude-sonnet-5로 답해요.",
		"토큰 누수 점검 (10-22 04:30~10-23 04:30): 합계 90.4M 토큰 $40.70, 경고 10건",
		"[kakao-new] 3번 연속 실패했어요",
		"[fail] [kakao-new] 다시 정상이에요",
		"[ask] 다시 정상이에요?",
	])
		expect(quietAlert(t)).toBe(false);
});

test("the same alert again, numbers aside, is a repeat for REPEAT_MS; an all-clear or the window ends it; a question never repeats", () => {
	const t0 = 1_000_000;
	expect(repeatAlert("땃쥐: 모델 제공자 오류(timeout after 30000ms)", t0)).toBe(false);
	expect(repeatAlert("땃쥐: 모델 제공자 오류(timeout after 45000ms)", t0 + 60_000)).toBe(true);
	expect(repeatAlert("디스크가 거의 찼어요", t0 + 60_000)).toBe(false);
	expect(repeatAlert("땃쥐: 모델 제공자 오류(timeout after 30000ms)", t0 + REPEAT_MS)).toBe(false);
	expect(repeatAlert("땃쥐: 모델 제공자 오류(timeout after 30000ms)", t0 + REPEAT_MS + 1)).toBe(true);
	expect(repeatAlert("땃쥐: 모델 제공자가 다시 연결됐어요.", t0 + REPEAT_MS + 2)).toBe(false);
	expect(repeatAlert("땃쥐: 모델 제공자 오류(timeout after 30000ms)", t0 + REPEAT_MS + 3)).toBe(false);
	expect(repeatAlert("[ask] 땃쥐: 모델 오류가 계속돼요. 어떻게 할까요?", t0)).toBe(false);
	expect(repeatAlert("[ask] 땃쥐: 모델 오류가 계속돼요. 어떻게 할까요?", t0 + 1)).toBe(false);
});

test("the record is on disk, so a restart does not tell the owner again", async () => {
	expect(repeatAlert("메모리가 부족해요 (9.1 GB)", 5)).toBe(false);
	const fresh: typeof import("./alert-gate.ts") = await import("./alert-gate.ts?restart");
	expect(fresh.repeatAlert("메모리가 부족해요 (9.4 GB)", 6)).toBe(true);
});

test("the gateway's alert marks its repeat on the event, so the bell, push and Discord can stay quiet", () => {
	const seen: HubEvent[] = [];
	onEmit(e => void (e.kind === "out" && e.target === "alert" && String(e.text).startsWith("게이트 시험") && seen.push(e)));
	alert("게이트 시험: 디스크 사용 91%");
	alert("게이트 시험: 디스크 사용 93%");
	expect(seen.map(e => e.repeat === true)).toEqual([false, true]);
});
