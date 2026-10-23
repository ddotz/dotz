import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftApprovalBlock, parseDraftApproval } from "../../../hub/draft-approval.ts";
import { followupTurn, parseFollowup, setFollowupWake, triggerFollowup, type FollowupInput } from "../../../hub/followup.ts";
import { runMailCli } from "../../../hub/mail-cli.ts";
import { runDraft } from "../bin/draft.ts";
import { paths } from "../lib/settings.ts";
import { stagedFiles } from "../lib/staged.ts";
import { getDraft, listDrafts } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
const files = mkdtempSync(join(tmpdir(), "rd-fu-"));
afterAll(() => {
	env.cleanup();
	rmSync(files, { recursive: true, force: true });
});
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), join(env.dir, "followups.json")]) rmSync(p, { force: true, recursive: true });
	setFollowupWake(() => {});
});

const score = join(files, "score.pdf");
writeFileSync(score, "pdf bytes");
const RULE = "악보를 달라는 댓글이고 메일 주소를 적었으면 그 주소로 악보를 메일로 보낸다";
const BODY = "안녕하세요.\n\n요청하신 악보를 보내드립니다.\n\n감사합니다.";

// Injected so no mail goes out: the runner records the argv, the hub records what the CLIs report to the gateway.
const harness = () => {
	const argvs: string[][] = [];
	const posts: { path: string; body: any }[] = [];
	return {
		argvs,
		posts,
		deps: {
			run: async (argv: string[]) => (argvs.push(argv), { code: 0, stdout: "", stderr: "" }),
			hub: { post: async (path: string, body?: unknown) => (posts.push({ path, body }), { status: 200 }) },
		},
	};
};
const compose = (h: ReturnType<typeof harness>, extra: string[] = []) =>
	runMailCli(["compose", "--app", "mail", "--to", "fan@example.com", "--subject", "악보 보내드립니다", "--attach", score, ...extra], BODY, h.deps);

describe("mail-cli compose", () => {
	test("stages the attachment, records a draft and prints the shared approval block", async () => {
		enable(env);
		const h = harness();
		const out = await compose(h, ["--origin", "comment:c1"]);
		expect(out.code).toBe(0);
		const text = out.lines.join("\n");
		const d = listDrafts()[0]!;
		expect(d).toMatchObject({ compose: true, status: "pending", to: "fan@example.com", subject: "악보 보내드립니다", origin: { kind: "comment", id: "c1", text: "댓글 답글에 이어서" } });
		expect(stagedFiles(d.id).map(f => f.name)).toEqual(["score.pdf"]);
		const card = parseDraftApproval(text);
		expect(card).toMatchObject({ toLabel: "받는이", to: "fan@example.com", subject: "악보 보내드립니다", origin: { text: "댓글 답글에 이어서" } });
		expect(card?.attachments?.map(a => a.name)).toEqual(["score.pdf"]);
		expect(card?.body).toContain("요청하신 악보를 보내드립니다.");
		expect(card?.warning).toBeUndefined();
		for (const label of ["보내기", "고치기", "보내지 않기"]) expect(text).toContain(label);
		// the web mail app lists it like a reply draft, without waking anyone
		expect(h.posts).toEqual([{ path: "/api/mail/compose", body: expect.objectContaining({ ref: d.id, to: "fan@example.com", origin: "댓글 답글에 이어서" }) }]);
		expect(h.argvs).toEqual([]);
	});

	test("a missing attachment file or an unknown mail app is refused before anything is recorded", async () => {
		enable(env);
		const h = harness();
		expect((await runMailCli(["compose", "--app", "mail", "--to", "a@example.com", "--subject", "s", "--attach", join(files, "nope.pdf")], "본문", h.deps)).code).toBe(2);
		expect((await runMailCli(["compose", "--app", "youtube", "--to", "a@example.com", "--subject", "s"], "본문", h.deps)).code).toBe(2);
		expect(listDrafts()).toEqual([]);
	});

	test("send refuses without the owner's 보내기, then sends once with the file after it", async () => {
		enable(env);
		const h = harness();
		await compose(h);
		const id = listDrafts()[0]!.id;
		h.posts.length = 0;
		const refused = await runMailCli(["send", "--draft", id], "", h.deps);
		expect(refused.code).toBe(1);
		expect(h.argvs).toEqual([]);
		expect(getDraft(id)?.status).toBe("pending");

		pick(env, id, 1);
		const sent = await runMailCli(["send", "--draft", id], "", h.deps);
		expect(sent.code).toBe(0);
		expect(h.argvs).toHaveLength(1);
		expect(h.argvs[0]!.slice(0, 5)).toEqual(["zele", "mail", "send", "--to", "fan@example.com"]);
		expect(h.argvs[0]).toContain("--attach");
		expect(h.argvs[0]!.some(a => a.endsWith("score.pdf"))).toBe(true);
		expect(getDraft(id)?.status).toBe("sent");
		expect(h.posts).toEqual([{ path: "/api/mail/compose", body: { ref: id, source: "zele", state: "sent" } }]);
		// a sent compose draft is never a trigger for another follow-up
		expect(h.posts.some(p => p.path === "/api/followup")).toBe(false);
		expect((await runMailCli(["send", "--draft", id], "", h.deps)).code).toBe(1);
		expect(h.argvs).toHaveLength(1);
	});

	test("the owner's 보내지 않기 sends nothing", async () => {
		enable(env);
		const h = harness();
		await compose(h);
		const id = listDrafts()[0]!.id;
		pick(env, id, 3);
		expect((await runMailCli(["send", "--draft", id], "", h.deps)).code).toBe(1);
		expect(h.argvs).toEqual([]);
		expect(getDraft(id)?.status).toBe("dropped");
	});
});

