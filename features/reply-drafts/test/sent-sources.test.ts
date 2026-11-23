import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { offerMailDraft } from "../lib/offer.ts";
import { identityOf, loadPairs, markLearned, paths, readLearned } from "../lib/settings.ts";
import { installSentMail, refreshPairs, SWEEP_LIMIT, type PluginSent, type Runner, type SentMail } from "../lib/tone.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.toneDir(), paths.learned(), paths.corpusDir(), join(paths.pairs("mail"), ".."), join(env.dir, "custom", "webmail")]) rmSync(p, { force: true, recursive: true });
});

const MAIL_ID = ["존댓말(해요체)로 짧게 쓴다", "인사 없이 바로 본론으로 들어간다", "끝은 '확인 부탁드려요.'로 맺는다"];
const DAY = 24 * 3_600_000;
const T0 = Date.parse("2031-03-01T00:00:00Z");
const daysAgo = (n: number): Date => new Date(new Date().getTime() - n * DAY);
const nothing: Runner = async () => ({ code: 1, stdout: "", stderr: "" });
const corpMail = { ...mailFixture, source: "corp", key: "corp-1", id: "1", to: "me@work.example" };
const sentItem = (n: number, body = `네 ${n}번 확인했습니다.`, at = T0 + n): SentMail => ({ to: "Kim <kim@example.com>", subject: `견적 ${n}`, at, body, received: "견적 부탁드려요" });
const pluginOf = (items: SentMail[], name = "corp"): PluginSent => async want => (want(name) ? [{ plugin: name, source: name, items }] : []);

function addSite(site: string): void {
	mkdirSync(join(env.dir, "custom", "webmail", site), { recursive: true });
	writeFileSync(join(env.dir, "custom", "webmail", site, "spec.json"), JSON.stringify({ sent: true }));
}
const siteRunner = (sites: Record<string, SentMail[] | "down">): Runner => async argv => {
	const items = sites[argv[2]!];
	if (items === undefined || items === "down") return { code: 1, stdout: "", stderr: "session expired" };
	return { code: 0, stdout: items.map(m => JSON.stringify(m)).join("\n"), stderr: "" };
};

test("an install whose sent mail lives in a mail plugin learns the mail identity when a draft is offered", async () => {
	enable(env);
	const analyze = fakeModel([j({ identity: MAIL_ID, templates: [] })]);
	const draft = fakeModel([j(goodReply)]);
	const plugins = pluginOf([sentItem(1), sentItem(2)]);
	const r = await offerMailDraft(corpMail, { send: () => {}, call: draft.call, analyze: analyze.call, sentTexts: onRead => installSentMail(nothing, plugins, onRead) });
	expect(r).toBe("offered");
	expect(identityOf({ app: "mail" })).toEqual(MAIL_ID);
	expect(analyze.calls[0]!.user).toContain("네 2번 확인했습니다.");
});

test("a plugin mail arriving with 자동 초안 off a day after the last read reads the sent folder again, with no draft and no model call", async () => {
	enable(env, { apps: { mail: { auto: false } } });
	markLearned(["pairs-plugin-corp~day", "pairs-plugin-corp@1"], daysAgo(2));
	const analyze = fakeModel([j({ identity: MAIL_ID, templates: [] })]);
	const draft = fakeModel([j(goodReply)]);
	const plugins = pluginOf([sentItem(7)]);
	let started: Promise<void> | undefined;
	const r = await offerMailDraft(corpMail, {
		send: () => {},
		call: draft.call,
		analyze: analyze.call,
		sentTexts: async () => ["네 확인했습니다."],
		refreshPairs: () => (started = refreshPairs(nothing, new Date(), plugins)),
	});
	await started;
	expect(r).toBe("off");
	expect(loadPairs("mail")).toMatchObject([{ reply: "네 7번 확인했습니다.", source: "corp" }]);
	expect(new Date().getTime() - Date.parse(readLearned()["pairs-plugin-corp~day"]!)).toBeLessThan(DAY);
	expect(draft.calls).toEqual([]);
	expect(analyze.calls).toEqual([]);
});

test("the identity sweep reads sites and plugins together, newest first, at most SWEEP_LIMIT texts, with quoted history dropped", async () => {
	addSite("webA");
	const mine = (n: number) => sentItem(n, `내 답장 ${n}\n\n> 인용된 옛 메일 ${n}\n\n2031년 3월 1일 Kim님이 작성:\n보낸 사람의 말 ${n}`, T0 + n * 1000);
	const site = Array.from({ length: 150 }, (_, n) => mine(n * 2));
	const plug = Array.from({ length: 150 }, (_, n) => mine(n * 2 + 1));
	const texts = await installSentMail(siteRunner({ webA: site }), pluginOf(plug));
	expect(texts).toHaveLength(SWEEP_LIMIT);
	expect(texts[0]).toContain("내 답장 299");
	expect(texts[1]).toContain("내 답장 298");
	expect(texts.at(-1)).toContain("내 답장 100");
	expect(texts.join("\n")).not.toMatch(/인용된|보낸 사람의 말/);
});

test("a source that fails never stops the others, and a plugin that fails does not either", async () => {
	addSite("webA");
	addSite("webB");
	const logged = spyOn(console, "error").mockImplementation(() => {});
	const reads: [string, number][] = [];
	const broken: PluginSent = async () => {
		throw new Error("plugin offline");
	};
	const fromSite = await installSentMail(siteRunner({ webA: "down", webB: [sentItem(1)] }), broken, (source, count) => reads.push([source, count]));
	expect(fromSite).toEqual(["네 1번 확인했습니다."]);
	expect(reads).toEqual([["webB", 1]]);
	const fromPlugin = await installSentMail(siteRunner({ webA: "down", webB: "down" }), pluginOf([sentItem(2)]));
	expect(fromPlugin).toEqual(["네 2번 확인했습니다."]);
	logged.mockRestore();
});

test("an empty sweep of the mail profile is logged with the sources it read, at most once a day", async () => {
	enable(env);
	const draft = fakeModel([j(goodReply)]);
	const lines: string[] = [];
	const deps = { send: () => {}, call: draft.call, analyze: fakeModel([j({ identity: [], templates: [] })]).call, log: (l: string) => void lines.push(l), sentTexts: (onRead: (source: string, count: number) => void) => installSentMail(nothing, pluginOf([]), onRead) };
	await offerMailDraft({ ...corpMail, key: "e-1", id: "e1", thread: "t-e1" }, deps);
	const empty = () => lines.filter(l => /identity not learned/.test(l));
	expect(empty()).toHaveLength(1);
	expect(empty()[0]).toContain("corp");
	await offerMailDraft({ ...corpMail, key: "e-2", id: "e2", thread: "t-e2" }, deps);
	expect(empty()).toHaveLength(1);
	const marked = readLearned();
	const dayOld = Object.keys(marked).filter(k => /empty/.test(k));
	expect(dayOld).toHaveLength(1);
	markLearned(dayOld, daysAgo(2));
	await offerMailDraft({ ...corpMail, key: "e-3", id: "e3", thread: "t-e3" }, deps);
	expect(empty()).toHaveLength(2);
});
