// The first read of the past reply pairs (lib/offer.ts readOnArrival, lib/tone.ts refreshPairs): a mail coming in starts it on an install that drafts nothing
// on its own, each source reads once, nothing calls a model, and an explicit off stays off, also for a draft the owner asks for.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runOnboard } from "../bin/onboard.ts";
import { offerMailDraft, requestMailDraft } from "../lib/offer.ts";
import { appOn, loadPairs, loadSettings, paths, readLearned } from "../lib/settings.ts";
import { refreshPairs, type PluginSent, type Runner } from "../lib/tone.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.learned(), paths.pairs("mail"), paths.personalFeature()]) rmSync(p, { force: true, recursive: true });
});

const SENT = { to: "Kim <kim@example.com>", subject: "견적", at: 1_900_000_000_000, body: "네 확인했습니다", received: "견적 부탁드려요" };
const noRun: Runner = async () => ({ code: 1, stdout: "", stderr: "" });
const DAY = 25 * 3_600_000, START = Date.parse("2031-03-01T00:00:00Z");

// A mail plugin with a sent folder; `answers` says what each read gets (undefined: no session this time). Every model call is counted.
function plugin(answers: (typeof SENT[] | undefined)[]) {
	const limits: number[] = [], model = fakeModel([j(goodReply)]), analyze = fakeModel([j({ identity: [], templates: [] })]), toneReads = { n: 0 };
	const sent: PluginSent = async want => {
		const limit = want("intra");
		if (!limit) return [];
		limits.push(limit);
		const items = answers.shift();
		return items ? [{ plugin: "intra", source: "intra", items }] : [];
	};
	const arrive = async (at: number, offer = offerMailDraft) => {
		const read = Promise.withResolvers<void>();
		const asked = { n: 0 };
		const r = await offer({ ...mailFixture, source: "intra", key: `intra-${at}`, id: String(at) }, { send: () => {}, call: model.call, analyze: analyze.call, sentTexts: async () => (toneReads.n++, ["네 확인했습니다"]), refreshPairs: () => (asked.n++, refreshPairs(noRun, new Date(at), sent).finally(read.resolve)) });
		if (asked.n) await read.promise;
		return { r, asked: asked.n };
	};
	return { limits, model, analyze, toneReads, arrive };
}

test("no switch decided and no monitoring: a mail of a plugin's source reads its sent folder once, with no draft and no model call", async () => {
	const p = plugin([[SENT], [SENT]]);
	expect(appOn(loadSettings(), "mail")).toBe(false);
	expect((await p.arrive(START)).r).toBe("off");
	expect(loadPairs("mail")).toMatchObject([{ reply: "네 확인했습니다", source: "intra" }]);
	expect(readLearned()["pairs-plugin-intra@1"]).toBeTruthy();
	await p.arrive(START + 3_600_000);
	await p.arrive(START + DAY);
	expect(p.limits).toEqual([3000, 40]);
	expect(p.model.calls).toEqual([]);
	expect(p.analyze.calls).toEqual([]);
});

test("a first read with no session stays open and takes the whole folder again the next day", async () => {
	const p = plugin([undefined, [SENT]]);
	await p.arrive(START);
	expect(readLearned()["pairs-plugin-intra@1"]).toBeUndefined();
	await p.arrive(START + DAY);
	expect(p.limits).toEqual([3000, 3000]);
	expect(readLearned()["pairs-plugin-intra@1"]).toBeTruthy();
});

test.each([
	["the whole feature off", ["off"]],
	["mail off", ["off", "--app", "mail"]],
])("%s: neither a new mail nor a draft he asks for reads anything", async (_name, args) => {
	await runOnboard(args);
	const p = plugin([[SENT]]);
	expect(await p.arrive(START)).toEqual({ r: "off", asked: 0 });
	expect((await p.arrive(START + 1, requestMailDraft)).asked).toBe(0);
	expect(p.limits).toEqual([]);
	expect(p.toneReads.n).toBe(0);
	expect(p.analyze.calls).toEqual([]);
	expect(loadPairs("mail")).toEqual([]);
});

test("a draft on an install that turned mail on still reads, once for both the arrival and the draft", async () => {
	enable(env);
	const p = plugin([[SENT]]);
	expect((await p.arrive(START)).r).toBe("offered");
	expect(p.limits).toEqual([3000]);
	expect(loadPairs("mail")).toHaveLength(1);
});
