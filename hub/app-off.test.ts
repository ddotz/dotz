import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "./app-settings.ts";
import { blockedByOff, removalPlan, removeApp, watchOff } from "./app-off.ts";
import { now } from "./config.ts";
import { emit } from "./events.ts";
import { appKeyOf, integrationAvailable, integrationContext, integrationItems, readAppOff } from "./integrations.ts";
import { listNotices, NOTICE_CAP, setAppBlocker, setAppResolver, setOrchestratorAvailable, unreadCount } from "./notices.ts";
import { addWatch, allWatches, removeWatch, runWatch, setWatchGate } from "./watch.ts";

// An app switched off on THIS install (custom/apps.json): off wins over every `on` rule, pauses the app's watches, silences its notices, comes back
// whole when switched on, and 제거 deletes the watches and feature enablement (data only when asked). Names and ids are placeholders.
const dir = mkdtempSync(join(tmpdir(), "dotz-app-off-"));
const at = (rel: string) => join(dir, rel);
const put = (rel: string, text: string) => { mkdirSync(join(at(rel), ".."), { recursive: true }); writeFileSync(at(rel), text); };
const turn = (app: string, here: boolean) => writeSettings(dir, app, { use_here: here });
const resolver = (n: Parameters<typeof appKeyOf>[0]) => appKeyOf(n, integrationContext(dir, ["zele"]));
setAppResolver(resolver);
setAppBlocker(n => blockedByOff(dir, n));
setWatchGate(name => watchOff(dir, name));
setOrchestratorAvailable(() => false);
afterAll(() => {
	setAppResolver(() => undefined);
	setAppBlocker(() => false);
	setWatchGate(() => false);
	setOrchestratorAvailable(() => true);
	for (const w of allWatches()) if (w.name.startsWith("kakao-new")) removeWatch(w.id);
	rmSync(dir, { recursive: true, force: true });
});

const convs = { "mail:a": 2 };
const keys = (flags: string[] = ["zele"]) => integrationItems(integrationContext(dir, flags), [], convs).map(i => i.key);

describe("the switch", () => {
	test("is the first setting of every app and is stored as {app:{off:true}}", () => {
		for (const app of ["mail", "kakao", "instagram", "youtube", "site"]) expect(readSettings(dir, app)[0]).toMatchObject({ key: "use_here", value: true, switch: true });
		turn("mail", false);
		expect(JSON.parse(readFileSync(at("custom/apps.json"), "utf8"))).toEqual({ mail: { off: true } });
		expect(readSettings(dir, "mail")[0]!.value).toBe(false);
		turn("mail", true);
		expect(readAppOff(dir).size).toBe(0);
		expect(readSettings(dir, "mail")[0]!.value).toBe(true);
	});

	test("off overrides the conversation-prefix rule and the flag; on restores; the app is then listed as available", () => {
		expect(keys()).toContain("mail");
		turn("mail", false);
		expect(keys()).not.toContain("mail");
		const ctx = integrationContext(dir, ["zele"]);
		expect(integrationAvailable(integrationItems(ctx, [], convs), ctx).find(a => a.key === "mail")).toMatchObject({ off: true, conv: ["mail:"] });
		expect(integrationAvailable([], integrationContext(dir, [])).map(a => a.key)).toEqual(["mail"]);
		turn("mail", true);
		expect(keys()).toContain("mail");
		const back = integrationContext(dir, ["zele"]);
		expect(integrationAvailable(integrationItems(back, [], convs), back).some(a => a.key === "mail")).toBe(false);
	});

	test("off only touches this app", () => {
		turn("youtube", false);
		expect(readAppOff(dir)).toEqual(new Set(["youtube"]));
		expect(keys()).toContain("mail");
		turn("youtube", true);
	});
});

