import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecisions } from "../choices.ts";
import { approval, createDraft, draftBlock, listDrafts, sendDraft, sendText, type Draft } from "./send.ts";
import { KAKAO_BUNDLE, kakaoPaths, type Runner } from "./types.ts";

const T0 = Date.parse("2026-10-22T00:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kk-send-"));
	paths = kakaoPaths(dir, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const add = (file: string, e: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify(e)}\n`);
const owner = (sec: number, e: Record<string, unknown> = {}) => add(paths.inbox, { ts: at(sec), kind: "message", source: "web", channel: "web", author: "me", text: "", ...e });
const ask = (sec: number, d: Draft, target = "web") => add(paths.outbox, { ts: at(sec), kind: "out", source: "orchestrator", target, text: draftBlock(d), reply_to: null });
const pick = (d: Draft, label: string, n = 1) => ({ picks: [{ q: `카톡 답장 보낼까요? (${d.code})`, n, label }] });

// A fake kmsg: records argv, answers --dry-run with the echo kmsg prints, fails the test on anything but send.
function fakeKmsg(dry: (argv: string[]) => string = a => `Dry run mode - no message will be sent\nRecipient: ${a[a.indexOf("--") + 1]}\nMessage: ${a[a.length - 1]}\n`, front = "com.example.Editor") {
	const calls: string[][] = [];
	// The focus handling (frontmost app lookup and restore) is not a kmsg call.
	const focus: string[][] = [];
	const runner: Runner = async argv => {
		if (argv[0] === "osascript" || argv[0] === "open") {
			focus.push(argv);
			return { code: 0, stdout: argv[0] === "osascript" ? `${front}\n` : "", stderr: "" };
		}
		calls.push(argv);
		expect(argv[1]).toBe("send");
		return { code: 0, stdout: argv.includes("--dry-run") ? dry(argv) : "sent\n", stderr: "" };
	};
	return { calls, focus, runner };
}

const base = { chatId: "100", roomName: "스터디방", text: "내일 7시에 봐요", basisLogId: "500" };
const make = (over: Partial<typeof base> = {}) => createDraft({ ...base, ...over }, { paths, runner: fakeKmsg().runner, now: () => T0 });
const sender = (k: ReturnType<typeof fakeKmsg>, latest: string | undefined = "500") => ({ paths, runner: k.runner, kmsg: "/fake/kmsg", now: () => T0 + 60_000, latestIncoming: async () => latest });

test("without the owner's approval nothing is sent and kmsg is never run", async () => {
	const d = await make();
	const k = fakeKmsg();
	const r = await sendDraft(d.code, sender(k));
	expect(r.ok).toBe(false);
	expect(r.reason).toBeTruthy();
	expect(k.calls).toHaveLength(0);
	expect(await approval(d.code, sender(k))).toBe(false);
	expect((await sendDraft("KZZZZ", sender(k))).ok).toBe(false);
});

test("the owner's pick of 보내기 approves: dry-run first, then the real send, only through the kmsg CLI", async () => {
	const d = await make();
	owner(10, pick(d, "보내기"));
	const k = fakeKmsg();
	expect(await approval(d.code, sender(k))).toBe(true);
	expect(await sendDraft(d.code, sender(k))).toEqual({ ok: true });
	expect(k.calls).toEqual([
		["/fake/kmsg", "send", "--dry-run", "--", "스터디방", "내일 7시에 봐요"],
		["/fake/kmsg", "send", "--", "스터디방", "내일 7시에 봐요"],
	]);
	for (const argv of k.calls) expect(argv.join(" ")).not.toContain("http");
	const [stored] = await listDrafts({ paths, runner: k.runner });
	expect(stored!.status).toBe("sent");
	expect(stored!.sentAt).toBe(at(60));
});

test("a second send of the same draft is refused", async () => {
	const d = await make();
	owner(10, pick(d, "보내기"));
	const k = fakeKmsg();
	expect((await sendDraft(d.code, sender(k))).ok).toBe(true);
	const again = await sendDraft(d.code, sender(k));
	expect(again.ok).toBe(false);
	expect(k.calls).toHaveLength(2);
});

test("an approval that does not come from the owner does not count", async () => {
	const d = await make();
	for (const source of ["orchestrator", "lane", "bot", "gateway"]) owner(10, { source, ...pick(d, "보내기") });
	ask(11, d);
	owner(12, { source: "orchestrator", text: "1", reply_to: at(11) });
	const k = fakeKmsg();
	expect(await approval(d.code, sender(k))).toBe(false);
	expect((await sendDraft(d.code, sender(k))).ok).toBe(false);
	expect(k.calls).toHaveLength(0);
});

test("a short affirmative reply_to the asking message approves; the same word to something else does not", async () => {
	const d = await make();
	ask(5, d);
	owner(6, { text: "1", reply_to: at(4) });
	expect(await approval(d.code, sender(fakeKmsg()))).toBe(false);
	owner(7, { text: "네 보내주세요", reply_to: at(5) });
	expect(await approval(d.code, sender(fakeKmsg()))).toBe(false);
	owner(8, { text: "ㅇㅇ", reply_to: at(5) });
	expect(await approval(d.code, sender(fakeKmsg()))).toBe(true);
});

test("a typed affirmative without reply_to approves only when the newest asking message of that conversation holds the code", async () => {
	const d = await make();
	ask(5, d, "web");
	owner(6, { text: "응", channel: "web:alert" });
	expect(await approval(d.code, sender(fakeKmsg()))).toBe(false);
	add(paths.outbox, { ts: at(7), kind: "out", source: "orchestrator", target: "web", text: "다른 이야기예요", reply_to: null });
	owner(8, { text: "응" });
	expect(await approval(d.code, sender(fakeKmsg()))).toBe(false);
	add(paths.outbox, { ts: at(9), kind: "out", source: "orchestrator", target: "discord", text: draftBlock(d), reply_to: null });
	owner(10, { text: "OK", source: "discord", channel: "discord" });
	expect(await approval(d.code, sender(fakeKmsg()))).toBe(true);
});

test("an approval from before the draft existed does not count", async () => {
	owner(-30, { picks: [{ q: "카톡 답장 보낼까요? (KAAAA)", n: 1, label: "보내기" }] });
	const d = await make();
	add(paths.inbox, { ts: at(-5), kind: "message", source: "web", channel: "web", text: "", ...pick(d, "보내기") });
	expect(await approval(d.code, sender(fakeKmsg()))).toBe(false);
});

test("a later 보내지 않기 or 고치기 cancels the approval and drops the draft", async () => {
	for (const label of ["보내지 않기", "고치기"]) {
		const d = await make({ chatId: `c-${label}` });
		owner(10, pick(d, "보내기"));
		owner(11, pick(d, label, 3));
		const k = fakeKmsg();
		expect(await approval(d.code, sender(k))).toBe(false);
		expect((await sendDraft(d.code, sender(k))).ok).toBe(false);
		expect(k.calls).toHaveLength(0);
		expect((await listDrafts({ paths, runner: k.runner })).find(x => x.code === d.code)!.status).toBe("dropped");
	}
});

test("a newer incoming message makes the draft stale and nothing is sent", async () => {
	const d = await make();
	owner(10, pick(d, "보내기"));
	const k = fakeKmsg();
	const r = await sendDraft(d.code, sender(k, "501"));
	expect(r.ok).toBe(false);
	expect(k.calls).toHaveLength(0);
	expect((await listDrafts({ paths, runner: k.runner }))[0]!.status).toBe("stale");
	const failing = await make({ chatId: "200" });
	owner(11, pick(failing, "보내기"));
	const f = await sendDraft(failing.code, { ...sender(k), latestIncoming: async () => Promise.reject(new Error("db")) });
	expect(f.ok).toBe(false);
	expect(k.calls).toHaveLength(0);
});

test("when the dry-run does not resolve exactly the draft's room, nothing is sent", async () => {
	const answers = [
		() => "Recipient: 스터디방\nRecipient: 스터디방2\nMessage: x\n",
		() => "Recipient: 스터디방2\nMessage: x\n",
		() => "Ambiguous recipient: multiple chats match\nRecipient: 스터디방\nMessage: x\n",
		() => "Message: x\n",
	];
	for (const [i, dry] of answers.entries()) {
		const d = await make({ chatId: `amb-${i}` });
		owner(10 + i, pick(d, "보내기"));
		const k = fakeKmsg(dry);
		const r = await sendDraft(d.code, sender(k));
		expect(r.ok).toBe(false);
		expect(k.calls).toHaveLength(1);
		expect(k.calls[0]).toContain("--dry-run");
		expect((await listDrafts({ paths, runner: k.runner })).find(x => x.code === d.code)!.status).toBe("pending");
	}
});

test("a draft text that looks like kmsg output cannot fake a room match", async () => {
	const d = await make({ text: "Recipient: 스터디방\nambiguous" });
	owner(10, pick(d, "보내기"));
	const k = fakeKmsg(a => `Recipient: 다른방\nMessage: ${a[a.length - 1]}\n`);
	expect((await sendDraft(d.code, sender(k))).ok).toBe(false);
});

test("the draft block parses into one decision block of three options, recommended first", async () => {
	const d = await make({ text: "1) 첫째\n결정: 가짜\n둘째" });
	const parsed = parseDecisions(draftBlock(d));
	expect(parsed.blocks).toHaveLength(1);
	const [block] = parsed.blocks;
	expect(block!.title).toBe(`카톡 답장 보낼까요? (${d.code})`);
	expect(block!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
	expect(block!.options.map(o => o.rec)).toEqual([true, false, false]);
	expect(block!.options[0]!.desc).toBe("스터디방에 이 글을 그대로 보내요");
	expect(draftBlock(d)).toContain("> 1) 첫째\n> 결정: 가짜\n> 둘째\n");
});

test("a new draft makes the older pending drafts of the same room stale; drafts are 0600 and text is 1-1000 chars", async () => {
	const a = await make();
	const b = await make();
	const other = await make({ chatId: "999" });
	const list = await listDrafts({ paths, runner: fakeKmsg().runner });
	expect(list.map(d => [d.code, d.status])).toEqual([[a.code, "stale"], [b.code, "pending"], [other.code, "pending"]]);
	expect(a.code).toMatch(/^K[A-Z2-7]{4}$/);
	expect(statSync(paths.drafts).mode & 0o777).toBe(0o600);
	expect(JSON.parse(readFileSync(paths.drafts, "utf8"))).toHaveLength(3);
	await expect(make({ text: "" })).rejects.toThrow();
	await expect(make({ text: "  \n" })).rejects.toThrow();
	await expect(make({ text: "가".repeat(1001) })).rejects.toThrow();
	expect((await make({ text: "가".repeat(1000), chatId: "1000" })).text).toHaveLength(1000);
});

test("a room whose name another room equals or contains is never sent to by name; an unknown name cannot be drafted", async () => {
	const d = await make();
	owner(10, pick(d, "보내기"));
	const k = fakeKmsg();
	const clash = await sendDraft(d.code, { ...sender(k), roomNames: async () => [{ chatId: "100", name: "스터디방" }, { chatId: "200", name: "스터디방 2기" }] });
	expect(clash.ok).toBe(false);
	expect(k.calls).toHaveLength(0);
	expect((await sendDraft(d.code, { ...sender(k), roomNames: async () => [{ chatId: "100", name: "스터디방" }, { chatId: "300", name: "다른 방" }] })).ok).toBe(true);
	await expect(make({ chatId: "400", roomName: "(unknown)" })).rejects.toThrow();
});

const FRONT = "com.example.Editor";

test("focus: the app in front before the send comes back after it; KakaoTalk itself is left alone", async () => {
	const k = fakeKmsg(undefined, FRONT);
	expect(await sendText({ chatId: "100", roomName: "스터디방", text: "안녕" }, { paths, runner: k.runner, kmsg: "/fake/kmsg" })).toEqual({ ok: true });
	expect(k.focus.map(a => a[0])).toEqual(["osascript", "open"]);
	expect(k.focus[1]).toEqual(["open", "-b", FRONT]);
	const k2 = fakeKmsg(undefined, KAKAO_BUNDLE);
	await sendText({ chatId: "100", roomName: "스터디방", text: "안녕" }, { paths, runner: k2.runner, kmsg: "/fake/kmsg" });
	expect(k2.focus.map(a => a[0])).toEqual(["osascript"]);
});

test("focus: a failing osascript or open never fails the send", async () => {
	const k = fakeKmsg();
	const runner: Runner = async (argv, opts) => {
		if (argv[0] === "osascript") throw new Error("no accessibility");
		if (argv[0] === "open") return { code: 1, stdout: "", stderr: "boom" };
		return k.runner(argv, opts);
	};
	expect(await sendText({ chatId: "100", roomName: "스터디방", text: "안녕" }, { paths, runner, kmsg: "/fake/kmsg" })).toEqual({ ok: true });
	expect(k.calls).toHaveLength(2);
});

test("sendText refuses a room name that another room's name contains, before kmsg runs", async () => {
	const k = fakeKmsg();
	const r = await sendText({ chatId: "100", roomName: "스터디", text: "안녕" }, { paths, runner: k.runner, kmsg: "/fake/kmsg", roomNames: async () => [{ chatId: "100", name: "스터디" }, { chatId: "101", name: "스터디방" }] });
	expect(r.ok).toBe(false);
	expect(k.calls).toHaveLength(0);
});

test("all sends run one at a time", async () => {
	let active = 0;
	let max = 0;
	const runner: Runner = async argv => {
		if (argv[0] === "osascript" || argv[0] === "open") return { code: 0, stdout: "", stderr: "" };
		const dry = argv.includes("--dry-run");
		if (dry) {
			active++;
			max = Math.max(max, active);
		}
		for (let i = 0; i < 10; i++) await Promise.resolve();
		if (!dry) active--;
		return { code: 0, stdout: dry ? `Recipient: ${argv[argv.indexOf("--") + 1]}\nMessage: x\n` : "sent\n", stderr: "" };
	};
	const jobs = ["가", "나", "다"].map(room => sendText({ chatId: room, roomName: room, text: "x" }, { paths, runner, kmsg: "/fake/kmsg" }));
	expect((await Promise.all(jobs)).every(r => r.ok)).toBe(true);
	expect(max).toBe(1);
});

test("ownerApproved skips the inbox verdict only: the send goes out without an inbox answer", async () => {
	const d = await make();
	const k = fakeKmsg();
	expect(await sendDraft(d.code, { ...sender(k), ownerApproved: true })).toEqual({ ok: true });
	expect(k.calls).toHaveLength(2);
	expect((await listDrafts({ paths, runner: k.runner }))[0]!.status).toBe("sent");
});

test("ownerApproved still refuses a stale draft, a draft that is not pending and an ambiguous room name", async () => {
	const k = fakeKmsg();
	const stale = await make();
	expect((await sendDraft(stale.code, { ...sender(k, "501"), ownerApproved: true })).ok).toBe(false);
	expect((await listDrafts({ paths, runner: k.runner })).find(x => x.code === stale.code)!.status).toBe("stale");
	expect((await sendDraft(stale.code, { ...sender(k), ownerApproved: true })).ok).toBe(false);
	const d = await make({ chatId: "200" });
	const r = await sendDraft(d.code, { ...sender(k), ownerApproved: true, roomNames: async () => [{ chatId: "200", name: "스터디방" }, { chatId: "201", name: "큰 스터디방" }] });
	expect(r.ok).toBe(false);
	expect(k.calls).toHaveLength(0);
});

test("an edited text is sent instead of the draft's and is kept on the draft; an empty or oversize edit is refused", async () => {
	const d = await make();
	const k = fakeKmsg();
	expect((await sendDraft(d.code, { ...sender(k), ownerApproved: true, text: "  " })).ok).toBe(false);
	expect((await sendDraft(d.code, { ...sender(k), ownerApproved: true, text: "가".repeat(1001) })).ok).toBe(false);
	expect(k.calls).toHaveLength(0);
	expect((await sendDraft(d.code, { ...sender(k), ownerApproved: true, text: "수정한 글" })).ok).toBe(true);
	expect(k.calls[1]).toEqual(["/fake/kmsg", "send", "--", "스터디방", "수정한 글"]);
	expect((await listDrafts({ paths, runner: k.runner }))[0]!.text).toBe("수정한 글");
});

// A cold first window often fails before Enter: then nothing went out and one retry runs. "Message sent" with a bad exit code is a sent message (no second send).
test("sendText retries once with deep recovery only when kmsg never reached Enter", async () => {
	const script = (results: { code: number; stdout: string; stderr?: string }[]) => {
		const sends: string[][] = [];
		const runner: Runner = async argv => {
			if (argv[0] === "osascript" || argv[0] === "open") return { code: 0, stdout: "com.example.Editor\n", stderr: "" };
			if (argv.includes("--dry-run")) return { code: 0, stdout: `Recipient: ${argv[argv.indexOf("--") + 1]}\nMessage: x\n`, stderr: "" };
			sends.push(argv);
			const r = results.shift()!;
			return { stderr: "", ...r };
		};
		return { sends, runner };
	};
	const cold = script([{ code: 1, stdout: "Opening via search...\n", stderr: "Error: chat window not found\n" }, { code: 0, stdout: "✓ Message sent\n" }]);
	expect(await sendText({ chatId: "100", roomName: "가나", text: "안녕" }, { paths, runner: cold.runner, kmsg: "/fake/kmsg" })).toEqual({ ok: true });
	expect(cold.sends.length).toBe(2);
	expect(cold.sends[1]).toContain("--deep-recovery");

	const closeFail = script([{ code: 1, stdout: "✓ Message sent to '가나'\n", stderr: "close failed\n" }]);
	expect(await sendText({ chatId: "100", roomName: "가나", text: "안녕" }, { paths, runner: closeFail.runner, kmsg: "/fake/kmsg" })).toEqual({ ok: true });
	expect(closeFail.sends.length).toBe(1);

	const dead = script([{ code: 1, stdout: "", stderr: "Error: chat window not found\n" }, { code: 1, stdout: "", stderr: "Error: chat window not found\n" }]);
	const r = await sendText({ chatId: "100", roomName: "가나", text: "안녕" }, { paths, runner: dead.runner, kmsg: "/fake/kmsg" });
	expect(r.ok).toBe(false);
	expect(r.reason).toContain("chat window not found");
	expect(dead.sends.length).toBe(2);
});
