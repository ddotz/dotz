import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseDecisions } from "../../../hub/choices.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { runDraft } from "../bin/draft.ts";
import { runOnboard } from "../bin/onboard.ts";
import { dropDraft, reviseDraft, sendDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { sendWith } from "../lib/senders.ts";
import { loadStyle, paths, toneFile } from "../lib/settings.ts";
import { getDraft, listDrafts } from "../lib/store.ts";
import { learnTone, type Runner } from "../lib/tone.ts";
import { enable, fakeModel, goodReply, j, mailFixture, pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.legacyStyle(), paths.toneDir(), paths.drafts(), paths.inbox(), paths.personalFeature()]) rmSync(p, { force: true, recursive: true });
});

const sink = () => {
	const sent: { target: string; text: string }[] = [];
	return { sent, send: (target: string, text: string) => void sent.push({ target, text }) };
};

async function offered(model = fakeModel([j(goodReply)])) {
	enable(env);
	const out = sink();
	const result = await offerMailDraft(mailFixture, { send: out.send, call: model.call });
	const rec = listDrafts()[0];
	return { out, result, rec, model };
}

test("off by default: with no config the offer does nothing and nothing is sent or called", async () => {
	const out = sink();
	const model = fakeModel([j(goodReply)]);
	expect(await offerMailDraft(mailFixture, { send: out.send, call: model.call })).toBe("off");
	expect(out.sent).toEqual([]);
	expect(model.calls).toHaveLength(0);
	enable(env, { auto: false });
	expect(await offerMailDraft(mailFixture, { send: out.send, call: model.call })).toBe("off");
});