describe("a watch of an off app", () => {
	test("does not run while off and runs again when on", async () => {
		const out = at("ran.txt");
		put("ran.txt", "");
		const w = addWatch({ name: "kakao-new", command: `echo run >> '${out}'`, every_minutes: 600, on: "change", to: "alert" }, "");
		await runWatch(w.id);
		expect(readFileSync(out, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
		turn("kakao", false);
		await runWatch(w.id);
		expect(readFileSync(out, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
		expect(watchOff(dir, "kakao-new")).toBe(true);
		expect(watchOff(dir, "sample-other")).toBe(false);
		turn("kakao", true);
		await runWatch(w.id);
		expect(readFileSync(out, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
		removeWatch(w.id);
	});
});

describe("notices of an off app", () => {
	const report = (label: string) => emit("inbox", { ts: now(), kind: "watch", source: "watch", watch: `sample-${label}`, label, reason: "output changed", text: "a=1" });
	const titles = () => listNotices(NOTICE_CAP).items.map(n => n.title);

	test("none is kept while off, the old ones are hidden and not counted, and on restores them", () => {
		report("메일 첫 점검");
		expect(titles()).toContain("메일 첫 점검");
		const before = unreadCount();
		turn("mail", false);
		expect(titles()).not.toContain("메일 첫 점검");
		expect(unreadCount()).toBe(before - 1);
		report("메일 둘째 점검");
		report("샘플 일반 점검");
		expect(titles()).not.toContain("메일 둘째 점검");
		expect(titles()).toContain("샘플 일반 점검");
		turn("mail", true);
		expect(titles()).toContain("메일 첫 점검");
		expect(titles()).not.toContain("메일 둘째 점검");
	});
});

describe("제거", () => {
	const fakeWatches = (names: string[]) => { const gone: string[] = []; return { gone, deps: { watchNames: () => names, removeWatch: (n: string) => void gone.push(n) } }; };
	const kakaoOn = () => {
		const shipped = readFileSync(join(import.meta.dir, "..", "features", "kakao", "feature.md"), "utf8");
		put("features/kakao/feature.md", shipped.replace(/^enabled: false$/m, "enabled: true"));
		put("custom/kakao/config.json", JSON.stringify({ enabled: true, watch_chats: ["1"] }));
	};

	test("the plan names what goes: the app's watches, the feature, the data that exists", () => {
		kakaoOn();
		expect(removalPlan(dir, "kakao", ["kakao-new", "sample-other"])).toEqual({ app: "kakao", label: "카카오톡", watches: ["kakao-new"], features: ["kakao"], data: ["custom/kakao"] });
		expect(removalPlan(dir, "nope", [])).toBeUndefined();
	});

	test("keep data: off, watches deleted, feature disabled here, the files stay", () => {
		kakaoOn();
		const { gone, deps } = fakeWatches(["kakao-new", "sample-other"]);
		removeApp(dir, "kakao", {}, deps);
		expect(gone).toEqual(["kakao-new"]);
		expect(readAppOff(dir).has("kakao")).toBe(true);
		expect(integrationContext(dir, []).features.has("kakao")).toBe(false);
		expect(existsSync(at("custom/kakao/config.json"))).toBe(true);
		expect(readFileSync(at("features/kakao/feature.md"), "utf8")).toMatch(/^enabled: false$/m);
	});

	test("delete data: the app's folder is gone too, other apps' files stay", () => {
		kakaoOn();
		put("custom/other/keep.json", "{}");
		removeApp(dir, "kakao", { deleteStored: true }, fakeWatches([]).deps);
		expect(existsSync(at("custom/kakao"))).toBe(false);
		expect(existsSync(at("custom/other/keep.json"))).toBe(true);
	});

	test("a key-based app deletes only its own key", () => {
		put("custom/sns/config.json", JSON.stringify({ instagram: { user_id: "u" }, youtube: { id: "y" } }));
		expect(integrationContext(dir, []).files("custom/sns/config.json#instagram")).toBe(true);
		removeApp(dir, "instagram", { deleteStored: true }, fakeWatches(["sns-ig-comments", "sns-yt-comments"]).deps);
		expect(JSON.parse(readFileSync(at("custom/sns/config.json"), "utf8"))).toEqual({ youtube: { id: "y" } });
	});

	test("a removed app can be switched on again; it is listed as available until it is set up", () => {
		const ctx = () => integrationContext(dir, []);
		expect(integrationAvailable(integrationItems(ctx(), [], {}), ctx()).find(a => a.key === "kakao")).toMatchObject({ off: true });
		turn("kakao", true);
		expect(readAppOff(dir).has("kakao")).toBe(false);
		expect(integrationItems(ctx(), [], {}).some(i => i.key === "kakao")).toBe(false);
	});
});
