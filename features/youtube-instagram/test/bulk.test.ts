// Multilingual bulk apply: off by default, public videos only, the daily quota budget (with progress that moves in 10% steps),
// the backup before the first edit, and restore per video and for all. Fake Data API and a fake translator, no network.
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { run as bulk } from "../bin/yt-bulk.ts";
import { run as sns } from "../bin/sns.ts";
import { bulkBudget, readBulk, restoreAll, restoreOne } from "../lib/bulk.ts";
import { type Config, paths, validateConfig, writeJson } from "../lib/config.ts";
import { used } from "../lib/quota.ts";
import { fakeCtx, type FakeCtx, setupEnv, type TestEnv, YT } from "./helpers.ts";

type Store = Record<string, { title: string; description: string; localizations?: Record<string, { title: string; description: string }> }>;

let env: TestEnv;
let store: Store;
let puts: { id: string; snippet: { description: string }; localizations: Record<string, { title: string; description: string }> }[];
let visibility: Record<string, string>;
const translate = async (_system: string, user: string) => {
	const lang = /Target language: (\S+)/.exec(user)![1];
	return JSON.stringify({ title: `T-${lang}`, description: `D-${lang}` });
};

function setup(mutate?: (c: Config) => void, n = 3) {
	env = setupEnv(c => {
		delete c.instagram;
		c.youtube!.bulk = true;
		mutate?.(c);
	});
	store = {};
	visibility = {};
	for (let i = 1; i <= n; i++) {
		store[`vid${String(i).padStart(8, "0")}`] = { title: `Title ${i}`, description: `Desc ${i}` };
		visibility[`vid${String(i).padStart(8, "0")}`] = "public";
	}
	store.vidprivate01 = { title: "Hidden", description: "Secret" };
	visibility.vidprivate01 = "private";
}

function serve(ctx: FakeCtx) {
	ctx.routes[`GET ${YT}/playlistItems`] = () => ({ items: Object.keys(store).map(id => ({ snippet: { resourceId: { videoId: id } }, status: { privacyStatus: visibility[id] } })) });
	ctx.routes[`GET ${YT}/videos`] = call => {
		const ids = new URL(call.url).searchParams.get("id")!.split(",");
		return { items: ids.map(id => ({ id, snippet: { title: store[id]!.title, description: store[id]!.description, categoryId: "22", defaultLanguage: "ko" }, localizations: store[id]!.localizations })) };
	};
	ctx.routes[`PUT ${YT}/videos`] = call => {
		const b = JSON.parse(call.body);
		puts.push(b);
		store[b.id]!.description = b.snippet.description;
		store[b.id]!.localizations = b.localizations;
		return { id: b.id };
	};
}

const readCfg = () => JSON.parse(readFileSync(paths.config(), "utf8")) as Config;
const day = (d: number) => `2030-06-${String(d).padStart(2, "0")}T20:00:00.000Z`;
const runDay = async (d: number) => {
	const ctx = fakeCtx(env, { now: day(d) });
	serve(ctx);
	return { ctx, res: await bulk(ctx, [], translate) };
};

beforeEach(() => {
	puts = [];
});
afterEach(() => env.cleanup());

test("off by default: no config flag, no call", async () => {
	setup(c => {
		c.youtube!.bulk = undefined;
	});
	const { ctx, res } = await runDay(15);
	expect(res).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
});

test("bulk needs languages and a budget within the daily one", () => {
	setup();
	const base = readCfg();
	expect(validateConfig({ ...base, youtube: { ...base.youtube, languages: [] } })).toContain("번역 언어");
	expect(validateConfig({ ...base, quota: { daily_budget: 9000, bulk_budget: 9500 } })).toContain("예산");
});

