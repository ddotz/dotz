import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDraft, getDraft, newId } from "../features/reply-drafts/lib/store.ts";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { webAnswer } from "./approval-wire.ts";
import { authRoute } from "./auth.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { createEscalations, setEscalationsForTest } from "./escalate.ts";
import { emit } from "./events.ts";
import { type Notice, authRequested, listNotices, resetNoticesForTest } from "./notices.ts";
import { out } from "./outbound.ts";
import { deliverAnswer, makeRoute } from "./routes.ts";
import { routeNotices } from "./routes-notices.ts";

const env = setupEnv();
afterAll(env.cleanup);
afterEach(() => {
	setEscalationsForTest(undefined);
	resetNoticesForTest();
});

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
const ask = (text: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text });
const card = (match: string): Notice => listNotices(300).items.find(n => n.kind === "decision" && `${n.title}${n.text}`.includes(match))!;
const stateOf = (id: string) => listNotices(300).items.find(n => n.id === id)!.decision!.state;
const draftText = (ref: string) => `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "받는이", body: "답", ref, question: "이 답장 보낼까요?" })}`;
const mailDraft = (id: string) => addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `ao-${id.toLowerCase()}`, to: "friend@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", text: "안녕" } as never });

const closers = (id: string) => [
	() => call("POST", "/api/notices/resolve", { ids: [id] }),
	() => call("POST", `/api/notices/${encodeURIComponent(id)}/ignore`),
	() => call("POST", "/api/send", { target: "main", text: "끝났어요", resolves: "*" }),
];

async function escalationCard(): Promise<{ card: Notice; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "owner-powers-"));
	const e = createEscalations({ file: join(dir, "escalations.json"), now: Date.now, post: async (_target, text) => void ask(text), launch: async req => ({ lane: req.name }), tell: () => {}, stop: () => {} });
	setEscalationsForTest(e);
	await e.propose({ asker: "main", cwd: "/home/user/repo", current: "acme/mid-model:medium", offer: "acme/mid-model:high", step: "rewrite the parser", reason: "three tries failed", est: 5 });
	return { card: listNotices(300).items.find(n => n.kind === "decision")!, dir };
}

