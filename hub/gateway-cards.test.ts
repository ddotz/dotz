import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasesFile, setAlias } from "./account-alias.ts";
import { rulesFile, writeRules } from "./account-rules.ts";
import { resetStickyForTest } from "./account-sticky.ts";
import { accountAsk, pinnedLimitAlert } from "./accounts-api.ts";
import { authFile } from "./apikey-policy.ts";
import { detailOf, parseChoices, parseDecisions, replyChoiceBlock } from "./choices.ts";
import { cfg, DATA_DIR, paths } from "./config.ts";
import { cardCovers } from "./doctor.ts";
import type { Finding } from "./doctor-types.ts";
import { emit } from "./events.ts";
import { LEGACY_ID, legacyAnswer, legacyAsk, MIGRATIONS_FILE } from "./migrations.ts";
import { allNotices, resetNoticesForTest } from "./notices.ts";
import { answerDecision } from "./notices-answers.ts";
import { errorAnswer, errorAsk, plainError } from "./orch-error.ts";
import { runKey } from "./notices-schedule.ts";
import { ownerText } from "./owner-text.ts";
import { proposeRecipe, recipeAnswer, recipeBlock } from "./recipes.ts";
import { sendRepeatAlerts } from "./reflect.ts";
import { slotStart } from "./release.ts";
import { restartCapText } from "./restart.ts";
import { scheduleRan } from "./schedule-fire.ts";
import { addSchedule, removeSchedule, runNow } from "./schedule.ts";
import { autoAlert } from "./selfupdate-card.ts";
import { cardAlert, harnessFailText, harnessLabel, type Run, runHarnessUpdate } from "./update.ts";
import { RECONNECT_ACTION, watchChoice, watchIssueText, watchSubject } from "./watch-ask.ts";
import { clockKo } from "./watchtext.ts";
import { SELF_UPDATE_CARD_ID } from "./worklog-kind.ts";

const DAY = 24 * 3600_000;
const NOW = Date.now();
type Card = { title: string; evidence: string[]; results: string[] };

const cardOf = (text: string): Card => {
	const blocks = parseDecisions(text).blocks;
	expect(blocks).toHaveLength(1);
	const b = blocks[0]!;
	return { title: b.title, evidence: b.evidence ?? [], results: b.options.map(o => o.desc) };
};

function expectSaysWhatEachAnswerDoes(card: Card): void {
	for (const r of card.results) expect(r.trim()).not.toBe("");
	expect(new Set(card.results).size).toBe(card.results.length);
}

function expectGatewayCard(card: Card, subject: string): void {
	expect(card.title.startsWith(`${subject} · `)).toBe(true);
	expect([...card.title].length).toBeLessThanOrEqual(40);
	expect(card.evidence.length).toBeGreaterThan(0);
	expectSaysWhatEachAnswerDoes(card);
}
const saved = cfg.identity;
beforeAll(() => void (cfg.identity = { ...saved, name: saved?.name ?? "sample-1", language: "ko" }));
afterAll(() => void (cfg.identity = saved));

afterEach(() => {
	for (const p of [paths.lanes, paths.recipeChoices, paths.corrections, paths.repeatAlerts]) rmSync(p, { recursive: true, force: true });
	resetNoticesForTest();
});

test("a monitor's card names the monitor, shows the failure count and since when, and says what each answer does and how a stop is undone", () => {
	const since = NOW - 5 * 3600_000;
	for (const login of [false, true]) {
		const card = cardOf(watchChoice("가격 확인", "failed 7 times in a row (exit 1)", login, { fails: 7, failSince: since }));
		expectGatewayCard(card, "가격 확인");
		expect(card.evidence).toContain("7번 연속 실패했어요");
		expect(card.evidence.some(l => l.endsWith("부터 실패하고 있어요"))).toBe(true);
		expect(card.results.at(-1)).toContain("다시 켜 달라고 하면");
		expect(watchSubject(card.title)).toBe("가격 확인");
	}
});

test("a monitor with a long label gets a title within 40 characters cut at a word, and the whole label as its first line", () => {
	const label = "아주 긴 이름을 가진 사내 그룹웨어 결재 대기 문서 확인";
	const card = cardOf(watchChoice(label, "failed 2 times in a row (exit 1)", true, { fails: 2 }));
	const subject = watchSubject(card.title)!;
	expectGatewayCard(card, subject);
	expect(subject.endsWith("…")).toBe(true);
	expect(label.startsWith(`${subject.slice(0, -1)} `)).toBe(true);
	expect(card.evidence[0]).toBe(`모니터링: ${label}`);
});

