// A new mail is the mail app's 새 소식 in the web app (bell + phone) whether or not it also gets a Discord thread, and each monitoring app's
// 알림 switches (새 소식 알림, 휴대폰 알림) take effect on that route: hub/mail.ts postMail -> inbox event -> hub/notices.ts -> hub/push.ts noticePush.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedByOff, newsMuted } from "./app-off.ts";
import { emit } from "./events.ts";
import { postMail, type MailDeps } from "./mail.ts";
import { listNotices, type Notice, onNoticeUnread, resetNoticesForTest, setAppBlocker, setAppResolver } from "./notices.ts";
import { noticePush, setWatchPushOff } from "./push.ts";

const data = mkdtempSync(join(tmpdir(), "mail-notice-"));
const apps = (v: unknown) => {
	mkdirSync(join(data, "custom"), { recursive: true });
	writeFileSync(join(data, "custom/apps.json"), JSON.stringify(v));
};
const unread: Notice[] = [];
onNoticeUnread(n => void unread.push(n));
// The resolvers main.ts installs, narrowed to this fixture: a mail conversation is the mail app's, a watch named "kakao-*" the kakao app's.
setAppResolver(n => (n.open?.startsWith("mail:") ? "mail" : n.watch?.startsWith("kakao-") ? "kakao" : undefined));
setAppBlocker(n => blockedByOff(data, n) || newsMuted(data, n, name => name === "quiet-watch"));
afterAll(() => {
	setAppBlocker(() => false);
	setAppResolver(() => undefined);
	setWatchPushOff(() => false);
	rmSync(data, { recursive: true, force: true });
});
beforeEach(() => {
	resetNoticesForTest();
	unread.length = 0;
	apps({});
});

const threads: string[] = [];
const deps = (threadOn: boolean): MailDeps => ({
	createThread: async (_p, name) => (threads.push(name), { id: "777" }), send: async () => {}, mailChannel: async () => "555", discordOn: true,
	threadOn: () => threadOn, emit: e => emit("inbox", e as Parameters<typeof emit>[1]), wake: () => {},
});
const mailNotices = () => listNotices().items.filter(n => n.open.startsWith("mail:"));

test("a new mail from the webmail source or zele makes an unread bell item and a phone notification, Discord thread or not", async () => {
	const web = await postMail({ source: "kdb", id: "w-1", subject: "견적 문의", from: "\"김철수\" <kim@example.com>" }, deps(false));
	const zele = await postMail({ source: "zele", id: "z-1", subject: "회의 일정", from: "lee@example.com" }, deps(true));
	expect(threads).toEqual(["회의 일정"]);
	expect(mailNotices().map(n => [n.open, n.title, n.text, n.read]).sort()).toEqual([
		[`mail:${web.key}`, "김철수", "견적 문의", false],
		[`mail:${zele.key}`, "lee@example.com", "회의 일정", false],
	]);
	expect(unread.map(n => n.open)).toEqual([`mail:${web.key}`, `mail:${zele.key}`]);
	expect(noticePush(unread[0]!)).toMatchObject({ kind: "news", title: "김철수 · 새 메일", body: "견적 문의", url: `/#chat/mail:${web.key}`, tag: `watch:mail:${web.key}`, app: "mail" });
	// the owner's own draft (composeMail) is no news
	emit("inbox", { ts: new Date().toISOString(), kind: "mail", source: "web", channel: "mail:own", conv: "mail:own", mail: "own", subject: "내 초안", from: "me", text: "" });
	expect(mailNotices()).toHaveLength(2);
});

test("새 소식 알림 off for the mail app: the mail is still posted but nothing reaches the bell or the phone; on again, it does", async () => {
	apps({ mail: { notify: false } });
	const off = await postMail({ source: "kdb", id: "w-2", subject: "조용한 메일", from: "a@example.com" }, deps(false));
	expect(off.ok).toBe(true);
	expect(mailNotices()).toEqual([]);
	expect(unread).toEqual([]);
	apps({ mail: { notify: true } });
	await postMail({ source: "kdb", id: "w-3", subject: "다시 켬", from: "a@example.com" }, deps(false));
	expect(mailNotices().map(n => n.text)).toEqual(["다시 켬"]);
});

test("a monitor's or an app's own switches: notify off keeps its reports out of the bell, push off keeps them off the phone only", () => {
	const report = (watch: string) => emit("inbox", { ts: new Date().toISOString(), kind: "watch", source: `watch:${watch}`, watch, channels: [], reason: "바뀌었어요", text: `${watch} 결과` });
	report("quiet-watch");
	apps({ kakao: { notify: false } });
	report("kakao-new");
	expect(listNotices().items.filter(n => n.kind === "watch")).toEqual([]);
	apps({});
	report("kakao-new");
	report("loud-watch");
	setWatchPushOff(name => name === "loud-watch");
	const [kakao, loud] = ["kakao-new", "loud-watch"].map(w => listNotices().items.find(n => n.watch === w)!);
	expect(noticePush(kakao!)).toMatchObject({ kind: "news" });
	expect(loud!.read).toBe(false);
	expect(noticePush(loud!)).toBeUndefined();
});
