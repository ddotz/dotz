import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN, paths } from "./config.ts";
import { AGENT_AUTHOR } from "./agent-author.ts";
import { webAnswer } from "./approval-wire.ts";
import { draftVerdict } from "./draft-approval.ts";
import { createEscalations, setEscalationsForTest } from "./escalate.ts";
import { emit, tailEvents } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { deliverAnswer, makeRoute } from "./routes.ts";
import { routeSend } from "./routes-send.ts";

// POST /api/message: what the composer sends is stored once, and nothing is stored for an empty message.
const env = setupEnv();
afterAll(env.cleanup);

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
const owner = (body: object) => {
	const url = new URL("http://hub.test/api/message");
	return routeSend(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, ["api", "message"], { peer: "none" }).then(r => r!);
};
const lines = async (text: string) => ((await (await call("GET", "/api/history?target=main&limit=500")).json()) as { events?: Array<{ text?: string }> }).events?.filter(e => e.text === text).length;

describe("POST /api/message", () => {
	test("the same client id sent twice is stored once and answers the same", async () => {
		const first = await call("POST", "/api/message", { text: "중복 시험", cid: "c-1" });
		const again = await call("POST", "/api/message", { text: "중복 시험", cid: "c-1" });
		expect(first.status).toBe(200);
		expect(await again.json()).toEqual(await first.json());
		expect(await lines("중복 시험")).toBe(1);
		await call("POST", "/api/message", { text: "중복 시험", cid: "c-2" });
		expect(await lines("중복 시험")).toBe(2);
	});
	test("a typed message that names a decision settles that decision with its text and no other", async () => {
		resetNoticesForTest();
		for (const q of ["보고서를", "폴더를"]) emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: `[ask] ${q} 어떻게 할까요?\n결정: ${q} 어떻게 할까요?\n**1) 하기**\n**2) 말기**` });
		const ds = () => listNotices(300).items.filter(n => n.kind === "decision");
		const first = ds()[0]!;
		const r = await owner({ text: "이미 완료됨", decision: first.id, cid: "c-dec" });
		expect(r.status).toBe(200);
		expect(ds().map(n => [n.id === first.id, n.decision!.state, n.decision!.answer])).toEqual(expect.arrayContaining([[true, "answered", "이미 완료됨"], [false, "open", undefined]]));
		resetNoticesForTest();
	});
	test("an agent's picks and decision are dropped, the owner's own are kept", async () => {
		resetNoticesForTest();
		const q = "초안을 보낼까요?";
		emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: `[ask] ${q}\n결정: ${q} (RPICK01)\n**1) 보내기**\n*보내요*\n**2) 보내지 않기**\n*안 보내요*` });
		const card = listNotices(300).items.find(n => n.kind === "decision")!;
		const picks = [{ q: `${q} (RPICK01)`, n: 2, label: "보내지 않기" }];
		const agent = await call("POST", "/api/message", { text: "에이전트가 쓴 글", decision: card.id, picks });
		expect(agent.status).toBe(200);
		expect((await owner({ text: "형이 고른 글", picks })).status).toBe(200);
		const sent = tailEvents(paths.inbox).filter(e => e.kind === "message");
		const byAgent = sent.findLast(e => e.text === "에이전트가 쓴 글")!;
		expect(byAgent.author).toBe(AGENT_AUTHOR);
		expect(byAgent.picks).toBeUndefined();
		expect(byAgent.decision).toBeUndefined();
		expect(listNotices(300).items.find(n => n.id === card.id)!.decision!.state).toBe("open");
		expect(sent.findLast(e => e.text === "형이 고른 글")!.picks).toEqual(picks);
		resetNoticesForTest();
	});
	test("a message of spaces only is refused and nothing is stored", async () => {
		const r = await call("POST", "/api/message", { text: "   " });
		expect(r.status).toBe(400);
		expect(typeof ((await r.json()) as { error?: string }).error).toBe("string");
		expect(await lines("   ")).toBe(0);
	});
	const ask = (text: string) => {
		resetNoticesForTest();
		emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text });
		const card = listNotices(300).items.find(n => n.kind === "decision")!;
		return { card, state: () => listNotices(300).items.find(n => n.id === card.id)!.decision!.state };
	};
	const CHOICE = "[ask] 보고서를 어떻게 할까요?\n결정: 보고서를 어떻게 할까요?\n**1) 하기**\n**2) 말기**";
	test("an agent's message that answers one of the card's options closes it, as the owner's terminal answer does", async () => {
		const { state } = ask(CHOICE);
		expect((await call("POST", "/api/message", { text: "1" })).status).toBe(200);
		expect(state()).toBe("answered");
		resetNoticesForTest();
	});
	test("an agent's message does not close a card without options; the owner's same words do", async () => {
		const { state } = ask("[ask] 배포 방식은 어떻게 할까요?");
		expect((await call("POST", "/api/message", { text: "기존 방식으로 해" })).status).toBe(200);
		expect(state()).toBe("open");
		expect((await owner({ text: "기존 방식으로 해" })).status).toBe(200);
		expect(state()).toBe("answered");
		resetNoticesForTest();
	});
	test("an agent's ordinary words leave a card with options open", async () => {
		const { state } = ask(CHOICE);
		expect((await call("POST", "/api/message", { text: "그건 그렇고 날씨 어때?" })).status).toBe(200);
		expect(state()).toBe("open");
		resetNoticesForTest();
	});
	test("an agent's message that names the card or quotes its question closes it only by answering an option", async () => {
		const { card, state } = ask("[ask] 사이트 배포는 어떻게 할까요?\n결정: 사이트 배포는 어떻게 할까요?\n**1) 새 방식**\n**2) 기존 방식**");
		expect((await call("POST", "/api/message", { text: "알아서 해", decision: card.id })).status).toBe(200);
		expect((await call("POST", "/api/message", { text: "알아서 해", reply: { id: card.decision!.reply_to, author: "", content: "사이트 배포는 어떻게 할까요?" } })).status).toBe(200);
		expect(state()).toBe("open");
		expect((await owner({ text: "알아서 해", reply: { id: card.decision!.reply_to, author: "", content: "사이트 배포는 어떻게 할까요?" } })).status).toBe(200);
		expect(state()).toBe("answered");
		resetNoticesForTest();
	});
});

