import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { fieldsOf, readSettings, setMailTrashProbe, SettingsError, writeSettings } from "./app-settings.ts";
import { HUB_TOKEN } from "./config.ts";
import { emit } from "./events.ts";
import { deleteMail, mailByKey, postMail, type MailDeps } from "./mail.ts";
import { deleteOriginal, deleteOriginals, originalDeleteRoute, ownerClick, recoverOriginalDeletes, type OriginalDeps, type PendingDelete } from "./mail-delete.ts";
import { mailAction, type SyncDeps } from "./mail-sync.ts";
import { makeRoute } from "./routes.ts";

// 삭제하면 원본도 삭제 (hub/mail-delete.ts): the sources are fakes only; zele here is a recording function and no real command ever runs.
const env = setupEnv();
afterAll(env.cleanup);

let seq = 0;
const uid = () => `orig${Date.now().toString(36)}${++seq}`;
const mailDeps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: e => emit("inbox", e as never), wake: () => undefined };
const incoming = async (source: string, extra: Record<string, unknown> = {}) => (await postMail({ source, id: uid(), subject: "삭제 시험", from: "Kim <kim@example.com>", to: "me@example.com", text: "본문", ...extra }, mailDeps)).key;

const THREAD = (...from: string[]) => from.map(f => `From: ${f}\nTo: me@example.com\nDate: Mon, 2 Nov 2026 09:00:00 +0900\n\n본문\n`).join("─────────\n");
function fakes(over: Partial<OriginalDeps> = {}) {
	const calls = { argv: [] as string[][], read: [] as string[], plugin: [] as Array<Record<string, string>>, removed: [] as string[] };
	let kept: PendingDelete[] = [];
	const deps: OriginalDeps = {
		allowed: () => true,
		exec: async argv => (calls.argv.push(argv), { code: 0, stderr: "" }),
		plugin: async a => (calls.plugin.push(a), true),
		read: async id => (calls.read.push(id), THREAD("Kim <kim@example.com>")),
		remove: async key => (calls.removed.push(key), deleteMail(key)),
		changed: () => undefined,
		pending: { load: () => kept, save: items => { kept = items; } },
		...over,
	};
	return { deps, calls, kept: () => kept };
}
const syncFakes = () => {
	const calls = { argv: [] as string[][], plugin: 0 };
	const deps: SyncDeps = { exec: async argv => (calls.argv.push(argv), { code: 0, stderr: "" }), plugin: async () => (calls.plugin++, true), pluginCan: () => ["trash"], webmail: () => false, setRead: () => undefined, remove: async key => deleteMail(key), changed: () => undefined };
	return { deps, calls };
};

describe("the switch off", () => {
	test("delete is dotz only: no source is called for zele or a plugin source, and nothing says otherwise", async () => {
		for (const source of ["zele", "fx"]) {
			const { deps, calls } = syncFakes();
			const key = await incoming(source);
			expect(await mailAction(key, "trash", deps)).toEqual({ ok: true, synced: false });
			expect(calls).toEqual({ argv: [], plugin: 0 });
			expect(mailByKey(key)).toBeUndefined();
		}
	});
	test("a mail the switch does not cover is refused without a source call and stays", async () => {
		const { deps, calls } = fakes({ allowed: () => false });
		const key = await incoming("zele");
		expect(await deleteOriginal(key, deps)).toMatchObject({ ok: false });
		expect(calls).toEqual({ argv: [], read: [], plugin: [], removed: [] });
		expect(mailByKey(key)).toBeDefined();
	});
});

describe("the switch on", () => {
	test("zele: one read, then one trash (never a permanent delete) per mail with its account, then the mail leaves dotz", async () => {
		const { deps, calls } = fakes();
		const a = await incoming("zele", { account: "me@example.com" }), b = await incoming("zele");
		const res = await deleteOriginals([a, b, "fx-nope"], deps);
		expect(res.map(r => r.ok)).toEqual([true, true, false]);
		const [ida, idb] = calls.read;
		expect(calls.argv).toEqual([["zele", "mail", "trash", ida!, "--account", "me@example.com"], ["zele", "mail", "trash", idb!]]);
		expect(calls.removed).toEqual([a, b]);
	});
	test("a plugin source gets one trash through mailAction", async () => {
		const { deps, calls } = fakes();
		const key = await incoming("fx");
		expect(await deleteOriginal(key, deps)).toEqual({ ok: true });
		expect(calls.plugin).toEqual([{ source: "fx", id: mailByKey(key)?.id ?? calls.plugin[0]!.id, action: "trash" }]);
		expect(calls.argv).toEqual([]);
	});
	for (const [name, over] of [
		["zele exits non-zero", { exec: async () => ({ code: 1, stderr: "boom" }) }],
		["the source throws", { exec: async () => { throw new Error("boom"); } }],
		["the thread cannot be read", { read: async () => { throw new Error("boom"); } }],
		["the thread reads empty", { read: async () => "" }],
	] as Array<[string, Partial<OriginalDeps>]>) test(`failure stays visible: ${name}`, async () => {
		const { deps, calls, kept } = fakes(over);
		const key = await incoming("zele");
		const res = await deleteOriginal(key, deps);
		expect(res.ok).toBe(false);
		expect(res.note).toBeTruthy();
		expect(calls.removed).toEqual([]);
		expect(mailByKey(key)).toBeDefined();
		expect(kept()).toEqual([]);
	});
	test("a plugin that refuses or does not know the source: the mail stays, nothing is reported deleted", async () => {
		for (const plugin of [async () => false, async () => undefined, async () => { throw new Error("boom"); }]) {
			const { deps, calls } = fakes({ plugin });
			const key = await incoming("fx");
			expect((await deleteOriginal(key, deps)).ok).toBe(false);
			expect(calls.removed).toEqual([]);
		}
	});
	test("a thread that holds a message from someone else that dotz has not shown is not trashed; the owner's own reply does not stop it", async () => {
		const seen = await incoming("zele", { messageId: "1|Nov 2", account: "me@example.com" });
		const stop = fakes({ read: async () => THREAD("Kim <kim@example.com>", "Lee <lee@example.com>") });
		expect(await deleteOriginal(seen, stop.deps)).toMatchObject({ ok: false });
		expect(stop.calls.argv).toEqual([]);
		const go = fakes({ read: async () => THREAD("Kim <kim@example.com>", "Me <me@example.com>") });
		expect(await deleteOriginal(seen, go.deps)).toEqual({ ok: true });
		expect(go.calls.argv.length).toBe(1);
	});
	test("a second click while the first call runs makes no second call", async () => {
		let open = (_: { code: number; stderr: string }) => {};
		const argv: string[][] = [];
		let entered = () => {};
		const inCall = new Promise<void>(res => { entered = res; });
		const { deps } = fakes({ exec: a => { argv.push(a); entered(); return new Promise(res => { open = res; }); } });
		const key = await incoming("zele", { messageId: "1|Nov 2" });
		const first = deleteOriginal(key, deps);
		await inCall;
		expect((await deleteOriginal(key, deps)).ok).toBe(false);
		open({ code: 0, stderr: "" });
		expect(await first).toEqual({ ok: true });
		expect(argv.length).toBe(1);
	});
});

