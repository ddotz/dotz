import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, paths } from "./config.ts";
import { emit, eventTarget, lastEventId, recentEvents, replayAfter } from "./events.ts";
import { answerDecision, authRequested, authSettled, type DecisionSend, dismissNotice, laneVerified, listNotices, markNoticesRead, NOTICE_CAP, type Notice, onDecision, setLaneTitleResolver, UPDATE_NOTICE_KEY, unreadCount, updateAvailable, updateResolved } from "./notices.ts";

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

test("a found dotz update creates one notice, a later check reuses it, and applying it marks it read", () => {
	markNoticesRead({ all: true });
	updateAvailable("dotz 새 버전이 있어요: 커밋 2개 (첫 번째). 설정 → 업데이트에서 적용해요.");
	const first = stored().filter(n => n.key === UPDATE_NOTICE_KEY);
	expect(first).toHaveLength(1);
	expect(first[0]).toMatchObject({ kind: "alert", title: "dotz 새 버전", open: "settings", read: false });
	expect(first[0]!.text).toContain("커밋 2개");

	markNoticesRead({ ids: [first[0]!.id] });
	updateAvailable("dotz 새 버전이 있어요: 커밋 3개 (두 번째). 설정 → 업데이트에서 적용해요.");
	const second = stored().filter(n => n.key === UPDATE_NOTICE_KEY);
	expect(second).toHaveLength(1);
	expect(second[0]).toMatchObject({ id: first[0]!.id, read: false, ts: first[0]!.ts });
	expect(second[0]!.text).toContain("커밋 3개");

	updateResolved();
	expect(stored().find(n => n.key === UPDATE_NOTICE_KEY)!.read).toBe(true);
	expect(stored().filter(n => n.key === UPDATE_NOTICE_KEY)).toHaveLength(1);
});

test("live posts shaped like main.ts out() (gateway worklog, orchestrator alert, both with reply_to) each create a notice", () => {
	const at = ts();
	emit("outbox", { ts: at, kind: "out", source: "gateway", target: "worklog", text: "계정을 a에서 b로 바꿨어요.", reply_to: null });
	emit("outbox", { ts: ts(), kind: "out", source: "orchestrator", target: "alert", text: "[fail] 라이브 경고 시험", reply_to: null });
	expect(byText("계정을 a에서 b로 바꿨어요.")[0]).toMatchObject({ kind: "worklog", open: "main", at, read: false });
	expect(byText("라이브 경고 시험")[0]).toMatchObject({ kind: "alert", tone: "fail", read: false });
});

// The backfill runs in a fresh process on a throwaway DOTZ_DIR holding sample persisted history (this process's store is not empty).
const NOW = "2026-10-21T00:00:00.000Z";
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const jsonl = (rows: Record<string, unknown>[]) => `${rows.map(r => JSON.stringify(r)).join("\n")}\n`;
const outRow = (h: number, target: string, text: string, extra: Record<string, unknown> = {}) => ({ ts: hoursAgo(h), kind: "out", source: "orchestrator", target, text, reply_to: null, ...extra });

function runBackfill(dir: string): { count: number; items: Notice[] } {
	const script = `import { backfillNotices } from "./hub/notices.ts"; console.log(JSON.stringify(backfillNotices(Date.parse(${JSON.stringify(NOW)})))); process.exit(0);`;
	const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DOTZ_DIR: dir } });
	expect(run.exitCode).toBe(0);
	const file = join(dir, "notices.json");
	return { count: JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!), items: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [] };
}

