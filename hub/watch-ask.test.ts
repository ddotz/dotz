import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { emit } from "./events.ts";
import { allNotices, answerDecision, decisionsOf, listNotices, resetNoticesForTest } from "./notices.ts";
import { settleDecision } from "./notices-store.ts";
import { out } from "./outbound.ts";
import { SLOT_SKIPPED_EXIT } from "./release-exit.ts";
import { cardCovers } from "./doctor.ts";
import { watches as doctorWatches } from "./doctor-checks.ts";
import { deliverAnswer } from "./routes.ts";
import { addWatch, allWatches, removeWatch, runWatch, startWatches, stopWatches, type Watch } from "./watch.ts";
import { watchChoice, watchIssuePost, watchIssueText, watchSubject } from "./watch-ask.ts";
import { watchCardAnsweredAt } from "./watch-backoff.ts";
import { reconnectWatch } from "./watch-reconnect.ts";
import { watchLabel } from "./workchannels.ts";

type Note = { w: Watch; reason: string; output: string; info: Parameters<Parameters<typeof startWatches>[0]>[4] };
const notes: Note[] = [];
beforeAll(() => startWatches((w, reason, output, _prev, info) => void notes.push({ w, reason, output, info })));
beforeEach(() => {
	resetNoticesForTest();
	notes.length = 0;
});
afterAll(() => {
	for (const w of allWatches()) removeWatch(w.id);
	stopWatches();
	resetNoticesForTest();
});

const issueEvent = (w: Watch, n: Note, ts = new Date().toISOString()) => ({ ts, kind: "out", source: "gateway", target: "alert", nk: "alert", text: watchIssueText(w, watchLabel(w.name), n.reason, n.info, n.output) });
const labels = (n: Note) => decisionsOf(issueEvent(n.w, n) as never)[0]!.options.map(o => o.label);
const failTwice = async (name: string) => {
	await runWatch(name);
	await runWatch(name);
	return notes.at(-1)!;
};

test("a watch that needs a login offers 다시 연결, 원인 확인 and 이 모니터링 멈추기; any other failing watch keeps its two choices", async () => {
	addWatch({ name: "site-login", command: "printf 'DOTZ_FAIL login\\n'; exit 1", every_minutes: 10, on: "fail", to: "alert", approval_minutes: 30 }, "");
	addWatch({ name: "site-fetch", command: "printf 'DOTZ_FAIL fetch\\n'; exit 1", every_minutes: 10, on: "fail", to: "alert" }, "");
	expect(labels(await failTwice("site-login"))).toEqual(["다시 연결", "원인 확인", "이 모니터링 멈추기"]);
	expect(labels(await failTwice("site-fetch"))).toEqual(["원인 확인", "모니터링 끄기"]);
});

test("다시 연결 on the card approves a disconnected gated watch and answers the card, with no message to the assistant", async () => {
	addWatch({ name: "gated-site", command: "printf 'DOTZ_FAIL login\\n'; exit 1", every_minutes: 10, on: "fail", to: "alert", approval_minutes: 30 }, "");
	emit("outbox", issueEvent(allWatches().find(w => w.name === "gated-site")!, await failTwice("gated-site")));
	const card = listNotices(300).items.find(n => n.kind === "decision")!;
	const sent: string[] = [];
	const bot = (a: Parameters<typeof deliverAnswer>[0]) => (a.action ? deliverAnswer(a) : void sent.push(a.text));
	const res = await answerDecision(card.id, { n: 1 }, a => Promise.resolve(bot({ ...a, login: "local" })));
	expect(res.status).toBe(200);
	expect(sent).toEqual([]);
	expect(existsSync(join(DATA_DIR, "approvals", "gated-site"))).toBe(true);
	expect(listNotices(300).items.find(n => n.id === card.id)!.decision).toMatchObject({ state: "answered", answer: "1) 다시 연결" });
});

test("다시 연결 on the card of a watch that is gone leaves the card open and says so", async () => {
	addWatch({ name: "gone-site", command: "printf 'DOTZ_FAIL login\\n'; exit 1", every_minutes: 10, on: "fail", to: "alert", approval_minutes: 30 }, "");
	const w = allWatches().find(x => x.name === "gone-site")!;
	emit("outbox", issueEvent(w, await failTwice("gone-site")));
	removeWatch(w.id);
	const card = listNotices(300).items.find(n => n.kind === "decision")!;
	const res = await answerDecision(card.id, { n: 1 }, a => deliverAnswer({ ...a, login: "local" }));
	expect([res.status, res.body.error]).toEqual([409, "이 모니터링을 찾을 수 없어요"]);
	expect(listNotices(300).items.find(n => n.id === card.id)!.decision!.state).toBe("open");
});

