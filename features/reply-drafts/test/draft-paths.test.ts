import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeSettings } from "../../../hub/app-settings.ts";
import { commentStyle } from "../../../hub/comments/real.ts";
import { realMailLink } from "../../../hub/comments/mail-link.ts";
import { DRAFT_AS_IS } from "../../../hub/draft-approval.ts";
import { draftRules } from "../lib/draft-rules.ts";
import { draftAttachIssues, draftLintFailures } from "../lib/flow.ts";
import { keysOf, learn } from "../lib/learn.ts";
import { addRecord, readLedger } from "../lib/ledger.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { type Pair, paths, savePairs, toneFile } from "../lib/settings.ts";
import { getDraft, listDrafts } from "../lib/store.ts";
import { enable, fakeModel, j, mailFixture, setupEnv } from "./helpers.ts";

// Every way a mail draft is made or checked reads the same rules (features/reply-drafts/lib/draft-rules.ts): the app's tone file, the mailbox's file with its 금지 and
// its own replies as examples, the recipient's file and the configured instruction. One table: what reached each path's prompt and check must be the same.
const env = setupEnv();
afterAll(env.cleanup);
const APP = "앱금지", BOX = "메일함금지", TO = "받는이금지", EXAMPLE = "메일함A예시", OTHER = "메일함B예시", CONFIGURED = "설정지시";
const BAD = `${APP} ${BOX} ${TO} 확인해 보고 말씀드릴게요.`;
const OK = "확인해 보고 말씀드릴게요.";
const reply = (body: string) => j({ action: "draft", reason: "asks", to: "a@example.com", subject: "Re: 회의 일정 문의", body, questions: [] });
let seq = 0;
const pair = (domain: string, text: string, received: string): Pair => ({ received, reply: `${text} ${++seq}번이에요.`, at: 1_900_000_000_000 + seq * 60_000, from: `Kim <kim${seq}@${domain}>`, source: "zele", conv: `c${seq}`, subj: `자료 ${seq}` });
const tone = (file: string, text: string) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));

beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.toneDir(), paths.ledger(), join(env.dir, "draft-files"), join(paths.pairs("mail"), ".."), join(env.dir, "custom", "apps.json")]) rmSync(p, { force: true, recursive: true });
	enable(env, { apps: { mail: { auto: true } } });
	const box = (id: string, from: string) => ({ id, name: id, mode: "auto", conds: { from: [from], subj: [], body: [], src: [] } });
	mkdirSync(join(env.dir, "custom"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "mailboxes.json"), JSON.stringify({ rev: 1, accounts: { mail: { boxes: [{ id: "base", name: "일반", base: true }, box("b-a", "@example.com"), box("b-b", "@other.example.org")] } }, pins: {} }));
	writeSettings(env.dir, "mail", { draft_default: CONFIGURED });
	tone(toneFile({ app: "mail" }), `## 예시\n\n- 네 보내드렸어요\n\n## 금지\n\n- ${APP}\n`);
	tone(toneFile({ app: "mail", room: "b-a" }), `## 금지\n\n- ${BOX}\n`);
	tone(toneFile({ app: "mail", to: "a@example.com" }), `## 금지\n\n- ${TO}\n`);
	// Mailbox B's replies read closer to the mail than mailbox A's: only A's may be the examples of a mail in A.
	savePairs("mail", [...Array.from({ length: 25 }, () => pair("example.com", EXAMPLE, "다른 일정")), ...Array.from({ length: 25 }, () => pair("other.example.org", OTHER, mailFixture.body))]);
});

type Seen = { app: boolean; box: boolean; to: boolean };
const checked = (text: string): Seen => ({ app: hit(text, APP), box: hit(text, BOX), to: hit(text, TO) });
const hit = (text: string, w: string) => text.includes(`expression '${w}'`) || text.includes(`표현 '${w}'`);
const prompted = (c: { system: string; user: string }) => {
	const t = c.system + c.user;
	return { app: t.includes(APP), box: t.includes(BOX), to: t.includes(TO), example: t.includes(EXAMPLE), otherBox: t.includes(OTHER), configured: t.includes(CONFIGURED) };
};
const FULL = { app: true, box: true, to: true };
const SEEN = { ...FULL, example: true, otherBox: false, configured: true };