test("an enabled install offers the draft as an [ask] with exactly the three choices", async () => {
	const { out, result, rec } = await offered();
	expect(result).toBe("offered");
	expect(out.sent).toHaveLength(1);
	expect(out.sent[0]!.target).toBe("th:t1");
	const text = out.sent[0]!.text;
	expect(text.startsWith("[ask]")).toBe(true);
	expect(parseDraftApproval(text)).toEqual({ toLabel: "받는이", to: "kim@example.com", subject: "Re: 회의 일정 문의", body: goodReply.body, noAttachments: true, ref: rec!.id });
	expect(parseDecisions(text).blocks[0]!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
	expect(rec).toMatchObject({ status: "pending", ref: "m-1", source: "zele", mailId: "msg-1" });
});

test("a question the draft still cannot settle is asked inside the approval card without breaking it", async () => {
	enable(env);
	const out = sink();
	await offerMailDraft(mailFixture, { send: out.send, call: fakeModel([j({ ...goodReply, questions: ["회의 날짜"] })]).call });
	expect(out.sent[0]!.text).not.toContain("정해 주세요");
	expect(out.sent[0]!.text).toMatch(/^결정: 이 답장 보낼까요\? 정할 것: 회의 날짜 \(R[A-Z2-7]{6}\)$/m);
	expect(parseDraftApproval(out.sent[0]!.text)?.body).toBe(goodReply.body);
});

test("automated senders, own address and an already drafted mail are skipped without a model call or a message", async () => {
	enable(env);
	const out = sink();
	const model = fakeModel([j(goodReply)]);
	expect(await offerMailDraft({ ...mailFixture, key: "m-2", from: "no-reply@example.com" }, { send: out.send, call: model.call })).toBe("skipped");
	expect(await offerMailDraft({ ...mailFixture, key: "m-3", from: "me@example.net" }, { send: out.send, call: model.call })).toBe("skipped");
	expect(model.calls).toHaveLength(0);
	expect(await offerMailDraft(mailFixture, { send: out.send, call: model.call })).toBe("offered");
	expect(await offerMailDraft(mailFixture, { send: out.send, call: model.call })).toBe("skipped");
	expect(model.calls).toHaveLength(1);
	expect(out.sent).toHaveLength(1);
});

test("a model skip, a failing model and a failing send never throw and leave no pending draft", async () => {
	enable(env);
	const out = sink();
	expect(await offerMailDraft({ ...mailFixture, key: "s-1" }, { send: out.send, call: fakeModel([j({ action: "skip", reason: "newsletter" })]).call })).toBe("skipped");
	const log = () => {};
	expect(await offerMailDraft({ ...mailFixture, key: "s-2" }, { send: out.send, call: async () => Promise.reject(new Error("down")), log })).toBe("failed");
	expect(await offerMailDraft({ ...mailFixture, key: "s-3" }, { send: () => Promise.reject(new Error("post failed")), call: fakeModel([j(goodReply)]).call, log })).toBe("failed");
	expect(out.sent).toEqual([]);
	expect(listDrafts()).toEqual([]);
});

test("send refuses without a pick, with a pick for another id, and after 보내지 않기", async () => {
	const { rec } = await offered();
	const sender = { calls: 0, send: async () => ({ ok: true, message: "보냈어요" }) };
	const run = async () => {
		sender.calls++;
		return sender.send();
	};
	expect((await sendDraft(rec!.id, { send: run })).ok).toBe(false);
	pick(env, "ROTHER1", 1);
	expect((await sendDraft(rec!.id, { send: run })).ok).toBe(false);
	pick(env, rec!.id, 1, undefined, "lane");
	expect((await sendDraft(rec!.id, { send: run })).ok).toBe(false);
	expect(sender.calls).toBe(0);
	pick(env, rec!.id, 3);
	const dropped = await sendDraft(rec!.id, { send: run });
	expect(dropped.ok).toBe(false);
	expect(getDraft(rec!.id)!.status).toBe("dropped");
	expect(sender.calls).toBe(0);
});

test("with a 보내기 pick the fake sender is called exactly once and the draft is marked sent", async () => {
	const { rec } = await offered();
	const seen: string[] = [];
	const deps = { send: async (r: { id: string; to: string }) => (seen.push(`${r.id}>${r.to}`), { ok: true, message: "보냈어요" }) };
	pick(env, rec!.id, 1);
	expect((await sendDraft(rec!.id, deps)).ok).toBe(true);
	expect(seen).toEqual([`${rec!.id}>kim@example.com`]);
	expect(getDraft(rec!.id)!.status).toBe("sent");
	expect((await sendDraft(rec!.id, deps)).ok).toBe(false);
	expect(seen).toHaveLength(1);
});

test("the lint runs again right before sending", async () => {
	const { rec } = await offered();
	enable(env);
	await Bun.write(toneFile({ app: "mail" }), "## 금지\n\n- 확인해 보고\n");
	pick(env, rec!.id, 1);
	let called = 0;
	const r = await sendDraft(rec!.id, { send: async () => (called++, { ok: true, message: "" }) });
	expect(r.ok).toBe(false);
	expect(r.text).toContain("확인해 보고");
	expect(called).toBe(0);
});

test("sending routes by source: the mail CLI reads then replies to the mail id, an unknown source is refused for the user to send by hand", async () => {
	const { rec } = await offered();
	const argvs: string[][] = [];
	const run: Runner = async argv => (argvs.push(argv), { code: 0, stdout: "", stderr: "" });
	expect((await sendWith(rec!, run)).ok).toBe(true);
	expect(argvs).toEqual([
		["zele", "mail", "read", "msg-1"],
		["zele", "mail", "reply", "msg-1", "--to", "kim@example.com", "--body", goodReply.body],
	]);
	const refused = await sendWith({ ...rec!, source: "manual" }, run);
	expect(refused.ok).toBe(false);
	expect(argvs).toHaveLength(2);
});

test("webmail source: draft, approve and send of that feature, in that order", async () => {
	const { rec } = await offered();
	const argvs: string[][] = [];
	const run: Runner = async argv => (argvs.push(argv), { code: 0, stdout: argv[3] === "draft" ? "초안 저장: d-1\n" : "ok\n", stderr: "" });
	expect((await sendWith({ ...rec!, source: "webmail:work" }, run)).ok).toBe(true);
	expect(argvs.map(a => a.slice(3, 5))).toEqual([["draft", "kim@example.com"], ["approve"], ["send", "d-1"]]);
	expect(argvs.every(a => a[2] === "work")).toBe(true);
});

test("고치기 round trip: pick with the change, revise makes a new id, the old one goes stale, the change is in the mail tone profile and the old id cannot be sent", async () => {
	const { rec, model } = await offered(fakeModel([j(goodReply), j({ ...goodReply, body: "곧 알려 드릴게요." })]));
	pick(env, rec!.id, 2, "더 짧게 써 주세요");
	const sender = { calls: 0 };
	expect((await sendDraft(rec!.id, { send: async () => (sender.calls++, { ok: true, message: "" }) })).ok).toBe(false);
	const revised = await reviseDraft(rec!.id, "더 짧게 써 주세요", { call: model.call });
	expect(revised.ok).toBe(true);
	const next = listDrafts().find(d => d.status === "pending")!;
	expect(next.id).not.toBe(rec!.id);
	expect(next).toMatchObject({ body: "곧 알려 드릴게요.", changes: ["더 짧게 써 주세요"], ref: "m-1" });
	expect(getDraft(rec!.id)!.status).toBe("stale");
	expect(parseDraftApproval(revised.text)).toMatchObject({ ref: next.id, body: "곧 알려 드릴게요." });
	expect(loadStyle({ app: "mail" }).corrections[0]).toContain("더 짧게 써 주세요");
	expect(model.calls[1]!.user).toContain("더 짧게 써 주세요");
	expect(model.calls[1]!.user).toContain(goodReply.body);
	pick(env, rec!.id, 1);
	expect((await sendDraft(rec!.id, { send: async () => (sender.calls++, { ok: true, message: "" }) })).ok).toBe(false);
	expect(sender.calls).toBe(0);
	expect(dropDraft(next.id).ok).toBe(true);
	expect((await reviseDraft(next.id, "x", { call: model.call })).ok).toBe(false);
});

test("tone learning writes 예시 from the user's sent mail and drops quoted history, signatures and duplicates", async () => {
	const sentBody = (extra: string) => `subject: x\nto: kim@example.com\n\n확인했어요. 내일 오전에 연락드릴게요.\n감사합니다.\n${extra}\n\nOn Mon, Jan 5, 2030, Kim <kim@example.com> wrote:\n> 지난번 건은 어떻게 됐나요?\n> 답장 부탁드려요.\n`;
	const bodies: Record<string, string> = { m1: sentBody("자료는 첨부했어요."), m2: `${sentBody("")}\n-- \n서명 줄입니다` };
	const run: Runner = async argv =>
		argv[2] === "list" ? { code: 0, stdout: "items:\n  - id: m1\n    snippet: s\n  - id: m2\n    snippet: s\n", stderr: "" } : { code: 0, stdout: bodies[argv[3]!] ?? "", stderr: "" };
	const r = await learnTone({ app: "mail" }, { run, zeleOn: true });
	expect(r.examples).toEqual(["확인했어요.", "내일 오전에 연락드릴게요.", "감사합니다.", "자료는 첨부했어요."]);
	const md = readFileSync(toneFile({ app: "mail" }), "utf8");
	expect(md).not.toContain("지난번");
	expect(md).not.toContain("서명");
	expect(loadStyle({ app: "mail" }).samples).toEqual(r.examples);
	const none = await learnTone({ app: "mail" }, { zeleOn: false });
	expect(none.examples).toEqual([]);
});

test("tone from a file, at most 40 sentences, and youtube/instagram fall back to the sns tone examples", async () => {
	await Bun.write(join(env.dir, "t.txt"), Array.from({ length: 60 }, (_, i) => `이것은 ${i}번째 문장이에요.`).join("\n"));
	expect((await learnTone({ app: "mail" }, { fromFile: join(env.dir, "t.txt") })).examples).toHaveLength(40);
	await Bun.write(join(env.dir, "custom", "sns", "tone.md"), "## 예시\n\n- 고마워요!\n");
	expect(loadStyle({ app: "youtube" })).toMatchObject({ samples: ["고마워요!"], samplesFrom: "legacy" });
	expect(loadStyle({ app: "instagram" }).samples).toEqual(["고마워요!"]);
	expect(loadStyle({ app: "mail" }).samples).not.toContain("고마워요!");
	expect(loadStyle({ app: "blog" }).samples).toEqual([]);
});

test("onboard on/off flips the config and the personal feature switch; learn reports a Korean summary", async () => {
	const noRun: Runner = async () => ({ code: 1, stdout: "", stderr: "" });
	expect(existsSync(paths.config())).toBe(false);
	const on = await runOnboard(["on", "--to", "main"], noRun, false);
	expect(on.code).toBe(0);
	expect(JSON.parse(readFileSync(paths.config(), "utf8")).enabled).toBe(true);
	expect(readFileSync(paths.personalFeature(), "utf8")).toMatch(/^enabled: true$/m);
	expect((await runOnboard(["off"], noRun, false)).code).toBe(0);
	expect(JSON.parse(readFileSync(paths.config(), "utf8")).enabled).toBe(false);
	expect(existsSync(paths.personalFeature())).toBe(false);
	await Bun.write(join(env.dir, "t.txt"), "알겠습니다. 확인해 볼게요.");
});

test("draft.ts new prints the [ask] block for a mail and the bare reply text for a comment; only an explicit off refuses it", async () => {
	const model = fakeModel([j(goodReply)]);
	const args = ["new", "--mail", "k-1", "--from", "kim@example.com", "--subject", "회의 일정 문의"];
	enable(env, { enabled: false });
	expect((await runDraft(args, "질문이에요", { call: model.call })).code).toBe(1);
	enable(env);
	const out = await runDraft(args, "질문이에요", { call: model.call });
	expect(out.code).toBe(0);
	expect(parseDraftApproval(out.lines[0]!)).toMatchObject({ to: "kim@example.com", body: goodReply.body });
	const comment = await runDraft(["new", "--mail", "c-1", "--kind", "comment", "--app", "youtube", "--from", "viewer"], "영상 잘 봤어요", { call: fakeModel([j({ action: "draft", reason: "r", to: "viewer", body: "고마워요!", questions: [] })]).call });
	expect(comment.lines).toEqual(["고마워요!"]);
	expect(listDrafts().filter(d => d.kind === "comment")).toEqual([]);
});

test("a second mail's body is read while the first draft is still in its model call; only the model calls queue", async () => {
	enable(env);
	const out = sink();
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const model = fakeModel([j(goodReply), j(goodReply)]);
	const reads: string[] = [];
	const deps = { send: out.send, call: async (s: string, u: string) => (await gate, model.call(s, u)), readBody: async (_src: string, id: string) => (reads.push(id), "다음 주 화요일에 회의 가능하신가요?") };
	const first = offerMailDraft({ ...mailFixture, body: undefined, key: "p-1", id: "p-1" }, deps);
	const second = offerMailDraft({ ...mailFixture, body: undefined, key: "p-2", id: "p-2" }, deps);
	await Promise.resolve();
	expect(reads).toEqual(["p-1", "p-2"]);   // both reads started before the first model call returned
	release();
	expect([await first, await second]).toEqual(["offered", "offered"]);
});
