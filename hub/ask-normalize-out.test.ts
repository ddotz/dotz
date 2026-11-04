// Options without the contract's block on the real send paths (outbound.out, lanereport.report -> events -> notices): each ends as an open
// decision with options, and carries Discord buttons, whoever wrote it. No model call and nothing leaves the test data folder.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { askComponentsFor } from "./askbuttons.ts";
import { ASK_A, ASK_B } from "./ask-normalize.fixture.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { dir, hooks, type Lane } from "./lanestate.ts";
import { report } from "./lanereport.ts";
import { ignoreNotice, listNotices } from "./notices.ts";
import { out } from "./outbound.ts";

const openFor = (to: string) => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.to === to);
const labels = (n: any) => n.decision.options.map((o: any) => o.label);
const buttons = (text: string) => (askComponentsFor("t", text) as { components: { label: string }[] }[]).flatMap(r => r.components.map(c => c.label));
const posted = (target: string) =>
	new Promise<HubEvent>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`nothing posted to ${target}`)), 5000);
		onEmit(e => {
			if (e.kind === "out" && e.target === target) {
				clearTimeout(timer);
				resolve(e);
			}
		});
	});
const CONV = "mail:ask-normalize-test";
const lane = { name: "ask-norm-test", reports: 0 } as unknown as Lane;
const reports: string[] = [];
const hook = hooks.report;
hooks.report = (_l, text) => void reports.push(text);
mkdirSync(dir(lane.name), { recursive: true });
afterAll(() => {
	hooks.report = hook;
	rmSync(dir(lane.name), { recursive: true, force: true });
	for (const n of openFor(CONV)) ignoreNotice((n as any).id);
});

test("(a) a final answer without a mark or block is a decision with buttons", async () => {
	const seen = posted(CONV);
	await out(CONV, ASK_A);
	const text = String((await seen).text);
	expect(text.startsWith("[ask] ")).toBe(true);
	const open = openFor(CONV);
	expect(open).toHaveLength(1);
	expect(labels(open[0])).toEqual(["그대로 반영", "알림 행만 조정하고 반영", "반영 보류"]);
	expect(buttons(text)).toEqual(["그대로 반영", "알림 행만 조정하고 반영", "반영 보류"]);
});

test("(b) a lane's marked report in the wrong format is stored and relayed as the block; a thin [ask] after it is dropped", () => {
	report(lane, ASK_B);
	expect(reports).toHaveLength(1);
	expect(reports[0]).toContain("결정: 2부를 main에 반영할까요?");
	expect(lane.pendingAsk?.text).toBe(reports[0]);
	expect(buttons(reports[0]!)).toEqual(["그대로 반영", "알림 행만 조정 후 반영", "보류"]);
	report(lane, "[ask] 형이 대조표를 보고 답하기 전에는 진행할 수 없어서 멈췄고, 계획에도 대기로 표시했어요.");
	expect(reports).toHaveLength(1);
	report(lane, "[ask] 하나 더요.\n\n결정: 알림도 같이 고칠까요?\n**1) 네**\n**2) 아니요**");
	expect(reports).toHaveLength(2);
	expect(lane.pendingAsk?.text).toBe(reports[1]);
});

test("a plain numbered report stays a plain message on the same path", async () => {
	const seen = posted(CONV);
	const text = "오늘 한 일이에요.\n\n1) 여백 값을 맞췄어요\n2) 대조표를 만들었어요";
	await out(CONV, text);
	expect((await seen).text).toBe(text);
});

test("a gateway notice is left as written", async () => {
	const seen = posted(CONV);
	const text = "어느 쪽으로 할까요?\n1) a\n2) b";
	await out(CONV, text, undefined, { source: "gateway" });
	expect((await seen).text).toBe(text);
});