test("every line of a monitor's card is true for its case: a stopped monitor is not said to keep running, a skipped slot says which slot", () => {
	const at = NOW - 3600_000;
	for (const reason of ["stopped after 9 failures in a row over a day; it runs again once the owner approves (dotz_watch approve x) or the watch is added again", "stopped after a fetch failure; it runs again once the owner approves (dotz_watch approve x) or the watch is added again"]) {
		const card = cardOf(watchChoice("가격 확인", reason, false, { fails: 9, failSince: at }));
		expectGatewayCard(card, "가격 확인");
		expect(card.results.join(" ")).not.toContain("그대로 돌아요");
	}
	expect(cardOf(watchChoice("가격 확인", "failed 3 times in a row (exit 1)", false, { fails: 3, failSince: at })).results[0]).toContain("모니터링은 그대로 돌아요");
	const skipped = cardOf(watchChoice("정시 릴리스", "failed 1 times in a row (exit 3)", false, { fails: 1, failSince: at }));
	expectGatewayCard(skipped, "정시 릴리스");
	expect(skipped.evidence.some(l => l.includes("실패하고 있어요"))).toBe(false);
	expect(skipped.evidence).toEqual([`${clockKo(slotStart(new Date(at)).toISOString())} 릴리스 시간대를 건너뛰었어요`]);
});

test("a yes/no card derives its result lines only when they read true: an open, a nested or a negated question gets the plain lines", () => {
	const results = (q: string) => cardOf(ownerText(`**결정: ${q}**`)).results;
	const plain = ["물은 대로 하라고 답해요.", "하지 말라고 답해요."];
	for (const q of ["확인 안 할까요?", "몇 시에 할까요?", "왜 이렇게 할까요?", "얼마나 할까요?", "어떤 걸로 할까요?", "지금 업데이트해야 할까요?", "A안으로 할까요 B안으로 할까요?"]) expect(results(q)).toEqual(plain);
	expect(results("다음 주에 할까요?")).toEqual(["다음 주에 해요.", "다음 주에 하지 않아요."]);
	expect(results("배포 · 이대로 머지할까요?")).toEqual(["이대로 머지해요.", "이대로 머지하지 않아요."]);
	expect(results("삭제할까요?")).toEqual(["삭제해요.", "삭제하지 않아요."]);
	expect(results("새 안을 제안할까요?")).toEqual(["새 안을 제안해요.", "새 안을 제안하지 않아요."]);
});

test("a lost-login card keeps its 다시 연결 action, and a card stored with a title of the old code is still that monitor's card", () => {
	const old = "가격 확인: 로그인이 풀렸어요. 다시 연결할까요, 이 모니터링을 멈출까요?";
	expect(watchSubject(old)).toBe("가격 확인");
	expect(watchSubject("다시 연결할까요, 가격 확인 모니터링을 멈출까요?")).toBe("가격 확인");
	const w = { name: "price-check", session: { url: "https://shop.example.test" }, state: { fails: 2, kind: "login" } };
	for (const text of [watchIssueText(w as Parameters<typeof watchIssueText>[0], "가격 확인", "failed 2 times in a row (exit 1)", undefined, "DOTZ_FAIL login"), `[가격 확인] 로그인이 풀렸어요\n결정: ${old}\n**1) 다시 연결**\n지금 다시 로그인해서 확인해요.\n**2) 원인 확인**\n출력을 봐요.`]) {
		resetNoticesForTest();
		emit("outbox", { ts: new Date(NOW).toISOString(), kind: "out", source: "gateway", target: "alert", nk: "alert", text });
		const [card, ...rest] = allNotices().filter(n => n.kind === "decision");
		expect(rest).toHaveLength(0);
		expect(watchSubject(card!.title)).toBe("가격 확인");
		expect(card!.decision!.options.find(o => o.label === "다시 연결")?.action).toBe(RECONNECT_ACTION);
	}
});

test("three skipped release slots told about one monitor leave one open card that counts them", () => {
	for (const h of [0, 6, 12]) emit("outbox", { ts: new Date(NOW - (12 - h) * 3600_000).toISOString(), kind: "out", source: "gateway", target: "alert", nk: "alert", text: watchIssueText({ name: "release-slot", state: { fails: 1 } }, "정시 릴리스", "failed 1 times in a row (exit 3)", undefined, "") });
	const cards = allNotices().filter(n => n.kind === "decision");
	expect(cards).toHaveLength(1);
	expect(cards[0]!.decision).toMatchObject({ state: "open", asked: { n: 3 } });
});

