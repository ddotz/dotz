import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replyCall } from "../features/reply-drafts/lib/flow.ts";
import { loadSettings, setApp } from "../features/reply-drafts/lib/settings.ts";
import { fieldsOf, readSettings, setReplyModelChoices, SettingsError, writeSettings } from "./app-settings.ts";
import { callReplyModel, DRAFT_TIMEOUT_MS, instanceOf, pickReplyModel, replyModel, type ReplyCall } from "./reply-model.ts";
import { replyModelChoices } from "./reply-model-choices.ts";
import { appEntries } from "./integrations.ts";
import { modelArgv } from "./outlang.ts";

const m = (selector: string, name: string, reasoning = true, provider = "anthropic") => ({ provider, selector: `${provider}/${selector}`, name, reasoning });
const LIST = [m("claude-sonnet-5-5", "Claude Sonnet 5.5"), m("claude-opus-5-5", "Claude Opus 5.5"), m("claude-haiku-4-5", "Claude Haiku 4.5"), m("gpt-5", "GPT 5", true, "openai")];
const SONNET = "anthropic/claude-sonnet-5-5";
const WORKER = `${SONNET}:high`;
const OPUS = "anthropic/claude-opus-5-5:high";

let dir = "";
let saved: string | undefined;
const config = () => JSON.parse(readFileSync(join(dir, "custom/reply-drafts/config.json"), "utf8"));
const seed = (rel: string, v: unknown) => {
	mkdirSync(dirname(join(dir, rel)), { recursive: true });
	writeFileSync(join(dir, rel), JSON.stringify(v));
};
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rm-"));
	saved = process.env.DOTZ_DIR;
	process.env.DOTZ_DIR = dir;
	setReplyModelChoices(replyModelChoices(LIST, WORKER));
});
afterEach(() => {
	if (saved === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = saved;
	rmSync(dir, { recursive: true, force: true });
});

describe("the model list of the setting", () => {
	test("subscription models with the newest Haiku (owner 2026-10-26), each a bare name and effort with no hint", () => {
		const c = replyModelChoices([...LIST, m("claude-haiku-5-5", "Claude Haiku 5.5"), m("claude-haiku-4-5-20251001", "Claude Haiku 4.5")], WORKER);
		expect(c.options[0]).toBe("");
		expect(c.options).toContain(WORKER);
		expect(c.options).toContain(OPUS);
		expect(c.options.some(o => /haiku-4/.test(o))).toBe(false);
		expect(c.options).toContain("anthropic/claude-haiku-5-5:low");
		expect(c.labels["anthropic/claude-haiku-5-5:low"]).toBe("Haiku 5.5 · low");
		expect(c.labels[WORKER]).toBe("Sonnet 5.5 · high");
		expect(c.labels[`${SONNET}:low`]).toContain("Sonnet 5.5 · low");
	});
	test("every other connected provider's models follow, one entry each with the provider's name; never one a draft would swap away", () => {
		const c = replyModelChoices([...LIST, m("openai/gpt-5.5", "openai/gpt-5.5", true, "opengateway"), m("openai/gpt-5-mini", "openai/gpt-5-mini", true, "opengateway"), m("openai/gpt-4o", "openai/gpt-4o", false, "opengateway")], WORKER);
		expect(c.options).toContain("openai/gpt-5:medium");
		expect(c.labels["openai/gpt-5:medium"]).toBe("OpenAI · GPT 5 · medium");
		expect(c.labels["opengateway/openai/gpt-5.5:medium"]).toBe("OpenGateway · openai/gpt-5.5 · medium");
		expect(c.labels["opengateway/openai/gpt-4o"]).toBe("OpenGateway · openai/gpt-4o");
		expect(c.options.some(o => /mini/.test(o))).toBe(false);
		expect(c.options.indexOf("openai/gpt-5:medium")).toBeGreaterThan(c.options.indexOf(OPUS));
	});
	test("the default option names the subagent model now, or the global reply model when one is set", () => {
		expect(replyModelChoices(LIST, WORKER).labels[""]).toBe("서브에이전트와 같음 · Sonnet 5.5 high");
		expect(replyModelChoices(LIST, "anthropic/claude-opus-5-5:medium").labels[""]).toBe("서브에이전트와 같음 · Opus 5.5 medium");
		expect(replyModelChoices(LIST, WORKER, OPUS).labels[""]).toBe("답장 기본값 · Opus 5.5 high");
	});
});

describe("the field per app and instance", () => {
	test("every app that drafts replies has it, with no help line; an app that does not draft has none", () => {
		for (const app of ["mail", "kakao", "youtube", "instagram", "site", "mail-2"]) {
			const f = fieldsOf(app).find(x => x.key === "reply_model");
			expect(f?.label).toBe("답장 모델");
			expect(f?.help).toBe("");   // a pick only, no description (owner 2026-10-26)
			expect(f?.options?.[0]).toBe("");
		}
		expect(fieldsOf("nope")).toEqual([]);
	});
	test("saved per app and per instance, read back, and an unknown model is rejected whole", () => {
		writeSettings(dir, "mail", { reply_model: OPUS });
		writeSettings(dir, "mail-2", { reply_model: `${SONNET}:low` });
		writeSettings(dir, "kakao", { reply_model: WORKER });
		expect(config().models).toEqual({ mail: OPUS, "mail-2": `${SONNET}:low`, kakao: WORKER });
		expect(readSettings(dir, "mail").find(f => f.key === "reply_model")?.value).toBe(OPUS);
		expect(readSettings(dir, "mail-2").find(f => f.key === "reply_model")?.value).toBe(`${SONNET}:low`);
		expect(readSettings(dir, "youtube").find(f => f.key === "reply_model")?.value).toBe("");
		expect(() => writeSettings(dir, "mail", { reply_model: "anthropic/claude-haiku-4-5" })).toThrow(SettingsError);
		expect(config().models.mail).toBe(OPUS);
	});
	test("the reply-drafts switches keep the models when they are written", () => {
		writeSettings(dir, "mail", { reply_model: OPUS });
		setApp("mail", true);
		expect(loadSettings().models).toEqual({ mail: OPUS });
		expect(loadSettings().apps.mail).toEqual({ auto: true });
	});
	test("a model alone does not make the app drafting on its own switch", () => {
		writeSettings(dir, "kakao", { reply_model: WORKER });
		expect(loadSettings().apps).toEqual({});
	});
});

describe("which model a draft uses", () => {
	test("the app setting first, then the global reply model, then the subagent model", async () => {
		expect(await replyModel("mail", undefined, { dataDir: dir, worker: WORKER })).toBe(WORKER);
		seed("custom/reply-drafts/config.json", { enabled: true, model: "anthropic/claude-sonnet-5-5:medium" });
		expect(await replyModel("mail", undefined, { dataDir: dir, worker: WORKER })).toBe("anthropic/claude-sonnet-5-5:medium");
		writeSettings(dir, "mail", { reply_model: OPUS });
		expect(await replyModel("mail", undefined, { dataDir: dir, worker: WORKER })).toBe(OPUS);
		expect(await replyModel("kakao", undefined, { dataDir: dir, worker: WORKER })).toBe("anthropic/claude-sonnet-5-5:medium");
	});
	test("'기본값' (empty) falls back and follows the subagent model live", async () => {
		writeSettings(dir, "mail", { reply_model: OPUS });
		writeSettings(dir, "mail", { reply_model: "" });
		expect(loadSettings().models).toBeUndefined();
		expect(await replyModel("mail", undefined, { dataDir: dir, worker: WORKER })).toBe(WORKER);
		expect(await replyModel("mail", undefined, { dataDir: dir, worker: "anthropic/claude-opus-5-5:max" })).toBe("anthropic/claude-opus-5-5:max");
	});
	test("an instance is chosen by the conversation its filter claims, and falls back to the default, not to its app", async () => {
		seed("custom/apps.json", { "mail-2": { app: "mail", label: "개인", filter: { conv: ["mail:naver-"] } } });
		const entries = appEntries(dir);
		expect(instanceOf(entries, "mail", "mail:naver-1")).toBe("mail-2");
		expect(instanceOf(entries, "mail", "mail:gmail-1")).toBe("mail");
		expect(instanceOf(entries, "mail")).toBe("mail");
		writeSettings(dir, "mail", { reply_model: OPUS });
		writeSettings(dir, "mail-2", { reply_model: `${SONNET}:low` });
		expect(await replyModel("mail", "mail:naver-1", { dataDir: dir, worker: WORKER })).toBe(`${SONNET}:low`);
		expect(await replyModel("mail", "mail:gmail-1", { dataDir: dir, worker: WORKER })).toBe(OPUS);
		writeSettings(dir, "mail-2", { reply_model: "" });
		expect(await replyModel("mail", "mail:naver-1", { dataDir: dir, worker: WORKER })).toBe(WORKER);
	});
	test("never a role or mini model, whatever the file says; Haiku is the owner's pick to keep", () => {
		const bad = (model: string) => pickReplyModel({ enabled: true, decided: true, auto: true, apps: {}, senders: { only: [], skip: [] }, models: { mail: model } }, "mail", WORKER);
		expect(bad("anthropic/claude-haiku-5-5:low")).toBe("anthropic/claude-haiku-5-5:low");
		expect(bad("anthropic/claude-gpt-5-mini")).toBe(SONNET);
		expect(bad("@tiny")).toBe(SONNET);
	});
});

describe("the draft paths call the model they resolved", () => {
	const recorder = () => {
		const seen: { model?: string; timeoutMs?: number }[] = [];
		const call: ReplyCall = async (_s, _u, opts) => (seen.push(opts), { text: "답", inputTokens: 1, outputTokens: 1 });
		return { seen, call };
	};
	test("callReplyModel (kakao and comments) passes the app's model to callModel", async () => {
		const { seen, call } = recorder();
		writeSettings(dir, "kakao", { reply_model: OPUS });
		await callReplyModel("kakao", "kakao:1", "s", "u", call, { dataDir: dir, worker: WORKER });
		await callReplyModel("youtube", undefined, "s", "u", call, { dataDir: dir, worker: WORKER });
		expect(seen.map(s => s.model)).toEqual([OPUS, WORKER]);
	});
	test("a draft waits at most 45 s (a spent provider is refused before the call)", async () => {
		const { seen, call } = recorder();
		await callReplyModel("kakao", undefined, "s", "u", call, { dataDir: dir, worker: WORKER });
		expect(seen.map(s => s.timeoutMs)).toEqual([DRAFT_TIMEOUT_MS]);
	});
	test("the mail/comment flow call (replyCall) uses the instance's model", async () => {
		const { seen, call } = recorder();
		seed("custom/apps.json", { "mail-2": { app: "mail", label: "개인", filter: { conv: ["mail:naver-"] } } });
		writeSettings(dir, "mail-2", { reply_model: `${SONNET}:low` });
		expect(await replyCall("mail", "mail:naver-9", call)("s", "u")).toBe("답");
		expect(seen[0]?.model).toBe(`${SONNET}:low`);
	});
});

describe("the effort reaches the model process", () => {
	const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
	test("a selector with an effort sets --thinking; without one the call thinks off as before", () => {
		const high = modelArgv("sys", "text", WORKER);
		expect(flag(high, "--thinking")).toBe("high");
		expect(flag(high, "--model")).toBe("anthropic-subscription/claude-sonnet-5-5");
		expect(flag(modelArgv("sys", "text", SONNET), "--thinking")).toBe("off");
		expect(flag(modelArgv("sys", "text", undefined), "--thinking")).toBe("off");
	});
});
