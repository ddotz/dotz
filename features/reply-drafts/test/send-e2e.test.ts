// End to end with fakes: a received mail -> reply draft offered as an [ask] (files of the 첨부 파일 폴더 staged) -> the owner's web pick
// 1) 보내기 -> `draft.ts send` -> the mail CLI (fake zele) gets `mail read` then `mail reply --attach`. Also a new mail (mail-cli compose).
// Nothing real is sent: every external call is the fake runner below, the gateway is a recording fake.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { runMailCli } from "../../../hub/mail-cli.ts";
import { runDraft } from "../bin/draft.ts";
import { sendDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { paths } from "../lib/settings.ts";
import { stagedFiles } from "../lib/staged.ts";
import { getDraft, listDrafts } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { enable, fakeModel, j, mailFixture, pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "rd-e2e-lib-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
writeFileSync(join(lib, "행방불명_공유용.pdf"), "pdf bytes");
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), join(env.dir, "custom", "reply-drafts", "sending")]) rmSync(p, { force: true, recursive: true });
});

const mail = { ...mailFixture, key: "e2e-1", subject: "행방불명 ost 악보 부탁드립니다", from: "Student <stu@example.com>", body: "선생님 행방불명 ost 악보 부탁드립니다." };
const replyJson = { action: "draft", reason: "asks for a score", to: "stu@example.com", subject: "Re: 행방불명 ost 악보 부탁드립니다", body: "요청하신 악보 보내드립니다.", questions: [] };

// The fake mail CLI: records every argv; `reply` exits with `replyCode` (1 = zele refused).
function fakeZele(o: { replyCode?: number } = {}) {
	const calls: string[][] = [];
	const run: Runner = async argv => {
		calls.push(argv);
		const reply = argv[2] === "reply" || argv[2] === "send";
		return reply && o.replyCode ? { code: o.replyCode, stdout: "", stderr: "zele: thread changed" } : { code: 0, stdout: reply ? "sent" : "mail body", stderr: "" };
	};
	return { calls, run, sends: () => calls.filter(a => a[2] === "reply" || a[2] === "send") };
}
const fakeHub = () => {
	const posts: { path: string; body: unknown }[] = [];
	return { posts, post: async (path: string, body?: unknown) => (posts.push({ path, body }), { status: 200 }) };
};

async function offered() {
	enable(env, { attachFolders: { mail: lib } });
	const asks: string[] = [];
	expect(await offerMailDraft(mail, { send: (_t, text) => void asks.push(text), call: fakeModel([j(replyJson)]).call, pick: async names => names })).toBe("offered");
	const rec = listDrafts()[0]!;
	return { rec, ask: asks[0]! };
}

