import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";
import { emit, eventTarget, lastEventId, recentEvents, replayAfter } from "./events.ts";
import { dismissNotice, laneVerified, listNotices, markNoticesRead, NOTICE_CAP, type Notice, setLaneTitleResolver, unreadCount } from "./notices.ts";

const ts = () => new Date().toISOString();
const stored = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));
const post = (target: string, text: string, extra: Record<string, unknown> = {}) => emit("outbox", { ts: ts(), kind: "out", source: "orchestrator", target, text, ...extra });
const byText = (text: string) => stored().filter(n => n.text === text);

setLaneTitleResolver(name => (name === "x" ? "로그인 고치기" : undefined));

test("a worklog post becomes a persisted unread notice", () => {
	post("worklog", "[run] 첫 번째 작업 기록");
	const [n] = byText("첫 번째 작업 기록");
	expect(n).toMatchObject({ kind: "worklog", tone: "run", title: "작업 기록", open: "main", read: false });
	expect(n!.id).toHaveLength(8);
	expect(unreadCount()).toBeGreaterThan(0);
});

test("the same update_key updates one item in place and reopens it only for a new result", () => {
	post("worklog", "[run] 진행 중이에요", { update_key: "lane:x" });
	const first = stored().filter(n => n.key === "lane:x");
	expect(first).toHaveLength(1);
	expect(first[0]).toMatchObject({ kind: "result", tone: "run", title: "로그인 고치기", open: "lane:x" });
	markNoticesRead({ ids: [first[0]!.id] });

	post("worklog", "[run] 진행 중이에요", { update_key: "lane:x" });
	expect(stored().find(n => n.key === "lane:x")!.read).toBe(true);

	post("worklog", "[done] 끝났어요", { update_key: "lane:x" });
	const after = stored().filter(n => n.key === "lane:x");
	expect(after).toHaveLength(1);
	expect(after[0]).toMatchObject({ id: first[0]!.id, tone: "done", text: "끝났어요", read: false, ts: first[0]!.ts });
});

test("an alert post is an alert, a restart notice is born read, progress notes and run reports are ignored", () => {
	post("alert", "[fail] 디스크가 거의 찼어요");
	expect(byText("디스크가 거의 찼어요")[0]).toMatchObject({ kind: "alert", tone: "fail", title: "알림", read: false });

	post("worklog", "게이트웨이 재시작했어요 (10:00 KST).\n- 이어서 하는 세션: x", { source: "gateway" });
	expect(stored().find(n => n.text.startsWith("게이트웨이 재시작했어요"))!.read).toBe(true);

	const before = stored().length;
	post("web", "처리 중이에요", { update_key: "progress", source: "gateway" });
	post("worklog", "[run] 진행 줄", { update_key: "progress" });
	emit("outbox", { ts: ts(), kind: "delivery", source: "gateway", target: "worklog", text: "x", ref: "r", state: "answered" });
	emit("inbox", { ts: ts(), kind: "lane_report", source: "lane:x", lane: "x", text: "[run] 아직 하는 중이에요" });
	expect(stored().length).toBe(before);
});

test("a done lane report upserts the session result; a watch post for a channel becomes a watch notice", () => {
	emit("inbox", { ts: ts(), kind: "lane_report", source: "lane:y", lane: "y", text: "Ask: a - wanted: b. For you: c. Now: d. Next: e.\n\n[fail] 테스트가 깨졌어요" });
	emit("inbox", { ts: ts(), kind: "lane_report", source: "lane:y", lane: "y", text: "[done] 고쳤어요" });
	const y = stored().filter(n => n.key === "lane:y");
	expect(y).toHaveLength(1);
	expect(y[0]).toMatchObject({ kind: "result", tone: "done", text: "고쳤어요", title: "세션", open: "lane:y", read: false });

	post("ch:123", "[주간 점검] 새 글이 올라왔어요", { source: "gateway" });
	expect(byText("새 글이 올라왔어요")[0]).toMatchObject({ kind: "watch", title: "주간 점검", open: "ch:123" });
	emit("inbox", { ts: ts(), kind: "watch", source: "watch:뉴스", watch: "뉴스", channels: [], reason: "바뀌었어요", text: "내용" });
	expect(byText("바뀌었어요\n내용")[0]).toMatchObject({ kind: "watch", title: "뉴스", open: "main" });
});

test("mark read by id and mark all persist, and the list shows unread first", () => {
	post("worklog", "읽기 시험 A");
	post("worklog", "읽기 시험 B");
	const [a, b] = [byText("읽기 시험 A")[0]!, byText("읽기 시험 B")[0]!];
	const unread = unreadCount();
	expect(markNoticesRead({ ids: [a.id] }).unread).toBe(unread - 1);
	expect(byText("읽기 시험 A")[0]!.read).toBe(true);
	expect(byText("읽기 시험 B")[0]!.read).toBe(false);

	const view = listNotices(300);
	const firstRead = view.items.findIndex(n => n.read);
	expect(view.items.slice(firstRead).every(n => n.read)).toBe(true);
	expect(view.items.slice(0, 1)[0]!.read).toBe(false);
	expect(view.unread).toBe(unread - 1);

	expect(markNoticesRead({ all: true }).unread).toBe(0);
	expect(stored().every(n => n.read)).toBe(true);
	expect(b.id).toBeTruthy();
});