// The model's first draft breaks all three bans; what its rewrite is told is what the path's own check found.
async function viaOffer() {
	const model = fakeModel([reply(BAD), reply(OK)]);
	const m = { ...mailFixture, key: "dp-1", from: "A <a@example.com>" };
	const deps = { send: () => {}, log: () => {}, call: model.call, mailOf: (key: string) => ({ key, source: "zele", id: "msg-1", subject: "s", from: m.from, at: "2031-01-01T00:00:00Z", mbox: "b-a" }), place: () => {} };
	expect(await offerMailDraft(m, deps)).toBe("offered");
	return { prompt: prompted(model.calls[0]!), check: checked(model.calls[1]!.user), id: listDrafts()[0]!.id };
}
const spec = { app: "mail", to: "A <a@example.com>", author: "A", text: mailFixture.body, postTitle: "글A" };
function riding() {
	const model = fakeModel([reply(BAD), reply(OK), reply(BAD), reply(OK)]);
	return { model, link: realMailLink({ call: model.call, run: async () => ({ code: 1, stdout: "", stderr: "" }) }) };
}
const composeOf = (link: ReturnType<typeof riding>["link"], body: string) => link.compose({ app: "mail", to: spec.to, subject: "글A 자료 보내드립니다", body, request: spec.text, postTitle: spec.postTitle });

describe("one rule bundle for every mail path", () => {
	test("mail auto draft", async () => {
		const r = await viaOffer();
		expect({ prompt: r.prompt, check: r.check }).toEqual({ prompt: SEEN, check: FULL });
	});
	test("riding mail, first write", async () => {
		const { model, link } = riding();
		expect(await link.write!(spec)).toBe(OK);
		expect({ prompt: prompted(model.calls[0]!), check: checked(model.calls[1]!.user) }).toEqual({ prompt: SEEN, check: FULL });
	});
	test("riding mail, revise", async () => {
		const { model, link } = riding();
		const made = await composeOf(link, (await link.write!(spec))!);
		if (!made.ok) throw new Error(made.reason);
		expect((await link.revise(made.id, "더 짧게")).ok).toBe(true);
		expect({ prompt: prompted(model.calls[2]!), check: checked(model.calls[3]!.user) }).toEqual({ prompt: SEEN, check: FULL });
	});
	test("compose check: the same bans, kept on the draft for the card and the gate", async () => {
		const made = await composeOf(riding().link, BAD);
		if (!made.ok) throw new Error(made.reason);
		expect(checked(getDraft(made.id)!.check!.warn.join("\n"))).toEqual(FULL);
		expect(checked(made.notes.join("\n"))).toEqual(FULL);
	});
	test("the attachment match reads the same on a mail auto draft and a riding mail", async () => {
		const auto = getDraft((await viaOffer()).id)!;
		const { link } = riding();
		const made = await composeOf(link, (await link.write!(spec))!);
		if (!made.ok) throw new Error(made.reason);
		const [a, b] = [auto, getDraft(made.id)!].map(d => draftAttachIssues({ ...d, check: { refuse: [], warn: [], judged: [] }, body: "자료를 첨부해 드려요." }));
		expect(a!.length).toBeGreaterThan(0);
		expect(a).toEqual(b);
	});
	test("pre-send check of an auto draft and of a riding mail", async () => {
		const auto = getDraft((await viaOffer()).id)!;
		const { link } = riding();
		const made = await composeOf(link, (await link.write!(spec))!);
		if (!made.ok) throw new Error(made.reason);
		const mine = getDraft(made.id)!;
		expect([auto, mine].map(d => checked(draftLintFailures({ ...d, body: BAD }).join("\n")))).toEqual([FULL, FULL]);
	});
	test("comment reply reads the app's file and the author's own", () => {
		tone(toneFile({ app: "youtube" }), `## 금지\n\n- ${APP}\n`);
		tone(toneFile({ app: "youtube", to: "UC-a" }), `## 금지\n\n- ${TO}\n`);
		const style = commentStyle({ key: "youtube" } as Parameters<typeof commentStyle>[0], "UC-a");
		expect([APP, TO].map(w => style.forbidden.includes(w))).toEqual([true, true]);
	});
});

