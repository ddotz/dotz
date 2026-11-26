import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learningSettled, type FlowDeps } from "../features/reply-drafts/lib/flow.ts";
import { draftRules } from "../features/reply-drafts/lib/draft-rules.ts";
import { HEADINGS, paths, profileBullets } from "../features/reply-drafts/lib/settings.ts";
import { addDraft, getDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { mailHash } from "../features/reply-drafts/lib/view.ts";
import { appendSealed } from "./approval-seal.ts";
import { runMailCli } from "./mail-cli.ts";

const dir = mkdtempSync(join(tmpdir(), "mail-cli-"));
const before = process.env.DOTZ_DIR;
process.env.DOTZ_DIR = dir;
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});

const LESSON = "일정을 알리는 메일 끝에는 '감사합니다'로 맺는다";
const composed = (id: string): DraftRec =>
	({ id, kind: "mail", app: "mail", source: "zele", mailId: `compose-${id}`, ref: `compose-${id.toLowerCase()}`, compose: true, to: "kim@example.com", subject: "Re: 다음 주 일정 안내", body: "다음 주 모임은 수요일 저녁이에요. 감사합니다.", editedFrom: "다음 주 모임은 수요일 저녁이에요.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", app: "mail", from: "kim@example.com", text: "", subject: "다음 주 일정 안내" } }) as unknown as DraftRec;

test("a compose mail the owner edited and sent by hand with mail-cli send --draft is learned once, through the learn call it is given", async () => {
	addDraft(composed("RCOMP01"));
	appendSealed(paths.inbox(), { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: "1) 보내기", picks: [{ q: "이 메일 보낼까요? (RCOMP01)", n: 1, label: "보내기", hash: mailHash(getDraft("RCOMP01")!) }] });
	const asked: string[] = [];
	const deps: FlowDeps & { hub: { post: () => Promise<{ status: number }> } } = {
		send: async () => ({ ok: true as const, message: "메일을 보냈어요" }),
		learnCall: app => async system => (asked.push(app), system.startsWith("You learn how") ? JSON.stringify({ lesson: LESSON, everywhere: false }) : JSON.stringify({ replaces: [] })),
		hub: { post: async () => ({ status: 200 }) },
	};
	const out = await runMailCli(["send", "--draft", "RCOMP01"], "", deps);
	expect(out.code).toBe(0);
	await learningSettled();
	expect(asked).toEqual(["mail"]);
	expect(profileBullets(draftRules(getDraft("RCOMP01")!, getDraft("RCOMP01")!.item).tone, HEADINGS.corrections)).toEqual([expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}: ${LESSON}$`))]);
});
