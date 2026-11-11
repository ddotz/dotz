import { afterAll, describe, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { deleteMail, mailByKey, mailKey, postMail, recordMail, type MailDeps } from "./mail.ts";
import { applyMailboxFlags, canOf, mailAction, mailActions, MAIL_ACTIONS, type MailAction, type SyncDeps } from "./mail-sync.ts";
import { makeRoute } from "./routes.ts";
import { emit } from "./events.ts";

// Two-way mailbox sync (hub/mail-sync.ts): each action changes dotz at once and then the mailbox through an injected transport; the mailbox's own
// state flows back as changes only. The transports here are fakes: zele is a recording exec, the plugin a function.
const env = setupEnv();
afterAll(env.cleanup);

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;
const mailDeps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: e => emit("inbox", e as Parameters<typeof emit>[1]), wake: () => undefined };
const incoming = async (source: string, extra: Record<string, unknown> = {}) => (await postMail({ source, id: uid("sy"), subject: "동기화 시험", from: "Kim <kim@example.com>", to: "me@example.com", body: "본문", ...extra }, mailDeps)).key;

function fakes(over: Partial<SyncDeps> = {}) {
	const calls = { argv: [] as string[][], reads: [] as Array<[string, string, string]>, removed: [] as string[], changed: [] as string[], plugin: [] as Array<Record<string, string>> };
	const deps: SyncDeps = {
		exec: async argv => (calls.argv.push(argv), { code: 0, stderr: "" }),
		plugin: async a => (calls.plugin.push(a), undefined),
		pluginCan: () => [],
		webmail: s => s === "mailsite",
		setRead: (target, ts, direction) => void calls.reads.push([target, ts, direction]),
		remove: async key => (calls.removed.push(key), deleteMail(key)),
		changed: key => void calls.changed.push(key),
		...over,
	};
	return { deps, calls };
}