test("backfill builds the store once from persisted history: last 7 days, one item per lane key, 24 h split read/unread, no second run", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-backfill-"));
	copyFileSync(CONFIG_FILE, join(dir, "config.json"));
	writeFileSync(
		join(dir, "outbox.jsonl"),
		jsonl([
			outRow(200, "worklog", "일주일 전 기록"),
			outRow(36, "worklog", "오래된 기록"),
			outRow(14, "worklog", "[run] 하는 중이에요", { update_key: "lane:aa" }),
			outRow(5, "worklog", "[done] 끝났어요", { update_key: "lane:aa" }),
			outRow(4, "worklog", "[run] 진행 줄", { update_key: "progress" }),
			outRow(3, "alert", "[fail] 새 경고"),
			outRow(2, "worklog", "야간 정리\n- 정리했어요", { source: "gateway" }),
			{ ts: hoursAgo(2), kind: "delivery", source: "gateway", target: "worklog", ref: "r", state: "answered", text: "" },
			outRow(1, "web", "그냥 대화예요"),
		]),
	);
	writeFileSync(
		join(dir, "inbox.jsonl"),
		jsonl([
			{ ts: hoursAgo(50), kind: "lane_report", source: "lane:bb", lane: "bb", text: "[done] 두 번째 세션 끝" },
			{ ts: hoursAgo(1), kind: "schedule", source: "schedule", id: "s1", channel: "main", text: "예약 시작" },
			{ ts: hoursAgo(1), kind: "message", source: "web", channel: "web", author: "local", text: "안녕" },
		]),
	);

	const first = runBackfill(dir);
	expect(first.count).toBe(6);
	expect(first.items.map(n => n.text).sort()).toEqual(["끝났어요", "두 번째 세션 끝", "새 경고", "야간 정리\n- 정리했어요", "예약 시작", "오래된 기록"].sort());

	// Lane keys are de-duplicated: the latest post wins, at its own ts.
	const aa = first.items.filter(n => n.key === "lane:aa");
	expect(aa).toHaveLength(1);
	expect(aa[0]).toMatchObject({ kind: "result", tone: "done", text: "끝났어요", open: "lane:aa", updated: hoursAgo(5), read: false });
	expect(first.items.find(n => n.key === "lane:bb")).toMatchObject({ tone: "done", updated: hoursAgo(50), read: true });

	// Original ts kept; older than 24 h is read, newer unread; kinds come from the live mapping.
	expect(first.items.find(n => n.text === "새 경고")).toMatchObject({ kind: "alert", tone: "fail", ts: hoursAgo(3), read: false });
	expect(first.items.find(n => n.text === "오래된 기록")).toMatchObject({ kind: "worklog", ts: hoursAgo(36), read: true });
	expect(first.items.find(n => n.text.startsWith("야간 정리"))).toMatchObject({ kind: "worklog", title: "야간 정리", read: false });
	expect(first.items.find(n => n.text === "예약 시작")).toMatchObject({ kind: "watch", title: "예약", read: false });
	expect(first.items.filter(n => !n.read)).toHaveLength(4);

	// A restart (a fresh process on the same files) must not add or change anything.
	const before = readFileSync(join(dir, "notices.json"), "utf8");
	const again = runBackfill(dir);
	expect(again.count).toBe(0);
	expect(readFileSync(join(dir, "notices.json"), "utf8")).toBe(before);
});

// A lane that is gone from the live map keeps its launch title: from its lane_start event or its lane.json record.
const titledDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-titles-"));
	copyFileSync(CONFIG_FILE, join(dir, "config.json"));
	mkdirSync(join(dir, "lanes", "rec"), { recursive: true });
	writeFileSync(join(dir, "lanes", "rec", "lane.json"), JSON.stringify({ name: "rec", title: "기록에 남은 제목" }));
	writeFileSync(join(dir, "outbox.jsonl"), jsonl([{ ts: hoursAgo(30), kind: "lane_start", source: "hub", lane: "gone", title: "알림 모아보기", text: "lane gone started in /x" }]));
	return dir;
};
const titleOf = (items: Notice[], key: string) => items.find(n => n.key === key)?.title;

test("backfill titles a lane that is no longer live from its lane_start event or lane.json, else falls back to the generic title", () => {
	const dir = titledDir();
	writeFileSync(
		join(dir, "inbox.jsonl"),
		jsonl([
			{ ts: hoursAgo(5), kind: "lane_report", source: "lane:gone", lane: "gone", text: "[done] 끝났어요" },
			{ ts: hoursAgo(4), kind: "lane_report", source: "lane:rec", lane: "rec", text: "[done] 끝났어요" },
			{ ts: hoursAgo(3), kind: "lane_report", source: "lane:nowhere", lane: "nowhere", text: "[done] 끝났어요" },
		]),
	);
	const { items } = runBackfill(dir);
	expect(titleOf(items, "lane:gone")).toBe("알림 모아보기");
	expect(titleOf(items, "lane:rec")).toBe("기록에 남은 제목");
	expect(titleOf(items, "lane:nowhere")).toBe("세션");
});

test("on load, stored lane items titled 세션 are re-titled in place when a real title can be found; others are left alone", () => {
	const dir = titledDir();
	const item = (key: string, title: string, id: string): Notice => ({ id, ts: hoursAgo(5), updated: hoursAgo(5), kind: "result", tone: "done", title, text: "끝났어요", open: key, src: key, at: hoursAgo(5), key, read: true });
	writeFileSync(
		join(dir, "notices.json"),
		JSON.stringify([item("lane:gone", "세션", "aaaaaaa1"), item("lane:rec", "세션", "aaaaaaa2"), item("lane:nowhere", "세션", "aaaaaaa3"), item("lane:rec2", "직접 정한 제목", "aaaaaaa4")]),
	);
	const run = Bun.spawnSync([process.execPath, "-e", `import "./hub/notices.ts"; process.exit(0);`], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DOTZ_DIR: dir } });
	expect(run.exitCode).toBe(0);
	const after: Notice[] = JSON.parse(readFileSync(join(dir, "notices.json"), "utf8"));
	expect(after).toHaveLength(4);
	expect(after.map(n => [n.key, n.title])).toEqual([["lane:gone", "알림 모아보기"], ["lane:rec", "기록에 남은 제목"], ["lane:nowhere", "세션"], ["lane:rec2", "직접 정한 제목"]]);
	expect(after.map(n => n.id)).toEqual(["aaaaaaa1", "aaaaaaa2", "aaaaaaa3", "aaaaaaa4"]);
});

