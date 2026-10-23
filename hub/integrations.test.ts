import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { belongsTo, INTEGRATIONS, integrationContext, integrationItems, integrationOn } from "./integrations.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

// A data dir whose personal copies of the shipped feature folders are switched on, as the onboarding does (enabled: false -> true).
function install(on: string[], sns?: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "dotz-intg-"));
	dirs.push(dir);
	for (const id of on) {
		mkdirSync(join(dir, "features", id), { recursive: true });
		const shipped = readFileSync(join(import.meta.dir, "..", "features", id, "feature.md"), "utf8");
		writeFileSync(join(dir, "features", id, "feature.md"), shipped.replace(/^enabled: false$/m, "enabled: true"));
	}
	if (sns) {
		mkdirSync(join(dir, "custom", "sns"), { recursive: true });
		writeFileSync(join(dir, "custom", "sns", "config.json"), JSON.stringify(sns));
	}
	return dir;
}
const keys = (dir: string, flags: string[] = []) => integrationItems(integrationContext(dir, flags), []).map(i => i.key);

describe("which integrations show", () => {
	test("none enabled: no sub-items", () => {
		expect(keys(install([]))).toEqual([]);
	});

	test("kakao and webmail enabled: 메일 and 카카오톡, in registry order", () => {
		expect(keys(install(["kakao", "webmail-no-api"]))).toEqual(["mail", "kakao"]);
	});

	test("one feature enabled shows only its own entry", () => {
		expect(keys(install(["kakao"]))).toEqual(["kakao"]);
		expect(keys(install(["webmail-no-api"]))).toEqual(["mail"]);
	});

	test("a runtime flag (zele) alone turns 메일 on", () => {
		expect(keys(install([]), ["zele"])).toEqual(["mail"]);
	});

	test("a mail conversation or a mail notice turns 메일 on without any switch; none leaves it off", () => {
		const ctx = integrationContext(install([]), []);
		const on = (notices: Parameters<typeof integrationItems>[1], convUnread: Record<string, number> = {}) => integrationItems(ctx, notices, convUnread).map(i => i.key);
		expect(on([], { "mail:k1": 0 })).toEqual(["mail"]);
		expect(on([{ id: "n", src: "mail:k1" }])).toEqual(["mail"]);
		expect(on([{ id: "n", open: "alert", title: "디스크 경고" }], { "ch:7": 3 })).toEqual([]);
		expect(on([])).toEqual([]);
	});

	test("YouTube and Instagram follow the channels set up in the sns config, each on its own", () => {
		expect(keys(install([], { youtube: { channel_id: "c" } }))).toEqual(["youtube"]);
		expect(keys(install([], { instagram: { user_id: "u" } }))).toEqual(["instagram"]);
		expect(keys(install([], { instagram: { user_id: "u" }, youtube: { channel_id: "c" } }))).toEqual(["instagram", "youtube"]);
		expect(keys(install([], {}))).toEqual([]);
	});

	test("an unreadable sns config counts as off", () => {
		const dir = install([]);
		mkdirSync(join(dir, "custom", "sns"), { recursive: true });
		writeFileSync(join(dir, "custom", "sns", "config.json"), "{not json");
		expect(keys(dir)).toEqual([]);
	});
});

const notice = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: "", text: "", open: "alert", read: false, ...extra });
const by = (key: string) => INTEGRATIONS.find(e => e.key === key)!;

