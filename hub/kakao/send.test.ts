import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecisions } from "../choices.ts";
import { approval, createDraft, draftBlock, forgetWarm, listDrafts, sendDraft, sendText, type Draft } from "./send.ts";
import { KAKAO_BUNDLE, kakaoPaths, type Runner } from "./types.ts";
import { type FakeRow, fakeScreen } from "./ui.fixture.ts";

const T0 = Date.parse("2026-10-22T00:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kk-send-"));
	paths = kakaoPaths(dir, dir);
	mkdirSync(join(dir, "kakao"), { recursive: true });
	forgetWarm();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const add = (file: string, e: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify(e)}\n`);
const owner = (sec: number, e: Record<string, unknown> = {}) => add(paths.inbox, { ts: at(sec), kind: "message", source: "web", channel: "web", author: "me", text: "", ...e });
const ask = (sec: number, d: Draft, target = "web") => add(paths.outbox, { ts: at(sec), kind: "out", source: "orchestrator", target, text: draftBlock(d), reply_to: null });
const pick = (d: Draft, label: string, n = 1) => ({ picks: [{ q: `카톡 답장 보낼까요? (${d.code})`, n, label }] });

// A fake KakaoTalk screen: every room of the tests is one list row whose window shows its own title. `calls` are the sends only.
const row = (title: string, window: FakeRow["window"] = { title }): FakeRow => ({ id: `chat_${title}`, title, window });
const ROWS = ["스터디방", "스터디", "가나", "가", "나", "다"].map(t => row(t));
function fakeKmsg(front = "com.example.Editor", rows: FakeRow[] = ROWS) {
	const s = fakeScreen(rows, { front });
	return { calls: s.sends, focus: s.focus, runner: s.runner };
}

const base = { chatId: "100", roomName: "스터디방", text: "내일 7시에 봐요", basisLogId: "500" };
const make = (over: Partial<typeof base> = {}) => createDraft({ ...base, ...over }, { paths, runner: fakeKmsg().runner, now: () => T0 });
const sender = (k: ReturnType<typeof fakeKmsg>, latest: string | undefined = "500") => ({ paths, runner: k.runner, now: () => T0 + 60_000, latestIncoming: async () => latest });

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

test("the owner's pick of 보내기 approves: the row is opened and checked, then one send by Accessibility, never an HTTP call", async () => {
	const d = await make();
	owner(10, pick(d, "보내기"));
	const k = fakeKmsg();
	expect(await approval(d.code, sender(k))).toBe(true);
	expect(await sendDraft(d.code, sender(k))).toMatchObject({ ok: true });
	expect(k.calls).toEqual([["ax-send", "스터디방", "내일 7시에 봐요"]]);
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
	expect(k.calls).toHaveLength(1);
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

test("when the open window is not exactly the draft's room, nothing is sent and the draft stays pending", async () => {
	const twins = [{ chatId: "100", name: "스터디방" }, { chatId: "101", name: "스터디방" }];
	const cases: [string, FakeRow[], typeof twins | undefined][] = [
		["wrong title", [row("스터디방", { title: "다른방" })], undefined],
		["unreadable", [row("스터디방", "unreadable")], undefined],
		["same name in the database, no member count to tell the rows apart", [row("스터디방"), { ...row("스터디방"), id: "chat_2" }], twins],
		["no row", [], undefined],
	];
	for (const [i, [, rows, names]] of cases.entries()) {
		const d = await make({ chatId: `amb-${i}`, text: "Recipient: 스터디방\nambiguous" });
		owner(10 + i, pick(d, "보내기"));
		const k = fakeKmsg(undefined, rows);
		const r = await sendDraft(d.code, { ...sender(k), ...(names ? { roomNames: async () => names } : {}) });
		expect(r.ok).toBe(false);
		expect(r.reason).toBeTruthy();
		expect(k.calls).toHaveLength(0);
		expect((await listDrafts({ paths, runner: k.runner })).find(x => x.code === d.code)!.status).toBe("pending");
	}
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

test("a longer room name does not block the send (only the exact list row counts); an unknown name cannot be drafted", async () => {
	const d = await make();
	owner(10, pick(d, "보내기"));
	const k = fakeKmsg(undefined, [...ROWS, row("스터디방 2기")]);
	const names = async () => [{ chatId: "100", name: "스터디방" }, { chatId: "200", name: "스터디방 2기" }];
	expect((await sendDraft(d.code, { ...sender(k), roomNames: names })).ok).toBe(true);
	expect(k.calls[0]).toEqual(["ax-send", "스터디방", "내일 7시에 봐요"]);
	await expect(make({ chatId: "400", roomName: "(unknown)" })).rejects.toThrow();
});

const FRONT = "com.example.Editor";

test("focus: KakaoTalk is never opened, activated or refocused; the owner's app keeps the focus whatever is in front", async () => {
	for (const front of [FRONT, KAKAO_BUNDLE]) {
		const k = fakeKmsg(front);
		expect(await sendText({ chatId: "100", roomName: "스터디방", text: "안녕" }, { paths, runner: k.runner })).toMatchObject({ ok: true });
		expect(k.focus.map(a => a[0])).toEqual(["osascript"]);
	}
});

test("focus: a failing frontmost lookup never fails the send", async () => {
	const k = fakeKmsg();
	const runner: Runner = async (argv, opts) => {
		if (argv[0] === "osascript" && argv[1] !== "-l") throw new Error("no accessibility");
		return k.runner(argv, opts);
	};
	expect(await sendText({ chatId: "100", roomName: "스터디방", text: "안녕" }, { paths, runner })).toMatchObject({ ok: true });
	expect(k.calls).toHaveLength(1);
});

test("sendText refuses a room that has no list row of exactly its name, before anything is opened", async () => {
	const k = fakeKmsg(undefined, [row("스터디방")]);
	const r = await sendText({ chatId: "100", roomName: "스터디", text: "안녕" }, { paths, runner: k.runner });
	expect(r.ok).toBe(false);
	expect(k.calls).toHaveLength(0);
});

test("all sends run one at a time", async () => {
	let active = 0;
	let max = 0;
	const screen = fakeScreen(["가", "나", "다"].map(t => row(t)));
	const runner: Runner = async (argv, o) => {
		const action = argv[1] === "-l" ? JSON.parse(o!.stdin!.trim()).action : "";
		if (action === "rows") {
			active++;
			max = Math.max(max, active);
		}
		for (let i = 0; i < 10; i++) await Promise.resolve();
		const r = await screen.runner(argv, o);
		if (action === "send") active--;
		return r;
	};
	const jobs = ["가", "나", "다"].map(room => sendText({ chatId: room, roomName: room, text: "x" }, { paths, runner }));
	expect((await Promise.all(jobs)).every(r => r.ok)).toBe(true);
	expect(max).toBe(1);
});

test("ownerApproved skips the inbox verdict only: the send goes out without an inbox answer", async () => {
	const d = await make();
	const k = fakeKmsg();
	expect(await sendDraft(d.code, { ...sender(k), ownerApproved: true })).toMatchObject({ ok: true });
	expect(k.calls).toHaveLength(1);
	expect((await listDrafts({ paths, runner: k.runner }))[0]!.status).toBe("sent");
});

test("ownerApproved still refuses a stale draft, a draft that is not pending and an ambiguous room name", async () => {
	const k = fakeKmsg();
	const stale = await make();
	expect((await sendDraft(stale.code, { ...sender(k, "501"), ownerApproved: true })).ok).toBe(false);
	expect((await listDrafts({ paths, runner: k.runner })).find(x => x.code === stale.code)!.status).toBe("stale");
	expect((await sendDraft(stale.code, { ...sender(k), ownerApproved: true })).ok).toBe(false);
	const d = await make({ chatId: "200" });
	const twins = fakeKmsg(undefined, [row("스터디방"), { ...row("스터디방"), id: "chat_twin" }]);
	const r = await sendDraft(d.code, { ...sender(twins), roomNames: async () => [{ chatId: "200", name: "스터디방" }, { chatId: "201", name: "스터디방" }], ownerApproved: true });
	expect(r.ok).toBe(false);
	expect(twins.calls).toHaveLength(0);
});

test("an edited text is sent instead of the draft's and is kept on the draft; an empty or oversize edit is refused", async () => {
	const d = await make();
	const k = fakeKmsg();
	expect((await sendDraft(d.code, { ...sender(k), ownerApproved: true, text: "  " })).ok).toBe(false);
	expect((await sendDraft(d.code, { ...sender(k), ownerApproved: true, text: "가".repeat(1001) })).ok).toBe(false);
	expect(k.calls).toHaveLength(0);
	expect((await sendDraft(d.code, { ...sender(k), ownerApproved: true, text: "수정한 글" })).ok).toBe(true);
	expect(k.calls[0]).toEqual(["ax-send", "스터디방", "수정한 글"]);
	expect((await listDrafts({ paths, runner: k.runner }))[0]!.text).toBe("수정한 글");
});

// Fast path: a window kept open, the frontmost lookup beside the send, the idle close, the phase times.
const one = { chatId: "100", roomName: "가나", text: "안녕" };
const names = async () => [{ chatId: "100", name: "가나" }];

test("keep window: only while KakaoTalk shows a window or the room was kept before; the idle close runs once after the last send", async () => {
	const timers: (() => void)[] = [];
	const later = (fn: () => void) => void timers.push(fn);
	const deps = { paths, roomNames: names, later };
	const shown = fakeScreen([row("가나")], { kakaoShown: true });
	expect(await sendText(one, { ...deps, runner: shown.runner })).toMatchObject({ ok: true, ms: { keep: true } });
	expect(shown.closes()).toBe(0);
	// KakaoTalk is hidden now, but its window was kept: the next send of the room keeps it too and moves the idle close.
	const hidden = fakeScreen([row("가나")], { kakaoShown: false });
	expect(await sendText(one, { ...deps, runner: hidden.runner })).toMatchObject({ ok: true, ms: { keep: true } });
	expect(timers).toHaveLength(2);
	timers[0]!();
	expect(await sendText({ ...one, text: "다시" }, { ...deps, runner: hidden.runner })).toMatchObject({ ok: true, ms: { keep: true } });
	expect(hidden.closes()).toBe(0);
	timers[2]!();
	const last = await sendText({ ...one, text: "끝" }, { ...deps, runner: hidden.runner }); // queued behind the idle close
	expect(hidden.closes()).toBe(2);
	expect(last.ms!.keep).toBeUndefined();
	// No kept window and KakaoTalk not shown: nothing is kept, the window is closed after the send.
	forgetWarm();
	const cold = fakeScreen([row("가나")], { kakaoShown: false });
	expect(await sendText(one, { ...deps, runner: cold.runner })).toMatchObject({ ok: true });
	expect(cold.closes()).toBe(1);
	expect(timers).toHaveLength(3);
});

test("the frontmost lookup runs beside the send: the text is in before the lookup answers, and the owner's app is never refocused", async () => {
	const deps = { paths, roomNames: names, later: () => {} };
	await sendText(one, { ...deps, runner: fakeScreen([row("가나")], { kakaoShown: true }).runner });
	const screen = fakeScreen([row("가나")], { front: FRONT });
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const runner: Runner = async (argv, o) => {
		if (argv[0] === "osascript" && argv[1] !== "-l") await gate;
		if (argv[1] === "-l" && JSON.parse(o!.stdin!.trim()).action === "send") release();
		return screen.runner(argv, o);
	};
	expect(await sendText(one, { ...deps, runner })).toMatchObject({ ok: true });
	expect(screen.order).toEqual(["ax-open", "send", "front"]);
	expect(screen.focus.filter(a => a[0] === "open")).toEqual([]);
});

test("the phase times of a send are on its result", async () => {
	const screen = fakeScreen([row("가나")]);
	const r = await sendText(one, { paths, runner: screen.runner, roomNames: names });
	expect(Object.keys(r.ms ?? {}).sort()).toEqual(["front", "pick", "send", "total"]);
	expect(r.ms!.total).toBeGreaterThanOrEqual(r.ms!.send);
	expect(r.ax!.map(a => a.step)).toEqual(["rows", "open", "verify", "input"]);
});

const leftFile = () => join(dir, "kakao", "input.json");
const readsLeft = () => JSON.parse(readFileSync(leftFile(), "utf8"));

// The owner's report: a failed attempt (not_set) left dotz's text in the input, so the next attempt failed as busy.
test("our own text left in the input is recognized, cleared and sent on the next attempt (not the owner's busy)", async () => {
	const screen = fakeScreen([row("가나")], { axSend: n => (n === 1 ? { ok: false, why: "not_set", left: "안녕" } : { ok: true }) });
	const r = await sendText(one, { paths, runner: screen.runner, roomNames: names });
	expect(r).toMatchObject({ ok: true });
	expect(screen.sends).toHaveLength(2);
	expect(r.attempts!.map(a => [a.n, a.recovery, a.state])).toEqual([[1, "none", "failed"], [2, "retry", "sent"]]);
	expect(readsLeft()["100"]).toBeUndefined();
});

test("a text of dotz left by an earlier send is passed as ours, so the next send into that room clears it instead of refusing", async () => {
	const failing = fakeScreen([row("가나")], { axSend: () => ({ ok: false, why: "not_set", left: "지난 글" }) });
	expect((await sendText(one, { paths, runner: failing.runner, roomNames: names })).ok).toBe(false);
	expect(readsLeft()["100"]).toMatchObject({ text: "지난 글" });
	const next = fakeScreen([row("가나")]);
	expect(await sendText({ ...one, text: "새 글" }, { paths, runner: next.runner, roomNames: names })).toMatchObject({ ok: true });
	expect(next.sendReqs[0]!.ours).toContain("지난 글");
	// The owner's own different text is never treated as dotz's.
	const busy = fakeScreen([row("가나")], { axSend: () => ({ ok: false, why: "owner_text", preview: "내가 쓰던 글" }) });
	const refused = await sendText({ ...one, text: "새 글" }, { paths, runner: busy.runner, roomNames: names });
	expect(refused.ok).toBe(false);
	expect(refused.reason).toContain("내가 쓰던 글");
	expect(refused.reason).not.toContain("owner_text");
	expect(busy.sendReqs[0]!.priorPressed).toBeUndefined();
	expect(busy.sends).toHaveLength(1);
});

test("a pressed attempt whose send is not in the database is unconfirmed and never pressed again by the next send", async () => {
	const first = fakeScreen([row("가나")], { axSend: () => ({ ok: false, why: "unclear", pressed: true }) });
	const r = await sendText(one, { paths, runner: first.runner, roomNames: names, confirm: async () => false, sleep: async () => {} });
	expect(r).toMatchObject({ ok: false, unconfirmed: true });
	expect(first.sends).toHaveLength(1);
	expect(readsLeft()["100"]).toMatchObject({ text: "안녕", pressed: true });
	const next = fakeScreen([row("가나")]);
	expect(await sendText({ ...one, text: "다른 글" }, { paths, runner: next.runner, roomNames: names })).toMatchObject({ ok: true });
	expect(next.sendReqs[0]!.priorPressed).toContain("안녕");
});

test("the press is confirmed by the database: found is sent, not found is unconfirmed and nothing is sent twice", async () => {
	const found = fakeScreen([row("가나")]);
	const ok = await sendText(one, { paths, runner: found.runner, roomNames: names, confirm: async () => true });
	expect(ok).toMatchObject({ ok: true });
	expect(found.sends).toHaveLength(1);
	const missing = fakeScreen([row("가나")]);
	const lost = await sendText(one, { paths, runner: missing.runner, roomNames: names, confirm: async () => false });
	expect(lost).toMatchObject({ ok: false, unconfirmed: true });
	expect(lost.reason).toContain("다시 보내지 않았으니");
	expect(missing.sends).toHaveLength(1);
});

test("a send that fails everywhere writes every attempt into the send record, and the room's failure reason has no raw code", async () => {
	const file = join(dir, "kakao", "sends.json");
	const screen = fakeScreen([row("가나")], { openFail: { step: "menu", why: "no_menu" } });
	const r = await sendText(one, { paths, runner: screen.runner, roomNames: names });
	expect(r.ok).toBe(false);
	expect(r.reason).not.toContain("no_menu");
	expect(r.attempts).toHaveLength(5);
	expect(r.attempts!.map(a => a.recovery)).toEqual(["none", "retry", "reopen", "deep", "front"]);
	const stored = JSON.parse(readFileSync(file, "utf8"));
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({ chatId: "100", state: "failed" });
	expect(stored[0].attempts.map((a: { n: number }) => a.n)).toEqual([1, 2, 3, 4, 5]);
	expect(stored[0].attempts[0].ax.at(-1)).toMatchObject({ step: "menu", ok: false });
});

test("attempts are kept on the send record the gateway already made (one bubble, not one per attempt)", async () => {
	const file = join(dir, "kakao", "sends.json");
	writeFileSync(file, JSON.stringify([{ id: "Ssent", chatId: "100", text: "안녕", state: "sending", at: Date.now(), collector: "mac-a" }]));
	const screen = fakeScreen([row("가나")], { axSend: n => (n === 1 ? { ok: false, why: "not_set" } : { ok: true }) });
	expect(await sendText(one, { paths, runner: screen.runner, roomNames: names })).toMatchObject({ ok: true });
	const stored = JSON.parse(readFileSync(file, "utf8"));
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({ id: "Ssent", state: "sending" });
	expect(stored[0].attempts).toHaveLength(2);
});
