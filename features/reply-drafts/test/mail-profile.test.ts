// A mail of a second mail app (instance `mail-beta`) is written, revised and checked with that app's own tone profile when it has one,
// and never carries the examples of another account. Without its own profile it uses the shared `mail` profile, as before.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toneKey, reviseDraft, sendDraft } from "../lib/flow.ts";
import { offerMailDraft, type OfferMail } from "../lib/offer.ts";
import { savePairs } from "../lib/pairs.ts";
import { paths, toneFile, writeIdentity } from "../lib/settings.ts";
import { listDrafts } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(() => env.cleanup());
beforeEach(() => {
	for (const p of [paths.config(), paths.toneDir(), paths.drafts(), paths.inbox(), paths.pairs("mail"), join(env.dir, "draft-files"), join(env.dir, "custom", "apps.json")]) rmSync(p, { force: true, recursive: true });
	enable(env);
	mkdirSync(join(env.dir, "custom"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ "mail-beta": { app: "mail", label: "베타 메일", filter: { conv: ["mail:beta-"] } } }));
	writeIdentity({ app: "mail" }, ["ALPHA-IDENTITY 해요체"]);
});

const mail = (key: string): OfferMail => ({ ...mailFixture, key, id: key, body: `body of ${key}` });
const own = () => writeIdentity({ app: "mail-beta" }, ["BETA-IDENTITY 합쇼체"]);
const offer = (keys: string[], model = fakeModel([j(goodReply)])) => Promise.all(keys.map(k => offerMailDraft(mail(k), { send: () => {}, call: model.call, log: () => {} })));
const promptOf = (model: ReturnType<typeof fakeModel>, key: string) => model.calls.filter(c => c.user.includes(`body of ${key}`)).map(c => c.system + c.user).join("\n");

test("two mails offered at once are each written with only their own app's identity", async () => {
	own();
	const model = fakeModel([j(goodReply)]);
	expect(await offer(["m-1", "beta-1"], model)).toEqual(["offered", "offered"]);
	expect(promptOf(model, "beta-1")).toContain("BETA-IDENTITY");
	expect(promptOf(model, "beta-1")).not.toContain("ALPHA-IDENTITY");
	expect(promptOf(model, "m-1")).toContain("ALPHA-IDENTITY");
	expect(promptOf(model, "m-1")).not.toContain("BETA-IDENTITY");
});

test("the stored draft keeps app mail and names its own profile only when the app has one", async () => {
	own();
	await offer(["m-1", "beta-1"]);
	const recs = listDrafts();
	expect(recs.map(r => [r.ref, r.app, r.profile])).toEqual(expect.arrayContaining([["m-1", "mail", undefined], ["beta-1", "mail", "mail-beta"]]));
	expect(toneKey(recs.find(r => r.ref === "beta-1")!)).toEqual({ app: "mail-beta" });
	expect(toneKey(recs.find(r => r.ref === "m-1")!)).toEqual({ app: "mail" });
});

test("a mail app without its own profile keeps using the shared mail profile", async () => {
	const model = fakeModel([j(goodReply)]);
	await offer(["beta-1"], model);
	expect(promptOf(model, "beta-1")).toContain("ALPHA-IDENTITY");
	expect(listDrafts()[0]!.profile).toBeUndefined();
});

test("a revise reads the draft's profile and its correction is recorded there, not in the shared profile", async () => {
	own();
	await offer(["beta-1"]);
	const rec = listDrafts()[0]!;
	const model = fakeModel([j({ ...goodReply, lesson: "항상 짧게" })]);
	expect((await reviseDraft(rec.id, "더 짧게", { call: model.call })).ok).toBe(true);
	expect(model.calls[0]!.system + model.calls[0]!.user).toContain("BETA-IDENTITY");
	expect(model.calls[0]!.system + model.calls[0]!.user).not.toContain("ALPHA-IDENTITY");
	expect(readFileSync(toneFile({ app: "mail-beta" }), "utf8")).toContain("항상 짧게");
	expect(readFileSync(toneFile({ app: "mail" }), "utf8")).not.toContain("항상 짧게");
	expect(listDrafts().find(r => r.status === "pending")!.profile).toBe("mail-beta");
});

test("the send-time check uses the draft's profile: a word forbidden in mail-beta stops only its drafts", async () => {
	own();
	writeFileSync(toneFile({ app: "mail-beta" }), `${readFileSync(toneFile({ app: "mail-beta" }), "utf8")}\n## 금지\n- FORBID-BETA\n`);
	const model = fakeModel([j({ ...goodReply, body: "확인했어요 FORBID-BETA" })]);
	await offer(["m-1", "beta-1"], model);
	const byRef = (ref: string) => listDrafts().find(r => r.ref === ref)!;
	const send = async () => ({ ok: true as const });
	const beta = await sendDraft(byRef("beta-1").id, { send }, { withReply: true });
	expect(beta.ok).toBe(false);
	expect(beta.text).toContain("FORBID-BETA");
	expect((await sendDraft(byRef("m-1").id, { send }, { withReply: true })).ok).toBe(true);
});

test("a draft with its own profile carries no past replies, since a pair does not say which account it came from", async () => {
	own();
	savePairs("mail", [{ received: "body of x 회의 일정", reply: "PAIR-REPLY-TEXT", at: 1 }]);
	const model = fakeModel([j(goodReply)]);
	await offer(["m-1", "beta-1"], model);
	expect(promptOf(model, "m-1")).toContain("PAIR-REPLY-TEXT");
	expect(promptOf(model, "beta-1")).not.toContain("PAIR-REPLY-TEXT");
});
