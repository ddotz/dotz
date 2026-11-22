import { afterAll, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { deleteMail, mailByKey, postMail, type MailDeps } from "./mail.ts";
import { mailActions, type SyncDeps } from "./mail-sync.ts";
import { emit } from "./events.ts";
import { flush } from "./runtime/test-clock.ts";

const env = setupEnv();
afterAll(env.cleanup);

const mailDeps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: e => emit("inbox", e as Parameters<typeof emit>[1]), wake: () => undefined };
const incoming = async (id: string) => (await postMail({ source: "zele", id, subject: "여럿 동시", from: "Kim <kim@example.com>", to: "me@example.com", body: "본문" }, mailDeps)).key;

function tracked() {
	const seen = { flying: 0, most: 0 };
	const deps: SyncDeps = {
		exec: async argv => {
			seen.most = Math.max(seen.most, ++seen.flying);
			await flush(1);
			seen.flying--;
			return { code: 0, stderr: "" };
		},
		plugin: async () => undefined,
		pluginCan: () => [],
		webmail: () => false,
		setRead: () => undefined,
		remove: async key => deleteMail(key),
		changed: () => undefined,
	};
	return { seen, deps };
}

test("a batch of mail actions runs three at a time and the results keep the order of the keys", async () => {
	const keys = await Promise.all(["pa1", "pa2", "pa3", "pa4", "pa5", "pa6", "pa7"].map(incoming));
	const { seen, deps } = tracked();
	const results = await mailActions([keys[0]!, "zele-missing", ...keys.slice(1)], "star", deps);
	expect(seen.most).toBe(3);
	expect(results.map(r => [r.key, r.ok, r.synced])).toEqual([[keys[0], true, true], ["zele-missing", false, false], ...keys.slice(1).map(k => [k, true, true])]);
	expect(keys.every(k => mailByKey(k)?.starred === true)).toBe(true);
});

test("the same key twice in one batch is still handled one after the other: the second finds it gone", async () => {
	const key = await incoming("pb1");
	const { deps } = tracked();
	const results = await mailActions([key, key], "trash", deps);
	expect(results.map(r => r.ok)).toEqual([true, false]);
});
