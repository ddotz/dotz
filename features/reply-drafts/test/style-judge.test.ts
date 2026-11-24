import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "../../../hub/config.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { requestMailDraft } from "../lib/offer.ts";
import { traceLine } from "../lib/flow.ts";
import { paths, recordRule, toneFile } from "../lib/settings.ts";
import { fakeModel, goodReply, j, mailFixture, setupEnv, enable } from "./helpers.ts";

const env = setupEnv();
afterAll(() => env.cleanup());
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), toneFile("install")]) rmSync(p, { force: true, recursive: true });
});

const logs = () => {
	const lines: string[] = [];
	return { lines, log: (l: string) => void lines.push(l) };
};
const sink = () => {
	const sent: string[] = [];
	return { sent, send: (_: string, text: string) => void sent.push(text) };
};
const violations = (vs: object[]) => j({ violations: vs });

describe("a mail draft and the style judge", () => {
	test("with a standing rule the draft is judged once on the judge's own call, and the draft's log line lists it", async () => {
		enable(env);
		recordRule("install", "존댓말로 쓴다");
		const model = fakeModel([j(goodReply)]), judge = fakeModel([violations([])]), l = logs();
		expect(await requestMailDraft({ ...mailFixture, key: "sj-1" }, { send: sink().send, call: model.call, judge: judge.call, log: l.log })).toBe("offered");
		expect(model.calls).toHaveLength(1);
		expect(judge.calls).toHaveLength(1);
		expect(judge.calls[0]!.user).toContain("1. 존댓말로 쓴다");
		expect(judge.calls[0]!.user).toContain(mailFixture.body);
		expect(l.lines.find(x => x.includes("model calls"))).toMatch(/^reply draft: mail sj-1 model calls 2: draft \d+ms, judge \d+ms$/);
	});

	test("a rule the rewrite still breaks is a 확인 note on the card", async () => {
		enable(env);
		recordRule("install", "끝맺음은 '감사합니다'로 한다");
		const model = fakeModel([j(goodReply)]), judge = fakeModel([violations([{ rule: 1, quote: "말씀드릴게요.", why: "끝맺음" }])]), out = sink();
		expect(await requestMailDraft({ ...mailFixture, key: "sj-2" }, { send: out.send, call: model.call, judge: judge.call })).toBe("offered");
		expect(model.calls).toHaveLength(2);
		expect(judge.calls).toHaveLength(2);
		expect(out.sent[0]).toContain("확인: 말투 조건과 달라 보여요: 끝맺음은 '감사합니다'로 한다");
		expect(parseDraftApproval(out.sent[0]!)?.body).toBe(goodReply.body);
	});

	test("no standing rule and no correction: no judge call", async () => {
		enable(env);
		const judge = fakeModel([violations([])]);
		expect(await requestMailDraft({ ...mailFixture, key: "sj-3" }, { send: sink().send, call: fakeModel([j(goodReply)]).call, judge: judge.call })).toBe("offered");
		expect(judge.calls).toHaveLength(0);
	});

	test("guard.style_judge false: no judge call", async () => {
		enable(env);
		recordRule("install", "존댓말로 쓴다");
		const judge = fakeModel([violations([])]), was = cfg.guard;
		cfg.guard = { style_judge: false };
		try {
			expect(await requestMailDraft({ ...mailFixture, key: "sj-4" }, { send: sink().send, call: fakeModel([j(goodReply)]).call, judge: judge.call })).toBe("offered");
		} finally {
			cfg.guard = was;
		}
		expect(judge.calls).toHaveLength(0);
	});

	test("a judge call the runner reports tokens for shows them in the draft's log line", () => {
		expect(traceLine({ deadline: 0, calls: [{ what: "draft", ms: 9490, tokens: { in: 4866, out: 863 } }, { what: "judge", ms: 820, tokens: { in: 900, out: 40 } }] })).toBe("model calls 2: draft 9490ms 4866/863 tok, judge 820ms 900/40 tok");
	});
});