describe("POST /api/notices/<id>/answer from an agent", () => {
	const ask = (text: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text });
	const answer = (id: string, n: number) => call("POST", `/api/notices/${encodeURIComponent(id)}/answer`, { n });
	const card = (title: string) => listNotices(300).items.find(n => n.kind === "decision" && n.title.includes(title))!;
	const stateOf = (id: string) => listNotices(300).items.find(n => n.id === id)!.decision!.state;

	test("an [ask] the agent wrote itself naming a draft: its 보내지 않기 is refused and writes no verdict; the owner's is one", async () => {
		resetNoticesForTest();
		ask("[ask] 답장을 정리했어요\n결정: 보낼까요? (RVICTIM)\n**1) 보내기**\n**2) 보내지 않기**");
		const asked = card("RVICTIM");
		const r = await answer(asked.id, 2);
		expect(r.status).toBe(403);
		expect(stateOf(asked.id)).toBe("open");
		expect(draftVerdict(paths.inbox, "RVICTIM", 0, undefined)).toEqual({ verdict: "none" });
		const mine = await webAnswer(asked.id, { n: 2 }, "local", a => deliverAnswer({ ...a, login: "local" }));
		expect(mine.status).toBe(200);
		expect(draftVerdict(paths.inbox, "RVICTIM", 0, undefined)).toEqual({ verdict: "drop" });
		resetNoticesForTest();
	});

	test("a card of several draft questions: the agent's 보내지 않기 on one is refused, the card stays open and no verdict is written", async () => {
		resetNoticesForTest();
		ask("[ask] 답장 두 통이에요\n결정: 첫째 답장 보낼까요? (RMULTA)\n**1) 보내기**\n**2) 보내지 않기**\n\n결정: 둘째 답장 보낼까요? (RMULTB)\n**1) 보내기**\n**2) 보내지 않기**");
		const first = card("RMULTA");
		expect(card("RMULTB").id).not.toBe(first.id);
		expect(stateOf(first.id)).toBe("open");
		expect((await answer(first.id, 2)).status).toBe(403);
		expect(stateOf(first.id)).toBe("open");
		expect(draftVerdict(paths.inbox, "RMULTA", 0, undefined)).toEqual({ verdict: "none" });
		resetNoticesForTest();
	});

	test("an agent's answer to an ordinary card is recorded as the agent's, not the owner's", async () => {
		resetNoticesForTest();
		ask("[ask] 점심\n결정: 점심 먹을까요?\n**1) 네**\n**2) 아니요**");
		const asked = card("점심");
		expect((await answer(asked.id, 1)).status).toBe(200);
		const line = tailEvents(paths.inbox).findLast(e => e.kind === "message" && e.decision === asked.id)!;
		expect(line.author).toBe(AGENT_AUTHOR);
		resetNoticesForTest();
	});

	test("an agent can neither approve nor decline a stronger-model request; the proposal and its card wait for the owner", async () => {
		resetNoticesForTest();
		const dir = mkdtempSync(join(tmpdir(), "route-escalate-"));
		const launched: string[] = [];
		const e = createEscalations({ file: join(dir, "escalations.json"), now: Date.now, post: async (_target, text) => void ask(text), launch: async req => (launched.push(req.session), { lane: req.name }), tell: () => {}, stop: () => {} });
		setEscalationsForTest(e);
		try {
			await e.propose({ asker: "main", cwd: "/home/user/repo", current: "acme/mid-model:medium", offer: "acme/mid-model:high", step: "rewrite the parser", reason: "three tries failed", est: 5 });
			const asked = listNotices(300).items.find(n => n.kind === "decision")!;
			for (const n of [1, 2]) expect((await answer(asked.id, n)).status).toBe(403);
			expect(launched).toEqual([]);
			expect(e.get("main")!.state).toBe("asked");
			expect(stateOf(asked.id)).toBe("open");
		} finally {
			setEscalationsForTest(undefined);
			rmSync(dir, { recursive: true, force: true });
			resetNoticesForTest();
		}
	});
});
