import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addDraft, getDraft, listDrafts, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { DATA_DIR, HUB_TOKEN } from "./config.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { mailDraftHandled } from "./draft-handled.ts";
import { emit } from "./events.ts";
import { listNotices, setDraftHandled } from "./notices.ts";
import { deleteMail, mailByKey, mailCard, mailTargets, postMail, recordMail, setMailReply, unrepliedMails, type MailDeps } from "./mail.ts";
import { createPeerMonitor } from "./peer-monitor.ts";
import { makeRoute } from "./routes.ts";

// The ⋯ of a mail card: 답장 안 해도 돼요 (fyi) and its undo, and 삭제 (the mail leaves dotz, never the real mailbox), on the hub that holds the mail
// and forwarded from another computer through /api/peer/act.
const env = setupEnv();
afterAll(env.cleanup);
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = (method: string, path: string) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) }));

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;
const deps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: () => undefined, wake: () => undefined };
const incoming = async (id: string, messageId?: string) => (await postMail({ source: "fx", id, subject: "견적 문의", from: "Kim <kim@example.com>", needsReply: true, ...(messageId ? { messageId } : {}) }, deps)).key;
const draft = (id: string, ref: string): DraftRec => ({ id, kind: "mail", app: "mail", source: "fx", mailId: "1", ref, to: "kim@example.com", body: "본문", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: "kim@example.com", text: "x" } });

describe("답장 안 해도 돼요", () => {
	test("leaves 답장 필요 and 미답장, holds the waiting reply draft, and the undo makes it 답장 필요 again", async () => {
		const key = await incoming(uid("fyi"), "m1");
		setMailReply(key, "need");
		const owed = () => unrepliedMails(new Set(), Date.parse(mailByKey(key)!.at)).some(m => m.key === key);   // setupEnv pins Date.now
		addDraft(draft("RFYAAA2", key));
		expect(owed()).toBe(true);
		expect((await call("POST", `/api/mail/${key}/fyi`)).status).toBe(200);
		expect(mailCard(mailByKey(key)!).reply).toBe("fyi");
		expect(owed()).toBe(false);
		expect(getDraft("RFYAAA2")!.status).toBe("held");
		expect((await call("DELETE", `/api/mail/${key}/fyi`)).status).toBe(200);
		expect(mailByKey(key)!.reply).toBe("needs");
		expect(getDraft("RFYAAA2")!.status).toBe("pending");
		expect(owed()).toBe(true);
		expect((await call("POST", "/api/mail/fx-nope/fyi")).status).toBe(404);
	});

	test("its send approval leaves 확인 대기 and 되돌리기 brings the same card back, waiting again; a newer draft replaces a held one", async () => {
		setDraftHandled(d => mailDraftHandled(d.draft!.ref!, { drafts: listDrafts, record: mailByKey }) ?? false);
		const key = await incoming(uid("hold"), "m1");
		setMailReply(key, "need");
		addDraft(draft("RHLAAA2", key));
		emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: `mail:${key}`, text: `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "kim@example.com", toLabel: "받는이", subject: "Re: 견적 문의", body: "본문", ref: "RHLAAA2", question: "이 답장 보낼까요?" })}` });
		const card = () => listNotices(200).items.find(i => i.decision?.draft?.ref === "RHLAAA2");
		expect(card()?.decision?.state).toBe("open");
		await call("POST", `/api/mail/${key}/fyi`);
		expect(card()?.decision).toMatchObject({ state: "answered", resolved: true });
		await call("DELETE", `/api/mail/${key}/fyi`);
		expect(card()?.decision?.state).toBe("open");
		expect(card()?.read).toBe(false);
		// held, then a newer draft comes: the held one is stale, the undo has nothing to bring back
		await call("POST", `/api/mail/${key}/fyi`);
		addDraft(draft("RHLBBB2", key));
		expect(getDraft("RHLAAA2")!.status).toBe("stale");
	});

	test("삭제 drops a held draft too", async () => {
		const key = await incoming(uid("hd"), "m1");
		addDraft(draft("RHDAAA2", key));
		await call("POST", `/api/mail/${key}/fyi`);
		await call("DELETE", `/api/mail/${key}`);
		expect(getDraft("RHDAAA2")!.status).toBe("dropped");
	});

	test("a send approval of a mail marked 답장 불필요 or 답장 안 함 is handled (it leaves 확인 대기) even when the draft is still pending", () => {
		const drafts = () => [{ id: "d1", ref: "m", status: "pending", created: "2026-10-27T00:00:00Z" }];
		expect(mailDraftHandled("d1", { drafts, record: () => ({ reply: "fyi" }) })).toBe(true);
		expect(mailDraftHandled("d1", { drafts, record: () => ({ reply: "skipped" }) })).toBe(true);
		expect(mailDraftHandled("d1", { drafts, record: () => ({ reply: "needs" }) })).toBe(false);
	});
});