test("a repeated correction's card names its topic, shows the count and one example, and says what each answer does", async () => {
	const ts = [3, 2, 1].map(d => new Date(NOW - d * DAY).toISOString());
	writeFileSync(paths.corrections, `${ts.map((t, i) => JSON.stringify({ ts: t, topic: "ui", conv: "web", text: `여백이 이상함 ${i}`, attachments: [], previous: "" })).join("\n")}\n`);
	const posted: string[] = [];
	await sendRepeatAlerts(async text => void posted.push(text), NOW);
	expect(posted).toHaveLength(1);
	const card = cardOf(posted[0]!);
	expectGatewayCard(card, "화면·디자인");
	expect(card.evidence).toContain("7일간 3건");
	expect(card.evidence).toContain("예: 여백이 이상함 2");
});

test("a recipe's card names the recipe, says when it is used, and says how a saved one is removed", () => {
	for (const [name, title] of [["report-a", "주간 매출 보고서 작성"], ["report-b", "주간 매출 보고서 정리"]]) {
		mkdirSync(join(paths.lanes, name!), { recursive: true });
		writeFileSync(join(paths.lanes, name!, "lane.json"), JSON.stringify({ name, title, status: "exited", endedAt: new Date(NOW - DAY).toISOString(), claim: { state: "verified" } }));
	}
	const id = /recipes\.ts propose (\S+)/.exec(recipeBlock(NOW))![1]!;
	const card = cardOf(proposeRecipe(id, { slug: "weekly-report", name: "주간 보고서", when: "주간 보고서를 달라고 할 때", body: "1. 시트를 읽어요\n2. 틀을 채워요" }, NOW));
	expectGatewayCard(card, "주간 보고서");
	expect(card.evidence).toContain("쓸 때: 주간 보고서를 달라고 할 때");
	expect(card.results[0]).toContain("그 폴더를 지우면");
});

test("a yes/no card a model wrote says what yes and no each do, in the question's words when it asks to do one thing", () => {
	const derived = cardOf(ownerText("확인했어요.\n**결정: sample-2 배포 · 지금 진행할까요?**"));
	expect(derived.title).toBe("sample-2 배포 · 지금 진행할까요?");
	expect(derived.results).toEqual(["지금 진행해요.", "지금 진행하지 않아요."]);
	for (const q of ["sample-2 배포 · 어떻게 할까요?", "sample-2 배포 · 괜찮을까요?"]) expectSaysWhatEachAnswerDoes(cardOf(ownerText(`**결정: ${q}**`)));
});

test("a reply question names whose reply it is and says what each choice sends", () => {
	const card = cardOf(replyChoiceBlock("몇 시에 만날까요?", ["3시에 만나요", "5시에 만나요"], "민수 답장"));
	expect(card.title).toBe("민수 답장 · 몇 시에 만날까요?");
	expect(card.results).toHaveLength(3);
	expect(card.results[0]).toContain("3시에 만나요");
	expectSaysWhatEachAnswerDoes(card);
});

test("a failed schedule run's card is correct Korean for any name and says what 다시 실행 and 그만두기 do", () => {
	for (const name of ["sample-4 매일 점검", "피드백 보고서", "Big Bath 점검 시간이에요"]) {
		const s = addSchedule({ name, kind: "task", text: "상태 보고해", in_minutes: 600, every_minutes: 1440 });
		const run = runNow(s.id);
		scheduleRan({ ids: [run], sk: "task" }, "failed");
		const card = allNotices().find(n => n.key === runKey(run))!;
		removeSchedule(s.id);
		expect(card.title).toBe(`${name} · 다시 실행할까요?`);
		expect(card.title).not.toContain("(를)");
		expect(card.decision!.evidence!.length).toBeGreaterThan(0);
		expectSaysWhatEachAnswerDoes({ title: card.title, evidence: card.decision!.evidence!, results: card.decision!.options.map(o => o.desc) });
	}
});

