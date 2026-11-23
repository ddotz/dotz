import { appendFileSync, existsSync, statSync, truncateSync } from "node:fs";
import { afterAll, expect, spyOn, test } from "bun:test";
import { paths } from "./config.ts";
import { emit } from "./events.ts";
import { deleteMail, mailByKey, recordMail } from "./mail.ts";
import * as noticeWords from "./notice.ts";
import { markRead } from "./reads.ts";

const logSizes = [paths.inbox, paths.outbox].map(file => [file, existsSync(file) ? statSync(file).size : 0] as const);
afterAll(() => {
	deleteMail("fl-mail");
	for (const [file, size] of logSizes) if (existsSync(file)) truncateSync(file, size);
});
const line = (e: object) => `${JSON.stringify(e)}\n`;
const stamp = (start: number, i: number) => new Date(start + i * 1000).toISOString();
const post = (ts: string, target: string, text: string, extra: object = {}) => line({ ts, kind: "out", source: "orchestrator", target, text, ...extra });
const rowOf = (list: { target: string }[], target: string) => list.find(c => c.target === target);

test("the first list after a restart converts each conversation's newest and first shown message and the unread ones, not every logged message", async () => {
	const base = Date.UTC(2031, 0, 1);
	const at = (target: number, i: number) => stamp(base, i * 10 + target);
	const targets = [21, 22, 23, 24, 25, 26];
	let outbox = "";
	for (const t of targets) for (let i = 0; i < 100; i++) outbox += post(at(t, i), `ch:${t}`, `첫목록 채널 ${t} 의 ${i}번째 답이에요`);
	appendFileSync(paths.outbox, outbox);
	for (const t of targets) markRead({ target: `ch:${t}`, ts: at(t, t === 24 ? 89 : 99) });

	const words = spyOn(noticeWords, "noticeKo");
	const { conversationList } = await import("./conversations.ts?first-load-count");
	const list = conversationList();
	const converted = words.mock.calls.filter(([text]) => String(text).includes("첫목록")).length;
	words.mockRestore();

	for (const t of targets) expect(rowOf(list, `ch:${t}`)).toMatchObject({ last: { ts: at(t, 99), text: `첫목록 채널 ${t} 의 99번째 답이에요`, from: "bot" }, unread: t === 24 ? 10 : 0 });
	expect(converted).toBeLessThanOrEqual(2 * targets.length + 10);
});

test("a message posted after a restart and before the first list counts unread next to 600 read ones", async () => {
	const at = (i: number) => stamp(Date.UTC(2032, 0, 1), i);
	let outbox = "";
	for (let i = 0; i < 600; i++) outbox += post(at(i), "ch:41", `옛 답 ${i}`);
	appendFileSync(paths.outbox, outbox);
	markRead({ target: "ch:41", ts: at(599) });
	const fresh = await import("./conversations.ts?first-load-live");
	emit("outbox", { ts: at(600), kind: "out", source: "orchestrator", target: "ch:41", text: "재시작 뒤 새 답" });
	const row = rowOf(fresh.conversationList(), "ch:41");
	expect(row?.unread).toBe(1);
	expect(row?.last?.ts).toBe(at(600));
});

test("an edit of a post more than 500 posts old counts unread", async () => {
	const at = (i: number) => stamp(Date.UTC(9998, 0, 1), i);
	let outbox = post(at(0), "worklog", "처음 쓴 줄", { update_key: "fl-old" });
	for (let i = 1; i <= 600; i++) outbox += post(at(i), "worklog", `작업 ${i}`);
	outbox += post(at(601), "worklog", "고친 줄", { update_key: "fl-old" });
	appendFileSync(paths.outbox, outbox);
	markRead({ target: "worklog", ts: at(600) });
	const row = rowOf((await import("./conversations.ts?first-load-edit")).conversationList(), "worklog");
	expect(row?.unread).toBe(1);
	expect(row?.last).toEqual({ ts: at(601), text: "고친 줄", from: "bot" });
});

test("an edited post whose newest version shows nothing keeps its last shown version, unread and as the preview", async () => {
	const at = (i: number) => stamp(Date.UTC(9998, 5, 1), i);
	appendFileSync(paths.outbox, post(at(0), "worklog", "보이는 판", { update_key: "fl-blank" }) + post(at(1), "worklog", "[ask]", { update_key: "fl-blank" }));
	markRead({ target: "worklog", ts: at(-1) });
	const row = rowOf((await import("./conversations.ts?first-load-blank")).conversationList(), "worklog");
	expect(row?.last).toEqual({ ts: at(0), text: "보이는 판", from: "bot" });
	expect(row?.unread).toBe(1);
});

test("an edit keeps the slot of its first version: 500 newer posts drop it even though its newest version is unread", async () => {
	const at = (i: number) => stamp(Date.UTC(9997, 0, 1), i);
	let outbox = post(at(0), "alert", "처음 경고", { update_key: "fl-slot" });
	for (let i = 1; i <= 300; i++) outbox += post(at(i), "alert", `경고 ${i}`);
	outbox += post(at(301), "alert", "고친 경고", { update_key: "fl-slot" });
	for (let i = 302; i <= 551; i++) outbox += post(at(i), "alert", `경고 ${i}`);
	appendFileSync(paths.outbox, outbox);
	markRead({ target: "alert", ts: at(300) });
	const row = rowOf((await import("./conversations.ts?first-load-slot")).conversationList(), "alert");
	expect(row?.unread).toBe(250);
	expect(row?.last?.ts).toBe(at(551));
});

