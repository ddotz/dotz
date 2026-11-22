// Refusals of send.ts and sendfile.ts that no other test pins: each test fails when its guard (or the exact condition) is mutated away.
// Everything runs against fake runners and temp dirs; nothing touches KakaoTalk, Accessibility or the Keychain.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraft, dropDraft, forgetWarm, listDrafts, restoreDraft, sendDraft, type SendResult, sendText } from "./send.ts";
import { sendFilesToSelf } from "./sendfile.ts";
import { kakaoPaths, type Msg, type Runner } from "./types.ts";
import { type FakeRow, fakeScreen } from "./ui.fixture.ts";

let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kk-refuse-"));
	paths = kakaoPaths(dir, dir);
	mkdirSync(join(dir, "kakao"), { recursive: true });
	forgetWarm();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (title: string): FakeRow => ({ id: `chat_${title}`, title, window: { title } });
const noop = async () => {};
const draftIn = { chatId: "100", roomName: "스터디방", text: "내일 7시에 봐요", basisLogId: "500" };
const idle = (screen: ReturnType<typeof fakeScreen>) => ({ paths, runner: screen.runner });

test("a draft without a chat id or without a room name is refused and nothing is stored", async () => {
	const screen = fakeScreen([]);
	await expect(createDraft({ ...draftIn, chatId: "" }, idle(screen))).rejects.toThrow();
	await expect(createDraft({ ...draftIn, roomName: "  " }, idle(screen))).rejects.toThrow();
	expect(await listDrafts(idle(screen))).toEqual([]);
});

test("a room whose name is unknown is refused before KakaoTalk is asked anything", async () => {
	const screen = fakeScreen([row("가나")]);
	const r = await sendText({ chatId: "354", roomName: " (unknown) ", text: "안녕" }, { paths, runner: screen.runner, confirm: async () => true });
	expect(r.ok).toBe(false);
	expect(screen.rowCalls).toEqual([]);
	expect(screen.focus).toEqual([]);
	expect(screen.sends).toEqual([]);
});

// The database is asked for a room's newest message only to tell same-name rooms apart. It is reached through the Keychain CLI, so the
// fake screen's unexpected-call log (`other`) shows whether it was asked at all.
const dbAsked = (screen: ReturnType<typeof fakeScreen>) => screen.other.some(argv => argv[0] === "security");
const withDb = () => writeFileSync(paths.config, JSON.stringify({ dbPath: join(dir, "none.db"), userId: "1" })) as void;
const deps380 = (screen: ReturnType<typeof fakeScreen>, all: { chatId: string; name: string }[]) => ({ paths, runner: screen.runner, roomNames: async () => all, confirm: async () => true, later: () => {}, sleep: noop });

test("the database is asked for the newest message when another room has the same name", async () => {
	mkdirSync(join(dir, "custom", "kakao"), { recursive: true });
	withDb();
	const screen = fakeScreen([row("가나")]);
	await sendText({ chatId: "380", roomName: "가나", text: "안녕" }, deps380(screen, [{ chatId: "380", name: "가나" }, { chatId: "381", name: "가나" }]));
	expect(dbAsked(screen)).toBe(true);
});

test("the database is not asked when the only other room has a different name", async () => {
	mkdirSync(join(dir, "custom", "kakao"), { recursive: true });
	withDb();
	const screen = fakeScreen([row("가나")]);
	const r = await sendText({ chatId: "380", roomName: "가나", text: "안녕" }, deps380(screen, [{ chatId: "380", name: "가나" }, { chatId: "381", name: "다라" }]));
	expect(r.ok).toBe(true);
	expect(dbAsked(screen)).toBe(false);
});

test("a sent text is remembered as dotz's own, and so is a pressed text whose send is not confirmed", async () => {
	const ok = fakeScreen([row("가나")]);
	const base = { paths, runner: ok.runner, confirm: async () => true, later: () => {}, sleep: noop };
	expect((await sendText({ chatId: "445", roomName: "가나", text: "첫 글" }, base)).ok).toBe(true);
	expect((await sendText({ chatId: "445", roomName: "가나", text: "둘째 글" }, base)).ok).toBe(true);
	expect(ok.sendReqs[1]!.ours).toContain("첫 글");

	const pressed = fakeScreen([row("가나")], { axSend: n => (n === 1 ? { ok: false, pressed: true, why: "unsure" } : { ok: true }) });
	const deps = { paths, runner: pressed.runner, confirm: async () => false, later: () => {}, sleep: noop };
	expect((await sendText({ chatId: "446", roomName: "가나", text: "눌린 글" }, deps)).ok).toBe(false);
	await sendText({ chatId: "446", roomName: "가나", text: "다음 글" }, { ...deps, confirm: async () => true });
	expect(pressed.sendReqs.at(-1)!.ours).toContain("눌린 글");
});

