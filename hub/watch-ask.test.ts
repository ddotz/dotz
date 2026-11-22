import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { emit } from "./events.ts";
import { answerDecision, decisionsOf, listNotices, resetNoticesForTest } from "./notices.ts";
import { deliverAnswer } from "./routes.ts";
import { addWatch, allWatches, removeWatch, runWatch, startWatches, stopWatches, type Watch } from "./watch.ts";
import { watchIssueText } from "./watch-ask.ts";
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