test("backfill with no persisted history creates nothing and no file", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-backfill-"));
	copyFileSync(CONFIG_FILE, join(dir, "config.json"));
	expect(runBackfill(dir)).toEqual({ count: 0, items: [] });
	expect(existsSync(join(dir, "notices.json"))).toBe(false);
});

/* ---------- decisions: a pending owner decision is its own pinned notice ---------- */
const decisions = (to: string) => stored().filter(n => n.kind === "decision" && n.decision?.to === to);
const owner = (text: string, extra: Record<string, unknown> = {}) => emit("inbox", { ts: ts(), kind: "message", source: "web", channel: "web", text, ...extra });
const laneOwner = (lane: string, text: string) => emit("inbox", { ts: ts(), kind: "lane_message", source: "web", lane, text });

test("a message with two choice blocks gives two decision notices that stay unread and cannot be dismissed", () => {
	const at = ts();
	const fresh: Notice[] = [];
	onDecision(n => fresh.push(n));
	post("web", "[ask] 두 가지를 정해 주세요\n결정: 먼저 고칠 것\n**1) 로그인 버그** ← 추천\n세션이 자꾸 풀려요\n**2) 결제 버그**\n결제가 가끔 안 돼요\n결정: 배포 시점\n**1) 지금**\n**2) 내일** ← 추천\n번호로 답해 주세요", { ts: at });
	const mine = decisions("main").filter(n => n.decision!.reply_to === at);
	expect(mine.map(n => n.title)).toEqual(["먼저 고칠 것", "배포 시점"]);
	expect(mine.every(n => !n.read && n.decision!.state === "open" && n.decision!.group === 2)).toBe(true);
	expect(mine[0]!.decision!.options).toEqual([
		{ n: 1, label: "로그인 버그", desc: "세션이 자꾸 풀려요", rec: true },
		{ n: 2, label: "결제 버그", desc: "결제가 가끔 안 돼요", rec: false },
	]);
	expect(mine[1]!.decision!.options.map(o => [o.label, o.rec])).toEqual([["지금", false], ["내일", true]]);
	expect(fresh.map(n => n.title)).toEqual(["먼저 고칠 것", "배포 시점"]);
	// pinned: first in the list, not readable away, not dismissable
	expect(listNotices().items.slice(0, 2).every(n => n.kind === "decision")).toBe(true);
	markNoticesRead({ all: true });
	expect(stored().filter(n => n.id === mine[0]!.id)[0]!.read).toBe(false);
	expect(dismissNotice(mine[0]!.id)).toMatchObject({ ok: false, held: true });
	expect(stored().find(n => n.id === mine[0]!.id)!.dismissed).toBeUndefined();
});

test("a button answers one decision as a reply to the asking message; a plain owner reply settles the rest of that chat", async () => {
	const at = ts();
	post("web", "[ask] 순서를 정해 주세요\n결정: 첫째\n**1) 가**\n**2) 나**\n결정: 둘째\n**1) 다**\n**2) 라**", { ts: at });
	const [a, b] = decisions("main").filter(n => n.decision!.reply_to === at) as [Notice, Notice];
	const sent: Parameters<DecisionSend>[0][] = [];
	const send: DecisionSend = async x => {
		sent.push(x);
		owner(x.text, { reply_to: x.replyTo, decision: x.notice });
	};
	const r = await answerDecision(b.id, { n: 2 }, send);
	expect(r.status).toBe(200);
	expect(sent).toEqual([{ to: "main", text: "둘째: 2) 라", replyTo: at, notice: b.id }]);
	const after = (id: string) => stored().find(n => n.id === id)!;
	expect(after(b.id)).toMatchObject({ read: true, decision: { state: "answered", answer: "2) 라" } });
	expect(after(a.id)).toMatchObject({ read: false, decision: { state: "open" } });
	// answering again does nothing; an option that does not exist is refused
	expect((await answerDecision(b.id, { n: 1 }, send)).body.already).toBe(true);
	expect(sent).toHaveLength(1);
	expect((await answerDecision(a.id, { n: 9 }, send)).status).toBe(400);
	// the owner replying in the chat settles what is still open there
	owner("1-1");
	expect(after(a.id)).toMatchObject({ read: true, decision: { state: "answered", answer: "1-1" } });
	expect(dismissNotice(a.id).ok).toBe(true);
});

