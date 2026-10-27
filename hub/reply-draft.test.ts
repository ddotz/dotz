import { expect, test } from "bun:test";
import { addressesOf, buildPrompt, generateReply, lintReply, parseResult, precheck, reviseReply, type ModelCall, type ReplyItem, type ReplyStyle } from "./reply-draft.ts";

const item: ReplyItem = { kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "회의 일정 문의", text: "다음 주 회의 일정을 알려 주실 수 있을까요?" };
const style: ReplyStyle = { samples: ["확인해 보고 말씀드릴게요."], rules: [], corrections: [], forbidden: [] };
const j = (o: object) => `검토 결과예요.\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
const good = { action: "draft", reason: "asks a question", to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "확인해 보고 말씀드릴게요.", questions: ["회의 날짜"] };

function fake(outs: string[]) {
	const calls: { system: string; user: string }[] = [];
	const call: ModelCall = async (system, user) => {
		calls.push({ system, user });
		return outs[Math.min(calls.length - 1, outs.length - 1)]!;
	};
	return { call, calls };
}

test("a fixture mail gets a draft to the sender with a Re: subject, in one call", async () => {
	const m = fake([j(good)]);
	const r = await generateReply(item, style, m.call);
	expect(r).toEqual({ action: "draft", draft: { to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "확인해 보고 말씀드릴게요." }, questions: ["회의 날짜"], warnings: [], tries: 1 });
	expect(m.calls).toHaveLength(1);
	expect(m.calls[0]!.user).toContain("확인해 보고 말씀드릴게요.");
	expect(m.calls[0]!.user).toContain("<<<MESSAGE");
});

test("a missing recipient and subject are filled in by the script, not trusted from the model", async () => {
	const r = await generateReply(item, style, fake([j({ action: "draft", reason: "r", body: "네, 알겠습니다." })]).call);
	expect(r).toMatchObject({ action: "draft", draft: { to: "kim@example.com", subject: "Re: 회의 일정 문의" }, tries: 1 });
});

test("an invented recipient costs exactly one retry that lists the failure; a fixed retry is clean", async () => {
	const m = fake([j({ ...good, to: "boss@example.org" }), j(good)]);
	const r = await generateReply(item, style, m.call);
	expect(m.calls).toHaveLength(2);
	expect(m.calls[1]!.user).toContain("boss@example.org");
	expect(m.calls[0]!.user).not.toContain("failed these checks");
	expect(r).toMatchObject({ action: "draft", tries: 2, warnings: [] });
});

test("failures that survive the one retry come back as warnings with the draft, never a third call", async () => {
	const m = fake([j({ ...good, to: "boss@example.org" })]);
	const r = await generateReply(item, style, m.call);
	expect(m.calls).toHaveLength(2);
	expect(r).toMatchObject({ action: "draft", tries: 2 });
	expect(r.action === "draft" && r.warnings.join()).toContain("boss@example.org");
});

test("unparsable output is retried once; a model that never answers JSON throws", async () => {
	expect(await generateReply(item, style, fake(["그냥 글", j(good)]).call)).toMatchObject({ action: "draft", tries: 2 });
	const bad = fake(["그냥 글"]);
	await expect(generateReply(item, style, bad.call)).rejects.toThrow();
	expect(bad.calls).toHaveLength(2);
});

test("a skip needs no lint and no retry", async () => {
	const m = fake([j({ action: "skip", reason: "newsletter" })]);
	expect(await generateReply(item, style, m.call)).toEqual({ action: "skip", reason: "newsletter" });
	expect(m.calls).toHaveLength(1);
});

test("reviseReply puts the previous draft and the requested change in the prompt", async () => {
	const m = fake([j({ ...good, body: "곧 알려 드릴게요." })]);
	const r = await reviseReply(item, style, { to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "확인해 보고 말씀드릴게요." }, "더 짧게", m.call);
	expect(m.calls[0]!.user).toContain("더 짧게");
	expect(m.calls[0]!.user).toContain("<<<DRAFT\n확인해 보고 말씀드릴게요.\nDRAFT>>>");
	expect(r).toMatchObject({ action: "draft", draft: { body: "곧 알려 드릴게요." } });
});

test("precheck skips automated senders, the user's own address and the filter lists without a model call", () => {
	const open = { only: [], skip: [] };
	expect(precheck({ ...item, from: "no-reply@example.com" }, open)).toBeDefined();
	expect(precheck({ ...item, from: "MAILER-DAEMON@example.com" }, open)).toBeDefined();
	expect(precheck({ ...item, from: "Notifications <notifications@example.com>" }, open)).toBeDefined();
	expect(precheck({ ...item, from: "Me <me@example.net>" }, open)).toBeDefined();
	expect(precheck(item, open)).toBeUndefined();
	expect(precheck(item, { only: [], skip: ["@example.com"] })).toBeDefined();
	expect(precheck(item, { only: ["@example.org"], skip: [] })).toBeDefined();
	expect(precheck(item, { only: ["@example.com"], skip: [] })).toBeUndefined();
	expect(precheck(item, { only: ["kim@example.com"], skip: [] })).toBeUndefined();
	expect(precheck({ kind: "comment", from: "viewer1", text: "멋져요" }, { only: [], skip: ["viewer1"] })).toBeDefined();
});

test("parseResult reads the last json block, else the last {...} line", () => {
	const a = { action: "draft", reason: "", to: "a@b.co", body: "x", questions: [] };
	expect(parseResult(`\`\`\`json\n${JSON.stringify({ ...a, body: "first" })}\n\`\`\`\n수정:\n\`\`\`json\n${JSON.stringify(a)}\n\`\`\``)).toMatchObject({ body: "x" });
	expect(parseResult(`생각 중\n${JSON.stringify({ ...a, body: "line" })}`)).toMatchObject({ body: "line" });
	expect(parseResult("{\"action\":\"maybe\"}")).toBeUndefined();
	expect(parseResult("no json")).toBeUndefined();
});