test("an unknown draft code is refused by drop, restore and send alike", async () => {
	const screen = fakeScreen([row("스터디방")]);
	expect(dropDraft("KNONE", { paths })).toMatchObject({ ok: false });
	expect(restoreDraft("KNONE", { paths })).toMatchObject({ ok: false });
	const r = await sendDraft("KNONE", { ...idle(screen), latestIncoming: async () => undefined, ownerApproved: true });
	expect(r.ok).toBe(false);
	expect(screen.sends).toEqual([]);
});

test("a dropped draft is not brought back when a newer draft of the room is pending", async () => {
	const screen = fakeScreen([]);
	const first = await createDraft(draftIn, idle(screen));
	expect(dropDraft(first.code, { paths })).toEqual({ ok: true });
	const second = await createDraft({ ...draftIn, text: "새 초안" }, idle(screen));
	expect(restoreDraft(first.code, { paths })).toMatchObject({ ok: false });
	const status = async (code: string) => (await listDrafts(idle(screen))).find(d => d.code === code)!.status;
	expect(await status(first.code)).toBe("dropped");
	expect(await status(second.code)).toBe("pending");
	expect(dropDraft(second.code, { paths })).toEqual({ ok: true });
	expect(restoreDraft(first.code, { paths })).toEqual({ ok: true });
	expect(await status(first.code)).toBe("pending");
});

// The KakaoTalk table of the reply design's failure taxonomy: every send that did not end as sent says whether anything may be in the room
// (`sent`) and why (`code`). Each case fails when its branch answers another class or code.
const approved = (screen: ReturnType<typeof fakeScreen>, over: Record<string, unknown> = {}) => ({ paths, runner: screen.runner, latestIncoming: async () => "500", ownerApproved: true, confirm: async () => true, later: () => {}, sleep: noop, ...over });
let chat = 0;
const draftOf = async (over: Partial<typeof draftIn> = {}) => createDraft({ ...draftIn, chatId: `t${++chat}`, ...over }, { paths, runner: fakeScreen([]).runner });
const room = () => fakeScreen([row("스터디방")]);
const withPressing = async (code: string) => {
	const list = await listDrafts({ paths, runner: room().runner });
	writeFileSync(paths.drafts, JSON.stringify(list.map(d => (d.code === code ? { ...d, pressing: { part: 0, text: d.text, at: 1 } } : d))));
};

test("outcome: every KakaoTalk send result says whether anything may be in the room, with its reason code", async () => {
	const cases: [string, () => Promise<SendResult>, Partial<SendResult>][] = [
		["unknown draft", () => sendDraft("KNONE", approved(room())), { sent: "no", code: "gone" }],
		["dropped draft", async () => {
			const d = await draftOf();
			dropDraft(d.code, { paths });
			return sendDraft(d.code, approved(room()));
		}, { sent: "no", code: "gone" }],
		["empty text", async () => sendDraft((await draftOf()).code, approved(room(), { text: "  " })), { sent: "no", code: "empty" }],
		["too long", async () => sendDraft((await draftOf()).code, approved(room(), { text: "가".repeat(1001) })), { sent: "no", code: "too_long" }],
		["no approval", async () => sendDraft((await draftOf()).code, approved(room(), { ownerApproved: false })), { sent: "no", code: "not_approved" }],
		["newer message unreadable", async () => sendDraft((await draftOf()).code, approved(room(), { latestIncoming: () => Promise.reject(new Error("db")) })), { sent: "no", code: "app_not_ready" }],
		["newer message", async () => sendDraft((await draftOf()).code, approved(room(), { latestIncoming: async () => "501" })), { sent: "no", code: "stale" }],
		["sender died holding the claim", async () => {
			const d = await draftOf();
			mkdirSync(join(dir, "kakao", "sending"), { recursive: true });
			writeFileSync(join(dir, "kakao", "sending", d.code), `${process.pid} Mon Jan  1 00:00:00 2001`);
			return sendDraft(d.code, approved(room()));
		}, { sent: "maybe", code: "interrupted" }],
		["died at the press, database cannot confirm", async () => {
			const d = await draftOf();
			await withPressing(d.code);
			return sendDraft(d.code, approved(room(), { confirm: async () => undefined }));
		}, { sent: "maybe", code: "press_unconfirmed", unconfirmed: true }],
		["already sent but unconfirmed", async () => {
			const d = await draftOf();
			await withPressing(d.code);
			await sendDraft(d.code, approved(room(), { confirm: async () => false }));
			return sendDraft(d.code, approved(room()));
		}, { sent: "no", code: "needs_resolve" }],
		["already sent", async () => {
			const d = await draftOf();
			await sendDraft(d.code, approved(room()));
			return sendDraft(d.code, approved(room()));
		}, { sent: "no", code: "already_sent" }],
		["room name unknown", () => sendText({ chatId: "u1", roomName: "(unknown)", text: "안녕" }, approved(room())), { sent: "no", code: "room_unknown" }],
		["no list row of that room", () => sendText({ chatId: "u2", roomName: "없는방", text: "안녕" }, approved(room())), { sent: "no", code: "room_unknown" }],
		["room list unreadable", () => sendText({ chatId: "u3", roomName: "스터디방", text: "안녕" }, approved(room(), { roomNames: () => Promise.reject(new Error("db")) })), { sent: "no", code: "app_not_ready" }],
		["input never ready", () => sendText({ chatId: "u4", roomName: "스터디방", text: "안녕" }, approved(fakeScreen([row("스터디방")], { axSend: () => ({ ok: false, why: "not_set" }) }))), { sent: "no", code: "app_not_ready" }],
		["the owner's text in the input", () => sendText({ chatId: "u5", roomName: "스터디방", text: "안녕" }, approved(fakeScreen([row("스터디방")], { axSend: () => ({ ok: false, why: "owner_text", preview: "내 글" }) }))), { sent: "no", code: "input_busy" }],
		["pressed, not confirmed", () => sendText({ chatId: "u6", roomName: "스터디방", text: "안녕" }, approved(fakeScreen([row("스터디방")], { axSend: () => ({ ok: false, why: "unclear", pressed: true }) }), { confirm: async () => false })), { sent: "maybe", code: "press_unconfirmed", unconfirmed: true }],
		["some parts in the room", async () => {
			const d = await draftOf({ text: "첫째\n\n둘째" });
			return sendDraft(d.code, approved(fakeScreen([row("스터디방")], { axSend: (_n, req) => (req.text === "둘째" ? { ok: false, why: "not_set" } : { ok: true }) })));
		}, { sent: "partial", done: 1, total: 2, code: "app_not_ready" }],
	];
	for (const [name, run, want] of cases) {
		forgetWarm();
		const r = await run();
		expect({ name, ok: r.ok, sent: r.sent, code: r.code, done: r.done, total: r.total, unconfirmed: r.unconfirmed }).toMatchObject({ name, ok: false, ...want });
	}
});

