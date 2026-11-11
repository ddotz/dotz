import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// Golden: the chat, 작업내역 (worklog) and 알림 (alert) conversations, drawn in a headless browser from fixtures full of
// machine markers, show no leading `[tag]` on any line. Nothing is sent.
const ts = (n: number) => `2026-10-23T08:${String(10 + n).padStart(2, "0")}:00.000Z`;
const chat = [
	{ ts: ts(0), kind: "message", source: "web", channel: "web", text: "상태 알려줘" },
	{ ts: ts(1), kind: "out", source: "orchestrator", target: "web", text: "[blocked] 권한이 필요해요\n[lane recovery] 세션을 다시 켰어요\n각주는 [1]로 남겨요" },
	{ ts: ts(2), kind: "out", source: "orchestrator", target: "web", text: "[done] [dotz inbox] 메일을 정리했어요" },
	{ ts: ts(3), kind: "lane_report", lane: "a", source: "lane:a", text: "[partial] 절반 끝\n- [run] 나머지 진행 중" },
];
const worklog = [
	{ ts: ts(4), kind: "out", source: "orchestrator", target: "worklog", update_key: "lane:a", text: "[run] [지금 도는 것] a 세션 시작" },
	{ ts: ts(5), kind: "out", source: "orchestrator", target: "worklog", update_key: "lane:b", text: "[lane exited] b 세션이 끝났어요" },
];
const alerts = [{ ts: ts(6), kind: "out", source: "gateway", target: "alert", text: "[fail] [dotz gateway] 사용량 한도가 찼어요" }];
const histories: Record<string, unknown[]> = { main: chat, worklog, alert: alerts };
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/state") return json({ name: "땅콩", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: histories[url.searchParams.get("target") ?? ""] ?? [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
const LEADING_TAG = /(^|\n)[ \t]*(?:[-*][ \t]+)?\[(?:run|done|ask|fail|warn|blocked|partial|later|file|attachment|system|lane [^\]\n]+|dotz[^\]\n]*|owner via [^\]\n]+|지금 도는 것|orchestrator-guard)\]/i;

describe("rendered web conversations show no [tag]", () => {
	for (const [target, marker] of [["main", "권한이 필요해요"], ["worklog", "b 세션이 끝났어요"], ["alert", "사용량 한도가 찼어요"]] as const) {
		test(`${target}: bubbles hold the text without leading tags`, async () => {
			await view.navigate(`${hub.origin}/`);
			await waitFor(`typeof openTarget === "function" && S`);
			await view.evaluate(`(openTarget(${JSON.stringify(target)}, "chat"), 0)`);
			await waitFor(`document.body.innerText.includes(${JSON.stringify(marker)})`);
			const shown = await view.evaluate(`[...document.querySelectorAll(".bm")].map(b => b.innerText).join("\\n")`);
			expect(shown).toContain(marker);
			expect(LEADING_TAG.test(shown)).toBe(false);
			if (target === "main") expect(shown).toContain("각주는 [1]로 남겨요");
		});
	}
});
