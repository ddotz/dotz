// DOTZ_DIR points at the throwaway config of the bun test preload (hub/runtime/test-setup.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { en as shippedEn } from "./i18n-en.ts";
import { webWords } from "./texts.ts";
import { loadCatalog, diskReader, setCatalogProvider, setOwnerWords, placeholders, type Catalog, type Value } from "./web-i18n.ts";
import { bundle, indexPage, setAppLang, webSources } from "./webapp.ts";
import { createGenerator, valueProblem, type CacheFile, type Call, type Generator } from "./web-i18n-gen.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-webgen-"));
});
afterEach(() => {
	setCatalogProvider(undefined);
	setOwnerWords(undefined);
	setAppLang("ko");
	rmSync(dir, { recursive: true, force: true });
});

type Sent = { k: string; ko: Value; en: Value };
const german = (v: Value): Value => (typeof v === "string" ? `de: ${v}` : Object.fromEntries(Object.entries(v).map(([c, t]) => [c, `de: ${t}`])));

// A fake model: answers every sent key through `answer` (default: the German marker plus the English text) and records what it was sent.
function fake(answer: (it: Sent, call: number) => unknown = it => german(it.en)) {
	const sent: string[][] = [];
	const call: Call = async (_system, text) => {
		const items = JSON.parse(text) as Sent[];
		sent.push(items.map(i => i.k));
		return { text: JSON.stringify(items.map(i => answer(i, sent.length))) };
	};
	return { call, sent, calls: () => sent.length };
}
const noTimer = () => () => {};
const cacheFile = (): CacheFile => JSON.parse(readFileSync(join(dir, "de.json"), "utf8"));

function build(call: Call, extra: { ko?: () => Catalog; en?: () => Catalog; connected?: () => boolean; batchSize?: number } = {}): Generator {
	const gen = createGenerator({
		call,
		dir,
		ko: extra.ko ?? (() => webSources().ko),
		en: extra.en ?? (() => webSources().en),
		lang: () => "de",
		connected: extra.connected ?? (() => true),
		onLanguage: setAppLang,
		schedule: noTimer,
		batchSize: extra.batchSize,
	});
	gen.install();
	return gen;
}
const page = async (): Promise<string> => (await indexPage(new Request("http://localhost/"))).text();

const koSmall: Catalog = { a: "가 {n}", b: "나 {n}", c: { one: "{n}개", other: "{n}개" }, d: "라", e: "마" };
const enSmall: Catalog = { a: "A {n}", b: "B {n}", c: { one: "{n} item", other: "{n} items" }, d: "D", e: "E" };

test("German from a fake model: cache file, bundle, html lang; the second page open makes no model call", async () => {
	const model = fake();
	const gen = build(model.call);
	await gen.signal("start");
	expect(existsSync(join(dir, "de.json"))).toBe(true);
	expect(cacheFile().complete).toBe(true);
	const js = bundle("js").text;
	expect(js).toContain('const I18N_LANG = "de"');
	expect(js).toContain(`de: ${shippedEnHome()}`);
	expect(await page()).toContain('<html lang="de">');
	const calls = model.calls();
	expect(calls).toBeGreaterThan(0);
	await page();
	bundle("js");
	expect(model.calls()).toBe(calls);
});
const shippedEnHome = (): string => String(webSources().en["common.home"]);

test("one changed source is the only key sent again", async () => {
	let en = enSmall;
	const model = fake();
	const gen = build(model.call, { ko: () => koSmall, en: () => en });
	await gen.signal("start");
	expect(model.sent.flat().sort()).toEqual(["a", "b", "c", "d", "e"]);
	en = { ...enSmall, b: "B changed {n}" };
	expect(gen.provider("de")?.b).toBe("B changed {n}");
	await gen.signal("start");
	expect(model.sent.slice(1)).toEqual([["b"]]);
	expect(gen.provider("de")?.b).toBe("de: B changed {n}");
	expect(gen.provider("de")?.a).toBe("de: A {n}");
});

