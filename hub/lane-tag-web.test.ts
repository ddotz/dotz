import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, on } from "./test-web.ts";

// A report's status tag says what the session does now, not what its stored mark said then (owner 2026-11-05: a finished session's five
// messages all said 진행 중). The stored text never changes; repeated [run] reports are one message, as on Discord.
const ts = (n: number) => `2026-11-05T01:${String(10 + n).padStart(2, "0")}:00.000Z`;
const report = (n: number, text: string, extra = {}) => ({ ts: ts(n), kind: "lane_report", lane: "audit", source: "lane:audit", text, ...extra });
const history = [
	report(0, "[run] 첫 보고"),
	report(1, "[run] 둘째 보고"),
	report(2, "[done] 끝난 보고"),
	{ ts: ts(3), kind: "message", source: "web", channel: "lane:audit", text: "이어서 해 줘" },
	report(4, "[run] 셋째 보고", { answering: true }),
	report(5, "[run] 넷째 보고"),
	report(6, "[wait] 다섯째 보고"),
];
let run: object = { kind: "working" };
const state = () => ({ name: "땅콩", orchestrator: { status: "idle" }, lanes: [{ name: "audit", status: "idle", title: "audit", cwd: "/tmp/audit", startedAt: ts(0) }], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, runs: { "lane:audit": run } });
const hub = fakeHub({
	state,
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "lane:audit" ? history : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
const rows = () => ev<[string, string][]>(view, `[...document.querySelectorAll("#tl .bm")].map(b => [b.querySelector(".md").innerText.replace(/\\s+/g, " ").trim(), b.querySelector(".st-tag")?.textContent ?? ""])`);
const repaint = async (next: object) => { run = next; await view.evaluate(`S.runs["lane:audit"] = ${JSON.stringify(next)}, paintRunState(), 0`); };

test("the newest report alone follows the session; older and superseded ones carry no live tag", async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await view.evaluate(`(openTarget("lane:audit", "chat"), 0)`);
	await waitFor(`[...document.querySelectorAll("#tl .bm")].length === 4`);
	const body = (await rows()).map(r => r[0].replace(/^(진행 중|완료|답을 기다려요)\s*/, ""));
	// 첫 is replaced by 둘째, 넷째 by 다섯째; a result, an owner message and an answer to the owner keep what stands before them.
	expect(body).toEqual(["둘째 보고", "끝난 보고", "셋째 보고", "다섯째 보고"]);
	expect((await rows()).map(r => r[1])).toEqual(["", "완료", "", "진행 중"]);
});

test("a session that finished, stopped or exited shows no 진행 중, and one waiting for the owner says so", async () => {
	for (const over of [{ kind: "done" }, { kind: "stopped" }, { kind: "idle" }, { kind: "error" }]) {
		await repaint(over);
		expect((await rows()).map(r => r[1])).toEqual(["", "완료", "", ""]);
	}
	await repaint({ kind: "waiting", reason: "standby" });
	expect((await rows()).map(r => r[1])).toEqual(["", "완료", "", "답을 기다려요"]);
	expect(await ev<string>(view, `document.querySelector("#runstate-tx").textContent`)).toBe("답을 기다려요");
	await repaint({ kind: "waiting", reason: "work", detail: "빌드" });
	expect((await rows()).at(-1)![1]).toBe("진행 중");
});
