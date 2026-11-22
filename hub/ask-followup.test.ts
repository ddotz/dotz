import { afterAll, beforeEach, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { flush, sendWeb } from "./intake.ts";
import { allNotices, resetNoticesForTest } from "./notices.ts";
import { queue } from "./outbound.ts";

process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => void delete process.env.DOTZ_NO_ORCHESTRATOR);

const TITLE = "그쪽 방식 중 무엇을 dotz에 가져올까요?";
const ask = () => emit("outbox", { ts: new Date(new Date().getTime() - 30 * 60_000).toISOString(), kind: "out", source: "orchestrator", target: "web", text: `[ask] ${TITLE}\n결정: ${TITLE}\n**1) 셋 다 가져오기**\n**2) 분리와 창 순서만**\n**3) 그대로 두기**` });
const open = () => allNotices().filter(n => n.kind === "decision" && n.title === TITLE && n.decision?.state === "open");
const followUps = () => queue.queued().filter(p => p.text.startsWith("[dotz gateway]") && p.text.includes(TITLE));

async function ownerTurn(answer: string): Promise<void> {
	await sendWeb({ channel: "web", text: "return으로 열기만 반영하자", mode: "default", login: "local" });
	flush("web");
	const p = queue.queued().at(-1)!;
	expect(p.text).toContain(TITLE);
	queue.onPrompt(p.text);
	queue.onAnswer(answer);
	queue.settleTurn();
}

beforeEach(() => {
	resetNoticesForTest();
	ask();
});

test("a free-text answer whose turn closes no listed question gets one follow-up turn, and only the bot closes the question", async () => {
	queue.settleTurn();
	expect(followUps()).toHaveLength(0);
	await ownerTurn("반영했어요.");
	expect(followUps()).toHaveLength(1);
	queue.settleTurn();
	expect(followUps()).toHaveLength(1);
	queue.onPrompt(followUps()[0].text);
	queue.onAnswer("-");
	queue.settleTurn();
	expect(followUps()).toHaveLength(0);
	expect(open()).toHaveLength(1);
});

test("a turn that closes the question with a <resolves> line gets no follow-up", async () => {
	await ownerTurn("반영했어요.\n<resolves>무엇을 dotz에 가져올까요</resolves>");
	expect(open()).toHaveLength(0);
	expect(followUps()).toHaveLength(0);
});
