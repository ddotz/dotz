import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../../../hub/app-settings.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { reviseDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { matchRule, ruleInstruction } from "../lib/rules.ts";
import { loadSettings, paths, setApp } from "../lib/settings.ts";
import { stagedFiles } from "../lib/staged.ts";
import { getDraft, listDrafts } from "../lib/store.ts";
import { enable, fakeModel, j, mailFixture, setupEnv } from "./helpers.ts";

// 자동 초안 규칙 (lib/rules.ts): the store behind the settings schema, the one matching call, and an offer drafted by a rule. Names are placeholders.
const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "rd-rules-lib-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
mkdirSync(join(lib, "forms"), { recursive: true });
writeFileSync(join(lib, "forms", "신청서.pdf"), "form bytes");
writeFileSync(join(lib, "안내문.pdf"), "guide bytes");
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
});

const RULE = { name: "자료 요청", when: "신청서를 보내 달라는 메일", how: "신청서를 첨부하고 짧게 인사해요", files: ["forms/신청서.pdf"] };
const other = { name: "견학 문의", when: "견학 날짜를 묻는 메일", how: "가능한 날짜를 물어요" };
const askMail = { ...mailFixture, key: "r-1", subject: "신청서 부탁드립니다", from: "Parent <parent@example.com>", body: "신청서 양식을 보내 주실 수 있을까요?" };
const reply = { action: "draft", reason: "asks for a form", to: "parent@example.com", subject: "Re: 신청서 부탁드립니다", body: "안녕하세요. 신청서 첨부해 드립니다.", questions: [] };
const sink = () => {
	const sent: { target: string; text: string }[] = [];
	const suggested: { key: string; s: unknown }[] = [];
	return { sent, suggested, send: (target: string, text: string) => void sent.push({ target, text }), suggest: (key: string, s: unknown) => void suggested.push({ key, s }) };
};
// The mail app's 자동 초안 switch off, the rules and the 기본 규칙 written through the settings schema like the settings screen does.
function rulesOff(rules: object[], base = "") {
	enable(env, { apps: { mail: { auto: false } }, attachFolders: { mail: lib } });
	writeSettings(env.dir, "mail", { draft_rules: rules, draft_default: base });
}

describe("the rule store (hub/app-settings.ts draft_rules)", () => {
	test("rules get stable ids, default on, and read back the same; the 기본 규칙 is empty by default", () => {
		enable(env);
		const before = readSettings(env.dir, "mail");
		expect(before.find(f => f.key === "draft_default")).toMatchObject({ value: "", placeholder: expect.stringContaining("비워 두면") });
		expect(before.find(f => f.key === "draft_rules")?.value).toEqual([]);
		writeSettings(env.dir, "mail", { draft_rules: [RULE, { ...other, on: false }] });
		const rules = readSettings(env.dir, "mail").find(f => f.key === "draft_rules")?.value;
		expect(rules).toEqual([{ id: "r1", ...RULE, on: true }, { id: "r2", ...other, files: [], on: false }]);
		// a new rule beside kept ids takes the first free one; a duplicate id is renumbered
		writeSettings(env.dir, "mail", { draft_rules: [{ id: "r2", ...other }, { ...RULE, name: "새 규칙" }, { id: "r2", ...RULE }] });
		expect((readSettings(env.dir, "mail").find(f => f.key === "draft_rules")?.value as { id: string }[]).map(r => r.id)).toEqual(["r2", "r1", "r3"]);
	});
	test("a rule without a name or a condition, or with a bad file list, is refused as a whole", () => {
		enable(env);
		expect(() => writeSettings(env.dir, "mail", { draft_rules: [{ when: "x" }] })).toThrow(/이름/);
		expect(() => writeSettings(env.dir, "mail", { draft_rules: [{ name: "x", when: " " }] })).toThrow(/조건/);
		expect(() => writeSettings(env.dir, "mail", { draft_rules: [{ name: "x", when: "y", files: [""] }] })).toThrow(/파일/);
		expect(() => writeSettings(env.dir, "mail", { draft_rules: "x" })).toThrow(/규칙 목록/);
	});
	test("switching another setting of the feature keeps the rules and the 기본 규칙", () => {
		rulesOff([RULE], "존댓말로 짧게");
		setApp("youtube", true);
		const raw = JSON.parse(readFileSync(paths.config(), "utf8"));
		expect(raw.draftRules.mail[0].name).toBe("자료 요청");
		expect(raw.draftDefaults.mail).toBe("존댓말로 짧게");
		expect(loadSettings().draftDefaults).toEqual({ mail: "존댓말로 짧게" });
	});
});

