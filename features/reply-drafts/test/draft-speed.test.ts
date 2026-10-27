import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecisions } from "../../../hub/choices.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import type { ModelCall } from "../../../hub/reply-draft.ts";
import { buildDraft, draftTrace } from "../lib/flow.ts";
import { offerMailDraft, requestMailDraft } from "../lib/offer.ts";
import { paths } from "../lib/settings.ts";
import { stagedFiles } from "../lib/staged.ts";
import { listDrafts } from "../lib/store.ts";
import { enable, fakeModel, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "rd-speed-lib-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
for (const f of ["캐논_a.pdf", "캐논_b.pdf", "캐논_c.pdf", "캐논_d.pdf", "캐논_e.pdf"]) writeFileSync(join(lib, f), `bytes of ${f}`);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
});

const sink = () => {
	const sent: string[] = [];
	return { sent, send: (_: string, text: string) => void sent.push(text) };
};
const logs = () => {
	const lines: string[] = [];
	return { lines, log: (l: string) => void lines.push(l) };
};

// A mail source that reports the sender by name only, cut short and without an address, and the owner presses 초안 작성 (an automatic offer skips
// a sender whose address cannot be found): before this change one such draft made four model calls (draft, lint retry for the missing address,
// resolve call for the open points, its lint retry).
const nameOnly = { ...mailFixture, key: "n-1", source: "work", from: "Lee Minsu (Sales", body: "다음 주 회의 날짜를 정해서 알려 주실 수 있을까요?" };
const nameOnlyReply = { action: "draft", reason: "asks for a date", to: "Lee Minsu", subject: "Re: 회의 일정 문의", body: "확인해 보고 말씀드릴게요.", questions: ["Lee Minsu님의 메일 주소", "회의 날짜"] };

describe("one model call for the common mail draft", () => {
	test("a name-only sender's draft is one call: no retry for the address, no resolve call, no address question on the card", async () => {
		enable(env);
		const out = sink(), l = logs();
		const model = fakeModel([j(nameOnlyReply)]);
		expect(await requestMailDraft(nameOnly, { send: out.send, call: model.call, log: l.log })).toBe("offered");
		expect(model.calls).toHaveLength(1);
		const title = parseDecisions(out.sent[0]!).blocks[0]!.title;
		expect(title).toContain("회의 날짜");
		expect(title).not.toContain("주소");
		expect(l.lines.find(x => x.includes("model calls"))).toMatch(/^reply draft: mail n-1 model calls 1: draft \d+ms$/);
		expect(l.lines.some(x => x.includes("offered in"))).toBe(true);
	});

	test("a name-only sender whose address the mail's text shows gets that address, still in one call", async () => {
		enable(env);
		const out = sink();
		const model = fakeModel([j(nameOnlyReply)]);
		await offerMailDraft({ ...nameOnly, key: "n-2", body: `${nameOnly.body}\n\nLee Minsu <minsu.lee@example.com>` }, { send: out.send, call: model.call });
		expect(model.calls).toHaveLength(1);
		expect(parseDraftApproval(out.sent[0]!)?.to).toContain("minsu.lee@example.com");
	});

	test("a failed draft still logs the calls it made", async () => {
		enable(env);
		const l = logs();
		const call: ModelCall = async () => {
			throw new Error("model call timed out after 45s");
		};
		expect(await requestMailDraft({ ...nameOnly, key: "n-3" }, { send: () => {}, call, log: l.log })).toBe("failed");
		expect(l.lines.find(x => x.includes("model calls"))).toMatch(/model calls 1: draft \d+ms \(model call timed out after 45s\)$/);
	});
});

describe("file picking never waits for the draft", () => {
	test("a tie among library files is broken by the model while the draft call is still running", async () => {
		enable(env, { attachFolders: { mail: lib } });
		let pickStarted!: () => void;
		const started = new Promise<void>(r => (pickStarted = r));
		const order: string[] = [];
		// The draft call does not answer until the pick has started: a pick that ran after the draft would never start, and the bound fails the test.
		const call: ModelCall = async () => {
			order.push("draft start");
			await Promise.race([started, new Promise((_, no) => setTimeout(() => no(new Error("pick did not start beside the draft")), 3000))]);
			order.push("draft end");
			return j({ action: "draft", reason: "asks for a score", to: "kim@example.com", subject: "Re: 캐논 악보 부탁드립니다", body: "캐논 악보 보내드립니다.", questions: [] });
		};
		const pick = async (names: string[]) => (order.push(`pick ${names.length}`), pickStarted(), ["캐논_d.pdf"]);
		const out = sink(), l = logs();
		expect(await offerMailDraft({ ...mailFixture, key: "f-1", subject: "캐논 악보 부탁드립니다", body: "캐논 악보 보내주세요." }, { send: out.send, call, pick, log: l.log })).toBe("offered");
		expect(order).toEqual(["draft start", "pick 5", "draft end"]);
		expect(parseDraftApproval(out.sent[0]!)?.attachments?.map(a => a.name)).toEqual(["캐논_d.pdf"]);
		expect(stagedFiles(listDrafts()[0]!.id).map(f => f.name)).toEqual(["캐논_d.pdf"]);
	});

	test("a tie in a mail that does not ask for a file takes the best-ranked files without a model call", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const model = fakeModel([j({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 캐논 연주", body: "캐논 악보 보내드립니다.", questions: [] })]);
		let picks = 0;
		await offerMailDraft({ ...mailFixture, key: "f-2", subject: "캐논 연주", body: "지난번 캐논 연주 좋았어요." }, { send: sink().send, call: model.call, pick: async () => (picks++, []) });
		expect(model.calls).toHaveLength(1);
		expect(picks).toBe(0);
		expect(stagedFiles(listDrafts()[0]!.id).map(f => f.name)).toEqual(["캐논_a.pdf", "캐논_b.pdf", "캐논_c.pdf"]);
	});
});

describe("one budget for the whole draft", () => {
	test("a retry is not started once the draft's budget is spent; the first draft is kept with its findings", async () => {
		enable(env);
		const trace = draftTrace();
		let n = 0;
		const call: ModelCall = async () => {
			n++;
			trace.deadline = Date.now();
			return j({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "[이름]님, 확인해 볼게요.", questions: [] });
		};
		const built = await buildDraft({ kind: "mail", app: "mail", from: "Kim <kim@example.com>", subject: "회의 일정 문의", text: "회의 일정 알려 주세요" }, { source: "zele", mailId: "b1", ref: "b1" }, { call, trace });
		expect(n).toBe(1);
		expect(built).toMatchObject({ action: "draft", warnings: ["the text contains a placeholder"] });
		expect(trace.calls).toHaveLength(1);
	});
});