test("a state file that cannot be written is logged and the send ends as state_write: it may be in the room and is never pressed again", async () => {
	mkdirSync(join(dir, "kakao", "sends.json", "blocked"), { recursive: true });
	const screen = room();
	const d = await draftOf();
	expect(await sendDraft(d.code, approved(screen))).toMatchObject({ ok: false, sent: "maybe", code: "state_write", unconfirmed: true });
	expect(readFileSync(join(dir, "hub.log"), "utf8")).toContain("state file sends.json could not be written");
	expect((await listDrafts(idle(screen))).find(x => x.code === d.code)).toMatchObject({ status: "sent", unconfirmed: true });
	expect(await sendDraft(d.code, approved(screen))).toMatchObject({ ok: false, sent: "no", code: "needs_resolve" });
	expect(screen.sends).toHaveLength(1);
});

const me = (logId: string, type: number): Msg => ({ logId, chatId: "777", authorId: "1", sender: "나", text: "", type, sentAt: 0, fromMe: true });
const selfRoom = { chatId: "777", name: "나", kind: "self" as const, members: 1 };
let clock = 0;
const fileDeps = (runner: Runner) => ({ runner, sleep: async (ms: number) => void (clock += ms), now: () => clock });
const windowAnswer = (req: any) => (req.action === "rows" ? { ok: true, rows: 1, scanned: 1, hits: [{ index: 0, texts: ["나"] }], stopped: "found" } : req.action === "probe" ? { ok: true, windows: [{ title: "나", self: true }] } : { ok: true });
function fakeJxa(answer: (req: any) => object) {
	const reqs: any[] = [];
	const runner: Runner = async (_argv, opts) => {
		const req = JSON.parse(opts?.stdin ?? "{}");
		reqs.push(req);
		return { code: 0, stdout: JSON.stringify(answer(req)), stderr: "" };
	};
	return { runner, reqs };
}

test("a file is never sent to a room that is not the self chat, and no window is touched", async () => {
	const { runner, reqs } = fakeJxa(windowAnswer);
	const notSelf = { ...selfRoom, kind: "direct" } as unknown as typeof selfRoom;
	const r = await sendFilesToSelf({ files: ["/x/a.png"], room: notSelf, all: [notSelf], messages: async () => [] }, fileDeps(runner));
	expect(r).toMatchObject({ ok: false, sent: 0 });
	expect(reqs).toEqual([]);
});

test("a press that is not an outright failure is judged by the database: a later file message makes it a success", async () => {
	const log: Msg[] = [me("10", 1)];
	const { runner } = fakeJxa(req => {
		if (req.action === "attach") {
			log.push(me("11", 18));
			return { ok: false, why: "dialog_left", pressed: true };
		}
		return windowAnswer(req);
	});
	const r = await sendFilesToSelf({ files: ["/x/a.hwpx"], room: selfRoom, all: [selfRoom], messages: async n => log.slice(-n) }, fileDeps(runner));
	expect(r).toMatchObject({ ok: true, sent: 1 });
});