describe("the card shows where a chained draft comes from", () => {
	test("the 이어서 line carries the comment link and parses back", () => {
		const text = draftApprovalBlock({ to: "fan@example.com", subject: "악보", body: BODY, ref: "R1", origin: { text: "댓글 답글에 이어서", link: "https://site.example/p7#c1" } });
		expect(text).toContain("> 이어서: 댓글 답글에 이어서 (https://site.example/p7#c1)");
		expect(parseDraftApproval(text)?.origin).toEqual({ text: "댓글 답글에 이어서", link: "https://site.example/p7#c1" });
		expect(parseDraftApproval(draftApprovalBlock({ to: "fan@example.com", body: BODY, ref: "R1" }))?.origin).toBeUndefined();
	});
});

describe("the 이어서 할 일 wake", () => {
	const comment: FollowupInput = { app: "youtube", kind: "comment", key: "send-1", ids: { comment: "c1", source: "youtube", thread: "p1" } };
	const wakes = () => {
		const turns: string[] = [];
		setFollowupWake(t => void turns.push(t));
		return turns;
	};

	test("no rule: no wake and nothing written", () => {
		enable(env);
		const turns = wakes();
		expect(triggerFollowup(comment)).toBe("none");
		expect(turns).toEqual([]);
	});

	test("with a rule it wakes once per approved action, with the rule, the ids and the condition check", () => {
		enable(env, { followups: { youtube: RULE } });
		const turns = wakes();
		expect(triggerFollowup(comment)).toBe("woke");
		expect(triggerFollowup(comment)).toBe("duplicate");
		expect(triggerFollowup({ ...comment, key: "send-2" })).toBe("woke");
		expect(turns).toHaveLength(2);
		const t = turns[0]!;
		expect(t).toContain("[followup:youtube]");
		expect(t).toContain(`규칙: ${RULE}`);
		expect(t).toContain("comment=c1");
		expect(t).toContain("mail-cli.ts compose");
		expect(t).toContain("--origin comment:c1");
		expect(t).toContain("mail-cli.ts send --draft");
		// condition not met: the wake text tells the bot to end silently, with no draft and no question
		expect(t).toMatch(/맞지 않으면 초안도 질문도 만들지 않고 아무 말 없이 끝냅니다/);
		expect(followupTurn(RULE, comment)).toBe(t);
	});

	test("a rule on another app does not wake this one", () => {
		enable(env, { followups: { instagram: RULE } });
		const turns = wakes();
		expect(triggerFollowup(comment)).toBe("none");
		expect(turns).toEqual([]);
	});

	test("the gateway endpoint body is validated", () => {
		expect(parseFollowup({ app: "mail", kind: "mail", key: "R1", ids: { draft: "R1", mail: "m-1" } })).toEqual({ app: "mail", kind: "mail", key: "R1", ids: { draft: "R1", mail: "m-1" } });
		expect(parseFollowup({ app: "mail", kind: "other", key: "R1" })).toBeNull();
		expect(parseFollowup({ app: "Mail X", kind: "mail", key: "R1" })).toBeNull();
		expect(parseFollowup({ app: "mail", kind: "mail", key: "" })).toBeNull();
		expect(parseFollowup({ app: "mail", kind: "mail", key: "R1", ids: { draft: "has space", "Bad": "x" } })?.ids).toEqual({});
	});

	test("a mail reply: the gateway hears of it only after the owner's 보내기 sent it", async () => {
		enable(env, { followups: { mail: RULE } });
		const h = harness();
		const m = fakeModel([j(goodReply)]);
		await runDraft(["new", "--mail", mailFixture.key, "--from", "kim@example.com", "--subject", mailFixture.subject, "--source", "zele", "--id", mailFixture.id], mailFixture.body, { call: m.call, ...h.deps });
		const rec = listDrafts()[0]!;
		const refused = await runDraft(["send", rec.id], "", { call: m.call, ...h.deps });
		expect(refused.code).not.toBe(0);
		expect(h.posts).toEqual([]);
		pick(env, rec.id, 1);
		const ok = await runDraft(["send", rec.id], "", { call: m.call, ...h.deps });
		expect(ok.code).toBe(0);
		expect(h.posts).toEqual([{ path: "/api/followup", body: { app: "mail", kind: "mail", key: rec.id, ids: { draft: rec.id, mail: rec.ref } } }]);
	});
});