test("public videos get [English]/[日本語] sections and localizations; the original is backed up first; a second run changes nothing", async () => {
	setup();
	const { res } = await runDay(15);
	expect(puts.map(p => p.id).sort()).toEqual(["vid00000001", "vid00000002", "vid00000003"]);
	const first = puts.find(p => p.id === "vid00000001")!;
	expect(first.snippet.description).toBe("Desc 1\n\n[English]\nD-en\n\n[日本語]\nD-ja");
	expect(first.localizations).toEqual({ en: { title: "T-en", description: "D-en" }, ja: { title: "T-ja", description: "D-ja" } });
	expect(existsSync(`${paths.backup()}/vid00000001.json`)).toBe(true);
	expect(existsSync(`${paths.backup()}/vidprivate01.json`)).toBe(false);
	expect(res.lines).toEqual(["다국어 설명을 공개 영상 3개에 모두 적용했어요"]);
	puts.length = 0;
	const again = await runDay(15);
	expect(puts).toHaveLength(0);
	expect(again.res.lines).toEqual(["다국어 설명을 공개 영상 3개에 모두 적용했어요"]);
});

test("the day's budget stops the run; the rest follows on the next Pacific day", async () => {
	setup(c => {
		c.quota.bulk_budget = 130;
	});
	const a = await runDay(15);
	expect(puts).toHaveLength(2);
	expect(used(a.ctx)).toBeLessThanOrEqual(130);
	expect(a.res.lines).toEqual(["다국어 설명 2/3개 적용했어요"]);
	const same = await runDay(15);
	expect(puts).toHaveLength(2);
	expect(same.res.lines).toEqual(["다국어 설명 2/3개 적용했어요"]);
	const next = await runDay(16);
	expect(puts).toHaveLength(3);
	expect(next.res.lines).toEqual(["다국어 설명을 공개 영상 3개에 모두 적용했어요"]);
});

test("the default budget keeps 500 units of the daily budget for comments", () => {
	setup();
	expect(bulkBudget(readCfg())).toBe(8500);
});

test("the progress line changes only when it moves by 10%", async () => {
	setup(c => {
		c.quota.bulk_budget = 60;
	}, 20);
	const lines: string[] = [];
	for (let d = 15; d <= 17; d++) lines.push((await runDay(d)).res.lines[0]!);
	expect(lines).toEqual(["다국어 설명 1/20개 적용했어요", "다국어 설명 2/20개 적용했어요", "다국어 설명 2/20개 적용했어요"]);
});

test("restore puts one video back and bulk does not apply it again; restore all undoes the rest within the budget", async () => {
	setup();
	const { ctx } = await runDay(15);
	puts.length = 0;
	await restoreOne(ctx, "vid00000001");
	expect(puts).toHaveLength(1);
	expect(puts[0]).toMatchObject({ id: "vid00000001", snippet: { description: "Desc 1" }, localizations: {} });
	expect(readBulk()!.restored).toEqual(["vid00000001"]);
	puts.length = 0;
	await runDay(16);
	expect(puts).toHaveLength(0);

	writeJson(paths.quota(), { day: "2030-06-17", units: 8900 });
	const c17 = fakeCtx(env, { now: day(17) });
	serve(c17);
	const cfg = readCfg();
	expect(await restoreAll(c17, cfg)).toEqual({ restored: 2, left: 0 });
	expect(store.vid00000002!.description).toBe("Desc 2");
	expect(store.vid00000003!.description).toBe("Desc 3");
});

test("restore all stops at the daily budget and says how many are left; sns.ts exposes it with the progress", async () => {
	setup();
	await runDay(15);
	writeJson(paths.quota(), { day: "2030-06-17", units: 8900 });
	const ctx = fakeCtx(env, { now: day(17) });
	serve(ctx);
	expect((await sns(ctx, ["restore", "all"])).lines).toEqual(["restored 2 left 1"]);
	expect((await sns(ctx, ["bulk-status"])).lines).toEqual(["다국어 설명 1/3개 적용했어요 (되돌린 영상 2개)"]);
});