test("an unread count after a restart skips the messages that show nothing and keeps at most the newest 500", async () => {
	const at = (target: number, i: number) => stamp(Date.UTC(2033, 0, 1), i * 10 + target);
	let outbox = "";
	for (let i = 0; i < 505; i++) outbox += post(at(1, i), "ch:31", i % 50 === 7 ? "[ask]" : `메시지 ${i}`);
	for (let i = 0; i < 600; i++) outbox += post(at(2, i), "ch:32", `메시지 ${i}`);
	appendFileSync(paths.outbox, outbox);
	for (const t of ["ch:31", "ch:32"]) markRead({ target: t, ts: "2032-12-31T00:00:00.000Z" });
	const list = (await import("./conversations.ts?first-load-cap")).conversationList();
	expect(rowOf(list, "ch:31")).toMatchObject({ unread: 495, last: { text: "메시지 504" } });
	expect(rowOf(list, "ch:32")?.unread).toBe(500);
});

test("owner messages, gateway system lines and a clean restart line are previews but never unread", async () => {
	const at = (i: number) => stamp(Date.UTC(2034, 0, 1), i);
	appendFileSync(paths.inbox, line({ ts: at(1), kind: "message", source: "web", channel: "ch:51", text: "형이 보낸 말" }));
	appendFileSync(
		paths.outbox,
		post(at(0), "ch:51", "읽은 답") +
			line({ ts: at(2), kind: "out", source: "gateway", target: "ch:51", system: true, text: "나중에 할게요" }) +
			post(at(3), "ch:51", "안 읽은 답") +
			line({ ts: at(4), kind: "out", source: "gateway", target: "ch:51", text: "게이트웨이 재시작했어요. 끊긴 작업은 없어요." }),
	);
	markRead({ target: "ch:51", ts: at(0) });
	const row = rowOf((await import("./conversations.ts?first-load-kinds")).conversationList(), "ch:51");
	expect(row?.unread).toBe(1);
	expect(row?.last?.ts).toBe(at(4));
});

test("conversations whose newest messages share a time keep the order of their first shown message", async () => {
	const at = (i: number) => stamp(Date.UTC(2035, 0, 1), i);
	appendFileSync(
		paths.outbox,
		post(at(0), "ch:61", "[ask]") + post(at(1), "ch:62", "62 첫 답") + post(at(2), "ch:61", "61 첫 답") + post(at(9), "ch:61", "같은 때 61") + post(at(9), "ch:62", "같은 때 62"),
	);
	const order = (await import("./conversations.ts?first-load-ties")).conversationList().map(c => c.target);
	expect(order.indexOf("ch:62")).toBeLessThan(order.indexOf("ch:61"));
});

test("conversations that get messages with one time after the first list keep the order of their first shown message", async () => {
	const at = (i: number) => stamp(Date.UTC(2036, 0, 1), i);
	appendFileSync(paths.outbox, post(at(0), "ch:881", "[ask]") + post(at(1), "ch:882", "882 첫 답") + post(at(2), "ch:881", "881 첫 답"));
	const { conversationList } = await import("./conversations.ts?first-load-later-ties");
	conversationList();
	emit("outbox", { ts: at(9), kind: "out", source: "orchestrator", target: "ch:881", text: "나중 같은 때 881" });
	emit("outbox", { ts: at(9), kind: "out", source: "orchestrator", target: "ch:882", text: "나중 같은 때 882" });
	const order = conversationList().map(c => c.target);
	expect(order.indexOf("ch:882")).toBeLessThan(order.indexOf("ch:881"));
});

test("a preview is the message with the greatest stamp even when the log sorts another one after it", async () => {
	appendFileSync(paths.outbox, post("2037-01-01T00:00:00.500Z", "ch:71", "큰 시각의 답") + post("2037-01-01T00:00:00+09:00", "ch:71", "뒤에 정렬된 답"));
	const row = rowOf((await import("./conversations.ts?first-load-stamps")).conversationList(), "ch:71");
	expect(row?.last?.text).toBe("큰 시각의 답");
});

test("a mail without a summary takes the brief of its first shown message that is not the owner's", async () => {
	const at = (i: number) => stamp(Date.UTC(2036, 0, 1), i);
	recordMail({ key: "fl-mail", source: "mail", id: "fl-1", subject: "견적 문의", from: "Kim <kim@example.com>", at: at(0) });
	appendFileSync(paths.inbox, line({ ts: at(2), kind: "message", source: "web", channel: "mail:fl-mail", text: "요약\n형이 먼저 쓴 말" }));
	appendFileSync(paths.outbox, post(at(1), "mail:fl-mail", "[ask]") + post(at(3), "mail:fl-mail", "요약\n견적서는 내일 오전에 보내 드릴게요") + post(at(4), "mail:fl-mail", "요약\n두 번째 답이에요"));
	(await import("./conversations.ts?first-load-mail")).conversationList();
	expect(mailByKey("fl-mail")?.summary).toBe("견적서는 내일 오전에 보내 드릴게요");
});