describe("which notices belong to an integration", () => {
	test("a notice in a mail conversation belongs to 메일, by where it lives", () => {
		expect(belongsTo(by("mail"), notice("a", { src: "mail:k1", open: "mail:k1" }))).toBe(true);
		expect(belongsTo(by("mail"), notice("b", { open: "main", decision: { to: "mail:k2" } }))).toBe(true);
		expect(belongsTo(by("kakao"), notice("c", { src: "mail:k1" }))).toBe(false);
	});

	test("the draft label of an approval decides between kakao and mail", () => {
		const draft = (label: string) => notice("d", { text: `> ${label}: 예시\n>\n> 본문`, decision: { to: "main" } });
		expect(belongsTo(by("kakao"), draft("대화방"))).toBe(true);
		expect(belongsTo(by("mail"), draft("대화방"))).toBe(false);
		expect(belongsTo(by("mail"), draft("받는이"))).toBe(true);
		expect(belongsTo(by("kakao"), draft("받는이"))).toBe(false);
	});

	test("a title or text pattern matches case-insensitively and a plain alert matches nothing", () => {
		expect(belongsTo(by("kakao"), notice("e", { title: "카톡 새 메시지" }))).toBe(true);
		expect(belongsTo(by("youtube"), notice("f", { text: "New YouTube comment" }))).toBe(true);
		expect(belongsTo(by("instagram"), notice("g", { text: "인스타 댓글" }))).toBe(true);
		for (const e of INTEGRATIONS) expect(belongsTo(e, notice("h", { title: "디스크 경고", text: "90% 찼어요" }))).toBe(false);
	});
});

describe("unread counts and notice lists per sub-item", () => {
	const ctx = integrationContext(install(["kakao", "webmail-no-api"], { instagram: { user_id: "u" } }), []);
	const notices = [
		notice("k1", { title: "카톡 새 메시지" }),
		notice("k2", { title: "카톡 새 메시지", read: true }),
		notice("k3", { title: "카톡 새 메시지", dismissed: true }),
		notice("m1", { src: "mail:a", open: "mail:a" }),
		notice("x1", { title: "디스크 경고" }),
		notice("i1", { text: "인스타그램 댓글" }),
	];

	test("counts unread notices only; read and dismissed ones neither count nor list as unread", () => {
		const items = integrationItems(ctx, notices);
		const kakao = items.find(i => i.key === "kakao")!;
		expect(kakao.unread).toBe(1);
		expect(kakao.notices).toEqual(["k1", "k2"]);
	});

	test("mail adds the unread messages of its conversations, and only of its own prefix", () => {
		const items = integrationItems(ctx, notices, { "mail:a": 2, "mail:b": 1, "ch:7": 5 });
		expect(items.find(i => i.key === "mail")).toMatchObject({ unread: 4, notices: ["m1"], conv: ["mail:"] });
		expect(items.find(i => i.key === "kakao")!.unread).toBe(1);
	});

	test("a notice outside every integration is in no list, and a disabled integration is not returned", () => {
		const items = integrationItems(ctx, notices);
		expect(items.flatMap(i => i.notices)).not.toContain("x1");
		expect(items.map(i => i.key)).toEqual(["mail", "kakao", "instagram"]);
		expect(items.find(i => i.key === "instagram")!.notices).toEqual(["i1"]);
	});

	test("the notice list is capped, newest first as given", () => {
		const many = Array.from({ length: 5 }, (_, i) => notice(`c${i}`, { title: "카톡" }));
		expect(integrationItems(ctx, many, {}, 3).find(i => i.key === "kakao")!.notices).toEqual(["c0", "c1", "c2"]);
	});
});

describe("the registry itself", () => {
	test("keys are unique and each entry can be drawn: label, icon, a stroke path and a way to be switched on", () => {
		expect(new Set(INTEGRATIONS.map(e => e.key)).size).toBe(INTEGRATIONS.length);
		for (const e of INTEGRATIONS) {
			expect(e.key).toMatch(/^[a-z0-9-]+$/);
			expect(e.label.length).toBeGreaterThan(0);
			expect(e.kind).toBe("app");
			expect(e.icon.length).toBeGreaterThan(0);
			expect(e.iconPath).toMatch(/^M[\d .,a-zA-Z-]+$/);
			expect(Object.values(e.on).some(v => v && v.length)).toBe(true);
			expect(Object.values(e.match).some(v => v && v.length)).toBe(true);
		}
	});

	test("an entry with nothing enabled stays off", () => {
		const off = integrationContext(install([]), []);
		expect(INTEGRATIONS.some(e => integrationOn(e, off))).toBe(false);
	});
});