test("a failed send leaves the decision open", async () => {
	post("web", "[ask] 하나만 골라 주세요\n**1) 예**\n**2) 아니요**");
	const n = decisions("main").find(x => x.title === "하나만 골라 주세요")!;
	const r = await answerDecision(n.id, { n: 1 }, async () => {
		throw new Error("세션이 끝났어요");
	});
	expect(r).toMatchObject({ status: 409, body: { error: "세션이 끝났어요" } });
	expect(stored().find(x => x.id === n.id)!.decision!.state).toBe("open");
	expect(n.decision!.group).toBe(1);
	owner("1");
});

test("a session [ask] makes one decision for that session, a repeated copy adds none, and only a reply in that session settles it", () => {
	const line = "[ask] 이어서 진행할까요?";
	post("lane:x", line, { source: "lane:x" });
	emit("inbox", { ts: ts(), kind: "lane_report", source: "lane:x", lane: "x", text: line });
	const [d, ...rest] = decisions("lane:x");
	expect(rest).toHaveLength(0);
	expect(d).toMatchObject({ kind: "decision", title: "이어서 진행할까요?", open: "lane:x", read: false, decision: { options: [], state: "open", group: 1 } });
	owner("네");   // the main chat is another conversation
	expect(stored().find(n => n.id === d!.id)!.decision!.state).toBe("open");
	laneOwner("y", "아니요");
	expect(stored().find(n => n.id === d!.id)!.decision!.state).toBe("open");
	laneOwner("x", "네, 이어서 해 주세요");
	expect(stored().find(n => n.id === d!.id)!).toMatchObject({ read: true, decision: { state: "answered", answer: "네, 이어서 해 주세요" } });
	// the same words again right after the answer do not open it again
	emit("inbox", { ts: ts(), kind: "lane_report", source: "lane:x", lane: "x", text: line });
	expect(stored().find(n => n.id === d!.id)!.decision!.state).toBe("answered");
});

test("a session's budget question gets yes / no buttons that send words the budget gate understands", async () => {
	post("lane:b", "[ask] 한도가 빠듯해요. 진행하려면 /budget-ok 가 필요해요. 진행할까요?", { source: "lane:b" });
	const d = decisions("lane:b")[0]!;
	expect(d.decision!.options.map(o => o.label)).toEqual(["네, 진행해 주세요", "아니요, 하지 마세요"]);
	let sent = "";
	await answerDecision(d.id, { n: 1 }, async x => {
		sent = x.text;
		laneOwner("b", x.text);
	});
	expect(sent).toBe("진행해");
});

test("a login request is a decision that its approve button and its end both settle", async () => {
	authRequested({ id: "a1", kind: "approve", title: "로그인 승인", site: "example.com", purpose: "결제 페이지에 들어가요" });
	const n = decisions("auth:a1")[0]!;
	expect(n).toMatchObject({ title: "로그인 승인", read: false, decision: { options: [{ action: "approve" }, { action: "cancel" }] } });
	const sent: Parameters<DecisionSend>[0][] = [];
	await answerDecision(n.id, { n: 1 }, async x => void sent.push(x));
	expect(sent).toEqual([{ to: "auth:a1", text: "1) 승인", notice: n.id, action: "approve" }]);
	authSettled("a1", "approved");
	expect(stored().find(x => x.id === n.id)).toMatchObject({ read: true, decision: { state: "answered", answer: "1) 승인" } });
	authRequested({ id: "a2", kind: "secret", title: "로그인 정보", site: "example.com", purpose: "계정이 필요해요" });
	const form = decisions("auth:a2")[0]!;
	expect((await answerDecision(form.id, { n: 1 }, async () => {})).status).toBe(400);   // the form is the page's own
	authSettled("a2", "timeout");
	expect(stored().find(x => x.id === form.id)!.decision).toMatchObject({ state: "answered", answer: "시간이 지나 닫혔어요" });
});

test("an open decision survives the store's cap and a reload from disk", () => {
	post("web", "[ask] 오래 남을 질문\n**1) 하나**\n**2) 둘**");
	const id = decisions("main").find(n => n.title === "오래 남을 질문")!.id;
	for (let i = 0; i < NOTICE_CAP + 5; i++) post("worklog", `[run] 채우기 ${i}`);
	expect(stored().length).toBeLessThanOrEqual(NOTICE_CAP);
	expect(stored().find(n => n.id === id)!.decision!.state).toBe("open");
	owner("1");
});
