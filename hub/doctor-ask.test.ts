import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { discordDoctorLeave, webAnswer } from "./approval-wire.ts";
import { parseDecisions } from "./choices.ts";
import { cfg, paths } from "./config.ts";
import { compose, type DoctorStore } from "./doctor.ts";
import { gateway, logins, plugins, sessions, update, watches } from "./doctor-checks.ts";
import { doctorEn, doctorKo, isDoctorLeave } from "./doctor-text.ts";
import type { Finding } from "./doctor-types.ts";
import { emit, tailEvents } from "./events.ts";
import { msg } from "./i18n.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { promptHealth } from "./prompt-health.ts";
import { deliverAnswer } from "./routes.ts";

const env = setupEnv();
afterAll(env.cleanup);

const H = 3600e3, D = 24 * H;
const T0 = Date.parse("2026-11-10T08:00:00Z");
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dotz-doctor-ask-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const finding = (over: Partial<Finding> = {}): Finding => ({ key: "gateway:restarts", area: "gateway", what: "Sample one restarted.", evidence: "hub.log", since: T0, level: 4, ...over });
const asking = (over: Partial<Finding> = {}): Finding => finding({ ask: true, ...over });
const storeOf = (...found: Finding[]): DoctorStore => ({ version: 1, lastRun: T0, memo: {}, findings: Object.fromEntries(found.map(f => [f.key, f])), told: {} });
const cardsOf = (text: string) => parseDecisions(text).blocks;
const diskDecision = { question: "Sample disk question?", options: [{ name: "OPT-ONE", result: "R1" }, { name: "OPT-TWO", result: "R2" }] };

describe("a finding that asks is a decision card, never a question sentence", () => {
	test("the cause question is a card with the two answers, named by the finding", () => {
		const t = msg().doctor;
		const text = compose(storeOf(asking()), T0)!.text;
		expect(text).not.toMatch(/고칠까요|답하면|Fix it\?/);
		const [card, ...rest] = cardsOf(text);
		expect(rest).toEqual([]);
		expect(card!.title).toBe(t.askCard("Sample one restarted"));
		expect(card!.options.map(o => o.label)).toEqual([t.askFind, t.askLeave]);
	});

	test("one message carries one card per finding that asks, each titled by its own finding", () => {
		const t = msg().doctor;
		const notice = compose(storeOf(asking(), asking({ key: "watches:sample-2", area: "watches", what: "Monitor sample-2 failed 4 times in a row." }), finding({ key: "sessions:stuck", area: "sessions", what: "Sample session is stuck.", todo: "Close it." })), T0)!;
		expect(cardsOf(notice.text).map(b => b.title)).toEqual([t.askCard("Sample one restarted"), t.askCard("Monitor sample-2 failed 4 times in a row")]);
		expect(notice.decisions).toBe(2);
		expect(notice.text.split("\n")[0]).toBe(t.head(1, 2));
		expect(notice.text).toContain("- Sample session is stuck. Close it.");
	});

	test("findings with their own question keep theirs, ahead of the cause cards", () => {
		const t = msg().doctor;
		const notice = compose(storeOf(asking(), finding({ key: "disk:low", area: "disk", what: "DISK", decide: diskDecision }), asking({ key: "update:self", area: "update", what: "Sample update failed." })), T0)!;
		expect(cardsOf(notice.text).map(b => b.title)).toEqual([diskDecision.question, t.askCard("Sample one restarted"), t.askCard("Sample update failed")]);
		expect(notice.decisions).toBe(3);
	});

	test("two findings that ask with their own question are two cards, not one", () => {
		const second = { question: "Sample second question?", options: diskDecision.options };
		const notice = compose(storeOf(finding({ key: "disk:low", area: "disk", what: "DISK", decide: diskDecision }), finding({ key: "prompt:review:a", area: "prompt", what: "REVIEW", decide: second })), T0)!;
		expect(cardsOf(notice.text).map(b => b.title)).toEqual([diskDecision.question, second.question]);
	});

	test("findings said together on one line are one card named by their area", () => {
		const t = msg().doctor;
		const fail = (k: string) => asking({ key: `failures:${k}`, area: "failures", what: `LONG-${k}`, short: `S-${k}` });
		const notice = compose(storeOf(fail("a"), fail("b")), T0)!;
		expect(cardsOf(notice.text).map(b => b.title)).toEqual([t.askCard(t.areas.failures)]);
		expect(notice.text).toContain(t.failuresGrew(["S-a", "S-b"]));
	});

	test("a finding that does not ask has no card and no question", () => {
		const notice = compose(storeOf(finding({ todo: "Close it." })), T0)!;
		expect(cardsOf(notice.text)).toEqual([]);
		expect(notice.decision).toBe(false);
	});
});