describe("삭제", () => {
	test("removes the record, its list entry and its pending draft, and stays gone for the same message", async () => {
		const key = await incoming(uid("del"), "m1");
		addDraft(draft("RDLAAA2", key));
		expect((await call("DELETE", `/api/mail/${key}`)).status).toBe(200);
		expect(mailByKey(key)).toBeUndefined();
		expect(mailTargets()).not.toContain(`mail:${key}`);
		expect(getDraft("RDLAAA2")!.status).toBe("dropped");
		// persisted: the mail file no longer has it, the deleted list remembers its message
		expect(JSON.parse(readFileSync(join(DATA_DIR, "mail-conversations.json"), "utf8")).some((r: { key: string }) => r.key === key)).toBe(false);
		expect(JSON.parse(readFileSync(join(DATA_DIR, "mail-deleted.json"), "utf8"))[key]).toBe("m1");
		// the watcher posting the same message again does not bring it back; a newer message of the thread does
		expect((await postMail({ source: "fx", id: key.slice(3), subject: "견적 문의", from: "Kim <kim@example.com>", messageId: "m1" }, deps)).skipped).toBe(true);
		expect(mailByKey(key)).toBeUndefined();
		await incoming(key.slice(3), "m2");
		expect(mailByKey(key)?.msg).toBe("m2");
		expect((await call("DELETE", "/api/mail/fx-nope")).status).toBe(404);
	});

	test("a record kept before message ids: the first id seen after the delete is that message, a later one brings it back", async () => {
		const id = uid("old"), key = `fx-${id}`;
		recordMail({ key, source: "fx", id, subject: "예전 메일", from: "Lee <lee@example.com>", at: new Date().toISOString() });
		expect(deleteMail(key)).toBe(true);
		expect(existsSync(join(DATA_DIR, "mail-files", key))).toBe(false);
		await incoming(id);
		await incoming(id, "a1");
		expect(mailByKey(key)).toBeUndefined();
		await incoming(id, "a1");
		expect(mailByKey(key)).toBeUndefined();
		await incoming(id, "a2");
		expect(mailByKey(key)?.msg).toBe("a2");
	});
});

describe("a deleted mail leaves every list", () => {
	test("its conversation keeps its messages but leaves /api/conversations and the snapshot the other computer reads, even after a later message", async () => {
		const key = await incoming(uid("gone"), "m1"), t = `mail:${key}`;
		emit("inbox", { ts: new Date().toISOString(), kind: "mail", source: "fx", channel: t, conv: t, mail: key, subject: "견적 문의", from: "Kim <kim@example.com>", text: "Kim · 견적 문의" });
		const pm = createPeerMonitor({ name: () => "A", computers: async () => [], local: route, localHeaders: { "x-dotz-token": HUB_TOKEN } });
		const lists = async () => {
			const own = ((await (await call("GET", "/api/conversations")).json()) as { items: { target: string; mail?: unknown }[] }).items;
			const snap = (await (await pm.route(new Request("http://local/api/peer/monitoring"), new URL("http://local/api/peer/monitoring")))!.json()) as { conversations: { target: string }[] };
			return { own: own.filter(c => c.target === t), peer: snap.conversations.filter(c => c.target === t) };
		};
		const before = await lists();
		expect([before.own.length, before.peer.length, !!before.own[0]?.mail]).toEqual([1, 1, true]);
		expect((await call("DELETE", `/api/mail/${key}`)).status).toBe(200);
		emit("outbox", { ts: new Date(Date.now() + 1000).toISOString(), kind: "out", source: "orchestrator", target: t, text: "늦게 온 답" });
		expect(await lists()).toEqual({ own: [], peer: [] });
	});
});

describe("the owner's mark", () => {
	test("답장 안 함 and 답장 필요로 표시 record that he set them and when; an automatic change drops the mark", async () => {
		const key = await incoming(uid("by"), "m1");
		expect((await call("POST", `/api/mail/${key}/no-reply`)).status).toBe(200);
		expect(mailByKey(key)).toMatchObject({ reply: "skipped", reply_by: "owner" });
		expect(Number.isFinite(Date.parse(mailByKey(key)!.reply_at!))).toBe(true);
		expect((await call("DELETE", `/api/mail/${key}/fyi`)).status).toBe(200);
		expect(mailByKey(key)).toMatchObject({ reply: "needs", reply_by: "owner" });
		setMailReply(key, "sent");
		expect(mailByKey(key)!.reply).toBe("replied");
		expect(mailByKey(key)!.reply_by).toBeUndefined();
	});

	test("no automatic event can close a mail as his mark: skip / fyi without the owner change nothing", async () => {
		const key = await incoming(uid("auto"), "m1");
		setMailReply(key, "need");
		setMailReply(key, "skip");
		setMailReply(key, "fyi");
		expect(mailByKey(key)!.reply).toBe("needs");
		setMailReply(key, "skip", undefined, "owner");
		expect(mailByKey(key)!.reply).toBe("skipped");
	});

	test("답장 필요로 표시 opens a mail with no reply state and an answered one", async () => {
		const key = (await postMail({ source: "fx", id: uid("open"), subject: "회의록 공유", from: "Lee <lee@example.com>", messageId: "m1" }, deps)).key;
		expect(mailByKey(key)!.reply).toBeUndefined();
		await call("DELETE", `/api/mail/${key}/fyi`);
		expect(mailByKey(key)!.reply).toBe("needs");
		setMailReply(key, "sent");
		await call("DELETE", `/api/mail/${key}/fyi`);
		expect(mailByKey(key)!.reply).toBe("needs");
	});
});

describe("from another computer (/api/peer/act)", () => {
	const seen: [string, string][] = [];
	const pm = createPeerMonitor({ name: () => "A", computers: async () => [], local: async req => (seen.push([req.method, new URL(req.url).pathname]), Response.json({ ok: true })) });
	const act = (action: string, args: unknown) => pm.route(new Request("http://local/api/peer/act", { method: "POST", body: JSON.stringify({ action, from: "B", args }) }), new URL("http://local/api/peer/act"));
	test("답장 안 해도 돼요, its undo and 삭제 each run once, on the routes of the computer that holds the mail", async () => {
		await act("fyi", { key: "kdb-1" });
		await act("fyi", { key: "kdb-1", on: false });
		await act("mail-delete", { key: "kdb-1" });
		expect(seen).toEqual([["POST", "/api/mail/kdb-1/fyi"], ["DELETE", "/api/mail/kdb-1/fyi"], ["DELETE", "/api/mail/kdb-1"]]);
		expect((await act("mail-delete", {}))!.status).toBe(400);
	});
});
