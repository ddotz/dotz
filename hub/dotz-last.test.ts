import { describe, expect, test } from "bun:test";
import { answerForTerminal, lastAnswer } from "./dotz-last.ts";
import type { HubEvent } from "./events.ts";
import { specOfElements } from "./message-spec.ts";

const ev = (over: Partial<HubEvent>): HubEvent => ({ ts: "2026-01-01T00:00:00Z", kind: "out", source: "orchestrator", text: "답", ...over });

describe("dotz last", () => {
	test("plain text loses its control characters too", () => {
		expect(answerForTerminal("안녕\u001b]0;x\u0007하세요", false, () => null)).toBe("안녕]0;x하세요");
	});

	test("the newest answer of the assistant, not an owner message, a system line or an update", () => {
		const events = [ev({ text: "첫째" }), ev({ text: "둘째" }), ev({ kind: "message", source: "web", text: "질문" }), ev({ text: "갱신", update_key: "k" }), ev({ text: "시스템", system: true }), ev({ text: "  " })];
		expect(lastAnswer(events)).toBe("둘째");
		expect(lastAnswer([ev({ kind: "message", source: "web" })])).toBeUndefined();
	});
	test("a spec draws as terminal text, any other answer stays as it is, the tone emoji leads", () => {
		const spec = specOfElements([{ type: "Facts", props: { rows: [{ key: "상태", value: "정상" }] } }]);
		expect(answerForTerminal("[done] 표", false, () => spec)).toBe("✅ 상태  정상");
		expect(answerForTerminal("[fail] 그냥 글", false, () => null)).toBe("❌ 그냥 글");
		expect(answerForTerminal("[ask] 어느 쪽?", true, () => specOfElements([{ type: "Meta", props: { text: "3초" } }]))).toBe("❓ \u001b[2m3초\u001b[22m");
	});
});