const LIMIT_FILES = () => [authFile(), join(process.env.OMO_CODING_AGENT_DIR!, "credential-pool-state.json"), join(DATA_DIR, "account.json"), rulesFile(), aliasesFile()];
function pinnedAtLimit<T>(read: (until: number) => T, o: { alias?: string; blocked?: string[]; ahead?: number } = {}): T {
	const until = NOW + (o.ahead ?? 3600_000), alias = o.alias ?? "개인 계정";
	writeFileSync(authFile(), JSON.stringify({ "anthropic-subscription": { accounts: ["default", "work"].map(name => ({ name, access: "fake" })) } }));
	writeFileSync(LIMIT_FILES()[1]!, JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots: Object.fromEntries((o.blocked ?? ["default"]).map(n => [n, { blockReason: "rate_limit", blockedUntil: until }])) } } } } }));
	writeRules({ manual: { account: "default" } });
	if (alias.trim()) setAlias("default", alias);
	else writeFileSync(aliasesFile(), JSON.stringify({ default: alias }));
	resetStickyForTest();
	try {
		return read(until);
	} finally {
		for (const f of LIMIT_FILES()) rmSync(f, { force: true });
		resetStickyForTest();
	}
}
const SELF_FAILED = { failed: true, rel: "261124.1 → 261124.2", why: "테스트 3개가 실패해서 이전 버전으로 되돌렸어요", commits: 4, latest: "닥터 점검 줄이 무엇을 쟀는지 숫자로 말해요" };
const SELF_REFUSED = { failed: false, rel: "261124.1 → 261124.2", why: "지금 브랜치가 dev이에요. main에서만 업데이트해요.", commits: 4, latest: "닥터 점검 줄이 무엇을 쟀는지 숫자로 말해요" };
const HARNESS_FAILED = { current: "5.1.38", latest: "5.1.40", now: "5.1.38", kept: "rolledBack" as const, output: "error: network down" };
const orchStopped = { since: new Date(NOW - 40 * 60_000).toISOString(), ...plainError("getaddrinfo ENOTFOUND api.anthropic.com"), raw: "getaddrinfo ENOTFOUND api.anthropic.com" };
const BUSY = ["lane l1 (2 background workers)", "orchestrator background jobs (1)"];
const busyTitle = (_kind: "lane" | "conv", key: string) => (key === "l1" ? "사이트 고치기" : key);

test("a pinned account at its limit: the card names the account, says when the limit clears and how many other accounts are free, and how each answer is changed back", () => {
	const card = pinnedAtLimit(until => cardOf(pinnedLimitAlert(until)!));
	expectGatewayCard(card, "개인 계정 한도");
	expect(card.evidence).toContain("지금 쓸 수 있는 다른 계정이 1개 있어요");
	expect(card.evidence.some(l => l.endsWith("에 한도가 풀려요"))).toBe(true);
	for (const r of card.results) expect(r).toContain("설정 → 계정");
});

test("a stopped orchestrator: the card names the assistant, says what broke and since when, and an empty name still gives a subject", () => {
	const card = cardOf(errorAsk("sample-1", orchStopped));
	expectGatewayCard(card, "sample-1");
	expect(card.evidence[0]).toBe("네트워크(DNS)가 안 돼요");
	expect(card.evidence[1]).toMatch(/^\d{2}:\d{2}부터 멈춰 있어요$/);
	expectGatewayCard(cardOf(errorAsk(" ", orchStopped)), "어시스턴트");
});

test("a restart past its cap: the card names the gateway restart, says how long it waited and what still runs, and that 지금 재시작 cuts that work", () => {
	const card = cardOf(restartCapText(BUSY, 92, busyTitle));
	expectGatewayCard(card, "게이트웨이 재시작");
	expect(card.evidence).toContain("92분째 기다리고 있어요");
	expect(card.evidence).toContain("아직 도는 작업: 세션 사이트 고치기 (워커 2개), 메인 대화 작업 1개");
	expect(card.results[0]).toContain("끊고");
	expect(card.results[1]).toContain("끊지 않고");
});

test("a failed or refused dotz auto-update: the card says which release, why, the new commits, and where auto-update is turned back on", () => {
	for (const [facts, first] of [[SELF_FAILED, "버전 261124.1 → 261124.2: 적용하지 못했어요"], [SELF_REFUSED, "버전 261124.1 → 261124.2: 막혀서 적용하지 않았어요"]] as const) {
		const card = cardOf(autoAlert(facts));
		expectGatewayCard(card, "dotz 업데이트");
		expect(card.evidence[0]).toBe(first);
		expect(card.evidence[1]).toBe(`이유: ${facts.why}`);
		expect(card.evidence).toContain("새 커밋 4개, 마지막: 닥터 점검 줄이 무엇을 쟀는지 숫자로 말해요");
		expect(card.results[1]).toContain("설정 → 업데이트의 '새 버전 자동 적용'으로 다시 켤 수 있어요");
	}
});

