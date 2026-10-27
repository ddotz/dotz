import { afterAll, expect, test } from "bun:test";
import { addDraft, getDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import type { Notice } from "./notices.ts";

// 3) 보내지 않기 on a mail reply draft's card drops the draft in its store at once; any other pick, or another kind of ref, leaves it.
const env = setupEnv();
afterAll(env.cleanup);
const { dropAnsweredMailDraft } = await import("./draft-drop.ts");

const rec = (id: string): DraftRec => ({ id, kind: "mail", app: "mail", source: "kdb", mailId: "1", ref: `kdb-${id}`, to: "a@b.co", body: "본문", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: "a@b.co", text: "x" } });
const card = (ref: string) => ({ id: "n1", decision: { draft: { ref }, options: [{ n: 1, label: "보내기" }, { n: 2, label: "고치기" }, { n: 3, label: "보내지 않기" }] } }) as unknown as Notice;

test("보내지 않기 drops the mail draft; 보내기 and 고치기 leave it to their own paths; a kakao code is not touched", async () => {
	addDraft(rec("RAAAAA2"));
	addDraft(rec("RBBBBB2"));
	await dropAnsweredMailDraft(card("RAAAAA2"), 3);
	await dropAnsweredMailDraft(card("RBBBBB2"), 1);
	await dropAnsweredMailDraft(card("RBBBBB2"), 2);
	await dropAnsweredMailDraft(card("KJDJF"), 3);
	expect([getDraft("RAAAAA2")!.status, getDraft("RBBBBB2")!.status]).toEqual(["dropped", "pending"]);
});
