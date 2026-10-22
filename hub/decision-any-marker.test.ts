import { describe, expect, test } from "bun:test";
import { DONE_REPLY } from "./decision-any-marker.fixture.ts";
import { decisionsOf } from "./notices.ts";

// A choice block ("결정:" + `**n) name**` options) makes a decision whatever status marker the message starts with, or none.
// Live failure (mac mini): a [done] chat answer ending in this block was shown as plain text.
const ev = (text: string, extra: Record<string, unknown> = {}) => ({ ts: "2050-06-01T00:00:00.000Z", kind: "out", source: "orchestrator", target: "web", text, ...extra });

describe("decisionsOf: any bot message with a choice block", () => {
	test("the exact [done] chat answer from the mac mini makes one decision with three options", () => {
		const ds = decisionsOf(ev(DONE_REPLY));
		expect(ds).toHaveLength(1);
		expect(ds[0]).toMatchObject({ title: "방문 예약", to: "main", group: 1 });
		expect(ds[0]!.options.map(o => [o.n, o.label, o.rec])).toEqual([
			[1, "압구정 본점 10/28(화) 15:00", true],
			[2, "청담 메종 10/31(금) 14:00", false],
			[3, "다른 날짜나 매장", false],
		]);
		expect(ds[0]!.options[0]!.desc).toBe("제일 빨리 가서 직접 물어볼 수 있어요");
	});

	test("every status marker, none at all, a session report and other channels give the same decision", () => {
		const block = DONE_REPLY.slice(DONE_REPLY.indexOf("결정:"));
		for (const head of ["[done] 보냈어요", "[run] 하는 중이에요", "[fail] 안 됐어요", "[ask] 어떻게 할까요?", "그냥 답이에요"]) {
			expect(decisionsOf(ev(`${head}\n\n${block}`)).map(d => d.title)).toEqual(["방문 예약"]);
		}
		expect(decisionsOf(ev(`[done] 끝\n\n${block}`, { target: "ch:5" }))[0]!.to).toBe("ch:5");
		const lane = { ts: "2050-06-01T00:00:00.000Z", kind: "lane_report", lane: "cartier", text: `[done] 끝\n\n${block}` };
		expect(decisionsOf(lane)).toHaveLength(1);
	});

	test("the multi-decision form gives one decision per block", () => {
		const text = "[done] 두 가지 정해 주세요\n\n결정: 장소\n**1) 압구정** ← 추천\n가까워요\n**2) 청담**\n커요\n\n결정: 시간\n**1) 오후 3시** ← 추천\n비어 있어요\n**2) 오후 4시**\n늦어요\n\n번호로 답해 주세요.";
		const ds = decisionsOf(ev(text));
		expect(ds.map(d => [d.title, d.group, d.options.length])).toEqual([["장소", 2, 2], ["시간", 2, 2]]);
	});

	test("a plain numbered list without 결정: stays text, and so do progress lines and worklog posts", () => {
		expect(decisionsOf(ev("[done] 설치 방법은 두 가지예요\n1) 브루로 설치\n2) 직접 빌드"))).toEqual([]);
		expect(decisionsOf(ev("[done] 두 가지예요\n**1) 가**\n설명\n**2) 나**\n설명"))).toEqual([]);
		expect(decisionsOf(ev("결정: 하나뿐\n**1) 가**\n설명"))).toEqual([]);
		const block = DONE_REPLY.slice(DONE_REPLY.indexOf("결정:"));
		expect(decisionsOf(ev(`[run] 진행\n${block}`, { update_key: "lane:a" }))).toEqual([]);
		expect(decisionsOf(ev(`[done] 기록\n${block}`, { target: "worklog" }))).toEqual([]);
		expect(decisionsOf(ev(`[done] 기록\n${block}`, { source: "web" }))).toEqual([]);
	});
});