describe("matching", () => {
	const rules = [{ id: "r1", ...other, files: [], on: true }, { id: "r2", ...RULE, on: false }, { id: "r3", ...RULE, on: true }];
	test("no rule on: no model call at all", async () => {
		const m = fakeModel(["1"]);
		expect(await matchRule({ subject: "s", text: "t" }, rules.map(r => ({ ...r, on: false })), m.call)).toBeUndefined();
		expect(m.calls).toHaveLength(0);
	});
	test("one call numbers only the rules that are on; its answer picks the rule, 0 or nonsense picks none", async () => {
		const m = fakeModel(["2", "0", "9", "rule two"]);
		expect((await matchRule({ subject: askMail.subject, text: askMail.body }, rules, m.call))?.id).toBe("r3");
		expect(m.calls[0]!.user).toContain(`1. ${other.when}\n2. ${RULE.when}`);
		expect(m.calls[0]!.user).toContain(askMail.body);
		for (let i = 0; i < 3; i++) expect(await matchRule({ subject: "s", text: "t" }, rules, m.call)).toBeUndefined();
	});
	test("the instruction is the 기본 규칙, the rule's 어떻게 and the owner's words, in that order", () => {
		expect(ruleInstruction("존댓말로", { id: "r1", ...RULE, on: true }, "금요일까지라고 써 줘")).toBe(`존댓말로\n${RULE.how}\n금요일까지라고 써 줘`);
		expect(ruleInstruction("", undefined)).toBeUndefined();
	});
});

describe("an offer drafted by a rule", () => {
	test("with 자동 초안 off, a matching mail is drafted with the rule's instruction, its file staged and its badge on the card and the mail", async () => {
		rulesOff([other, RULE], "존댓말로 짧게");
		const m = fakeModel(["2", j(reply)]);
		const out = sink();
		expect(await offerMailDraft(askMail, { send: out.send, suggest: out.suggest, call: m.call })).toBe("offered");
		expect(m.calls).toHaveLength(2);
		expect(m.calls[1]!.user).toContain(`존댓말로 짧게 ${RULE.how}`);
		const d = listDrafts()[0]!;
		expect(d.rule).toEqual({ id: "r2", name: "자료 요청" });
		expect(stagedFiles(d.id).map(f => [f.name, readFileSync(f.path, "utf8")])).toEqual([["신청서.pdf", "form bytes"]]);
		expect(parseDraftApproval(out.sent[0]!.text)).toMatchObject({ rule: "자료 요청", attachments: [{ name: "신청서.pdf" }] });
		expect(out.suggested).toEqual([{ key: "r-1", s: { kind: "reply-draft", label: "답장 초안", ref: d.id, rule: "자료 요청" } }]);
	});
	test("a revision keeps the rule and its files", async () => {
		rulesOff([RULE]);
		const out = sink();
		await offerMailDraft({ ...askMail, key: "r-2" }, { send: out.send, call: fakeModel(["1", j(reply)]).call });
		const first = listDrafts()[0]!;
		const r = await reviseDraft(first.id, "더 짧게", { call: fakeModel([j({ ...reply, body: "신청서 첨부해 드립니다." })]).call });
		expect(r.ok).toBe(true);
		expect(getDraft(r.id!)?.rule).toEqual(first.rule);
		expect(parseDraftApproval(r.text)).toMatchObject({ rule: "자료 요청", attachments: [{ name: "신청서.pdf" }] });
	});
	test("with 자동 초안 off, a mail no rule meets is looked at once and not drafted", async () => {
		rulesOff([RULE]);
		const m = fakeModel(["0", j(reply)]);
		const out = sink();
		expect(await offerMailDraft({ ...askMail, key: "r-3" }, { send: out.send, call: m.call })).toBe("skipped");
		expect(m.calls).toHaveLength(1);
		expect(out.sent).toEqual([]);
		expect(await offerMailDraft({ ...askMail, key: "r-3" }, { send: out.send, call: m.call })).toBe("skipped");
		expect(m.calls).toHaveLength(1);
	});
	test("with 자동 초안 off and no rule on, nothing is called", async () => {
		rulesOff([{ ...RULE, on: false }]);
		const m = fakeModel([j(reply)]);
		expect(await offerMailDraft({ ...askMail, key: "r-4" }, { send: () => {}, call: m.call })).toBe("off");
		expect(m.calls).toHaveLength(0);
	});
	test("with 자동 초안 on, a mail no rule meets is drafted as usual (the 기본 규칙 still applies), with no badge", async () => {
		rulesOff([RULE], "존댓말로 짧게");
		enable(env, { apps: { mail: { auto: true } }, draftRules: { mail: [{ id: "r1", ...RULE, on: true }] }, draftDefaults: { mail: "존댓말로 짧게" } });
		const m = fakeModel(["0", j(reply)]);
		const out = sink();
		expect(await offerMailDraft({ ...askMail, key: "r-5" }, { send: out.send, call: m.call })).toBe("offered");
		expect(m.calls[1]!.user).toContain("존댓말로 짧게");
		expect(listDrafts()[0]!.rule).toBeUndefined();
		expect(parseDraftApproval(out.sent[0]!.text)?.rule).toBeUndefined();
	});
	test("a rule file that is not there is named on the card", async () => {
		rulesOff([{ ...RULE, files: ["없는 파일.pdf"] }]);
		const out = sink();
		expect(await offerMailDraft({ ...askMail, key: "r-6" }, { send: out.send, call: fakeModel(["1", j(reply)]).call })).toBe("offered");
		expect(out.sent[0]!.text).toContain("규칙에 적힌 파일을 찾지 못했어요: 없는 파일.pdf");
	});
	test("the feature switched off for the whole install: rules draft nothing", async () => {
		enable(env, { enabled: false, draftRules: { mail: [{ id: "r1", ...RULE, on: true }] } });
		const m = fakeModel(["1", j(reply)]);
		expect(await offerMailDraft({ ...askMail, key: "r-7" }, { send: () => {}, call: m.call })).toBe("off");
		expect(m.calls).toHaveLength(0);
	});
});