describe("every doctor and prompt-health output path", () => {
	const saved = cfg.identity;
	afterEach(() => void (cfg.identity = saved));

	const logLine = (at: number, text: string) => `${new Date(at).toISOString()} ${text}\n`;
	async function realFindings(): Promise<Finding[]> {
		writeFileSync(join(dir, "hub.log"), [1, 2, 3].map(n => logLine(T0 - n * H, "gateway restart (1 request(s) coalesced, waited 2s)")).join("") + logLine(T0 - H, "omo update: OmO 1 → 2 설치하지 못했어요(network)"));
		writeFileSync(join(dir, "gateway.err.log"), "old\n");
		const memo: Record<string, unknown> = {};
		const ctx = { now: T0, dataDir: dir, home: dir, memo };
		await gateway(ctx);
		writeFileSync(join(dir, "gateway.err.log"), "old\nerror: new\n    at b (y.ts:2)\n");
		mkdirSync(join(dir, "lanes", "stalled"), { recursive: true });
		const old = new Date(T0 - 10 * H).toISOString();
		writeFileSync(join(dir, "lanes", "stalled", "lane.json"), JSON.stringify({ name: "stalled", status: "working", startedAt: old, lastReportAt: old }));
		const w = (id: string, state: object, extra: object = {}) => ({ id, name: id, ...extra, state: { fails: 0, ...state } });
		writeFileSync(join(dir, "watches.json"), JSON.stringify([w("login-a", { fails: 5, failSince: T0 - 13 * H, kind: "login" }, { session: { url: "u" } }), w("flaky", { fails: 3, failSince: T0 - H })]));
		writeFileSync(join(dir, "plugin-failures.json"), JSON.stringify({ "sample-plugin.ts": "Error: broken import" }));
		const prompt = { now: T0, dataDir: dir, home: dir };
		writeFileSync(join(dir, "RULES.md"), "- keep replies short\n");
		await promptHealth(prompt);
		writeFileSync(join(dir, "RULES.md"), `- never run launchctl kickstart on the gateway\n${"r".repeat(60_000)}\n`);
		writeFileSync(join(dir, "LESSONS.md"), "l".repeat(200_000));
		const t = msg().doctor;
		const byCatalog: Finding[] = [
			asking({ key: "failures:sample-a", area: "failures", what: t.failuresGrew(["S-a"]), short: t.failureShort("sample-a", "up") }),
			asking({ key: "tokens:sample-b", area: "tokens", what: t.tokens(["S-b"]), short: t.tokenShort("sample-b", 2) }),
			finding({ key: "disk:low", area: "disk", what: t.disk(2, 4), todo: t.todo.disk, decide: { question: t.diskQuestion, options: [{ name: t.diskCleanName, result: t.diskCleanResult }, { name: t.diskKeepName, result: t.diskKeepResult }] } }),
		];
		return [...(await gateway(ctx)), ...(await sessions(ctx)), ...(await logins(ctx)), ...(await watches(ctx)), ...(await update(ctx)), ...(await plugins(ctx)), ...((await promptHealth({ ...prompt, now: T0 + D })) as Finding[]), ...byCatalog];
	}

	const questionOutsideCards = (text: string): string[] => text.split(/\n{2,}/).filter(p => !p.startsWith("결정:")).join("\n").split("\n").filter(l => /[?？]|까요|나요|Fix it|Answer and/.test(l));

	for (const language of ["ko", "en"]) {
		test(`${language}: no line outside a card asks the owner anything, and a finding that asks always has its card`, async () => {
			cfg.identity = { ...cfg.identity, name: cfg.identity?.name ?? "sample-1", language };
			const found = await realFindings();
			expect(found.filter(f => f.ask).map(f => f.key).sort()).toEqual(["failures:sample-a", "gateway:crashes", "gateway:restarts", "plugins:sample-plugin.ts", "prompt:cap:LESSONS.md", "prompt:cap:RULES.md", "prompt:size:lessons", "prompt:size:rules", "prompt:size:total", "tokens:sample-b", "update:omo", "watches:flaky"]);
			for (const f of found) {
				const notice = compose(storeOf(f), T0)!;
				expect([f.key, questionOutsideCards(notice.text)]).toEqual([f.key, []]);
				if (f.ask || f.decide) expect([f.key, notice.decisions]).toEqual([f.key, 1]);
			}
			const all = compose(storeOf(...found), T0, true)!;
			expect(questionOutsideCards(all.text)).toEqual([]);
			const titles = cardsOf(all.text).map(b => b.title);
			expect(titles).toHaveLength(all.decisions);
			expect(new Set(titles).size).toBe(titles.length);
		});
	}

	test("the doctor's own sentences, in both languages, hold no question to the owner but the card questions", () => {
		const cardWords = new Set([doctorKo.diskQuestion, doctorEn.diskQuestion, doctorKo.askTitle, doctorEn.askTitle]);
		for (const catalog of [doctorKo, doctorEn]) {
			const strings = [...Object.values(catalog), ...Object.values(catalog.todo), ...Object.values(catalog.areas)].filter((v): v is string => typeof v === "string" && !cardWords.has(v));
			expect(strings.filter(s => /[?？]|까요|Fix it/.test(s))).toEqual([]);
		}
	});
});