test("a failed harness install: the card names the harness update, says the versions, what it is on now and the installer's last line", () => {
	const card = cardOf(harnessFailText("omp", HARNESS_FAILED));
	expectGatewayCard(card, "omp 업데이트");
	expect(card.evidence).toEqual(["버전 5.1.38 → 5.1.40 설치하지 못했어요", "이전 버전으로 되돌렸어요 (지금 5.1.38)", "마지막 출력: error: network down"]);
});

test("the earlier YouTube/Instagram login: the card names it, says what was found and that nothing is copied yet, and how to bring it over later", () => {
	const card = cardOf(legacyAsk(["youtube-oauth.json", "instagram.json"]));
	expectGatewayCard(card, "예전 유튜브·인스타 연결");
	expect(card.evidence[0]).toBe("찾은 연결: 유튜브, 인스타그램");
	expect(card.results[1]).toContain("예전 파일 위치");
	expect(card.results[1]).toContain("다시 묻지 않아요");
});

test("every card of these producers keeps its subject and a title within 40 characters in English too", () => {
	const ko = cfg.identity;
	cfg.identity = { ...ko!, language: "en" };
	try {
		const cards: [string, string][] = [
			[pinnedAtLimit(until => pinnedLimitAlert(until)!), "개인 계정 limit"],
			[errorAsk("sample-1", orchStopped), "sample-1"],
			[restartCapText(BUSY, 92, busyTitle), "Gateway restart"],
			[autoAlert(SELF_FAILED), "dotz update"],
			[harnessFailText("omp", HARNESS_FAILED), "omp update"],
			[legacyAsk(["youtube-oauth.json"]), "YouTube/Instagram login"],
		];
		for (const [text, subject] of cards) expectGatewayCard(cardOf(text), subject);
	} finally {
		cfg.identity = ko;
	}
});

test("the answers of an orchestrator-error card are read from its labels in either language, so a card stored by the old code is still answered", () => {
	expect([errorAnswer("1) 다시 시작"), errorAnswer("**2) 기다리기**"), errorAnswer("1) Restart"), errorAnswer("2) Wait")]).toEqual(["restart", "wait", "restart", "wait"]);
	expect([errorAnswer("2) 다시 시작"), errorAnswer("다시 시작"), errorAnswer("1) 다시 생각해 볼게요")]).toEqual([undefined, undefined, undefined]);
});