test("reconnecting a watch with no approval gate runs its check once", async () => {
	const counter = join(DATA_DIR, "reconnect-count.txt");
	writeFileSync(counter, "");
	addWatch({ name: "plain-site", command: `echo run >> '${counter}'`, every_minutes: 10, on: "fail", to: "alert" }, "");
	const outcome = reconnectWatch(allWatches().find(w => w.name === "plain-site")!);
	await outcome.done;
	expect([outcome.approved, readFileSync(counter, "utf8").trim().split("\n")]).toEqual([false, ["run"]]);
});

const posted = (w: Watch, n: Note) => ({ ...issueEvent(w, n), card_ids: [`watches:${w.name}`] });
const cardOf = (name: string) => listNotices(300).items.find(n => n.decision?.card_id === `watches:${name}`)!;

test("two monitors whose labels are cut to one title are two cards, and 다시 연결 on each reaches its own monitor", async () => {
	const base = "아주 긴 채널 이름을 가진 프로젝트 사내 그룹웨어 결재";
	for (const n of [1, 2]) addWatch({ name: `gw-${n}`, label: `${base} 감시 ${n}`, command: "printf 'DOTZ_FAIL login\\n'; exit 1", every_minutes: 10, on: "fail", to: "alert", approval_minutes: 30 }, "");
	for (const n of [1, 2]) emit("outbox", posted(allWatches().find(w => w.name === `gw-${n}`)!, await failTwice(`gw-${n}`)));
	const [one, two] = [cardOf("gw-1"), cardOf("gw-2")];
	expect(one.title).toBe(two.title);
	expect(one.id).not.toBe(two.id);
	expect(one.decision!.evidence![0]).toBe(`모니터링: ${base} 감시 1`);
	expect(two.decision!.evidence![0]).toBe(`모니터링: ${base} 감시 2`);
	const reconnect = (card: typeof one) => answerDecision(card.id, { n: 1 }, a => deliverAnswer({ ...a, login: "local" }));
	expect((await reconnect(two)).status).toBe(200);
	expect([existsSync(join(DATA_DIR, "approvals", "gw-1")), existsSync(join(DATA_DIR, "approvals", "gw-2"))]).toEqual([false, true]);
	expect((await reconnect(one)).status).toBe(200);
	expect(existsSync(join(DATA_DIR, "approvals", "gw-1"))).toBe(true);
});

test("a monitor whose label starts with [, 결정 or Decision gets its card, answered by 다시 연결 and seen as answered by the back-off", async () => {
	for (const [name, label] of [["nas", "[NAS] 패치 감시"], ["kr", "결정 로그 감시"], ["dlog", "Decision log 감시"]] as const) {
		addWatch({ name, label, command: "printf 'DOTZ_FAIL login\\n'; exit 1", every_minutes: 10, on: "fail", to: "alert", approval_minutes: 30 }, "");
		emit("outbox", posted(allWatches().find(w => w.name === name)!, await failTwice(name)));
		const card = cardOf(name);
		expect(watchSubject(card.title)).toBe(label);
		expect((await answerDecision(card.id, { n: 1 }, a => deliverAnswer({ ...a, login: "local" }))).status).toBe(200);
		expect(existsSync(join(DATA_DIR, "approvals", name))).toBe(true);
		expect(watchCardAnsweredAt(name)).toBe(Date.parse(cardOf(name).decision!.answered_at!));
	}
});

test("the doctor's finding about a failing monitor is covered by that monitor's card, whatever its label", async () => {
	const doctorLabels = { watch: watchLabel, harness: () => undefined };
	for (const [name, label] of [["price", "가격 확인"], ["long", "아주 긴 채널 이름을 가진 프로젝트 사내 그룹웨어 결재 감시 1"], ["bracket", "[NAS] 패치 감시"]] as const) {
		addWatch({ name, label, command: "printf 'DOTZ_FAIL fetch\\n'; exit 1", every_minutes: 10, on: "fail", to: "alert" }, "");
		await failTwice(name);
		emit("outbox", posted(allWatches().find(w => w.name === name)!, await failTwice(name)));
		const finding = (await doctorWatches({ now: Date.now(), dataDir: DATA_DIR, home: DATA_DIR })).find(f => f.key === `watches:${name}`)!;
		expect(finding).toBeDefined();
		expect(cardCovers(allNotices(), Date.now(), doctorLabels)(finding)).toBe(true);
	}
});

