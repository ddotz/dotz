import { afterAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { sendWith } from "../lib/senders.ts";
import type { DraftRec } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { msg } from "../../../hub/i18n.ts";
import { setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => rmSync(`${env.dir}/mail-conversations.json`, { force: true }));

const rec = (): DraftRec =>
	({ id: "RACC002", kind: "mail", app: "mail", source: "zele", mailId: "thread-1", ref: "k1", to: "kim@example.com", subject: "Re: 문의", body: "본문", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { text: "x", from: "Kim <kim@example.com>" } }) as unknown as DraftRec;

type Step = { code: number; stderr: string };
const tool = (o: { whoami: Step & { out?: string }; read: Step }, calls: string[][]): Runner => async argv => {
	calls.push(argv);
	if (argv[1] === "whoami") return { code: o.whoami.code, stdout: o.whoami.out ?? "", stderr: o.whoami.stderr };
	if (argv[2] === "read") return { code: o.read.code, stdout: "", stderr: o.read.stderr };
	return { code: 0, stdout: "ok", stderr: "" };
};
const two = { code: 0, stderr: "", out: "a@x.com\nb@x.com" };
const mailCalls = (calls: string[][]) => calls.filter(a => a[2] === "reply" || a[2] === "send");

test("two accounts and both reads fail offline: the refusal says offline, not that the account is unknown", async () => {
	const calls: string[][] = [];
	const o = await sendWith(rec(), tool({ whoami: two, read: { code: 1, stderr: "getaddrinfo ENOTFOUND gmail.googleapis.com" } }, calls));
	expect({ ok: o.ok, sent: o.sent, code: o.code }).toEqual({ ok: false, sent: "no", code: "offline" });
	expect(o.message).toContain(msg().sendFail.offline);
	expect(o.message).not.toContain("알 수 없어서");
	expect(mailCalls(calls)).toEqual([]);
});

test("two accounts and both reads fail for another reason: still account_needed", async () => {
	const o = await sendWith(rec(), tool({ whoami: two, read: { code: 1, stderr: "thread not found" } }, []));
	expect(o.code).toBe("account_needed");
});

test("whoami fails and the draft names no account: nothing is sent and no reply goes out without --account", async () => {
	const calls: string[][] = [];
	const o = await sendWith(rec(), tool({ whoami: { code: 1, stderr: "boom" }, read: { code: 0, stderr: "" } }, calls));
	expect({ ok: o.ok, sent: o.sent, code: o.code }).toEqual({ ok: false, sent: "no", code: "tool_before_send" });
	expect(calls.filter(a => a[2] === "read" || a[2] === "reply")).toEqual([]);
});

test("whoami fails offline: the refusal says offline", async () => {
	const o = await sendWith(rec(), tool({ whoami: { code: 1, stderr: "getaddrinfo ENOTFOUND oauth2.googleapis.com" }, read: { code: 0, stderr: "" } }, []));
	expect({ sent: o.sent, code: o.code }).toEqual({ sent: "no", code: "offline" });
});