test("verifying a session reopens its result and puts one compact card into the main chat", () => {
	markNoticesRead({ all: true });
	post("worklog", "[done] 보고만 했어요", { update_key: "lane:x" });
	markNoticesRead({ all: true });
	const seen = lastEventId();
	const before = recentEvents(300).length;
	laneVerified("x", "[done] 무시되는 글");
	const item = stored().find(n => n.key === "lane:x")!;
	expect(item).toMatchObject({ tone: "done", text: "보고만 했어요", read: false });

	const card = recentEvents(300).at(-1)!;
	expect(recentEvents(300).length).toBe(Math.min(300, before + 1));
	expect(card).toMatchObject({ kind: "result", source: "gateway", target: "web", session: "x", title: "로그인 고치기", tone: "done", verified: true, open: "lane:x" });
	expect(eventTarget(card)).toBe("main");
	expect(replayAfter(seen)?.some(f => f.includes('"kind":"notice"'))).toBe(true);
});

test("notice broadcasts belong to no conversation", () => {
	expect(eventTarget({ ts: ts(), kind: "notice", source: "gateway", text: "" })).toBeUndefined();
	expect(eventTarget({ ts: ts(), kind: "notice_read", source: "gateway", text: "" })).toBeUndefined();
});

test("a notice links to its source message: the conversation and the event ts", () => {
	const at = ts();
	emit("outbox", { ts: at, kind: "out", source: "gateway", target: "ch:77", text: "[네이버] 링크 시험 글" });
	expect(byText("링크 시험 글")[0]).toMatchObject({ open: "ch:77", src: "ch:77", at });
	const alertAt = ts();
	emit("outbox", { ts: alertAt, kind: "out", source: "orchestrator", target: "alert", text: "[fail] 링크 경고" });
	expect(byText("링크 경고")[0]).toMatchObject({ src: "main", at: alertAt });

	const card = (laneVerified("x", "[done] 무시"), recentEvents(300).at(-1)!);
	expect(stored().find(n => n.key === "lane:x")).toMatchObject({ open: "lane:x", src: "main", at: card.ts });
});

test("dismissing a notice reads it and removes it from the list and the count, and survives a reload from disk", () => {
	markNoticesRead({ all: true });
	post("worklog", "지울 글 A");
	post("worklog", "지울 글 B");
	const [a, b] = [byText("지울 글 A")[0]!, byText("지울 글 B")[0]!];
	expect(unreadCount()).toBe(2);
	const seen = lastEventId();

	expect(dismissNotice(a.id)).toEqual({ ok: true, unread: 1 });
	expect(dismissNotice(a.id)).toEqual({ ok: true, unread: 1 });
	expect(dismissNotice("nope")).toEqual({ ok: false, unread: 1 });
	expect(byText("지울 글 A")[0]).toMatchObject({ dismissed: true, read: true });
	expect(listNotices(300).items.map(n => n.id)).not.toContain(a.id);
	expect(listNotices(300)).toMatchObject({ unread: 1 });
	expect(listNotices(300).items.map(n => n.id)).toContain(b.id);
	expect(replayAfter(seen)?.filter(f => f.includes('"kind":"notice_dismiss"'))).toHaveLength(1);
	expect(eventTarget({ ts: ts(), kind: "notice_dismiss", source: "gateway", text: "" })).toBeUndefined();

	// A fresh process reads notices.json again: the dismissed item stays gone and uncounted.
	const script = `import { listNotices, unreadCount } from "./hub/notices.ts"; console.log(JSON.stringify({ ids: listNotices(300).items.map(n => n.id), unread: unreadCount() })); process.exit(0);`;
	const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env: process.env });
	expect(run.exitCode).toBe(0);
	const fresh = JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!);
	expect(fresh.ids).not.toContain(a.id);
	expect(fresh.ids).toContain(b.id);
	expect(fresh.unread).toBe(1);
});

test("a dismissed session result stays gone on quiet progress and returns on a new result", () => {
	post("worklog", "[done] 끝났어요 하나", { update_key: "lane:dz" });
	const id = stored().find(n => n.key === "lane:dz")!.id;
	dismissNotice(id);
	post("worklog", "[done] 끝났어요 하나", { update_key: "lane:dz" });
	expect(listNotices(300).items.map(n => n.id)).not.toContain(id);
	post("worklog", "[done] 새 결과예요", { update_key: "lane:dz" });
	const back = listNotices(300).items.find(n => n.id === id);
	expect(back).toMatchObject({ read: false, text: "새 결과예요" });
	expect(back!.dismissed).toBeUndefined();
});

test("the store keeps at most 300 items, dropping read ones first and then the oldest", () => {
	markNoticesRead({ all: true });
	post("worklog", "읽지 않은 오래된 글");
	for (let i = 0; i < NOTICE_CAP - 1; i++) post("worklog", `채우기 ${i}`);
	let items = stored();
	expect(items).toHaveLength(NOTICE_CAP);
	expect(items.every(n => !n.read)).toBe(true);
	expect(items.some(n => n.text === "읽지 않은 오래된 글")).toBe(true);

	post("worklog", "채우기 마지막");
	items = stored();
	expect(items).toHaveLength(NOTICE_CAP);
	expect(items.some(n => n.text === "읽지 않은 오래된 글")).toBe(false);
	expect(items.some(n => n.text === "채우기 마지막")).toBe(true);
});
