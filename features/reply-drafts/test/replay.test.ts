import { afterAll, beforeEach, expect, test } from "bun:test";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runDraft } from "../bin/draft.ts";
import { replay, sendOf } from "../lib/replay.ts";
import { paths } from "../lib/settings.ts";
import { addDraft, type DraftRec, listDrafts } from "../lib/store.ts";
import { enable, fakeModel, j, mailFixture, seedRules, setupEnv } from "./helpers.ts";

// A recorded case runs draft -> revise -> the pre-send check on a scratch copy of the data dir; nothing real is written and nothing is sent. Anonymous fixture text.
const env = setupEnv();
afterAll(env.cleanup);
const ID = "RAAAAAA";
const reply = (body: string) => j({ action: "draft", reason: "asks", to: "kim@example.com", subject: "Re: 회의 일정 문의", body, questions: [] });
const judge = () => fakeModel(["{\"violations\":[]}"]).call;
const FIRST = "확인해 보고 말씀드릴게요.", SECOND = "다음 주 화요일 오후가 좋아요.";
const rec = (): DraftRec =>
	({ id: ID, kind: "mail", app: "mail", source: "zele", mailId: mailFixture.id, ref: mailFixture.key, to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "옛 초안이에요.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", app: "mail", from: mailFixture.from, subject: mailFixture.subject, text: mailFixture.body } }) as DraftRec;

beforeEach(() => {
	enable(env);
	if (!listDrafts().length) {
		seedRules({ app: "mail" }, { tone: ["짧게 써요"] });
		addDraft(rec());
	}
});

const tree = (dir: string): Record<string, string> =>
	Object.fromEntries((readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[]).filter(e => e.isFile()).map(e => join(e.parentPath, e.name)).sort().map(f => [relative(dir, f), `${statSync(f).size}:${readFileSync(f, "utf8")}`]));

test("runs the draft, the revise and the check on a scratch copy, never sends, and leaves the real files byte for byte", async () => {
	const before = tree(env.dir);
	expect(Object.keys(before)).toContain(relative(env.dir, paths.drafts()));
	expect(Object.keys(before)).toContain(relative(env.dir, paths.ledger()));
	const model = fakeModel([reply(FIRST), reply(SECOND)]);
	const sends: DraftRec[] = [];
	const r = await replay(ID, "화요일로 바꿔 주세요", { call: model.call, judge: judge(), send: async d => (sends.push(d), { sent: "yes" }) as never });
	expect(r.ok).toBe(true);
	expect(model.calls.length).toBe(2);
	expect(model.calls[1]!.user).toContain("화요일로 바꿔 주세요");
	expect(r.draft).toContain(FIRST);
	expect(r.revised).toContain(SECOND);
	expect(r.check).toEqual({ refuse: [], warn: [], judged: [] });
	expect(sends.length).toBe(0);
	expect(tree(env.dir)).toEqual(before);
	expect(process.env.DOTZ_DIR).toBe(env.dir);
});

test("a send that is reached anyway throws instead of going out", async () => {
	const seen: DraftRec[] = [];
	await expect(sendOf({ send: async d => (seen.push(d), { sent: "yes" }) as never })(rec())).rejects.toThrow("replay never sends");
	expect(seen.length).toBe(1);
});

test("a draft that is not in the store is told, not made up", async () => {
	const model = fakeModel([reply(FIRST)]);
	const r = await replay("RZZZZZZ", undefined, { call: model.call });
	expect(r.ok).toBe(false);
	expect(r.lines.join("\n")).toContain("RZZZZZZ");
	expect(model.calls.length).toBe(0);
});

test("`draft.ts replay <ref>` prints each stage and the check result, or the same as json", async () => {
	const out = await runDraft(["replay", ID, "--change", "화요일로 바꿔 주세요"], "", { call: fakeModel([reply(FIRST), reply(SECOND)]).call, judge: judge() });
	expect(out.code).toBe(0);
	const text = out.lines.join("\n");
	expect(text).toContain(FIRST);
	expect(text).toContain(SECOND);
	expect(text).toContain("발송 직전 검사");
	const json = await runDraft(["replay", ID, "--json"], "", { call: fakeModel([reply(FIRST), reply(SECOND)]).call, judge: judge() });
	expect(Object.keys(JSON.parse(json.lines.join("\n")))).toEqual(expect.arrayContaining(["draft", "revised", "check"]));
});