test("a reply that breaks a rule leaves that key English, its neighbours translated, and it is not sent again", async () => {
	const bad: Record<string, unknown> = {
		a: "de: A",
		b: "de: B {n+이/가}",
		c: { one: "de: {n} item", few: "de: {n} items", other: "de: {n} items" },
		d: "  ",
	};
	const model = fake(it => (it.k in bad ? bad[it.k] : german(it.en)));
	const gen = build(model.call, { ko: () => koSmall, en: () => enSmall });
	await gen.signal("start");
	const served = gen.provider("de")!;
	expect(served.e).toBe("de: E");
	for (const k of ["a", "b", "c", "d"]) expect(served[k]).toEqual(enSmall[k]!);
	const file = cacheFile();
	for (const k of ["a", "b", "c", "d"]) expect(file.entries[k]?.rejected).toBe(true);
	expect(file.entries.e?.rejected).toBeUndefined();
	const before = model.calls();
	await gen.signal("start");
	expect(model.calls()).toBe(before);
});

test("markup the English does not have is not taken", () => {
	expect(valueProblem("Save", "<b>Speichern</b>", ["one", "other"])).toBeDefined();
	expect(valueProblem("a < b", "a < b", ["one", "other"])).toBeUndefined();
	expect(valueProblem("Save", "Speichern", ["one", "other"])).toBeUndefined();
});

test("an owner's web: entry survives a full regeneration and wins; one with broken placeholders is not used", async () => {
	const withPlaceholder = Object.entries(webSources().en).find(([, v]) => typeof v === "string" && placeholders(v).length > 0)![0];
	mkdirSync(join(dir, "custom"), { recursive: true });
	const owner = { "web:common.home": "Mein Zuhause", [`web:${withPlaceholder}`]: "ohne Platzhalter" };
	writeFileSync(join(dir, "custom", "texts.json"), JSON.stringify(owner));
	setOwnerWords(() => webWords(dir));
	const first = build(fake().call);
	await first.signal("start");
	rmSync(join(dir, "de.json"));
	const model = fake();
	const again = build(model.call);
	await again.signal("start");
	expect(model.calls()).toBeGreaterThan(0);
	const js = bundle("js").text;
	expect(js).toContain("Mein Zuhause");
	expect(js).not.toContain("ohne Platzhalter");
	expect(js).toContain(`de: ${String(webSources().en[withPlaceholder])}`);
});

test("connection path: English and no call before the model is connected, German after the signal; a failing model is retried by the next signal", async () => {
	let connected = false;
	let broken = true;
	const model = fake();
	const call: Call = (s, t, o) => (broken ? Promise.reject(new Error("no route")) : model.call(s, t, o));
	const gen = build(call, { connected: () => connected });
	await gen.signal("start");
	expect(model.calls()).toBe(0);
	expect(await page()).toContain('<html lang="en">');
	expect(gen.status().state).toBe("waiting");

	connected = true;
	await gen.signal("connected");
	expect(gen.status().state).toBe("failed");
	expect(await page()).toContain('<html lang="en">');

	broken = false;
	await gen.signal("connected");
	expect(gen.status().state).toBe("ready");
	expect(await page()).toContain('<html lang="de">');
	expect(bundle("js").text).toContain('const I18N_LANG = "de"');
});

test("half-built: a run stopped after the first batch serves English; resuming sends only the unfinished keys", async () => {
	let stopAfterFirst = true;
	const model = fake();
	const call: Call = (s, t, o) => (stopAfterFirst && model.calls() >= 1 ? Promise.reject(new Error("stopped")) : model.call(s, t, o));
	const gen = build(call, { ko: () => koSmall, en: () => enSmall, batchSize: 2 });
	await gen.signal("start");
	expect(gen.provider("de")).toBeUndefined();
	expect(await page()).toContain('<html lang="en">');
	const done = model.sent[0]!;
	expect(done.length).toBe(2);
	expect(Object.keys(cacheFile().entries).sort()).toEqual([...done].sort());

	stopAfterFirst = false;
	await gen.signal("start");
	const resumed = model.sent.slice(1).flat();
	for (const k of done) expect(resumed).not.toContain(k);
	expect([...done, ...resumed].sort()).toEqual(["a", "b", "c", "d", "e"]);
	expect(gen.provider("de")?.e).toBe("de: E");
});

test("an en channel name and its web common word stay the same word", () => {
	const web = loadCatalog("en", diskReader());
	const pairs: [string, string][] = [["chat", "common.chat"], ["alert", "common.alerts"], ["worklog", "common.worklog"], ["mail", "common.mail"]];
	for (const [name, key] of pairs) expect(String(web[key]).toLowerCase()).toBe(shippedEn.channelNames[name as "chat"].toLowerCase());
});
