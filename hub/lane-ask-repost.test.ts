// One question, one card (owner 2026-11-05: "이거 왜 두번오냐"): a session's [ask] already waits in 답변 필요, so the orchestrator's turn that heard it
// cannot post it again in other words. Replays 2026-11-05 14:20 UTC through the real report path, the real /api/send and the real notice store;
// only the model's turn is absent, the route calls stand in for its tools.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ASK_A } from "./ask-normalize.fixture.ts";
import { cfg, HUB_TOKEN, NAME, paths } from "./config.ts";
import { convs } from "./convsessions.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { report } from "./lanereport.ts";
import { hooks, lanes, type Lane } from "./lanestate.ts";
import { installLaneHandlers, laneRelay } from "./lanewire.ts";
import { listNotices, needsAnswer, resetNoticesForTest } from "./notices.ts";
import { queue } from "./outbound.ts";
import { makeRoute } from "./routes.ts";

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const post = async (path: string, body: object) => (await route(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN }, body: JSON.stringify(body) }))).json() as Promise<{ delivered?: boolean; reason?: string }>;
const dotzSend = (text: string, target = "web") => post("/api/send", { target, text, session: "main" });
const cards = () => listNotices().items.filter(needsAnswer);

const LANE_ASK = "[ask] 형이 직접 쓴 긴 글이 이 맥에는 없어요.\n\n결정: 중간·긴 글 평가에 쓸 형 글을 줄 수 있나요?\n**1) 블로그나 칼럼 주소를 줘요**\n그 글을 읽어서 평가해요.\n**2) 지금 줄 글이 없어요**\n공개 저자 글로 재요.";
const REWORDED = "[ask] 문체 스킬을 시험할 형의 긴 글이 이 맥에 없어요.\n\n결정: 중간·긴 글 시험에 쓸 형의 글을 줄 수 있나요?\n**1) 블로그나 칼럼 주소**\n주소를 적어 주세요.\n**2) 지금 줄 글이 없어요**\n공개된 글로 시험해요.";
const OWN_ASK = "[ask] 야간 점검이 끝났어요.\n\n결정: 정리 보고를 언제 받을까요?\n**1) 지금 받기**\n바로 보내요.\n**2) 내일 받기**\n아침에 보내요.";

let sent: string[] = [];
const saved = Reflect.get(cfg, "output_language");
const waiters: ((e: HubEvent) => void)[] = [];
let tick = 0;

beforeAll(() => {
	Reflect.set(cfg, "output_language", "off");
	process.env.DOTZ_NO_ORCHESTRATOR = "1";
	onEmit(e => {
		if (e.kind === "lane_report") for (const w of waiters.splice(0)) w(e);
	});
	installLaneHandlers();
});
afterAll(() => {
	Reflect.set(cfg, "output_language", saved);
	delete process.env.DOTZ_NO_ORCHESTRATOR;
});
beforeEach(() => {
	resetNoticesForTest();
	sent = [];
	laneRelay.flush();
	queue.settleTurn();
});

function lane(): Lane {
	const name = `pv-${++tick}`;
	mkdirSync(join(paths.lanes, name), { recursive: true });
	const l = { name, cwd: "/tmp", model: "m", status: "working", startedAt: "", reports: 0, lastText: "", ctx: { compaction: { state: "idle" } }, proc: { send: (t: string) => sent.push(t) } } as unknown as Lane;
	lanes.set(name, l);
	return l;
}
// The report goes through lanereport.ts and lanewire.ts as a running lane's turn end does, and starts the orchestrator's turn with no asking channel.
const asks = async (l: Lane, text = LANE_ASK) => {
	const reported = new Promise<HubEvent>(resolve => waiters.push(resolve));
	report(l, text);
	await reported;
	queue.onPrompt(queue.queued().at(-1)!.text);
};
const ownerTurn = (id: string) => {
	queue.deliver(`owner message ${id}`, { target: "web", replyTo: id, owner: true });
	queue.onPrompt(`owner message ${id}`);
};
// The turn that heard the report ended: the orchestrator's idle hook.
const turnEnds = () => {
	queue.settleTurn();
	laneRelay.flush();
};

test("the orchestrator's reworded [ask] on the report turn makes no second card, and it is told why", async () => {
	const l = lane();
	await asks(l);
	expect(cards()).toHaveLength(1);
	const r = await dotzSend(REWORDED);
	expect(r.delivered).toBe(false);
	expect(r.reason).toContain(l.name);
	expect(cards().map(c => c.decision!.to)).toEqual([`lane:${l.name}`]);
});

