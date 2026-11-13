// The reply routes' shapes and status codes (design 1.9).
import { expect, test } from "bun:test";
import { createApprovalSender } from "./approval-send.ts";
import { createReplyActions } from "./reply-actions.ts";
import { replyRoute } from "./reply-route.ts";
import type { DraftView, ReplyAdapter } from "./reply-types.ts";

const draft: DraftView = { item: "mail:k1", ref: "RAAAAAA", kind: "mail", app: "mail", label: "메일", conv: "mail:k1", at: 0, can: { send: true, revise: true, edit: true, drop: true, restore: true }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "확인했어요" } };
const adapter = { kind: "mail", get: async (ref: string) => (ref === draft.ref ? draft : undefined), list: async () => [draft], target: () => ({ kind: "mail", lane: "m" }), question: (r: string) => `q (${r})` } as unknown as ReplyAdapter;
const replies = createReplyActions({
	adapters: [adapter],
	sender: createApprovalSender({ kind: () => ({ kind: "mail", lane: "m" }), run: async () => ({ code: 0, out: "" }), report: () => undefined, log: () => undefined }),
	recordPick: () => undefined,
	learning: { record: async () => undefined, refine: async () => undefined },
	cards: { open: () => [], replace: () => undefined, rewrite: () => undefined, close: () => undefined },
	toBot: async () => undefined,
	emit: () => undefined,
	log: () => undefined,
});
const call = (method: string, path: string, b?: object, o: { agent?: boolean; wired?: boolean } = {}) =>
	replyRoute(new Request(`http://x${path}`, { method, ...(b ? { body: JSON.stringify(b) } : {}) }), new URL(`http://x${path}`), { replies: o.wired === false ? undefined : replies, login: "me", agent: o.agent });

test("the queue lists every item with its counts; ?refs= narrows it", async () => {
	const r = (await call("GET", "/api/reply/queue"))!;
	expect(r.status).toBe(200);
	const b = await r.json();
	expect(b.items.map((i: DraftView) => i.ref)).toEqual(["RAAAAAA"]);
	expect(b.counts).toEqual({ waiting: 1, failed: 0, unsure: 0, sending: 0, sentToday: 0 });
	expect((await (await call("GET", "/api/reply/queue?refs=NOPE"))!.json()).items).toEqual([]);
});

test("act answers with its status code: 400 bad, 403 agent, 404 unknown, 503 not wired; other paths are not this route's", async () => {
	expect((await call("POST", "/api/reply/act", { ref: "RAAAAAA" }))!.status).toBe(400);
	expect((await call("POST", "/api/reply/act", { ref: "RAAAAAA", action: "drop" }, { agent: true }))!.status).toBe(403);
	expect((await call("POST", "/api/reply/act", { ref: "RZZZZZZ", action: "send" }))!.status).toBe(404);
	expect((await call("POST", "/api/reply/act", { ref: "RAAAAAA", action: "send" }, { wired: false }))!.status).toBe(503);
	expect((await call("POST", "/api/reply/act", { items: [] }))!.status).toBe(400);
	expect(await call("GET", "/api/replies")).toBeUndefined();
});
