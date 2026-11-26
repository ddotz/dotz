import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dropAnsweredMailDraft } from "../../../hub/draft-drop.ts";
import { commentStyle } from "../../../hub/comments/real.ts";
import { commentsDir, createStore } from "../../../hub/comments/store.ts";
import type { SourceConfig } from "../../../hub/comments/contract.ts";
import { dropDraft, learningSettled, learnLine, recordForbidden, sendDraft } from "../lib/flow.ts";
import { draftRules } from "../lib/draft-rules.ts";
import { dataDir, HEADINGS, loadPairs, loadStyle, ownToneMailApps, paths, profileBullets } from "../lib/settings.ts";
import { addDraft, type DraftRec, getDraft, newId } from "../lib/store.ts";
import { enable, pick, setupEnv } from "./helpers.ts";

// How a lesson reaches the drafts that read it: a mail app file with only lessons, every learning path into the mail app's own-tone files,
// a mail that rode on a comment reply as a past reply, a 보내지 않기 reason, and a site's DM tone file.
const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.toneDir(), paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "custom", "reply-drafts", "pairs"), join(env.dir, "custom", "apps.json"), commentsDir(dataDir())]) rmSync(p, { force: true, recursive: true });
});

const profile = (file: string, md: string) => {
	mkdirSync(paths.toneDir(), { recursive: true });
	writeFileSync(join(paths.toneDir(), file), md);
};
const apps = (...ids: string[]) => writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify(Object.fromEntries(ids.map(id => [id, { app: "mail" }]))));
const now = () => new Date("2030-03-04T09:00:00Z");
const MAIL = "## 정체성\n- MAIL-IDENTITY\n\n## 예시\n- MAIL-SAMPLE\n\n## 고친 점\n- 2030-01-01: MAIL-CORRECTION\n";
const item = { kind: "mail" as const, from: "Kim <kim@example.com>" };
const draft = (extra: Partial<DraftRec> = {}): DraftRec => {
	const id = newId();
	const rec: DraftRec = { id, kind: "mail", app: "mail", source: "zele", mailId: `m-${id}`, ref: `ref-${id}`, to: "kim@example.com", subject: "Re: 문의", body: "확인했습니다.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", from: "kim@example.com", text: "문의드립니다" } as never, ...extra };
	addDraft(rec);
	return rec;
};

test("a mail app file with only corrections adds them to the shared mail tone of its drafts, and a lesson for the mail app reaches it", async () => {
	profile("mail.md", MAIL);
	profile("mail-beta.md", "## 고친 점\n- 2030-02-01: BETA-CORRECTION\n");
	apps("mail-beta");
	const style = draftRules({ app: "mail-beta" }, item).style();
	expect(style.identity).toEqual(["MAIL-IDENTITY"]);
	expect(style.samples).toEqual(["MAIL-SAMPLE"]);
	expect(style.corrections).toEqual(["2030-01-01: MAIL-CORRECTION", "2030-02-01: BETA-CORRECTION"]);
	expect(ownToneMailApps()).toEqual(["mail-beta"]);
	await learnLine({ app: "mail" }, "인사는 뺀다", "correction", { now });
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.corrections)).toEqual(["2030-02-01: BETA-CORRECTION", "2030-03-04: 인사는 뺀다"]);
});

test("a mail app with its own tone is one of the app list: a tone file of a mail app that is not in it gets no copy of a mail-wide lesson", async () => {
	profile("mail.md", MAIL);
	profile("mail-beta.md", "## 고친 점\n- 2030-02-01: BETA-CORRECTION\n");
	profile("mail-ghost.md", "## 고친 점\n- 2030-02-02: GHOST-CORRECTION\n");
	apps("mail-beta");
	expect(ownToneMailApps()).toEqual(["mail-beta"]);
	await learnLine({ app: "mail" }, "인사는 뺀다", "correction", { now });
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.corrections)).toEqual(["2030-02-01: BETA-CORRECTION", "2030-03-04: 인사는 뺀다"]);
	expect(profileBullets({ app: "mail-ghost" }, HEADINGS.corrections)).toEqual(["2030-02-02: GHOST-CORRECTION"]);
});