describe("dotz action -> mailbox", () => {
	test("zele gets the matching command for each action, with the account, and the result says it synced", async () => {
		const { deps, calls } = fakes();
		const key = await incoming("zele", { account: "me@example.com" });
		const id = mailByKey(key)!.id;
		for (const action of MAIL_ACTIONS) if (action !== "trash") expect(await mailAction(key, action, deps)).toEqual({ ok: true, synced: true });
		expect(calls.argv).toEqual([
			["zele", "mail", "read-mark", id, "--account", "me@example.com"],
			["zele", "mail", "unread-mark", id, "--account", "me@example.com"],
			["zele", "mail", "archive", id, "--account", "me@example.com"],
			["zele", "mail", "label", id, "--add", "INBOX", "--account", "me@example.com"],
			["zele", "mail", "star", id, "--account", "me@example.com"],
			["zele", "mail", "unstar", id, "--account", "me@example.com"],
		]);
		expect(calls.reads.map(r => r[2])).toEqual(["read", "unread"]);
		expect(calls.reads[1]![1] < calls.reads[0]![1]).toBe(true);
	});

	test("archive and star are flags of the record; a newer message of the thread clears them", async () => {
		const { deps } = fakes();
		const key = await incoming("zele");
		await mailAction(key, "archive", deps);
		await mailAction(key, "star", deps);
		expect(mailByKey(key)).toMatchObject({ archived: true, starred: true });
		await mailAction(key, "unarchive", deps);
		expect(mailByKey(key)!.archived).toBeUndefined();
		await mailAction(key, "archive", deps);
		await postMail({ source: "zele", id: mailByKey(key)!.id, messageId: "m2", subject: "동기화 시험", from: "Kim <kim@example.com>", body: "새 답" }, mailDeps);
		expect(mailByKey(key)!.archived).toBeUndefined();
	});

	test("a failing mailbox call changes dotz only and says so; trash removes the mail and calls no source", async () => {
		const down = fakes({ exec: async () => ({ code: 1, stderr: "token expired" }) });
		const key = await incoming("zele");
		const res = await mailAction(key, "archive", down.deps);
		expect(res).toMatchObject({ ok: true, synced: false });
		expect(res.note).toContain("반영하지 못했어요");
		expect(mailByKey(key)!.archived).toBe(true);
		const { deps, calls } = fakes();
		expect(await mailAction(key, "trash", deps)).toEqual({ ok: true, synced: false });
		expect(calls.argv).toEqual([]);
		expect(calls.removed).toEqual([key]);
		expect(mailByKey(key)).toBeUndefined();
		expect(await mailAction(key, "read", deps)).toMatchObject({ ok: false });
	});

	test("a webmail site and a plugin that cannot reach the mailbox succeed without a note; a plugin that can does it; a plugin that throws is a failure", async () => {
		const web = await incoming("mailsite");
		const { deps, calls } = fakes();
		expect(await mailAction(web, "read", deps)).toEqual({ ok: true, synced: false });
		const other = await incoming("work");
		expect(await mailAction(other, "star", deps)).toEqual({ ok: true, synced: false });
		expect(calls.plugin).toEqual([{ source: "work", id: mailByKey(other)!.id, action: "star" }]);
		const yes = fakes({ plugin: async () => true });
		expect(await mailAction(other, "read", yes.deps)).toEqual({ ok: true, synced: true });
		const boom = fakes({ plugin: async () => { throw new Error("session gone"); } });
		expect(await mailAction(other, "unread", boom.deps)).toMatchObject({ ok: true, synced: false, note: "메일함에 반영하지 못했어요 · dotz에서만 바뀌었어요" });
		expect(canOf("zele", deps)).toEqual([...MAIL_ACTIONS]);
		expect(canOf("mailsite", deps)).toEqual([]);
		expect(canOf("work", { webmail: () => false, pluginCan: () => ["read", "trash"] })).toEqual(["read", "trash"]);
	});

	test("opening a mail tells only the mailbox (providerOnly) and the batch keeps each result", async () => {
		const { deps, calls } = fakes();
		const a = await incoming("zele"), b = await incoming("zele");
		await mailAction(a, "read", deps, { providerOnly: true });
		expect(calls.reads).toEqual([]);
		expect(calls.argv).toHaveLength(1);
		const results = await mailActions([a, "zele-nope", b], "star", deps);
		expect(results.map(r => [r.key, r.ok, r.synced])).toEqual([[a, true, true], ["zele-nope", false, false], [b, true, true]]);
	});
});

describe("mailbox -> dotz", () => {
	const flagDeps = (f: ReturnType<typeof fakes>) => ({ ...f.deps, keyOf: (s: string, id: string) => mailKey(s, id) });

	test("only a change of the last reported state is applied: a stale poll never undoes a dotz action", async () => {
		const f = fakes({ exec: async () => ({ code: 1, stderr: "offline" }) });
		const key = await incoming("zele");
		const id = mailByKey(key)!.id;
		await applyMailboxFlags("zele", [{ id, read: true, starred: false }], flagDeps(f));
		expect(f.calls.reads.map(r => r[2])).toEqual(["read"]);
		expect(mailByKey(key)!.box).toEqual({ read: true, starred: false });
		// he marks it unread in dotz, the mailbox could not follow and still says read: no change, nothing undone
		await mailAction(key, "unread", f.deps);
		f.calls.reads.length = 0;
		await applyMailboxFlags("zele", [{ id, read: true, starred: false }], flagDeps(f));
		expect(f.calls.reads).toEqual([]);
		// the mailbox itself changes: unread there, starred there
		await applyMailboxFlags("zele", [{ id, unread: true, starred: true }], flagDeps(f));
		expect(f.calls.reads.map(r => r[2])).toEqual(["unread"]);
		expect(mailByKey(key)).toMatchObject({ starred: true, box: { read: false, starred: true } });
		await applyMailboxFlags("zele", [{ id, read: true, starred: false }], flagDeps(f));
		expect(f.calls.reads.map(r => r[2])).toEqual(["unread", "read"]);
		expect(mailByKey(key)!.starred).toBeUndefined();
	});

	test("the first report applies only what is not the default, and trashed there is gone here", async () => {
		const f = fakes();
		const key = await incoming("zele"), gone = await incoming("zele");
		await applyMailboxFlags("zele", [{ id: mailByKey(key)!.id, unread: true, starred: true, archived: true }], flagDeps(f));
		expect(f.calls.reads).toEqual([]);
		expect(mailByKey(key)).toMatchObject({ starred: true, archived: true });
		const changed = await applyMailboxFlags("zele", [{ id: mailByKey(gone)!.id, trashed: true }, { id: "no-such-thread", read: true }], flagDeps(f));
		expect(changed).toEqual([`mail:${gone}`]);
		expect(mailByKey(gone)).toBeUndefined();
	});
});