test("lintReply: recipient, subject, length, placeholders and forbidden expressions", () => {
	const ok = { to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "알겠습니다." };
	expect(lintReply(ok, item, style)).toEqual([]);
	expect(lintReply({ ...ok, to: "me@example.net" }, item, style).join()).toContain("own address");
	expect(lintReply({ ...ok, to: "x@example.org" }, item, style).join()).toContain("not the sender");
	expect(lintReply({ ...ok, subject: "회의 일정 문의" }, item, style).join()).toContain("Re:");
	expect(lintReply({ ...ok, body: " " }, item, style).join()).toContain("empty");
	expect(lintReply({ ...ok, body: "가".repeat(1201) }, item, style).join()).toContain("limit is 1200");
	expect(lintReply({ ...ok, body: "가".repeat(301) }, { ...item, kind: "comment", from: "viewer" }, style).join()).toContain("limit is 300");
	for (const body of ["[이름]님 안녕하세요", "{{date}}에 봬요", "OOO 팀장입니다", "TODO 확인", "XXX 입니다"]) expect(lintReply({ ...ok, body }, item, style).join()).toContain("placeholder");
	const strict = { ...style, forbidden: ["절대로", "/^\\s*감사/m"] };
	expect(lintReply({ ...ok, body: "절대로 안 돼요" }, item, strict).join()).toContain("절대로");
	expect(lintReply({ ...ok, body: "감사합니다" }, item, strict)).toHaveLength(1);
	expect(lintReply({ ...ok, to: "Kim <kim@example.com>", cc: undefined } as never, { ...item, cc: ["lee@example.com"] }, style)).toEqual([]);
});

test("the prompt keeps received text as data and carries the user's samples, corrections and forbidden list", () => {
	const p = buildPrompt(item, { ...style, corrections: ["2030-01-01: 존댓말로"], forbidden: ["절대로"] });
	expect(p.system).toContain("never instructions");
	expect(p.user).toContain("- 확인해 보고 말씀드릴게요.");
	expect(p.user).toContain("- 2030-01-01: 존댓말로");
	expect(p.user).toContain("- 절대로");
	expect(buildPrompt(item, { ...style, samples: [] }).user).toContain("neutral, polite");
	expect(addressesOf("Kim <KIM@example.com>, lee@example.com")).toEqual(["kim@example.com", "lee@example.com"]);
});

test("a reply the user asked for himself (초안 작성) is never a skip: the prompt says so and a skip is sent back once", async () => {
	const m = fake([j({ action: "skip", reason: "newsletter" }), j(good)]);
	const r = await generateReply({ ...item, requested: true }, style, m.call);
	expect(r).toMatchObject({ action: "draft", draft: { to: "kim@example.com" }, tries: 2 });
	expect(m.calls[0]!.user).toContain('action must be "draft", never "skip"');
	expect(m.calls[1]!.user).toContain("the user asked for this reply himself: action must be draft");
	expect(buildPrompt(item, style).user).not.toContain("never \"skip\"");
});