test("every learning path for the mail app (the shared learnLine and forbidden wordings) also learns into a mail app with its own tone", async () => {
	profile("mail.md", MAIL);
	profile("mail-beta.md", "## 정체성\n- BETA-IDENTITY\n");
	apps("mail-beta");
	const learned = await learnLine({ app: "mail" }, "답장은 짧게", "rule", { now });
	expect(learned.also?.map(a => [a.app, a.stored])).toEqual([["mail-beta", true]]);
	recordForbidden({ app: "mail" }, ["확인 부탁드립니다"]);
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.rules)).toEqual(["답장은 짧게"]);
	expect(profileBullets({ app: "mail-beta" }, HEADINGS.forbidden)).toEqual(["확인 부탁드립니다"]);
	// A lesson of one mail app stays in it.
	await learnLine({ app: "mail-beta" }, "베타만", "rule", { now });
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["답장은 짧게"]);
});

test("a changed mail that rode on a comment reply becomes a past reply to that comment, tagged with its comment source", async () => {
	enable(env);
	const rec = draft({ compose: true, body: "말씀 감사합니다. 곧 연락드릴게요.", changes: ["더 짧게"], item: { kind: "mail", app: "mail", from: "kim@example.com", text: "말씀 감사합니다. 곧 연락드릴게요." } as never });
	const store = createStore(commentsDir(dataDir()));
	store.addComments([{ id: "c-1", source: "site-shop", native: "n1", mine: false, collector: "m", thread: "post-1", author: "Kim", text: "자료 받을 수 있을까요?", postTitle: "post", at: 1 }]);
	store.putDraft({ code: "C1", commentId: "c-1", source: "site-shop", thread: "post-1", text: "메일로 보내드릴게요", status: "pending", created: 1, changes: [], clean: true, notes: [], mail: rec.id });
	const r = await sendDraft(rec.id, { send: async () => ({ ok: true, message: "보냈어요" }) }, { withReply: true, learn: false });
	expect(r.ok).toBe(true);
	expect(loadPairs("mail").map(p => [p.received, p.reply, p.via])).toEqual([["자료 받을 수 있을까요?", "말씀 감사합니다. 곧 연락드릴게요.", "comment:site-shop"]]);
});

test("보내지 않기 with a reason learns it as a correction of the draft's tone; without a reason nothing is learned", async () => {
	enable(env);
	profile("mail.md", MAIL);
	const quiet = draft();
	expect(dropDraft(quiet.id).ok).toBe(true);
	const withReason = draft();
	expect(dropDraft(withReason.id, { reason: "광고 메일에는 답하지 않는다", deps: { now } }).ok).toBe(true);
	await learningSettled();
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual(["2030-01-01: MAIL-CORRECTION", "2030-03-04: 보내지 않은 초안 - 광고 메일에는 답하지 않는다"]);
	// The owner's pick on the card: "3) 보내지 않기 - <reason>" reaches the send, which drops and learns it.
	const picked = draft();
	pick(env, picked.id, 3, "회신이 필요 없는 공지");
	expect((await sendDraft(picked.id, { now })).ok).toBe(false);
	await learningSettled();
	expect(getDraft(picked.id)?.status).toBe("dropped");
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections).at(-1)).toBe("2030-03-04: 보내지 않은 초안 - 회신이 필요 없는 공지");
	// The web card's free-text note with 보내지 않기.
	const noted = draft();
	await dropAnsweredMailDraft({ decision: { draft: { ref: noted.id }, options: [{ n: 3, label: "보내지 않기" }] } } as never, 3, undefined, "스팸", () => ({ now }));
	await learningSettled();
	expect(getDraft(noted.id)?.status).toBe("dropped");
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections).at(-1)).toBe("2030-03-04: 보내지 않은 초안 - 스팸");
});

test("a site's DM reply reads its DM tone file on top of the site's tone; a comment reply does not", () => {
	profile("site-shop.md", "## 정체성\n- SITE-IDENTITY\n\n## 말투\n- 댓글은 짧게\n");
	profile("site-shop-dm.md", "## 말투\n- 쪽지는 존댓말로 길게\n");
	const src = { key: "site-shop", kind: "website", label: "w", watch: ["*"], autoDraft: false } as SourceConfig;
	const dm = commentStyle(src, undefined, "dm:r9");
	expect(dm.identity).toEqual(["SITE-IDENTITY"]);
	expect(dm.rules).toEqual(["댓글은 짧게", "쪽지는 존댓말로 길게"]);
	expect(commentStyle(src, undefined, "post-1").rules).toEqual(["댓글은 짧게"]);
});
