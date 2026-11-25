import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { advance, flush } from "../../../hub/runtime/test-clock.ts";
import { offerMailDraft, requestMailDraft } from "../lib/offer.ts";
import { replyRecipients } from "../lib/recipients.ts";
import { paths } from "../lib/settings.ts";
import { getDraft, listDrafts } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
	enable(env);
});

const relay = { ...mailFixture, key: "rt-1", id: "rt-1", from: "Forms <forms@relay.example>", replyTo: "Person <person@example.com>" };
const deps = (call: ReturnType<typeof fakeModel>["call"]) => ({ send: () => {}, call, log: () => {} });

describe("Reply-To reaches the draft", () => {
	test("a model that answers the relay is moved to the Reply-To person", async () => {
		const model = fakeModel([j({ ...goodReply, to: "forms@relay.example" })]);
		expect(await offerMailDraft(relay, deps(model.call))).toBe("offered");
		const draft = listDrafts().find(d => d.ref === "rt-1")!;
		expect(draft.to).toBe("person@example.com");
		expect(draft.item.replyTo).toBe("Person <person@example.com>");
		expect(draft.item.from).toBe("Forms <forms@relay.example>");
	});

	test("an owner-requested draft goes to the Reply-To person too", async () => {
		const model = fakeModel([j({ ...goodReply, to: "person@example.com" })]);
		expect(await requestMailDraft(relay, deps(model.call))).toBe("offered");
		expect(getDraft(listDrafts().find(d => d.ref === "rt-1")!.id)?.to).toBe("person@example.com");
	});
});

describe("Reply-To read at draft time", () => {
	const zele = { ...mailFixture, key: "rt-2", id: "rt-2", messageId: "1|", from: "Forms <forms@relay.example>" };

	test("a zele mail without one asks deps.replyTo and the draft goes to that person", async () => {
		const asked: string[] = [];
		const model = fakeModel([j({ ...goodReply, to: "forms@relay.example" })]);
		const replyTo = async (m: { id: string }) => (asked.push(m.id), { from: "forms@relay.example", replyTo: "person@example.com" });
		expect(await offerMailDraft(zele, { ...deps(model.call), replyTo })).toBe("offered");
		expect(asked).toEqual(["rt-2"]);
		const draft = listDrafts().find(d => d.ref === "rt-2")!;
		expect(draft.item.replyTo).toBe("person@example.com");
		expect(draft.to).toBe("person@example.com");
	});

	test("a mail that came with one is not asked", async () => {
		const asked: string[] = [];
		const model = fakeModel([j({ ...goodReply, to: "forms@relay.example" })]);
		const replyTo = async (m: { id: string }) => (asked.push(m.id), { from: "forms@relay.example", replyTo: "other@example.com" });
		await offerMailDraft({ ...zele, replyTo: "Person <person@example.com>" }, { ...deps(model.call), replyTo });
		expect(asked).toEqual([]);
		expect(listDrafts().find(d => d.ref === "rt-2")!.item.replyTo).toBe("Person <person@example.com>");
	});

	test("a mail of another source is not asked", async () => {
		const asked: string[] = [];
		const model = fakeModel([j({ ...goodReply, to: "forms@relay.example" })]);
		await offerMailDraft({ ...zele, source: "api" }, { ...deps(model.call), replyTo: async m => (asked.push(m.id), { from: "forms@relay.example", replyTo: "other@example.com" }) });
		expect(asked).toEqual([]);
	});

	test("a read that fails or has no answer leaves the reply with the sender", async () => {
		const lines: string[] = [];
		const model = fakeModel([j({ ...goodReply, to: "forms@relay.example" })]);
		const failing = async () => { throw new Error("timed out"); };
		await offerMailDraft(zele, { ...deps(model.call), log: l => void lines.push(l), replyTo: failing });
		const draft = listDrafts().find(d => d.ref === "rt-2")!;
		expect(draft.item.replyTo).toBeUndefined();
		expect(draft.to).toBe("forms@relay.example");
		expect(lines.filter(l => l.includes("Reply-To not read"))).toHaveLength(1);
	});

	test("an owner-requested draft asks too", async () => {
		const model = fakeModel([j({ ...goodReply, to: "person@example.com" })]);
		await requestMailDraft({ ...zele, key: "rt-3", id: "rt-3" }, { ...deps(model.call), replyTo: async () => ({ from: "forms@relay.example", replyTo: "person@example.com" }) });
		expect(listDrafts().find(d => d.ref === "rt-3")!.to).toBe("person@example.com");
	});

	test("the Reply-To of the thread's first message from another sender than the mail's is not used", async () => {
		const model = fakeModel([j({ ...goodReply, to: "lee@example.com" })]);
		const first = async () => ({ from: "forms@relay.example", replyTo: "kim-assistant@example.com" });
		await offerMailDraft({ ...zele, key: "rt-4", id: "rt-4", from: "Lee <lee@example.com>" }, { ...deps(model.call), replyTo: first });
		const draft = listDrafts().find(d => d.ref === "rt-4")!;
		expect(draft.item.replyTo).toBeUndefined();
		expect(draft.to).toBe("lee@example.com");
	});

	test("a first message without a From gives no Reply-To either", async () => {
		const model = fakeModel([j({ ...goodReply, to: "forms@relay.example" })]);
		await offerMailDraft({ ...zele, key: "rt-5", id: "rt-5" }, { ...deps(model.call), replyTo: async () => ({ replyTo: "person@example.com" }) });
		expect(listDrafts().find(d => d.ref === "rt-5")!.item.replyTo).toBeUndefined();
	});

	test("a mail that precheck skips does not wait for the lookup", async () => {
		const asked: string[] = [];
		const model = fakeModel([j({ ...goodReply })]);
		const never = (m: { id: string }) => (asked.push(m.id), new Promise<undefined>(() => {}));
		expect(await offerMailDraft({ ...zele, key: "rt-6", id: "rt-6", from: "Forms Desk" }, { ...deps(model.call), replyTo: never })).toBe("skipped");
		expect(asked).toEqual(["rt-6"]);
	});

	test("a later message of the thread is not asked: the raw read shows only the first message", async () => {
		const asked: string[] = [];
		const model = fakeModel([j({ ...goodReply, to: "forms@relay.example" })]);
		const replyTo = async (m: { id: string }) => (asked.push(m.id), { from: "forms@relay.example", replyTo: "persona@example.com" });
		await offerMailDraft({ ...zele, key: "rt-9", id: "rt-9", messageId: "2|" }, { ...deps(model.call), replyTo });
		expect(asked).toEqual([]);
		const draft = listDrafts().find(d => d.ref === "rt-9")!;
		expect(draft.item.replyTo).toBeUndefined();
		expect(draft.to).toBe("forms@relay.example");
	});

	test("a lookup that never answers holds the draft only for the history wait", async () => {
		const model = fakeModel([j({ ...goodReply, to: "forms@relay.example" })]);
		const never = () => new Promise<undefined>(() => {});
		const offered = offerMailDraft({ ...zele, key: "rt-10", id: "rt-10" }, { ...deps(model.call), replyTo: never });
		await flush();
		await advance(8000);
		expect(await offered).toBe("offered");
		expect(listDrafts().find(d => d.ref === "rt-10")!.to).toBe("forms@relay.example");
	});
});