// The mailbox is the one the account lists (custom/mailboxes.json), whether or not it has a tone file: b-b has none, yet a rule written at its scope is read for b-b only and a lesson for "this mailbox" lands there.
test("a mailbox without a tone file of its own reads and learns at its own scope", async () => {
	const LINE = "메일함B만 짧게 써요", SCOPE = { app: "mail", room: "b-b" };
	addRecord({ text: LINE, kind: "tone", scope: SCOPE, by: "test", at: new Date("2026-11-20T00:00:00.000Z") });
	const item = { kind: "mail", from: "Kim <a@example.org>", text: "일정 문의" } as const;
	const rulesIn = (box: string) => draftRules({ app: "mail", instance: "mail", box }, item);
	expect(rulesIn("b-b").style().rules).toContain(LINE);
	expect(rulesIn("base").style().rules).not.toContain(LINE);
	const learnt = await learn({ source: "chat", ref: "R1", keys: keysOf(rulesIn("b-b")), words: "끝인사는 짧게 써 줘", proposal: { scope: "channel" } }, { now: () => new Date("2026-11-21T00:00:00.000Z"), learnCall: () => async () => JSON.stringify({ replaces: [] }) });
	expect(learnt.scopeLabel).toBe("이 메일함");
	expect(readLedger().find(r => r.text.includes("끝인사는 짧게"))?.scope).toEqual(SCOPE);
});

// A `내용:` line of 금지 (content not to write): the style judge keeps a remark about it, the one rewrite leaves it, and then the card holds the draft for 이대로 보내기.
describe("a content ban in the tone files, on every path", () => {
	const CONTENT = "용도를 묻지 않기", ASKS = "어디에 쓰실 건가요? 확인해 보고 말씀드릴게요.";
	const WARN = `쓰지 않기로 한 내용이 들어 있어요: ${CONTENT}`;
	const judged = j({ violations: [{ rule: 1, about: "content", quote: "어디에 쓰실", why: "용도" }] });
	beforeEach(() => tone(toneFile({ app: "mail" }), `## 예시\n\n- 네 보내드렸어요\n\n## 금지\n\n- 내용: ${CONTENT}\n`));

	test("mail auto draft: one rewrite, the ban still there: the card says 확인: and offers 이대로 보내기", async () => {
		const model = fakeModel([reply(ASKS), judged, reply(ASKS), judged]);
		const cards: string[] = [];
		const m = { ...mailFixture, key: "dp-2", from: "A <a@example.com>" };
		const deps = { send: (_target: string, text: string) => void cards.push(text), log: () => {}, call: model.call, mailOf: (key: string) => ({ key, source: "zele", id: "msg-2", subject: "s", from: m.from, at: "2031-01-01T00:00:00Z", mbox: "b-a" }), place: () => {} };
		expect(await offerMailDraft(m, deps)).toBe("offered");
		expect(model.calls).toHaveLength(4);
		expect(cards[0]).toContain(`확인: ${WARN}`);
		expect(cards[0]).toContain(DRAFT_AS_IS);
		expect(listDrafts()[0]!.check?.warn).toEqual([WARN]);
	});

	test("riding mail: its first write is judged, the warning reaches the reply card's notes and the gate that asks for 이대로 보내기", async () => {
		const model = fakeModel([reply(ASKS), judged, reply(ASKS), judged]);
		const link = realMailLink({ call: model.call, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
		const body = await link.write!(spec);
		expect(model.calls).toHaveLength(4);
		const made = await composeOf(link, body!);
		if (!made.ok) throw new Error(made.reason);
		expect(model.calls).toHaveLength(4);
		expect(made.notes).toContain(`확인: ${WARN}`);
		expect(getDraft(made.id)!.check?.warn).toEqual([WARN]);
		expect(link.issues!(made.id)).toContain(WARN);
	});
});
