// The reply routes' shapes and status codes (design 1.9).
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDraft, getDraft, listDrafts, setStatus, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { approvalHash, createApprovalSender } from "./approval-send.ts";
import { commentsDir, createStore } from "./comments/store.ts";
import { createReplyActions } from "./reply-actions.ts";
import { mailAdapter } from "./reply-mail.ts";
import { localMidnight, replyRoute, sinceMidnight } from "./reply-route.ts";
import type { DraftView, ReplyAdapter, ReplyItem } from "./reply-types.ts";

const dir = mkdtempSync(join(tmpdir(), "reply-route-"));
const before = process.env.DOTZ_DIR;
process.env.DOTZ_DIR = dir;
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});
beforeEach(() => {
	rmSync(join(dir, "custom"), { recursive: true, force: true });
	mkdirSync(join(dir, "custom", "reply-drafts"), { recursive: true });
	writeFileSync(join(dir, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true }));
});

const draft: DraftView = { item: "mail:k1", ref: "RAAAAAA", kind: "mail", app: "mail", label: "메일", conv: "mail:k1", at: 0, can: { send: true, revise: true, edit: true, drop: true, restore: true }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "확인했어요" } };
const adapter = { kind: "mail", get: async (ref: string) => (ref === draft.ref ? draft : undefined), list: async () => [draft], target: () => ({ kind: "mail", lane: "m" }), question: (r: string) => `q (${r})` } as unknown as ReplyAdapter;
const replies = createReplyActions({
	adapters: [adapter],
	sender: createApprovalSender({ kind: () => ({ kind: "mail", lane: "m" }), run: async () => ({ code: 0, out: "" }), report: () => undefined, log: () => undefined }),
	recordPick: () => undefined,
	learning: { record: async () => ({ kind: "correction" as const, stored: true, replaced: [] }), refine: async () => undefined, forbid: async () => undefined },
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

const rec = (id: string, ref: string, o: Partial<DraftRec> = {}): DraftRec =>
	({ id, kind: "mail", app: "mail", source: "zele", account: "me@example.net", mailId: id, ref, to: "kim@example.com", subject: "Re: x", body: "본문", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", app: "mail", from: "Kim <kim@example.com>", text: "hi", subject: "x" }, ...o }) as unknown as DraftRec;
const restarted = () =>
	createReplyActions({
		adapters: [mailAdapter()],
		sender: createApprovalSender({ kind: () => ({ kind: "mail", lane: "m" }), run: async () => ({ code: 0, out: "" }), report: () => undefined, log: () => undefined }),
		recordPick: () => undefined,
		learning: { record: async () => ({ kind: "correction" as const, stored: true, replaced: [] }), refine: async () => undefined, forbid: async () => undefined },
		cards: { open: () => [], replace: () => undefined, rewrite: () => undefined, repost: async () => undefined, close: () => undefined },
		toBot: async () => undefined,
		emit: () => undefined,
		log: () => undefined,
	});
const queueOf = async (r: typeof replies): Promise<{ items: ReplyItem[]; counts: Record<string, number> }> =>
	(await replyRoute(new Request("http://x/api/reply/queue"), new URL("http://x/api/reply/queue"), { replies: r, login: "me" }))!.json();
const setSentAt = (id: string, sentAt: string) => {
	const file = join(dir, "custom", "reply-drafts", "drafts.json");
	writeFileSync(file, JSON.stringify({ drafts: listDrafts().map(d => (d.id === id ? { ...d, sentAt } : d)), keys: [] }));
};

test("U4-7 a mail sent before a restart (no send record left) is a sent row of today; waiting counts only the pending one", async () => {
	addDraft(rec("RSENTAA", "rk1"));
	addDraft(rec("RWAITBB", "rk2"));
	setStatus("RSENTAA", "sent");
	const b = await queueOf(restarted());
	const sent = b.items.find(i => i.ref === "RSENTAA");
	expect(sent).toMatchObject({ draft: { state: "sent" }, send: { state: "sent", how: "owner", actions: [] } });
	expect(sent!.send!.at).toBe(Date.parse(getDraft("RSENTAA")!.sentAt!));
	expect(b.counts).toEqual({ waiting: 1, failed: 0, unsure: 0, sending: 0, sentToday: 1 });
});

test("U4-7 a mail sent yesterday, or sent before the send time was kept, is no row; a second sent keeps the first time", async () => {
	addDraft(rec("RSENTAA", "rk1"));
	addDraft(rec("ROLDCCC", "rk3", { status: "sent" }));
	setStatus("RSENTAA", "sent");
	const first = getDraft("RSENTAA")!.sentAt;
	expect(first).toBeTruthy();
	setStatus("RSENTAA", "sent");
	expect(getDraft("RSENTAA")!.sentAt).toBe(first);
	expect(getDraft("ROLDCCC")!.sentAt).toBeUndefined();
	setSentAt("RSENTAA", new Date(localMidnight() - 3_600_000).toISOString());
	const b = await queueOf(restarted());
	expect(b.items).toEqual([]);
	expect(b.counts.sentToday).toBe(0);
});

test("P13 the mail adapter lists a sent draft of today with its time; get names its state; the account is in the hash, the time is not", async () => {
	addDraft(rec("RUIAAA1", "k1"));
	addDraft(rec("RUIBBB2", "k2", { account: "other@example.net" }));
	const a = mailAdapter();
	setStatus("RUIAAA1", "sent");
	const view1 = (await a.get("RUIAAA1"))!;
	expect(view1.draft.state).toBe("sent");
	expect(view1.sent).toEqual({ at: Date.parse(getDraft("RUIAAA1")!.sentAt!), how: "owner" });
	expect((await a.list()).map(v => v.ref).sort()).toEqual(["RUIAAA1", "RUIBBB2"]);
	expect(approvalHash(view1)).toBe(approvalHash({ ...view1, sent: undefined }));
	const view2 = (await a.get("RUIBBB2"))!;
	expect(view2.draft.account).toBe("other@example.net");
	addDraft(rec("RUICCC3", "k3", { account: "third@example.net" }));
	const same = { item: "mail:k2", conv: "mail:k2" };
	expect(approvalHash({ ...(await a.get("RUICCC3"))!, ref: "x", ...same })).not.toBe(approvalHash(view2));
	addDraft(rec("RUIDDD4", "k4", { account: "other@example.net" }));
	expect(approvalHash({ ...(await a.get("RUIDDD4"))!, ref: "x", ...same })).toBe(approvalHash(view2));
});

test("U4-5 a mail that went out with its comment reply is no sent row of its own; one left behind by 답글만 보내기 and sent alone is", async () => {
	addDraft(rec("RPAIRAA", "rk4"));
	addDraft(rec("RLEFTBB", "rk5"));
	addDraft(rec("RALONEC", "rk6"));
	const comments = createStore(commentsDir(dir));
	const reply = (code: string, mail: string, withMail: boolean) => {
		comments.putDraft({ code, commentId: `cm:x:${code}`, source: "x", thread: "t", text: "답글", status: "sent", created: 1, changes: [], clean: true, notes: [], mail });
		comments.putReply({ id: `send:${code}`, commentId: `cm:x:${code}`, source: "x", thread: "t", text: "답글", state: "sent", at: 2, draft: code, via: "owner", collector: "mac", ...(withMail ? { mail: { state: "sent" as const, text: "" } } : {}) });
	};
	reply("DPAIR0001", "RPAIRAA", true);
	reply("DLEFT0001", "RLEFTBB", false);
	for (const id of ["RPAIRAA", "RLEFTBB", "RALONEC"]) setStatus(id, "sent");
	expect((await mailAdapter().list()).map(v => v.ref).sort()).toEqual(["RALONEC", "RLEFTBB"]);
});

test("today begins at the gateway's local midnight", () => {
	const now = Date.now(), midnight = localMidnight(now);
	expect(new Date(midnight).getHours()).toBe(0);
	expect(now - midnight).toBeLessThan(86_400_000 + 3_600_000);
	expect(sinceMidnight(midnight, now)).toBe(true);
	expect(sinceMidnight(midnight - 1, now)).toBe(false);
});
