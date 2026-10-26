import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyMemory, approxTokens, APP_SETTINGS, fieldsOf, memoryNote, mailDiscordOn, parseProposal, readSettings, setDiscordProbe, SETTING_SECTIONS, SettingsError, settingsContext, validate, writeSettings } from "./app-settings.ts";

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
		expect(fieldsOf("site").map(f => f.key)).toEqual(["use_here", "label", "reply_model", "followup"]);
		expect(() => validate("nope", { a: 1 })).toThrow(SettingsError);
		expect(() => validate("__proto__", { a: 1 })).toThrow(SettingsError);
	});
});

describe("디스코드에도 올리기 (mail)", () => {
	afterEach(() => setDiscordProbe(() => false));
	const has = (app: string) => fieldsOf(app).some(f => f.key === "discord");
	test("drawn for the mail app and its instances only while Discord is connected", () => {
		setDiscordProbe(() => false);
		expect(has("mail")).toBe(false);
		setDiscordProbe(() => true);
		expect(has("mail")).toBe(true);
		expect(has("mail-2")).toBe(true);
		expect(has("kakao")).toBe(false);
		const f = readSettings(dir, "mail").find(x => x.key === "discord")!;
		expect(f).toMatchObject({ label: "디스코드에도 올리기", type: "bool", help: "새 메일마다 디스코드 메일 채널에 스레드를 만들어요", value: false });
		expect(() => validate("mail", { discord: true })).not.toThrow();
		setDiscordProbe(() => false);
		expect(() => validate("mail", { discord: true })).toThrow(SettingsError);
	});
	test("off by default; the switch is stored per instance and mailDiscordOn follows the instance that owns the mail's source", () => {
		setDiscordProbe(() => true);
		seed("custom/apps.json", { mail: {}, "mail-2": { app: "mail", label: "개인", filter: { source: "naver" } } });
		expect(mailDiscordOn(dir, "zele-1")).toBe(false);
		expect(mailDiscordOn(dir, "naver-1")).toBe(false);
		writeSettings(dir, "mail-2", { discord: true });
		expect(json("custom/apps.json")["mail-2"]).toMatchObject({ discord: true, label: "개인" });
		expect(mailDiscordOn(dir, "naver-1")).toBe(true);
		expect(mailDiscordOn(dir, "zele-1")).toBe(false);
		expect(readSettings(dir, "mail").find(x => x.key === "discord")?.value).toBe(false);
		writeSettings(dir, "mail", { discord: true });
		expect(mailDiscordOn(dir, "zele-1")).toBe(true);
		writeSettings(dir, "mail-2", { discord: false });
		expect(mailDiscordOn(dir, "naver-1")).toBe(false);
	});
});

describe("한 개념에 조작 하나 (sections and shared terms)", () => {
	test("every row of every app has a known section, and no two rows of one app share a label", () => {
		for (const app of ["mail", "kakao", "instagram", "youtube", "site", "mail-2", "kakao-2"]) {
			const rows = fieldsOf(app);
			for (const f of rows) expect(SETTING_SECTIONS).toContain(f.section ?? "advanced");
			const labels = rows.map(f => f.label);
			expect(new Set(labels).size).toBe(labels.length);
		}
	});
	test("the automatic draft and the approval mode read the same words in every app", () => {
		const drafts = ["mail", "instagram", "youtube"].map(app => APP_SETTINGS[app]!.find(f => f.key === "auto_draft")!);
		expect(drafts.map(f => f.label)).toEqual(["자동 초안", "자동 초안", "자동 초안"]);
		expect(new Set(drafts.map(f => f.help.replace(/(메일|인스타그램|유튜브)에/, ""))).size).toBe(1);
		const approval = APP_SETTINGS.instagram!.find(f => f.key === "approval")!;
		expect([approval.label, approval.section, approval.options]).toEqual(["승인 방식", "draft", ["each", "batch"]]);
		expect(APP_SETTINGS.instagram!.find(f => f.key === "approval")).toBe(APP_SETTINGS.youtube!.find(f => f.key === "approval"));
	});
	test("the draft and watch rows of one app never sit in the same section as a control that means the same thing", () => {
		const sect = (app: string, key: string) => fieldsOf(app).find(f => f.key === key)?.section;
		expect([sect("mail", "auto_draft"), sect("mail", "skip_senders"), sect("kakao", "auto_draft_chats"), sect("kakao", "exclude_chats")]).toEqual(["draft", "draft", "draft", "draft"]);
		expect([sect("kakao", "enabled"), sect("kakao", "watch_chats"), sect("kakao", "open_chats")]).toEqual(["watch", "watch", "watch"]);
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

describe("앱 기억 (owner 2026-10-26: learned in conversation, not set in the settings screen)", () => {
	test("a block of memory keys only is stored at once; a block with any other key stays a proposal and writes nothing", () => {
		expect(fieldsOf("mail").filter(f => f.memory).map(f => f.key).sort()).toEqual(["attach_folder", "followup"]);
		expect(applyMemory(dir, fence("mail", { attach_folder: "~/Documents/양식" }))).toEqual({ app: "mail", keys: ["attach_folder"] });
		expect(json("custom/reply-drafts/config.json").attachFolders.mail).toBe("~/Documents/양식");
		expect(applyMemory(dir, fence("mail", { followup: "x", auto_draft: true }))).toBeUndefined();
		expect(json("custom/reply-drafts/config.json").followups).toBeUndefined();
		expect(applyMemory(dir, "기억할 것 없음")).toBeUndefined();
		expect(memoryNote(dir, "mail")).toContain("첨부 파일 폴더=\"~/Documents/양식\"");
		expect(readSettings(dir, "mail").find(f => f.key === "followup")!.memory).toBe(true);
	});
});