describe("a Reply-To the reply must not follow", () => {
	const own = { ...relay, key: "rt-7", id: "rt-7", from: "Lee <lee@example.com>", to: "Me <me@example.net>", replyTo: "Me <me@example.net>" };

	test("the owner's own address is ignored, in the draft and in 답장 / 전체 답장", async () => {
		const model = fakeModel([j({ ...goodReply, to: "lee@example.com" })]);
		await offerMailDraft(own, deps(model.call));
		const draft = listDrafts().find(d => d.ref === "rt-7")!;
		expect(draft.item.replyTo).toBeUndefined();
		expect(draft.to).toBe("lee@example.com");
		const sets = replyRecipients({ sender: own.from, replyTo: own.replyTo, to: "Me <me@example.net>, Park <park@example.com>", self: ["me@example.net"] });
		expect(sets.reply).toEqual({ to: ["lee@example.com"], cc: [] });
		expect(sets.all).toEqual({ to: ["lee@example.com", "park@example.com"], cc: [] });
	});

	test("an automated address is ignored, in the draft and in 답장 / 전체 답장", async () => {
		const model = fakeModel([j({ ...goodReply, to: "noreply@example.com" })]);
		await offerMailDraft({ ...own, key: "rt-8", id: "rt-8", to: "me@example.net", replyTo: "noreply@example.com" }, deps(model.call));
		const draft = listDrafts().find(d => d.ref === "rt-8")!;
		expect(draft.item.replyTo).toBeUndefined();
		expect(draft.to).toBe("lee@example.com");
		expect(replyRecipients({ sender: own.from, replyTo: "No Reply <noreply@example.com>", to: "me@example.net", self: ["me@example.net"] }).reply).toEqual({ to: ["lee@example.com"], cc: [] });
	});
});

describe("답장 and 전체 답장 follow the Reply-To", () => {
	const mail = { sender: "Forms <forms@relay.example>", replyTo: "Person <person@example.com>", to: "Me <me@example.net>, Lee <lee@example.com>", cc: "Park <park@example.com>", self: ["me@example.net"] };

	test("답장 goes to the Reply-To person alone", () => {
		expect(replyRecipients(mail).reply).toEqual({ to: ["person@example.com"], cc: [] });
	});

	test("전체 답장 adds the original's 받는 사람·참조 to the person, never the relay", () => {
		expect(replyRecipients(mail).all).toEqual({ to: ["person@example.com", "lee@example.com"], cc: ["park@example.com"] });
	});

	test("no Reply-To: the sender, as before", () => {
		expect(replyRecipients({ ...mail, replyTo: undefined }).reply).toEqual({ to: ["forms@relay.example"], cc: [] });
	});
});
