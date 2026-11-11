import { afterAll, expect, test } from "bun:test";
import { previewOf } from "./conversations.ts";
import { buildPayloads } from "./discord-format.ts";
import { clean } from "./notices-rules.ts";
import { fakeHub, json, on } from "./test-web.ts";

// A lane's worklog entry carries its claim as words in the stored text (laneops.ts claimPrefix). The 작업내역 conversation draws them as
// the app's status tag, whatever the entry's age; notices and previews drop them; Discord, which has no tags, keeps the word as subtext.
const ts = (n: number) => `2026-11-05T15:${String(10 + n).padStart(2, "0")}:00.000Z`;
const entry = (n: number, text: string) => ({ ts: ts(n), kind: "out", source: "orchestrator", target: "worklog", update_key: `lane:l${n}`, text });
const worklog = [
	entry(0, "확인됨 · ✅ 메신저 로그인 연결을 끝냈어요.\n- 온보딩도 같은 흐름이에요."),
	entry(1, "확인됨 · ✅ 메일함 앱 구현을 끝냈어요."),
	entry(2, "[done] 확인됨 · 자원 효율 2차를 끝냈어요."),
	entry(3, "verified · 영어로 남은 줄이에요."),
	entry(4, "보고됨 · 아직 보고만 한 일이에요."),
	entry(5, "[run] 확인됨 · 다시 도는 일이에요."),
	entry(6, "확인됨 · 확인됨 · 두 번 붙은 옛 줄이에요."),
	entry(7, "빌드는 확인됨 · 배포는 내일이에요."),
];
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/state") return json({ name: "땅콩", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "worklog" ? worklog : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);

test("작업내역 draws the claim as a status tag in the entry, never as body text", async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await view.evaluate(`(openTarget("worklog", "chat"), 0)`);
	await waitFor(`document.body.innerText.includes("배포는 내일이에요")`);
	const rows = JSON.parse(
		(await view.evaluate(`JSON.stringify([...document.querySelectorAll("#tl .wl-row")].map(b => {
			const tags = [...b.querySelectorAll(":scope > .rc-hd > .tag")];
			return { tags: tags.map(t => [t.textContent, t.classList.contains("ok"), t.getBoundingClientRect().height > 0]), body: b.querySelector(".fr-sum, .wl-q").textContent };
		}))`)) as string,
	) as { tags: [string, boolean, boolean][]; body: string }[];
	expect(rows.map(r => r.tags.map(t => t[0]))).toEqual([["완료", "확인됨"], ["완료", "확인됨"], ["완료", "확인됨"], ["확인됨"], ["보고만 함"], ["진행 중", "확인됨"], ["확인됨"], []]);
	// entries 2 and 3 sit under one header (.cont hides .mt), so the tag has to stay visible in the entry itself
	expect(rows[1]!.tags[1]).toEqual(["확인됨", true, true]);
	expect(rows[0]!.body.startsWith("메신저 로그인 연결을 끝냈어요")).toBe(true);
	expect(rows[2]!.body).toBe("자원 효율 2차를 끝냈어요");
	expect(rows[3]!.body).toBe("영어로 남은 줄이에요");
	expect(rows[4]!.body).toBe("아직 보고만 한 일이에요");
	expect(rows[5]!.body).toBe("다시 도는 일이에요");
	expect(rows[6]!.body).toBe("두 번 붙은 옛 줄이에요");
	expect(rows[7]!.body).toBe("빌드는 확인됨 · 배포는 내일이에요");
});

test("notices and previews drop the claim; Discord shows it as subtext", () => {
	for (const text of ["확인됨 · ✅ 메일함을 끝냈어요", "확인됨 · 확인됨 · ✅ 메일함을 끝냈어요", "[done] 보고됨 · ✅ 메일함을 끝냈어요", "verified · ✅ 메일함을 끝냈어요"]) {
		expect(clean(text).text).toBe("✅ 메일함을 끝냈어요");
		expect(previewOf(text)).toContain("메일함을 끝냈어요");
		expect(previewOf(text)).not.toMatch(/확인됨|보고됨|verified/);
	}
	expect(clean("[done] 확인됨 · 끝냈어요")).toEqual({ tone: "done", text: "끝냈어요" });
	expect(buildPayloads("[done] 확인됨 · 끝냈어요")[0]!.content).toBe("✅ 끝냈어요\n-# 확인됨");
	expect(buildPayloads("확인됨 · 확인됨 · ✅ 끝냈어요")[0]!.content).toBe("끝냈어요\n-# 확인됨");
	expect(buildPayloads("보고됨 · 끝냈어요")[0]!.content).toBe("끝냈어요\n-# 보고만 함");
	expect(buildPayloads("빌드는 확인됨 · 배포는 내일이에요")[0]!.content).toBe("빌드는 확인됨 · 배포는 내일이에요");
});