describe("REQ1: an agent cannot close the owner's cards by resolve, ignore or dotz_send resolves", () => {
	test("a send-approval card stays open", async () => {
		ask(draftText("RAOD01"));
		const c = card("RAOD01");
		expect(c.decision!.draft).toBeDefined();
		for (const close of closers(c.id)) {
			await close();
			expect(stateOf(c.id)).toBe("open");
		}
	});
	test("a card whose title names a draft ref stays open", async () => {
		ask("[ask] 답장을 정리했어요\n결정: 보낼까요? (RAOREF)\n**1) 보내기**\n**2) 보내지 않기**");
		const c = card("RAOREF");
		for (const close of closers(c.id)) {
			await close();
			expect(stateOf(c.id)).toBe("open");
		}
	});
	test("a stronger-model card stays open", async () => {
		const { card: c, dir } = await escalationCard();
		try {
			for (const close of closers(c.id)) {
				await close();
				expect(stateOf(c.id)).toBe("open");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("an auth card stays open", async () => {
		authRequested({ id: "aoauth1", kind: "approve", title: "로그인 승인", site: "example.com", purpose: "승인해 주세요" });
		const c = listNotices(300).items.find(n => n.decision?.to === "auth:aoauth1")!;
		for (const close of closers(c.id).slice(0, 2)) {
			await close();
			expect(stateOf(c.id)).toBe("open");
		}
	});
	test("an ordinary card is still closed by the agent's resolve and ignore", async () => {
		ask("[ask] 점심\n결정: 점심 먹을까요?\n**1) 네**\n**2) 아니요**");
		const c = card("점심");
		expect(((await (await call("POST", "/api/notices/resolve", { ids: [c.id] })).json()) as { resolved: number }).resolved).toBe(1);
		expect(stateOf(c.id)).not.toBe("open");
		ask("[ask] 저녁\n결정: 저녁 먹을까요?\n**1) 네**\n**2) 아니요**");
		const d = card("저녁");
		expect((await call("POST", `/api/notices/${encodeURIComponent(d.id)}/ignore`)).status).toBe(200);
		expect(stateOf(d.id)).not.toBe("open");
	});
});

describe("REQ2: an agent cannot answer the owner's second-factor request", () => {
	test("approve over /api/auth and a card answer both leave it pending; the owner's own approve settles it", async () => {
		const created = (await (await call("POST", "/api/auth", { kind: "approve", site: "aoauth", purpose: "승인", target: "chat" })).json()) as { id: string };
		const status = async () => ((await (await call("GET", `/api/auth/${created.id}`)).json()) as { status: string }).status;
		expect((await call("POST", `/api/auth/${created.id}`, { action: "approve" })).status).toBe(403);
		expect(await status()).toBe("pending");
		const c = listNotices(300).items.find(n => n.decision?.to === `auth:${created.id}`)!;
		const viaCard = await webAnswer(c.id, { n: 1 }, "hub-token", a => deliverAnswer({ ...a, login: "hub-token" }), true);
		expect([viaCard.status, (viaCard.body as { code?: string }).code]).toEqual([403, "owner_only"]);
		expect(await status()).toBe("pending");
		const url = new URL(`http://local/api/auth/${created.id}`);
		const mine = await authRoute(new Request(url, { method: "POST", body: JSON.stringify({ action: "approve" }) }), url);
		expect(mine!.status).toBe(200);
		expect(await status()).toBe("approved");
	});
});

describe("REQ3: a note-only answer from an agent cannot close a stronger-model card", () => {
	test("no `n`, only a note: 403 and the card waits", async () => {
		const { card: c, dir } = await escalationCard();
		try {
			const r = await call("POST", `/api/notices/${encodeURIComponent(c.id)}/answer`, { note: "no" });
			expect(r.status).toBe(403);
			expect(stateOf(c.id)).toBe("open");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("REQ4: an agent cannot restore a draft the owner dropped", () => {
	test("reopen of the dropped draft's card leaves it dropped; the owner's reopen restores it", async () => {
		const id = newId();
		mailDraft(id);
		await out("mail:ao-restore", draftText(id));
		const c = listNotices(500).items.find(n => n.decision?.draft?.ref === id)!;
		expect((await webAnswer(c.id, { n: 3 }, "owner@example.com", async () => undefined)).status).toBe(200);
		expect(getDraft(id)?.status).toBe("dropped");
		const r = await call("POST", "/api/notices/reopen", { ids: [c.id] });
		expect(r.status).toBe(403);
		expect(getDraft(id)?.status).toBe("dropped");
		expect(stateOf(c.id)).not.toBe("open");
		const ownerReopen = await routeNotices(new Request("http://local/api/notices/reopen", { method: "POST", body: JSON.stringify({ ids: [c.id] }) }), new URL("http://local/api/notices/reopen"));
		expect(ownerReopen!.status).toBe(200);
		expect(getDraft(id)?.status).toBe("pending");
	});
});

describe("REQ6: a pick with no label (the shell guard lets it by) answers a plain card, never a send card", () => {
	test("n only on a draft's card is owner_only and the draft waits; on an ordinary [ask] card it answers", async () => {
		const id = newId();
		mailDraft(id);
		await out("mail:ao-nolabel", draftText(id));
		const send = listNotices(500).items.find(n => n.decision?.draft?.ref === id)!;
		const refused = await call("POST", `/api/notices/${encodeURIComponent(send.id)}/answer`, { n: 1 });
		expect([refused.status, ((await refused.json()) as { code?: string }).code]).toEqual([403, "owner_only"]);
		expect([stateOf(send.id), getDraft(id)?.status]).toEqual(["open", "pending"]);
		ask("[ask] 검사\n결정: 작업 용어 검사를 만들까요?\n**1) 검사 만들기**\n**2) 7일 숨기기**");
		const plain = card("작업 용어 검사");
		expect((await call("POST", `/api/notices/${encodeURIComponent(plain.id)}/answer`, { n: 1 })).status).toBe(200);
		expect(stateOf(plain.id)).not.toBe("open");
	});
});

describe("REQ5: an agent cannot close the owner's open Kakao question", () => {
	test("POST /api/kakao/chat/<id>/ask/drop with the hub token is owner_only", async () => {
		const r = await call("POST", "/api/kakao/chat/100/ask/drop");
		expect([r.status, ((await r.json()) as { code?: string }).code]).toEqual([403, "owner_only"]);
	});
});
