import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approxTokens, fieldsOf, parseProposal, readSettings, SettingsError, settingsContext, validate, writeSettings } from "./app-settings.ts";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "as-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const file = (rel: string) => join(dir, rel);
const json = (rel: string) => JSON.parse(readFileSync(file(rel), "utf8"));
const seed = (rel: string, v: unknown) => { mkdirSync(dirname(file(rel)), { recursive: true }); writeFileSync(file(rel), JSON.stringify(v)); };
const fence = (app: string, changes: unknown) => `확인해 보세요.\n\`\`\`dotz-settings\n${JSON.stringify({ app, changes })}\n\`\`\``;

describe("schema validation", () => {
	test("unknown key, wrong type and empty set are rejected and nothing is written", () => {
		for (const bad of [{ nope: true }, { enabled: "yes" }, { watch_chats: "123" }, { watch_chats: [1] }, { watch_chats: [""] }, {}, null, [1]]) {
			expect(() => writeSettings(dir, "kakao", bad)).toThrow(SettingsError);
		}
		expect(() => writeSettings(dir, "instagram", { approval: "sometimes" })).toThrow(SettingsError);
		expect(existsSync(file("custom/kakao/config.json"))).toBe(false);
		expect(existsSync(file("custom/sns/config.json"))).toBe(false);
	});
	test("one bad key rejects the whole set", () => {
		seed("custom/kakao/config.json", { enabled: false });
		expect(() => writeSettings(dir, "kakao", { enabled: true, nope: 1 })).toThrow("알 수 없는 설정");
		expect(json("custom/kakao/config.json")).toEqual({ enabled: false });
	});
	test("an app without a schema has no settings", () => {
		expect(fieldsOf("nope")).toEqual([]);
		expect(fieldsOf("site").map(f => f.key)).toEqual(["use_here"]);
		expect(() => validate("nope", { a: 1 })).toThrow(SettingsError);
		expect(() => validate("__proto__", { a: 1 })).toThrow(SettingsError);
	});
});

describe("PATCH write path", () => {
	test("a switch writes the install's custom file and keeps the other keys", () => {
		seed("custom/kakao/config.json", { enabled: false, watch_chats: ["1", "2"], dbPath: "/x" });
		const view = writeSettings(dir, "kakao", { enabled: true });
		expect(json("custom/kakao/config.json")).toEqual({ enabled: true, watch_chats: ["1", "2"], dbPath: "/x" });
		expect(view.find(f => f.key === "enabled")?.value).toBe(true);
		expect(view.find(f => f.key === "watch_chats")?.value).toEqual(["1", "2"]);
	});
	test("auto draft turns the feature on with it and lists are replaced whole and deduplicated", () => {
		writeSettings(dir, "mail", { auto_draft: true, skip_senders: [" ads@x.com ", "ads@x.com", "promo"] });
		expect(json("custom/reply-drafts/config.json")).toEqual({ apps: { mail: { auto: true } }, enabled: true, senders: { skip: ["ads@x.com", "promo"] } });
		writeSettings(dir, "mail", { auto_draft: false });
		expect(json("custom/reply-drafts/config.json").apps.mail.auto).toBe(false);
		expect(json("custom/reply-drafts/config.json").enabled).toBe(true);
	});
	test("GET values: defaults when the file is missing, stored values when present", () => {
		expect(readSettings(dir, "youtube").find(f => f.key === "approval")?.value).toBe("each");
		writeSettings(dir, "youtube", { approval: "batch" });
		expect(readSettings(dir, "instagram").find(f => f.key === "approval")?.value).toBe("batch");
	});
});

describe("change card block", () => {
	test("is parsed without writing and applied only by the PATCH", () => {
		seed("custom/kakao/config.json", { enabled: true, auto_draft_chats: ["1"] });
		const p = parseProposal(fence("kakao", { auto_draft_chats: ["1", "7"] }), "kakao");
		expect(p).toEqual({ app: "kakao", changes: { auto_draft_chats: ["1", "7"] } });
		expect(json("custom/kakao/config.json").auto_draft_chats).toEqual(["1"]);
		writeSettings(dir, "kakao", p!.changes);
		expect(json("custom/kakao/config.json").auto_draft_chats).toEqual(["1", "7"]);
	});
	test("a block for another app, with a bad key or bad JSON is not a proposal", () => {
		expect(parseProposal(fence("mail", { auto_draft: true }), "kakao")).toBeNull();
		expect(parseProposal(fence("kakao", { nope: true }), "kakao")).toBeNull();
		expect(parseProposal("```dotz-settings\n{oops\n```", "kakao")).toBeNull();
		expect(parseProposal("그냥 답이에요", "kakao")).toBeNull();
	});
});

describe("settings context size", () => {
	test("stays under 2K tokens even with 200-item lists and four long turns", () => {
		const ids = Array.from({ length: 200 }, (_, i) => `4${String(i).padStart(14, "0")}`);
		seed("custom/kakao/config.json", { enabled: true, watch_chats: ids, auto_draft_chats: ids, exclude_chats: ids });
		const turn = "가".repeat(900);
		const recent = Array.from({ length: 10 }, (_, i) => ({ from: i % 2 ? "bot" as const : "owner" as const, text: turn }));
		const ctx = settingsContext(dir, "kakao", "카카오톡", recent);
		expect(approxTokens(ctx)).toBeLessThan(2000);
		expect(ctx.match(/오너:|봇:/g)?.length).toBe(4);
		expect(ctx).not.toContain("custom/");
	});
	test("a typical turn", () => {
		seed("custom/kakao/config.json", { enabled: true, watch_chats: ["4100", "4101", "4102"], auto_draft_chats: ["4100"] });
		const ctx = settingsContext(dir, "kakao", "카카오톡", [{ from: "owner", text: "이 방은 자동 초안 켜 줘" }]);
		console.log(`typical settings turn context: ${ctx.length} chars, ~${approxTokens(ctx)} tokens`);
		expect(approxTokens(ctx)).toBeLessThan(700);
	});
});