describe("the cards through the notice store and the card buttons", () => {
	const post = (text: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target: "alert", wk: "doctor", text });
	const cards = () => listNotices(300).items.filter(n => n.kind === "decision");
	const inbox = (text: string) => tailEvents(paths.inbox).filter(e => e.kind === "message" && e.text === text);

	test("two findings that ask are two open cards, and the answer to one carries its finding", async () => {
		resetNoticesForTest();
		const t = msg().doctor;
		post(compose(storeOf(asking(), asking({ key: "update:self", area: "update", what: "Sample update failed." })), T0)!.text);
		const [first, second] = cards();
		expect(cards().map(c => c.title).sort()).toEqual([t.askCard("Sample one restarted"), t.askCard("Sample update failed")].sort());
		expect([first!.decision!.state, second!.decision!.state]).toEqual(["open", "open"]);
		const sent: string[] = [];
		const r = await webAnswer(second!.id, { n: 1 }, "local", async a => void sent.push(a.text));
		expect(r.status).toBe(200);
		expect(sent).toEqual([`${second!.title}: 1) ${t.askFind}`]);
		expect(cards().find(c => c.id === first!.id)!.decision!.state).toBe("open");
		resetNoticesForTest();
	});

	test("이번엔 둬요 closes the card and starts no turn; the other card stays open", async () => {
		resetNoticesForTest();
		const t = msg().doctor;
		post(compose(storeOf(asking(), asking({ key: "update:self", area: "update", what: "Sample update failed." })), T0)!.text);
		const target = cards().find(c => c.title === t.askCard("Sample one restarted"))!;
		const before = tailEvents(paths.inbox).length;
		const r = await webAnswer(target.id, { n: 2 }, "local", a => deliverAnswer({ ...a, login: "local" }));
		expect(r.status).toBe(200);
		expect(cards().map(c => [c.title, c.decision!.state, c.decision!.answer])).toEqual(expect.arrayContaining([[target.title, "answered", `2) ${t.askLeave}`]]));
		expect(cards().filter(c => c.decision!.state === "open")).toHaveLength(1);
		expect(tailEvents(paths.inbox)).toHaveLength(before);
		expect(inbox(`${target.title}: 2) ${t.askLeave}`)).toEqual([]);
		resetNoticesForTest();
	});

	test("이번엔 둬요 pressed on Discord closes the card with no turn too; another card's pick there is not taken", async () => {
		resetNoticesForTest();
		const t = msg().doctor;
		post(compose(storeOf(asking(), finding({ key: "disk:low", area: "disk", what: "DISK", decide: diskDecision })), T0)!.text);
		const target = cards().find(c => c.title === t.askCard("Sample one restarted"))!;
		const before = tailEvents(paths.inbox).length;
		const leave = (title: string, label: string) => discordDoctorLeave("alert", [{ q: title, n: 2, label }], a => deliverAnswer({ ...a, login: "owner" }));
		expect(await leave(diskDecision.question, t.askLeave)).toBe(false);
		expect(await leave(target.title, t.askLeave)).toBe(true);
		expect(cards().find(c => c.id === target.id)!.decision).toMatchObject({ state: "answered", answer: `2) ${t.askLeave}` });
		expect(tailEvents(paths.inbox)).toHaveLength(before);
		resetNoticesForTest();
	});

	test("only the doctor's cause question is left without a turn: the same words on another card still answer", () => {
		expect(isDoctorLeave(msg().doctor.askCard("Sample"), msg().doctor.askLeave)).toBe(true);
		expect(isDoctorLeave(diskDecision.question, msg().doctor.askLeave)).toBe(false);
		expect(isDoctorLeave(msg().doctor.askCard("Sample"), msg().doctor.askFind)).toBe(false);
	});
});
