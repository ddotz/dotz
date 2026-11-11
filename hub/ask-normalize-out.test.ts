// Options without the contract's block on the real send paths (outbound.out, lanereport.report -> events -> notices): each ends as an open
// decision with options, and carries Discord buttons, whoever wrote it. No model call and nothing leaves the test data folder.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { askComponentsFor } from "./askbuttons.ts";
import { ASK_A, ASK_B } from "./ask-normalize.fixture.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { dir, hooks, type Lane } from "./lanestate.ts";
import { report } from "./lanereport.ts";
import { normalizeAsk } from "./ask-normalize.ts";
import { cardRef } from "./approval-queue.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { ignoreNotice, listNotices, onDraftCardRefreshed, syncDraftFiles } from "./notices.ts";
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

test("a bold heading over a numbered question and indented options is a card; the recommendation and the rest stay as the message", async () => {
	for (const n of openFor(CONV)) ignoreNotice((n as any).id);
	const seen = posted(CONV);
	await out(CONV, "둘 다 멈췄어요.\n\n**결정 필요**\n1. 남은 화면을 어떤 모델로 이어갈까요?\n   - (a) 한도가 풀릴 때까지 기다리기.\n   - (b) 워커만 다른 모델로 돌리기. 오늘 밤 안에 끝낼 수 있어요.\n   - 추천: 오늘 끝내려면 (b)예요.\n\n지금 상태는 이래요.");
	const text = String((await seen).text);
	const open = openFor(CONV);
	expect(open).toHaveLength(1);
	expect((open[0] as any).title).toBe("남은 화면을 어떤 모델로 이어갈까요?");
	expect(labels(open[0])).toEqual(["한도가 풀릴 때까지 기다리기.", "워커만 다른 모델로 돌리기. 오늘 밤 안에 끝낼 수 있어요."]);
	expect(text).toContain("- 추천: 오늘 끝내려면 (b)예요.");
	expect(text).toContain("지금 상태는 이래요.");
	expect(normalizeAsk(text)).toBe(text);
	ignoreNotice(open[0].id);
});

const draftCard = (ref: string) => `[ask] 새 메일 초안을 만들었어요\n${draftApprovalBlock({ to: "a@b.c", toLabel: "받는이", subject: "제목", body: "안녕하세요", ref, question: "이 메일 보낼까요?" })}`;
test("a card shown in a code block is a card: buttons and its ref; other code stays code", () => {
	const card = draftCard("RFENCE1");
	for (const text of [`\`\`\`\n${card}\n\`\`\``, `초안 올려요.\n\n\`\`\`text\n${card}\n\`\`\``]) {
		const shown = normalizeAsk(text);
		expect(cardRef(shown.includes("초안 올려요") ? shown.slice(shown.indexOf("[ask]")) : shown)).toBe("RFENCE1");
		expect(askComponentsFor("ch:123", shown)).toHaveLength(1);
		expect(shown).not.toContain("```");
	}
	const code = "```\n결정: 예시 (RFENCE2)\n1) 하나\n```";
	expect(normalizeAsk(code)).toBe(code);
});

test("a card whose findings changed is handed over for its Discord message, with the words it shows now", async () => {
	const seen: string[] = [];
	onDraftCardRefreshed(n => void seen.push(n.text));
	await out("ch:124", draftCard("RSYNC01"), undefined, { source: "orchestrator" });
	expect(syncDraftFiles(() => undefined, id => (id === "RSYNC01" ? ["파일이 달라요"] : undefined))).toBe(1);
	expect(seen).toHaveLength(1);
	expect(seen[0]).toContain("**4) 이대로 보내기**");
	ignoreNotice(listNotices().items.find((n: any) => n.decision?.draft?.ref === "RSYNC01")!.id);
});

test("options written on one line of an [ask] are a card, and what follows them stays", async () => {
	for (const n of openFor(CONV)) ignoreNotice((n as any).id);
	const seen = posted(CONV);
	await out(CONV, "[ask] 메일 1통째를 보낼 안이에요.\n\n1) 보내기 / 2) 고치기 / 3) 보내지 않기\n\n---\n❌ 임시저장본은 아직 못 지웠어요.");
	const text = String((await seen).text);
	const open = openFor(CONV);
	expect(open).toHaveLength(1);
	expect(labels(open[0])).toEqual(["보내기", "고치기", "보내지 않기"]);
	expect(text).toContain("임시저장본은 아직 못 지웠어요.");
	expect(normalizeAsk(text)).toBe(text);
	ignoreNotice(open[0].id);
});

test("a row of numbers in a sentence, or outside an [ask], is left as written", () => {
	const text = "오늘 한 일이에요.\n\n1) 빌드 / 2) 배포 / 3) 점검 순서로 했어요.";
	expect(normalizeAsk(text)).toBe(text);
});
