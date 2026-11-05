import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, on } from "./test-web.ts";

// A session's mid-turn progress note (hub/lanewire.ts: update_key, no live flag), new or stored, is drawn in the shape of the
// gateway's live status (.lv under the speaker line), never a one-line row with the time on the left.
const ts = (n: number) => `2026-11-05T01:${String(10 + n).padStart(2, "0")}:00.000Z`;
const note = (t: string, n: number, text: string, extra: object = {}) => ({ ts: ts(n), kind: "out", source: t, target: t, update_key: "progress", text, ...extra });
const history: Record<string, object[]> = {
	"lane:stx": [note("lane:stx", 0, "[run] 판례를 대조하고 있어요.\n지금: 판례와 기준서 원문을 함께 대조해서 평가액을 다시 확인하는 중이에요 아주 긴 문장이 이어져도 한 줄로 잘려요\n- 환율 확인")],
	"lane:old": [note("lane:old", 1, "진행 중: 재시작 전에 남은 메모예요")],
	"lane:gone": [note("lane:gone", 1, "[run] 세션이 끝나기 전 메모예요")],
};
const running = { kind: "working", since: ts(0) };
const lanes = ["stx", "old", "gone"].map(name => ({ name, status: "working", title: name, cwd: `/tmp/${name}`, startedAt: ts(0) }));
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "땅콩", orchestrator: { status: "idle" }, lanes, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, runs: { "lane:stx": running, "lane:old": running } }),
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: history[url.searchParams.get("target") ?? ""] ?? [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
type Seen = { old: number; notes: number; who: string; time: boolean; tag: string; lead: string; wide: boolean };
const seen = () => ev<Seen>(view, `(() => {
	const bm = document.querySelector("#tl .bm:has(> .lv)"), lv = bm.querySelector(".lv");
	return { old: document.querySelectorAll("#tl .pn").length, notes: document.querySelectorAll("#tl .lv").length, who: bm.querySelector(":scope > .mt .mn")?.textContent ?? "",
		time: /\\d:\\d/.test(lv.textContent), tag: lv.querySelector(".st-tag")?.textContent ?? "", lead: lv.querySelector("p").textContent, wide: lv.getBoundingClientRect().right > innerWidth };
})()`);
const open = async (t: string) => {
	await view.evaluate(`(openTarget(${JSON.stringify(t)}, "chat"), 0)`);
	await waitFor(`!!document.querySelector("#tl .lv") && target === ${JSON.stringify(t)}`);
};

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof openTarget === "function" && S`);
await hub.streamConnected();

test("a stored note draws as the live status, under the speaker line, and a tap opens the cut row", async () => {
	await open("lane:stx");
	expect(await seen()).toEqual({ old: 0, notes: 1, who: "stx", time: false, tag: "진행 중", lead: "진행 중판례를 대조하고 있어요.", wide: false });
	const nowrap = `getComputedStyle(document.querySelector("#tl .lv .lv-r")).whiteSpace`;
	expect(await ev(view, nowrap)).toBe("nowrap");
	await view.evaluate(`(document.querySelector("#tl .lv").click(), 0)`);
	expect(await ev(view, nowrap)).toBe("normal");
});

test("a note stored in the old wording loses the prefix and gets the same shape", async () => {
	await open("lane:old");
	expect(await seen()).toEqual({ old: 0, notes: 1, who: "old", time: false, tag: "진행 중", lead: "진행 중재시작 전에 남은 메모예요", wide: false });
});

test("a live note replaces the last one, and the answer that drops it keeps its own head", async () => {
	await open("lane:stx");
	hub.push(note("lane:stx", 2, "[run] 다음 단계로 넘어갔어요"));
	await waitFor(`document.querySelector("#tl .lv p")?.textContent.includes("다음 단계")`);
	expect((await seen()).notes).toBe(1);
	hub.push({ ts: ts(3), kind: "out", source: "lane:stx", target: "lane:stx", text: "끝났어요" });
	await waitFor(`!document.querySelector("#tl .lv")`);
	expect(await ev(view, `getComputedStyle(document.querySelector("#tl .bm:last-of-type > .mt")).display`)).not.toBe("none");
});

test("a stored note of a session that is gone or no longer moving says nothing is running", async () => {
	await open("lane:old");
	await view.evaluate(`(S.runs["lane:old"] = { kind: "idle" }, paintRunState(), 0)`);
	expect((await seen()).tag).toBe("");
	await open("lane:gone");
	await view.evaluate(`(paintRunState(), 0)`);
	expect((await seen()).tag).toBe("");
});