test("the self-update and failed-install cards are posted with their ids, and the doctor's finding of the same matter counts as covered", async () => {
	const plain: string[] = [];
	const post = cardAlert(async (target, text, _replyTo, extra) => void emit("outbox", { ts: new Date(NOW).toISOString(), kind: "out", source: "gateway", target, text, ...extra }), text => void plain.push(text));
	post(autoAlert(SELF_FAILED), [SELF_UPDATE_CARD_ID]);
	const run: Run = async cmd => (cmd[1] === "--version" ? { code: 0, out: "omo 5.1.38 (engine: senpi 2026.10.19)" } : { code: 1, out: "error: network down" });
	const stateDir = mkdtempSync(join(tmpdir(), "dotz-gateway-cards-"));
	try {
		await runHarnessUpdate({ mode: "install", post: () => undefined, alert: post, restart: () => "", run, latest: async () => "5.1.40", locate: () => "/home/user/.bun/install/global/node_modules/omo-ai/bin/omo.js", harnesses: ["omo"], stateDir });
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
	expect(plain).toEqual([]);
	const cards = allNotices().filter(n => n.kind === "decision");
	expect(cards.map(n => n.decision?.card_id).sort()).toEqual(["update:omo", "update:self"]);
	for (const n of cards) expectGatewayCard({ title: n.title, evidence: n.decision?.evidence ?? [], results: n.decision!.options.map(o => o.desc) }, n.decision?.card_id === "update:self" ? "dotz 업데이트" : `${harnessLabel("omo")} 업데이트`);
	expect(cards.find(n => n.decision?.card_id === "update:self")!.decision?.evidence).toEqual(cardOf(autoAlert(SELF_FAILED)).evidence);
	expect(cards.find(n => n.decision?.card_id === "update:omo")!.decision?.evidence).toEqual(["버전 5.1.38 → 5.1.40 설치하지 못했어요", "지금 5.1.38 그대로예요", "마지막 출력: error: network down"]);
	const covers = cardCovers(allNotices(), NOW, { watch: name => name, harness: harnessLabel });
	const matter = (key: string): Finding => ({ key, area: "update", what: "failed", evidence: [], since: NOW, level: 1, ask: true });
	expect([covers(matter("update:self")), covers(matter("update:omo")), covers(matter("update:omp"))]).toEqual([true, true, false]);
});

const LONG_ALIAS = "회사 공용 클로드 맥스 구독 계정 (디자인팀 + 개발팀 함께 씀)";
const LONG_NAME = "우리 집 비서 어시스턴트 (맥미니 메인 오케스트레이터)";
const LONG_ERR = "Error: request failed\n    at fetch (node:internal/deps/undici:1)\n    caused by: getaddrinfo ENOTFOUND api.anthropic.com";
const BUSY_LONG = ["lane l1 (2 background workers)", "lane l2 (1 background workers)", "conversation session c1 background jobs (3)", "orchestrator background workers (2)", "orchestrator background jobs (1)"];
const longTitle = (_kind: "lane" | "conv", key: string) => ({ l1: "인스타그램 댓글 자동 답장 기능 전체 리팩터링과 테스트 보강", l2: "세션 사이트 고치기", c1: "어머니와의 대화 (카카오톡)" })[key] ?? key;
const SELF_LONG = { failed: true, rel: "261124.1 → 261124.2", why: "테스트 3개가 실패해서 이전 버전으로 되돌렸어요: hub/doctor.test.ts > the morning card names its subject and stays within forty characters on a phone\nhub/x.test.ts > y", commits: 137, latest: "게이트웨이 카드가 주제를 말하고, 근거를 보여 주고, 각 답이 무엇을 하는지 말해요 (긴 제목 시험)" };
const UNDO = `git -C "/Users/me/dotz" reset --keep 0a1b2c3d4e5f`;
const HALFWAY = { ...SELF_FAILED, why: "테스트 3개가 실패했어요", halfway: { at: "5f3e2a1", undo: UNDO } };
const NPM_404 = "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/omo-ai/-/omo-ai-5.1.40.tgz - Not found in this registry, please check the version and the package name";
type Handler = "account" | "orch" | "legacy" | "model";
const systemCards = (): { name: string; text: string; handler: Handler }[] => [
	{ name: "account", text: pinnedAtLimit(until => pinnedLimitAlert(until)!), handler: "account" },
	{ name: "account, long name, another day", text: pinnedAtLimit(until => pinnedLimitAlert(until)!, { alias: LONG_ALIAS, ahead: 2 * DAY }), handler: "account" },
	{ name: "orchestrator", text: errorAsk("sample-1", orchStopped), handler: "orch" },
	{ name: "orchestrator, long name and error", text: errorAsk(LONG_NAME, { since: orchStopped.since, ...plainError(LONG_ERR), raw: LONG_ERR }), handler: "orch" },
	{ name: "restart", text: restartCapText(BUSY, 92, busyTitle), handler: "model" },
	{ name: "restart, long busy list", text: restartCapText(BUSY_LONG, 1440, longTitle), handler: "model" },
	{ name: "self-update failed", text: autoAlert(SELF_FAILED), handler: "model" },
	{ name: "self-update refused", text: autoAlert(SELF_REFUSED), handler: "model" },
	{ name: "self-update, long reason", text: autoAlert(SELF_LONG), handler: "model" },
	{ name: "self-update stopped halfway", text: autoAlert(HALFWAY), handler: "model" },
	{ name: "harness", text: harnessFailText("omp", HARNESS_FAILED), handler: "model" },
	{ name: "harness, long output", text: harnessFailText("omo", { ...HARNESS_FAILED, kept: "notRolledBack", now: "5.1.40", output: NPM_404.split("\n").pop()! }), handler: "model" },
	{ name: "legacy", text: legacyAsk(["instagram.json"]), handler: "legacy" },
	{ name: "legacy, both", text: legacyAsk(["youtube-oauth.json", "instagram.json"]), handler: "legacy" },
];
function inLanguage<T>(language: string, read: () => T): T {
	const was = cfg.identity;
	cfg.identity = { ...was!, language };
	try {
		return read();
	} finally {
		cfg.identity = was;
	}
}
const LANGUAGES = ["ko", "en"];

test("every system card keeps a title within 40 characters and at most four evidence lines for the longest realistic input, and cuts a long reason, output or busy list", () => {
	for (const language of LANGUAGES)
		for (const { name, text } of inLanguage(language, systemCards)) {
			const card = cardOf(text);
			expect({ name, language, titleChars: [...card.title].length <= 40, evidence: card.evidence.length >= 1 && card.evidence.length <= 4 }).toEqual({ name, language, titleChars: true, evidence: true });
			for (const line of card.evidence.filter(l => !l.includes(UNDO))) expect({ name, language, line, short: [...line].length <= 120 }).toEqual({ name, language, line, short: true });
		}
	const ko = Object.fromEntries(systemCards().map(c => [c.name, cardOf(c.text)]));
	const why = ko["self-update, long reason"]!.evidence[1]!;
	expect({ start: why.startsWith("이유: 테스트 3개가 실패해서 이전 버전으로 되돌렸어요: hub/doctor.test.ts"), cut: why.endsWith("…"), secondLine: why.includes("hub/x.test.ts"), short: [...why].length <= 104 }).toEqual({ start: true, cut: true, secondLine: false, short: true });
	const output = ko["harness, long output"]!.evidence[2]!;
	expect({ start: output.startsWith("마지막 출력: npm ERR! 404 Not Found - GET"), cut: output.endsWith("…"), short: [...output].length <= 88 }).toEqual({ start: true, cut: true, short: true });
	expect(ko["restart, long busy list"]!.evidence[1]!.endsWith("…")).toBe(true);
	expect(ko["account, long name, another day"]!.title).toBe("회사 공용 클로드 맥스 구독 계정… · 자동 전환으로 바꿀까요?");
	expect([...ko["orchestrator, long name and error"]!.title].length).toBeLessThanOrEqual(40);
});

test("every option of the system cards is taken by a tap alone, and its answer is read by its own card's handler and by no other, in both languages", async () => {
	const kept = process.env.DOTZ_LEGACY_SECRETS;
	process.env.DOTZ_LEGACY_SECRETS = "";
	const pending = join(DATA_DIR, MIGRATIONS_FILE);
	const readers = (said: string): Handler[] => {
		writeFileSync(pending, JSON.stringify({ done: {}, pending: { [LEGACY_ID]: ["instagram.json"] } }));
		try {
			const took: (Handler | false)[] = [errorAnswer(said) !== undefined && "orch", legacyAnswer(DATA_DIR, said) !== undefined && "legacy", accountAsk(said, ["default", "work"], {}) !== undefined && "account", recipeAnswer(said) !== undefined && "model"];
			return took.filter((h): h is Handler => h !== false);
		} finally {
			rmSync(pending, { force: true });
			rmSync(join(DATA_DIR, "custom", "sns"), { recursive: true, force: true });
		}
	};
	try {
		for (const language of LANGUAGES)
			for (const { name, text, handler } of inLanguage(language, systemCards)) {
				const options = parseDecisions(text).blocks[0]!.options;
				expect(parseChoices(text).options.map(o => o.label)).toEqual(options.map(o => o.label));
				for (const o of options) {
					resetNoticesForTest();
					emit("outbox", { ts: new Date(NOW).toISOString(), kind: "out", source: "gateway", target: "alert", nk: "alert", text });
					const id = allNotices().find(n => n.kind === "decision")!.id;
					let sent = "";
					const tapped = await answerDecision(id, { n: o.n }, async p => void (sent = p.text));
					const said = `${o.n}) ${o.label}`;
					expect({ name, language, label: o.label, asksDetail: detailOf(o), status: tapped.status, sent }).toEqual({ name, language, label: o.label, asksDetail: false, status: 200, sent: said });
					expect({ name, language, said, readBy: readers(said) }).toEqual({ name, language, said, readBy: handler === "model" ? [] : [handler] });
				}
			}
	} finally {
		kept === undefined ? delete process.env.DOTZ_LEGACY_SECRETS : (process.env.DOTZ_LEGACY_SECRETS = kept);
	}
	expect([errorAnswer("1) Restart the orchestrator"), errorAnswer("1) 다시 시작하지 마요"), errorAnswer("1) 다시 시작 - 지금 바로")]).toEqual([undefined, undefined, "restart"]);
});

test("an English install's system cards carry no Korean in a line the gateway writes, and name each setting as the settings page names it", () => {
	const cards = inLanguage("en", () => [
		pinnedAtLimit(until => pinnedLimitAlert(until)!, { alias: "Personal", ahead: 2 * DAY }),
		pinnedAtLimit(until => pinnedLimitAlert(until)!, { alias: "Personal", ahead: 60_000 }),
		errorAsk("sample-1", orchStopped),
		restartCapText(BUSY_LONG, 92, (_kind, key) => (key === "l1" ? "Fix the site" : key)),
		autoAlert({ ...SELF_FAILED, latest: "Cards say what each answer does" }),
		autoAlert({ ...SELF_REFUSED, latest: "Cards say what each answer does" }),
		autoAlert({ ...HALFWAY, latest: "Cards say what each answer does" }),
		harnessFailText("omo", HARNESS_FAILED),
		legacyAsk(["youtube-oauth.json", "instagram.json"]),
	]);
	for (const text of cards) expect(text.split("\n").map(l => l.replace(/^결정: /, "")).filter(l => /[가-힣]/.test(l))).toEqual([]);
	expect(cardOf(cards[4]!).results[1]).toContain("Settings → Updates, Apply updates automatically");
	expect(cardOf(cards[3]!).results[0]).toContain("Restart now in Settings → Updates");
	for (const r of cardOf(cards[0]!).results) expect(r).toContain("Settings → Accounts");
	expect(cardOf(cards[0]!).results[1]).toContain("At a limit");
	expect(cardOf(cards[7]!).title).toBe("work program update · Install again?");
});

test("the switch answer of the account card says later limits switch without asking and where that is changed", () => {
	expect(cardOf(pinnedAtLimit(until => pinnedLimitAlert(until)!)).results[0]).toBe("쓸 수 있는 다른 계정으로 넘어가 바로 이어서 해요. 고정은 풀리고, 다음 한도에도 묻지 않고 넘어가요. 설정 → 계정에서 다시 고정하고, '한도에 걸리면'에서 바꿀 수 있어요.");
	expect(inLanguage("en", () => cardOf(pinnedAtLimit(until => pinnedLimitAlert(until)!)).results[0])).toBe("Moves to another usable account and continues right away; the pin is lifted and later limits switch without asking. Settings → Accounts pins it again, and At a limit changes that.");
});

test("an account with a blank name is named by its id, and blocked accounts are not counted as usable", () => {
	expect(cardOf(pinnedAtLimit(until => pinnedLimitAlert(until)!, { alias: "  " })).title).toBe("default 한도 · 자동 전환으로 바꿀까요?");
	expect(cardOf(pinnedAtLimit(until => pinnedLimitAlert(until)!, { blocked: ["default", "work"] })).evidence).toContain("다른 계정도 지금은 모두 막혀 있어요");
});

test("a self-update whose rollback failed too says it stopped halfway, where the files are and the whole command that puts it back, never that the version is unchanged", () => {
	expect(cardOf(autoAlert(HALFWAY)).evidence).toEqual(["버전 261124.1 → 261124.2: 적용하지 못했어요", "이유: 테스트 3개가 실패했어요", "업데이트가 중간에 멈췄어요. 파일은 새 버전 5f3e2a1에 있어요", `되돌리려면 터미널에서: \`${UNDO}\``]);
	expect(inLanguage("en", () => cardOf(autoAlert(HALFWAY)).evidence)).toEqual(["Version 261124.1 → 261124.2: could not be applied", "Why: applying it failed; the update log has the reason", "The update stopped halfway: the files are at the new version 5f3e2a1", `To put it back, run in a terminal: \`${UNDO}\``]);
	expect(cardOf(autoAlert(SELF_FAILED)).evidence[3]).toBe("지금 버전 그대로예요. 더 새 버전이 오면 다시 시도해요");
});

test("an English self-update card says whether the update was blocked before applying or failed while applying", () => {
	expect(inLanguage("en", () => [cardOf(autoAlert(SELF_REFUSED)).evidence[1], cardOf(autoAlert(SELF_FAILED)).evidence[1]])).toEqual(["Why: blocked before applying; the update log has the reason", "Why: applying it failed; the update log has the reason"]);
});

test("a self-update of a commit with no release number says the new commits, not an empty version", () => {
	expect(cardOf(autoAlert({ ...SELF_FAILED, rel: "" })).evidence[0]).toBe("새 커밋을 적용하지 못했어요");
	expect(cardOf(autoAlert({ ...SELF_REFUSED, rel: "" })).evidence[0]).toBe("새 커밋이 막혀서 적용하지 않았어요");
	expect(inLanguage("en", () => cardOf(autoAlert({ ...SELF_FAILED, rel: "" })).evidence[0])).toBe("The new commits could not be applied");
});