describe("a restart in the middle", () => {
	test("the mail in flight is on file while the source runs and off it after", async () => {
		const seen: PendingDelete[][] = [];
		const f = fakes({ exec: async () => { seen.push(f.kept()); return { code: 0, stderr: "" }; } });
		const key = await incoming("zele", { messageId: "1|Nov 2" });
		await deleteOriginal(key, f.deps);
		expect(seen[0]!.map(p => p.key)).toEqual([key]);
		expect(f.kept()).toEqual([]);
	});
	test("boot never repeats the call: the mail stays and one visible line asks him to look", async () => {
		const key = await incoming("zele");
		let kept: PendingDelete[] = [{ key, subject: "삭제 시험" }];
		const lines: string[] = [];
		recoverOriginalDeletes({ load: () => kept, save: items => { kept = items; } }, t => lines.push(t));
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("삭제 시험");
		expect(kept).toEqual([]);
		expect(mailByKey(key)).toBeDefined();
		recoverOriginalDeletes({ load: () => kept, save: items => { kept = items; } }, t => lines.push(t));
		expect(lines.length).toBe(1);
	});
});

describe("only the owner's click reaches it", () => {
	const browser = (extra: Record<string, string> = {}) => new Request("http://hub.test/api/mail/delete-original", { method: "POST", headers: { "sec-fetch-site": "same-origin", ...extra } });
	test("a browser's same-origin request passes; the bot's token, a peer and a plain script do not", () => {
		expect(ownerClick(browser(), "none")).toBe(true);
		expect(ownerClick(browser({ "x-dotz-token": HUB_TOKEN }), "none")).toBe(false);
		expect(ownerClick(browser(), "ok")).toBe(false);
		expect(ownerClick(new Request("http://hub.test/x", { method: "POST" }), "none")).toBe(false);
		expect(ownerClick(browser({ "sec-fetch-site": "cross-site" }), "none")).toBe(false);
	});
	test("the real route refuses the bot's token: 403, no source call, the mail stays", async () => {
		const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => mailDeps });
		const key = await incoming("fx");
		const res = await route(new Request("http://hub.test/api/mail/delete-original", { method: "POST", headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ keys: [key] }) }));
		expect(res.status).toBe(403);
		expect(mailByKey(key)).toBeDefined();
	});
	test("the route takes a list of keys and answers one result per key", async () => {
		const { deps } = fakes();
		const key = await incoming("fx");
		const res = await originalDeleteRoute(browser(), "none", { keys: [key] }, deps);
		expect(await res.json()).toEqual({ ok: true, results: [{ key, ok: true }] });
		expect((await originalDeleteRoute(browser(), "none", { keys: "x" }, deps)).status).toBe(400);
	});
});

describe("the setting", () => {
	const dir = mkdtempSync(join(tmpdir(), "mail-delete-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const row = (app: string) => readSettings(dir, app).find(f => f.key === "delete_original");
	const raw = (v: object) => { mkdirSync(join(dir, "custom"), { recursive: true }); writeFileSync(join(dir, "custom/apps.json"), JSON.stringify(v)); };

	test("every mail instance has it, no other app does, and an existing install reads off", () => {
		setMailTrashProbe(() => true);
		raw({ mail: { label: "회사" }, "mail-2": { app: "mail", label: "개인" } });
		expect(row("mail")).toMatchObject({ value: false, type: "bool" });
		expect(row("mail-2")).toMatchObject({ value: false });
		expect(fieldsOf("kakao").some(f => f.key === "delete_original")).toBe(false);
	});
	test("it is per instance", () => {
		setMailTrashProbe(() => true);
		writeSettings(dir, "mail-2", { delete_original: true });
		expect(row("mail-2")!.value).toBe(true);
		expect(row("mail")!.value).toBe(false);
	});
	test("a mailbox with no delete: the row is shown off with its reason, and turning it on is refused", () => {
		setMailTrashProbe(() => false);
		expect(row("mail-2")).toMatchObject({ value: false, blocked: expect.any(String) });
		expect(() => writeSettings(dir, "mail", { delete_original: true })).toThrow(SettingsError);
		expect(writeSettings(dir, "mail", { label: "회사" }).find(f => f.key === "label")!.value).toBe("회사");
	});
});

