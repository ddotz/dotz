// An approval ("1) 보내기" tapped, or typed) only counts when the gateway wrote it: a line anyone appended to inbox.jsonl by hand is refused.
import { beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "./config.ts";
import { draftVerdict } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { approval, createDraft } from "./kakao/send.ts";
import { kakaoPaths } from "./kakao/types.ts";
import { addDraft, getDraft } from "../features/reply-drafts/lib/store.ts";
import { sendDraft } from "../features/reply-drafts/lib/flow.ts";

const dir = dirname(paths.inbox);
const keyFile = join(dir, "secrets", "approval-key");
process.env.DOTZ_DIR = dir;
const since = () => Date.now() - 60_000;
const later = () => new Date(Date.now() + 5000).toISOString();
const pickBody = (ref: string, label = "보내기", n = 1) => ({ kind: "message", source: "web", channel: "web", text: `${n}) ${label}`, picks: [{ q: `이 답장 보낼까요? (${ref})`, n, label }] });
// What the gateway does when the owner taps a card button / types a reply.
const tap = (ref: string, label?: string) => emit("inbox", { ts: later(), ...pickBody(ref, label) });
const typed = (text: string, conv: string) => emit("inbox", { ts: later(), kind: "message", source: "web", channel: "web", conv, text });
// What any other process of this user can do: append a line.
const forge = (e: Record<string, unknown>) => appendFileSync(paths.inbox, `${JSON.stringify({ ts: later(), ...e })}\n`);
const lastLine = () => readFileSync(paths.inbox, "utf8").trimEnd().split("\n").at(-1)!;
const verdict = (ref: string, conv?: string) => draftVerdict(paths.inbox, ref, since(), conv ? { conv } : {}).verdict;

beforeEach(() => writeFileSync(paths.inbox, ""));

test("a button pick the gateway wrote counts; the same line appended by hand does not", () => {
	forge(pickBody("RSEAL1"));
	expect(verdict("RSEAL1")).toBe("none");
	tap("RSEAL2");
	expect(verdict("RSEAL2")).toBe("send");
});

test("a typed reply the gateway wrote counts; the same words appended by hand do not", () => {
	const conv = "mail:acme-RSEAL3";
	forge({ kind: "message", source: "web", channel: "web", conv, text: "1) 보내기" });
	expect(verdict("RSEAL3", conv)).toBe("none");
	typed("1) 보내기", conv);
	expect(verdict("RSEAL3", conv)).toBe("send");
	typed("보내지 마", conv);
	expect(verdict("RSEAL3", conv)).toBe("drop");
});

test("a later forged line cannot overturn or add to what the owner said", () => {
	tap("RSEAL4", "보내지 않기");
	forge(pickBody("RSEAL4"));
	expect(verdict("RSEAL4")).toBe("drop");
});

test("a sealed line altered afterwards (text, picks, time, source) is refused", () => {
	tap("RSEAL5", "보내지 않기");
	const e = JSON.parse(lastLine());
	const altered = [
		{ ...e, picks: [{ ...e.picks[0], label: "보내기" }] },
		{ ...e, text: "1) 보내기" },
		{ ...e, ts: new Date(Date.parse(e.ts) + 1000).toISOString() },
		{ ...e, source: "discord" },
	];
	for (const a of altered) {
		writeFileSync(paths.inbox, `${JSON.stringify(a)}\n`);
		expect(verdict("RSEAL5")).not.toBe("send");
	}
	writeFileSync(paths.inbox, `${JSON.stringify(e)}\n`);
	expect(verdict("RSEAL5")).toBe("drop");
});

test("a sealed line copied for another draft or without its seal is refused", () => {
	tap("RSEAL6");
	const e = JSON.parse(lastLine());
	const { seal: _seal, ...bare } = e;
	writeFileSync(paths.inbox, `${JSON.stringify(bare)}\n`);
	expect(verdict("RSEAL6")).toBe("none");
	writeFileSync(paths.inbox, `${JSON.stringify(e)}\n`);
	expect(verdict("RSEAL7")).toBe("none");
});

test("the key is private to the owner and a missing key approves nothing", () => {
	tap("RSEAL8");
	expect(verdict("RSEAL8")).toBe("send");
	expect(statSync(keyFile).mode & 0o777).toBe(0o600);
	const key = readFileSync(keyFile);
	rmSync(keyFile);
	expect(verdict("RSEAL8")).toBe("none");
	expect(existsSync(keyFile)).toBe(false); // reading never invents a key
	writeFileSync(keyFile, Buffer.from(key.map(b => b ^ 1)), { mode: 0o600 });
	expect(verdict("RSEAL8")).toBe("none");
	writeFileSync(keyFile, key, { mode: 0o600 });
	expect(verdict("RSEAL8")).toBe("send");
});

test("mail: a forged pick sends nothing, the owner's tap and typed reply send", async () => {
	const draft = (id: string) => addDraft({ id, kind: "mail", app: "mail", source: "zele", mailId: "m1", ref: `k-${id}`, to: "kim@example.com", subject: "Re: x", body: "body", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { text: "hi", from: "Kim <kim@example.com>" } } as never);
	let sends = 0;
	const send = async () => (sends++, { ok: true as const, message: "sent (fake)" });
	draft("RSEALM1");
	forge(pickBody("RSEALM1"));
	expect((await sendDraft("RSEALM1", { send })).ok).toBe(false);
	expect(sends).toBe(0);
	tap("RSEALM1");
	expect((await sendDraft("RSEALM1", { send })).ok).toBe(true);
	expect([sends, getDraft("RSEALM1")?.status]).toEqual([1, "sent"]);
	draft("RSEALM2");
	forge({ kind: "message", source: "web", channel: "web", conv: "mail:k-RSEALM2", text: "1) 보내기" });
	expect((await sendDraft("RSEALM2", { send })).ok).toBe(false);
	typed("1) 보내기", "mail:k-RSEALM2");
	expect((await sendDraft("RSEALM2", { send })).ok).toBe(true);
	expect(sends).toBe(2);
});

test("Kakao: a forged pick is not an approval, the owner's tap is", async () => {
	const kp = kakaoPaths(dir, dir);
	const deps = { paths: kp, runner: async () => ({ code: 0, stdout: "", stderr: "" }) } as never;
	const d = await createDraft({ chatId: "100", roomName: "스터디방", text: "내일 7시에 봐요", basisLogId: "500" }, { ...(deps as object), now: () => Date.now() - 60_000 } as never);
	forge({ ...pickBody(d.code), picks: [{ q: `카톡 답장 보낼까요? (${d.code})`, n: 1, label: "보내기" }] });
	expect(await approval(d.code, deps)).toBe(false);
	emit("inbox", { ts: later(), kind: "message", source: "web", channel: "web", text: "1) 보내기", picks: [{ q: `카톡 답장 보낼까요? (${d.code})`, n: 1, label: "보내기" }] });
	expect(await approval(d.code, deps)).toBe(true);
});