describe("mail reply: draft -> 1) 보내기 -> zele reply with the file", () => {
	test("the [ask] shows the staged file; the pick sends it once through read + reply --attach and the owner is told", async () => {
		const { rec, ask } = await offered();
		expect(parseDraftApproval(ask)).toMatchObject({ to: "stu@example.com", attachments: [{ name: "행방불명_공유용.pdf" }], ref: rec.id });
		const file = stagedFiles(rec.id)[0]!;
		const zele = fakeZele();
		const hub = fakeHub();
		expect((await runDraft(["send", rec.id], "", { run: zele.run, hub })).code).toBe(1);
		expect(zele.calls).toEqual([]);
		pick(env, rec.id, 1);
		const out = await runDraft(["send", rec.id], "", { run: zele.run, hub });
		expect(out).toMatchObject({ code: 0, lines: ["stu@example.com에게 답장을 보냈어요"] });
		expect(zele.calls).toEqual([
			["zele", "mail", "read", "msg-1"],
			["zele", "mail", "reply", "msg-1", "--to", "stu@example.com", "--body", "요청하신 악보 보내드립니다.", "--attach", file.path],
		]);
		expect(getDraft(rec.id)!.status).toBe("sent");
		expect(hub.posts.map(p => p.path)).toEqual(["/api/followup"]);
	});

	test("a failed reply tells why, keeps the draft and its file pending, and the same approval sends after the CLI recovers", async () => {
		const { rec } = await offered();
		pick(env, rec.id, 1);
		const down = fakeZele({ replyCode: 1 });
		const failed = await runDraft(["send", rec.id], "", { run: down.run, hub: fakeHub() });
		expect(failed.code).toBe(1);
		expect(failed.lines[0]).toContain("보내지 못했어요");
		expect(failed.lines[0]).toContain("zele: thread changed");
		expect(getDraft(rec.id)!.status).toBe("pending");
		expect(stagedFiles(rec.id)).toHaveLength(1);
		const up = fakeZele();
		expect((await runDraft(["send", rec.id], "", { run: up.run, hub: fakeHub() })).code).toBe(0);
		expect(up.sends()).toHaveLength(1);
		expect(up.sends()[0]).toContain("--attach");
	});

	test("a double tap (two 보내기 answers, two sends at once) sends once; a replayed answer later sends nothing", async () => {
		const { rec } = await offered();
		pick(env, rec.id, 1);
		pick(env, rec.id, 1);
		const calls: string[][] = [];
		let release!: () => void;
		let entered!: () => void;
		const inReply = new Promise<void>(r => (entered = r));
		const held = new Promise<void>(r => (release = r));
		let first = true;
		const run: Runner = async argv => {
			calls.push(argv);
			if (argv[2] === "reply" && first) {
				first = false;
				entered();
				await held;
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const a = sendDraft(rec.id, { run });
		await inReply;
		const b = await sendDraft(rec.id, { run });
		expect(b.ok).toBe(false);
		release();
		expect((await a).ok).toBe(true);
		expect(calls.filter(c => c[2] === "reply")).toHaveLength(1);
		pick(env, rec.id, 1);
		const replay = fakeZele();
		const again = await runDraft(["send", rec.id], "", { run: replay.run, hub: fakeHub() });
		expect(again.code).toBe(1);
		expect(again.lines[0]).toContain("이미 sent");
		expect(replay.calls).toEqual([]);
	});
});

describe("new mail (mail-cli compose): 1) 보내기 -> zele send with the file", () => {
	test("compose stages the file, the pick sends it once with --attach", async () => {
		enable(env);
		const src = join(mkdtempSync(join(tmpdir(), "rd-e2e-att-")), "견적서.pdf");
		mkdirSync(join(src, ".."), { recursive: true });
		writeFileSync(src, "quote");
		const hub = fakeHub();
		const made = await runMailCli(["compose", "--app", "mail", "--to", "kim@example.com", "--subject", "견적서 보내드립니다", "--attach", src], "견적서 첨부합니다.", { hub });
		expect(made.code).toBe(0);
		const rec = listDrafts().find(d => d.compose)!;
		expect(parseDraftApproval(made.lines[0]!)).toMatchObject({ to: "kim@example.com", attachments: [{ name: "견적서.pdf" }], ref: rec.id });
		const zele = fakeZele();
		expect((await runMailCli(["send", "--draft", rec.id], "", { run: zele.run, hub })).code).toBe(1);
		pick(env, rec.id, 1);
		const sent = await runMailCli(["send", "--draft", rec.id], "", { run: zele.run, hub });
		expect(sent).toMatchObject({ code: 0, lines: ["kim@example.com에게 메일을 보냈어요"] });
		expect(zele.sends()).toEqual([["zele", "mail", "send", "--to", "kim@example.com", "--subject", "견적서 보내드립니다", "--body", "견적서 첨부합니다.", "--attach", stagedFiles(rec.id)[0]!.path]]);
		expect(getDraft(rec.id)!.status).toBe("sent");
		expect((await runMailCli(["send", "--draft", rec.id], "", { run: zele.run, hub })).code).toBe(1);
		expect(zele.sends()).toHaveLength(1);
	});
});