test("a card made by a 결정 block with no [ask] marker is refused too", async () => {
	await asks(lane());
	const r = await dotzSend(REWORDED.replace("[ask] ", ""));
	expect(r.delivered).toBe(false);
	expect(cards()).toHaveLength(1);
});

test("a plain note in that turn still goes out", async () => {
	await asks(lane());
	expect((await dotzSend("세션에 긴 글 관련 질문이 올라갔어요.")).delivered).toBe(true);
	expect(cards()).toHaveLength(1);
});

test("the orchestrator's own question goes out when no session's question is open", async () => {
	expect((await dotzSend(OWN_ASK)).delivered).toBe(true);
	expect(cards().map(c => c.decision!.to)).toEqual(["main"]);
});

test("once the owner answered the card, the question in that turn is the orchestrator's own again", async () => {
	const l = lane();
	await asks(l);
	ownerTurn("own1");
	await post(`/api/lanes/${l.name}/send`, { text: "오너 답: 2번" });
	expect(cards()).toEqual([]);
	expect((await dotzSend(OWN_ASK)).delivered).toBe(true);
});

test("a later turn is not held back: the refusal lasts the turn that heard the question", async () => {
	await asks(lane());
	turnEnds();
	expect((await dotzSend(OWN_ASK)).delivered).toBe(true);
	expect(cards()).toHaveLength(2);
});

test("a question that only hands a chore to the orchestrator is no card of the owner's, so the orchestrator may ask him", async () => {
	await asks(lane(), `[ask] 게이트웨이 재시작이 필요해요.\n\nFor ${NAME}: 재시작해 주세요`);
	expect(cards()).toEqual([]);
	expect((await dotzSend(OWN_ASK)).delivered).toBe(true);
});

test("the owner's answer carried over from another conversation reaches the lane and closes its card", async () => {
	const l = lane();
	await asks(l);
	ownerTurn("own2");
	await post(`/api/lanes/${l.name}/send`, { text: "오너 답: 2번으로 해요" });
	expect(sent.at(-1)).toContain("오너 답: 2번으로 해요");
	expect(l.pendingAsk).toBeUndefined();
	expect(cards()).toEqual([]);
});

test("a message to the lane from a turn no owner message started leaves his card open", async () => {
	const l = lane();
	await asks(l);
	await post(`/api/lanes/${l.name}/send`, { text: "답이 올 때까지 다른 칸을 계속해요" });
	expect(sent.at(-1)).toContain("다른 칸을 계속해요");
	expect(cards()).toHaveLength(1);
});

// A card with buttons for every open decision, from every sender that can ask: a list in the wrong form included. A lane has no dotz_send
// (extension/index.ts gives it to the orchestrator and its conversation sessions); it asks by its report and its mid-turn text.
const ASK_LABELS = ["그대로 반영", "알림 행만 조정하고 반영", "반영 보류"];
const labelsOf = (to: string) => cards().filter(c => c.decision!.to === to).map(c => c.decision!.options.map(o => o.label));
const posted = (target: string) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`nothing posted to ${target}`)), 5000);
		onEmit(e => {
			if (e.kind === "out" && e.target === target) {
				clearTimeout(timer);
				resolve();
			}
		});
	});

test("a conversation session's dotz_send of an option list is a card in its own conversation", async () => {
	const target = "mail:choice-flow";
	const r = await post("/api/send", { target, text: ASK_A, session: convs.keyOf(target) });
	expect(r.delivered).toBe(true);
	expect(labelsOf(target)).toEqual([ASK_LABELS]);
});

test("a scheduled turn's dotz_send is a card, to another channel at once and to its own channel with the final answer", async () => {
	queue.deliver("[schedule] 아침 점검", { target: "web" });
	queue.onPrompt("[schedule] 아침 점검");
	expect(await dotzSend(ASK_A, "mail:schedule-flow")).toMatchObject({ delivered: true });
	expect(labelsOf("mail:schedule-flow")).toEqual([ASK_LABELS]);
	const held = await dotzSend(OWN_ASK);
	expect(held).toMatchObject({ delivered: true, held: true });
	const seen = posted("web");
	queue.onAnswer("점검을 끝냈어요.");
	await seen;
	expect(labelsOf("main")).toEqual([["지금 받기", "내일 받기"]]);
});

test("a lane's mid-turn text with an option list is a card, as its report is", async () => {
	const l = lane();
	const seen = posted(`lane:${l.name}`);
	hooks.progress(l, `[ask] ${ASK_A}`);
	await seen;
	expect(labelsOf(`lane:${l.name}`)).toEqual([ASK_LABELS]);
});