describe("the routes", () => {
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => mailDeps });
	const call = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));

	test("POST /api/mail/<key>/action and /api/mail/actions, the card fields, and POST /api/mail/state with the new fields", async () => {
		const key = await incoming("fx");
		const one = await call("POST", `/api/mail/${key}/action`, { action: "star" });
		expect(one.status).toBe(200);
		expect(await one.json()).toEqual({ ok: true, synced: false });
		expect((await call("POST", `/api/mail/${key}/action`, { action: "explode" })).status).toBe(400);
		expect((await call("POST", "/api/mail/fx-nope/action", { action: "read" })).status).toBe(404);
		await call("POST", `/api/mail/${key}/action`, { action: "archive" });
		const batch = await (await call("POST", "/api/mail/actions", { keys: [key, "fx-nope"], action: "unread" })).json() as { ok: boolean; results: unknown[] };
		expect(batch.results).toEqual([{ key, ok: true, synced: false }, { key: "fx-nope", ok: false, synced: false, note: "이 메일을 찾지 못했어요" }]);
		const card = ((await (await call("GET", "/api/conversations?all=1")).json()) as { items: Array<{ target: string; mail?: Record<string, any> }> }).items.find(i => i.target === `mail:${key}`)!.mail!;
		expect(card).toMatchObject({ read: false, archived: true, starred: true, can: [] });
		expect(typeof card.base).toBe("string");
		await call("POST", `/api/mail/${key}/action`, { action: "read" });
		const again = ((await (await call("GET", "/api/conversations?all=1")).json()) as { items: Array<{ target: string; mail?: Record<string, any> }> }).items.find(i => i.target === `mail:${key}`)!.mail!;
		expect(again.read).toBe(true);
		const z = await incoming("zele");
		const st = await (await call("POST", "/api/mail/state", { source: "zele", items: [{ id: mailByKey(z)!.id, trashed: true }] })).json();
		expect(st).toEqual({ ok: true, changed: 1 });
		expect(mailByKey(z)).toBeUndefined();
		expect((await call("DELETE", `/api/mail/${key}`)).status).toBe(200);
	});

	test("안 읽음 action on an old mail whose message is no longer in the event log still counts it unread, and 읽음 clears it", async () => {
		const key = `fx-old${uid("")}`;
		recordMail({ key, source: "fx", id: key.slice(3), subject: "오래된 메일", from: "Kim <kim@example.com>", to: "me@example.com", at: "2026-10-01T00:00:00.000Z", reply: "needs" });
		const cardOf = async () => ((await (await call("GET", "/api/conversations?all=1")).json()) as { items: Array<{ target: string; unread: number; mail?: Record<string, any> }> }).items.find(i => i.target === `mail:${key}`)!;
		expect((await cardOf()).mail!.read).toBe(true);
		expect((await call("POST", `/api/mail/${key}/action`, { action: "unread" })).status).toBe(200);
		expect(await cardOf()).toMatchObject({ unread: 1, mail: { read: false } });
		await call("POST", `/api/mail/${key}/action`, { action: "read" });
		expect(await cardOf()).toMatchObject({ unread: 0, mail: { read: true } });
	});
});

export type { MailAction };
