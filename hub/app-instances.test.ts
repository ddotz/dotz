import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "./app-settings.ts";
import { blockedByOff, createApp, deleteApp, removalPlan, watchOff } from "./app-off.ts";
import { DATA_DIR, HUB_TOKEN } from "./config.ts";
import { appEntries, appKeyOf, integrationAvailable, integrationContext, integrationItems, readAppOff } from "./integrations.ts";
import { makeRoute } from "./routes.ts";

// App instances (custom/apps.json): the old {key:{off}} shape reads as one default instance per app, a second mail account is a second instance that owns
// its source's conversations and watches, each has its own name, an instance is created by one hub call and deleted only once off. Placeholders only.
const dir = mkdtempSync(join(tmpdir(), "dotz-app-inst-"));
const at = (rel: string) => join(dir, rel);
const put = (rel: string, text: string) => { mkdirSync(join(at(rel), ".."), { recursive: true }); writeFileSync(at(rel), text); };
const apps = (v: unknown) => put("custom/apps.json", JSON.stringify(v));
const readApps = () => JSON.parse(readFileSync(at("custom/apps.json"), "utf8"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { rmSync(at("custom"), { recursive: true, force: true }); rmSync(join(DATA_DIR, "custom/apps.json"), { force: true }); });

const TWO = { "mail-2": { app: "mail", label: "개인 메일", filter: { source: "naver", watches: ["webmail-naver"] } } };
const convs = { "mail:gmail-1": 2, "mail:naver-1": 3 };
const note = (id: string, where: string, extra: object = {}) => ({ id, title: "새 메일", text: "내용", src: where, ...extra });
const items = (flags = ["zele"], notices: ReturnType<typeof note>[] = [], unread = convs) => integrationItems(integrationContext(dir, flags), notices, unread);

describe("the old apps.json shape", () => {
	test("{key:{off}} reads as today: one default instance per app, id = app key, registry label", () => {
		apps({ mail: { off: true }, kakao: {} });
		expect(readAppOff(dir)).toEqual(new Set(["mail"]));
		expect(appEntries(dir).map(e => [e.key, e.label, !!e.created])).toEqual([["mail", "메일", false], ["kakao", "카카오톡", false], ["instagram", "인스타그램", false], ["youtube", "유튜브", false], ["site", "웹사이트 댓글", false]]);
		expect(items().map(i => i.key)).toEqual([]);
		apps({});
		expect(items().map(i => [i.key, i.app, i.label, i.conv, i.unread])).toEqual([["mail", "mail", "메일", ["mail:"], 5]]);
	});

	test("no file at all is the same as an empty one", () => {
		expect(items().map(i => i.key)).toEqual(["mail"]);
		expect(readAppOff(dir).size).toBe(0);
	});
});

describe("two mail instances", () => {
	test("each lists only its source's items and counts; the default keeps the rest", () => {
		apps(TWO);
		const notices = [note("a", "mail:gmail-1"), note("b", "mail:naver-1"), note("c", "mail:naver-2", { read: true })];
		const got = items(["zele"], notices);
		expect(got.map(i => [i.key, i.app, i.label, i.unread, i.notices])).toEqual([["mail", "mail", "메일", 3, ["a"]], ["mail-2", "mail", "개인 메일", 4, ["b", "c"]]]);
		expect(got[0]).toMatchObject({ conv: ["mail:"], convNot: ["mail:naver-"] });
		expect(got[1]).toMatchObject({ conv: ["mail:naver-"] });
		expect(got[1]!.convNot).toBeUndefined();
	});

	test("a text-only notice about mail stays the default's; a notice in the second source's conversation never leaks into it by text", () => {
		apps(TWO);
		const ctx = integrationContext(dir, ["zele"]);
		expect(appKeyOf({ id: "t", title: "메일 확인", text: "" }, ctx)).toBe("mail");
		expect(appKeyOf(note("n", "mail:naver-9", { title: "메일 도착" }), ctx)).toBe("mail-2");
		expect(appKeyOf(note("g", "mail:gmail-9", { title: "메일 도착" }), ctx)).toBe("mail");
	});

	test("an added instance is on without any feature or flag; it is off with the switch and then listed as available with its own name", () => {
		apps(TWO);
		expect(items([], [], {}).map(i => i.key)).toEqual(["mail-2"]);
		writeSettings(dir, "mail-2", { use_here: false });
		expect(readApps()["mail-2"]).toMatchObject({ app: "mail", off: true });
		const ctx = integrationContext(dir, ["zele"]);
		expect(integrationItems(ctx, [], convs).map(i => i.key)).toEqual(["mail"]);
		expect(integrationAvailable([], ctx)).toEqual([{ key: "mail-2", app: "mail", label: "개인 메일", icon: "mail", iconPath: expect.any(String), off: true, conv: ["mail:naver-"] }]);
	});

	test("the second source's switch and watch gate leave the default alone", () => {
		apps({ ...TWO, "mail-2": { ...TWO["mail-2"], off: true } });
		expect(watchOff(dir, "webmail-naver")).toBe(true);
		expect(watchOff(dir, "webmail-gmail")).toBe(false);
		expect(blockedByOff(dir, { src: "mail:naver-1" })).toBe(true);
		expect(blockedByOff(dir, { src: "mail:gmail-1" })).toBe(false);
		expect(blockedByOff(dir, { app: "mail-2" })).toBe(true);
	});
});

describe("rename", () => {
	test("the label is a setting of the instance; it shows in the item and the available list, and empty returns the app's own name", () => {
		expect(readSettings(dir, "mail")[1]).toMatchObject({ key: "label", type: "text", value: "메일", switch: true, max: 30 });
		writeSettings(dir, "mail", { label: "회사 메일" });
		expect(readApps()).toEqual({ mail: { label: "회사 메일" } });
		expect(items().map(i => i.label)).toEqual(["회사 메일"]);
		apps(TWO);
		writeSettings(dir, "mail-2", { label: "  보조  " });
		expect(items(["zele"]).map(i => i.label)).toEqual(["메일", "보조"]);
		expect(readSettings(dir, "mail-2")[1]!.value).toBe("보조");
		writeSettings(dir, "mail-2", { label: "" });
		expect(items(["zele"]).map(i => i.label)).toEqual(["메일", "메일"]);
		expect(() => writeSettings(dir, "mail-2", { label: "가".repeat(31) })).toThrow();
	});
});

describe("create and delete", () => {
	test("createApp registers an instance: the next free id, the label and a checked filter; a bad filter or app is refused", () => {
		expect(createApp(dir, { app: "mail", label: " 개인 ", filter: { source: " naver ", watches: ["webmail-naver"] } })).toEqual({ id: "mail-2", label: "개인" });
		expect(createApp(dir, { app: "mail", id: "mail-work" })).toEqual({ id: "mail-work", label: "메일" });
		expect(createApp(dir, { app: "mail" }).id).toBe("mail-3");
		expect(readApps()["mail-2"]).toEqual({ app: "mail", label: "개인", filter: { source: "naver", watches: ["webmail-naver"] } });
		expect(() => createApp(dir, { app: "nope" })).toThrow();
		expect(() => createApp(dir, { app: "mail", id: "kakao-2" })).toThrow();
		expect(() => createApp(dir, { app: "mail", id: "mail-2" })).toThrow(/이미/);
		expect(() => createApp(dir, { app: "mail", filter: { data: ["../secrets"] } })).toThrow();
		expect(() => createApp(dir, { app: "mail", filter: { conv: ["Mail: x"] } })).toThrow();
		expect(() => createApp(dir, { app: "mail", filter: { source: "///" } })).toThrow();
		expect(() => createApp(dir, { app: "kakao", filter: { source: "work" } })).toThrow();
	});

	test("deleteApp refuses an app that is on, then removes an off one for good with its watches; data only when asked", () => {
		put("custom/naver/store.json", "{}");
		createApp(dir, { app: "mail", label: "개인", filter: { conv: ["mail:naver-"], watches: ["webmail-naver"], data: ["custom/naver"] } });
		const gone: string[] = [], deps = { watchNames: () => ["webmail-naver", "webmail-gmail"], removeWatch: (n: string) => void gone.push(n) };
		expect(() => deleteApp(dir, "mail-2", {}, deps)).toThrow(/켜져 있어요/);
		expect(readApps()["mail-2"]).toBeDefined();
		expect(removalPlan(dir, "mail-2", deps.watchNames())).toMatchObject({ label: "개인", watches: ["webmail-naver"], features: [], data: ["custom/naver"] });
		writeSettings(dir, "mail-2", { use_here: false });
		expect(deleteApp(dir, "mail-2", {}, deps).watches).toEqual(["webmail-naver"]);
		expect(gone).toEqual(["webmail-naver"]);
		expect(readApps()["mail-2"]).toBeUndefined();
		expect(existsSync(at("custom/naver/store.json"))).toBe(true);
		expect(appEntries(dir).some(e => e.key === "mail-2")).toBe(false);
		expect(() => deleteApp(dir, "mail-2", {}, deps)).toThrow(/알 수 없는/);
		createApp(dir, { app: "mail", filter: { data: ["custom/naver"] } });
		writeSettings(dir, "mail-2", { use_here: false });
		deleteApp(dir, "mail-2", { deleteStored: true }, deps);
		expect(existsSync(at("custom/naver"))).toBe(false);
	});

	test("a deleted default stays off and gone (not listed, not available); creating without a filter brings it back", () => {
		apps({ mail: { label: "옛 이름", off: true } });
		const deps = { watchNames: () => [], removeWatch: () => {} };
		deleteApp(dir, "mail", {}, deps);
		expect(readApps()).toEqual({ mail: { off: true, deleted: true } });
		const ctx = integrationContext(dir, ["zele"]);
		expect(readAppOff(dir).has("mail")).toBe(true);
		expect(integrationItems(ctx, [], convs)).toEqual([]);
		expect(integrationAvailable([], ctx)).toEqual([]);
		expect(createApp(dir, { app: "mail", label: "새 메일" })).toEqual({ id: "mail", label: "새 메일" });
		expect(items().map(i => [i.key, i.label])).toEqual([["mail", "새 메일"]]);
	});

	test("deleting the default of two mail instances keeps the feature folder for the other; deleting the last one disables it", () => {
		const shipped = readFileSync(join(import.meta.dir, "..", "features", "webmail-no-api", "feature.md"), "utf8");
		put("features/webmail-no-api/feature.md", /^enabled:/m.test(shipped) ? shipped.replace(/^enabled:.*$/m, "enabled: true") : shipped.replace(/^---\r?\n/, "---\nenabled: true\n"));
		apps({ ...TWO, mail: { off: true } });
		expect(removalPlan(dir, "mail", [])!.features).toEqual([]);
		apps({ mail: { off: true } });
		expect(removalPlan(dir, "mail", [])!.features).toEqual(["webmail-no-api"]);
	});
});

describe("an install's own watches", () => {
	const deps = (names: string[], gone: string[] = []) => ({ watchNames: () => names, removeWatch: (n: string) => void gone.push(n) });

	test("a watch named in the instance's `watches` is the app's own: paused while off, listed and deleted by 제거, beside the registry's", () => {
		apps({ mail: { off: true, watches: ["kdb-login", "kdb-sync-"] } });
		for (const w of ["kdb-login", "kdb-sync-inbox", "webmail-gmail"]) expect(watchOff(dir, w)).toBe(true);
		expect(watchOff(dir, "kdb-login-2")).toBe(false);
		expect(watchOff(dir, "kakao-new")).toBe(false);
		apps({ mail: { watches: ["kdb-login"] } });
		expect(watchOff(dir, "kdb-login")).toBe(false);
		const names = ["kdb-login", "webmail-gmail", "other-watch"], gone: string[] = [];
		expect(removalPlan(dir, "mail", names)!.watches).toEqual(["kdb-login", "webmail-gmail"]);
		writeSettings(dir, "mail", { use_here: false });
		deleteApp(dir, "mail", {}, deps(names, gone));
		expect(gone).toEqual(["kdb-login", "webmail-gmail"]);
	});

	test("an added instance owns its extra watches, and the default no longer does", () => {
		apps({ mail: { watches: ["kdb-login"] }, "mail-2": { app: "mail", filter: { watches: ["webmail-naver"] }, watches: ["naver-login"] } });
		expect(removalPlan(dir, "mail-2", ["naver-login", "webmail-naver", "webmail-gmail"])!.watches).toEqual(["naver-login", "webmail-naver"]);
		expect(removalPlan(dir, "mail", ["kdb-login", "naver-login", "webmail-naver", "webmail-gmail"])!.watches).toEqual(["kdb-login", "webmail-gmail"]);
	});
});

describe("a custom mail reader", () => {
	test("a company mail plugin is a mail instance by its source and its own watch names: its mails, counts and watches are the instance's alone", () => {
		expect(createApp(dir, { app: "mail", label: "회사 메일", filter: { source: "KDB Work", watches: ["kdb-login", "kdb-mail"] } })).toEqual({ id: "mail-2", label: "회사 메일" });
		const got = items(["zele"], [note("w1", "mail:kdb-work-77"), note("g1", "mail:gmail-1")], { "mail:kdb-work-77": 4, "mail:gmail-1": 1 });
		expect(got.map(i => [i.key, i.label, i.unread, i.notices])).toEqual([["mail", "메일", 2, ["g1"]], ["mail-2", "회사 메일", 5, ["w1"]]]);
		expect(got[1]!.conv).toEqual(["mail:kdb-work-"]);
		expect(watchOff(dir, "kdb-login")).toBe(false);
		writeSettings(dir, "mail-2", { use_here: false });
		expect(watchOff(dir, "kdb-login")).toBe(true);
		expect(watchOff(dir, "kdb-mail")).toBe(true);
		expect(watchOff(dir, "webmail-gmail")).toBe(false);
		expect(blockedByOff(dir, { src: "mail:kdb-work-77" })).toBe(true);
		expect(removalPlan(dir, "mail-2", ["kdb-login", "kdb-mail", "webmail-gmail"])).toMatchObject({ label: "회사 메일", watches: ["kdb-login", "kdb-mail"], features: [] });
		expect(removalPlan(dir, "mail", ["kdb-login", "kdb-mail", "webmail-gmail"])!.watches).toEqual(["webmail-gmail"]);
		expect(readSettings(dir, "mail-2").map(f => f.key)).toEqual(["use_here", "label", "auto_draft", "skip_senders", "only_senders", "reply_model", "followup", "attach_folder", "draft_default", "draft_rules"]);
	});
});

describe("the hub routes", () => {
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const call = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));

	test("POST /api/apps creates, the list shows the new name, PATCH renames it, DELETE only works once it is off", async () => {
		const made = await call("POST", "/api/apps", { app: "mail", label: "개인 메일", filter: { conv: ["mail:naver-"] } });
		expect(made.status).toBe(200);
		expect(await made.json()).toEqual({ ok: true, id: "mail-2", label: "개인 메일" });
		const listed = (await (await call("GET", "/api/integrations")).json()) as { items: { key: string; label: string }[] };
		expect(listed.items.map(i => [i.key, i.label])).toContainEqual(["mail-2", "개인 메일"]);
		const renamed = await call("PATCH", "/api/integrations/mail-2/settings", { values: { label: "보조 메일" } });
		expect(renamed.status).toBe(200);
		expect(((await (await call("GET", "/api/integrations")).json()) as { items: { key: string; label: string }[] }).items.find(i => i.key === "mail-2")!.label).toBe("보조 메일");
		const early = await call("DELETE", "/api/apps/mail-2");
		expect(early.status).toBe(409);
		expect(readAppOff(DATA_DIR).has("mail-2")).toBe(false);
		await call("PATCH", "/api/integrations/mail-2/settings", { values: { use_here: false } });
		const avail = (await (await call("GET", "/api/integrations")).json()) as { available: { key: string; label: string }[] };
		expect(avail.available.map(a => [a.key, a.label])).toContainEqual(["mail-2", "보조 메일"]);
		const done = await call("DELETE", "/api/apps/mail-2");
		expect(done.status).toBe(200);
		expect(((await (await call("GET", "/api/integrations")).json()) as { available: { key: string }[] }).available.some(a => a.key === "mail-2")).toBe(false);
		expect((await call("DELETE", "/api/apps/mail-2")).status).toBe(404);
	});

	test("an unknown instance has no settings; a bad create is a 400", async () => {
		expect((await call("PATCH", "/api/integrations/mail-9/settings", { values: { label: "x" } })).status).toBe(404);
		expect((await call("GET", "/api/integrations/mail-9/remove")).status).toBe(404);
		expect((await call("POST", "/api/apps", { app: "nope" })).status).toBe(400);
	});
});