test("a failing monitor's alert, posted the way the gateway posts it, lands in the notice store as a card with the id watches:<name>", async () => {
	addWatch({ name: "price-post", label: "가격 확인", command: "printf 'DOTZ_FAIL fetch\\n'; exit 1", every_minutes: 10, on: "fail", to: "alert" }, "");
	const n = await failTwice("price-post");
	await out(...watchIssuePost(n.w, watchLabel("price-post"), n.reason, n.info, n.output));
	expect(listNotices(300).items.filter(c => c.kind === "decision").map(c => [c.decision!.card_id, c.title])).toEqual([["watches:price-post", "가격 확인 · 원인을 확인할까요?"]]);
});

test("a skipped release slot's line names the slot its tick belongs to, not the minute of the tick", () => {
	const skipped = (tick: string) => watchChoice("정시 릴리스", `failed 1 times in a row (exit ${SLOT_SKIPPED_EXIT})`, false, { fails: 1, failSince: Date.parse(tick) }).split("\n")[1];
	expect(skipped("2026-12-01T03:06:40Z")).toBe("12월 1일 오후 12:00 릴리스 시간대를 건너뛰었어요");
	expect(skipped("2026-12-01T09:03:10Z")).toBe("12월 1일 오후 6:00 릴리스 시간대를 건너뛰었어요");
	expect(skipped("2026-12-01T15:07:00Z")).toBe("12월 2일 오전 12:00 릴리스 시간대를 건너뛰었어요");
});

const LOGIN = "printf 'DOTZ_FAIL login\\n'; exit 1";
const olderCard = (name: string, ts: string) => ({ ts, kind: "out", source: "gateway", target: "alert", nk: "alert", text: `[${name}] 로그인이 풀렸어요\n결정: ${name}: 로그인이 풀렸어요. 다시 연결할까요, 이 모니터링을 멈출까요?\n**1) 다시 연결**\n지금 다시 로그인해서 확인해요.\n**2) 원인 확인**\n출력을 보고 원인과 고칠 방법을 알려드려요.` });
const olderCardOf = () => listNotices(300).items.find(n => n.decision?.to === "alert" && n.decision.card_id === undefined)!;

test("an answer on a monitor's older card stored without an id counts for the back-off while its newer card with the id stays open", async () => {
	addWatch({ name: "shop-old", command: LOGIN, every_minutes: 10, on: "fail", to: "alert", approval_minutes: 30 }, "");
	emit("outbox", olderCard("shop-old", new Date(Date.now() - 3 * 3600_000).toISOString()));
	emit("outbox", posted(allWatches().find(w => w.name === "shop-old")!, await failTwice("shop-old")));
	expect((await answerDecision(olderCardOf().id, { n: 2 }, async () => {})).status).toBe(200);
	expect(cardOf("shop-old").decision!.state).toBe("open");
	expect(watchCardAnsweredAt("shop-old")).toBe(Date.parse(olderCardOf().decision!.answered_at!));
});

test("of a monitor's older card and its newer one, both answered, the newer answer counts", async () => {
	addWatch({ name: "shop-two", command: LOGIN, every_minutes: 10, on: "fail", to: "alert", approval_minutes: 30 }, "");
	const t0 = Date.parse("2026-12-01T00:00:00Z"), iso = (h: number) => new Date(t0 + h * 3600_000).toISOString();
	emit("outbox", olderCard("shop-two", iso(0)));
	settleDecision(olderCardOf(), "1) 다시 연결", iso(1));
	emit("outbox", { ...posted(allWatches().find(x => x.name === "shop-two")!, await failTwice("shop-two")), ts: iso(2) });
	settleDecision(cardOf("shop-two"), "2) 원인 확인", iso(3));
	expect(watchCardAnsweredAt("shop-two")).toBe(t0 + 3 * 3600_000);
});
