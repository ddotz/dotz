// A claim left by a sender that died may have sent the mail already (the mailbox accepted it, `setStatus("sent")` never ran): a replayed answer must not send again.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runDraft } from "../bin/draft.ts";
import { sendDraft } from "../lib/flow.ts";
import { paths } from "../lib/settings.ts";
import { addDraft, claimFile, getDraft, type DraftRec } from "../lib/store.ts";
import { pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), claimFile("RDEAD1")]) rmSync(p, { force: true, recursive: true });
});

const draft = (): DraftRec =>
	({ id: "RDEAD1", kind: "mail", app: "mail", source: "zele", mailId: "m1", ref: "k1", to: "kim@example.com", subject: "Re: 문의", body: "확인해 보고 말씀드릴게요.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { text: "문의드립니다", from: "Kim <kim@example.com>" } }) as unknown as DraftRec;

async function deadClaim(): Promise<void> {
	const gone = Bun.spawn([process.execPath, "-e", "0"]);
	await gone.exited;
	mkdirSync(dirname(claimFile("RDEAD1")), { recursive: true });
	writeFileSync(claimFile("RDEAD1"), String(gone.pid));
}

test("a draft whose sender died mid-send is not sent again unless the owner retries", async () => {
	addDraft(draft());
	pick(env, "RDEAD1", 1);
	await deadClaim();
	let sends = 0;
	const send = async () => (sends++, { ok: true as const, message: "보냈어요" });
	const refused = await sendDraft("RDEAD1", { send });
	expect(refused.ok).toBe(false);
	expect(refused.text).toContain("나갔을 수");
	expect(sends).toBe(0);
	expect(getDraft("RDEAD1")?.status).toBe("pending");
	const retried = await sendDraft("RDEAD1", { send }, { retry: true });
	expect(retried.ok).toBe(true);
	expect(sends).toBe(1);
	expect(getDraft("RDEAD1")?.status).toBe("sent");
});

test("draft.ts send takes the owner's retry only from --retry", async () => {
	addDraft(draft());
	pick(env, "RDEAD1", 1);
	await deadClaim();
	let sends = 0;
	const send = async () => (sends++, { ok: true as const, message: "보냈어요" });
	expect((await runDraft(["send", "RDEAD1"], "", { send })).code).toBe(1);
	expect(sends).toBe(0);
	expect((await runDraft(["send", "RDEAD1", "--retry"], "", { send })).code).toBe(0);
	expect(sends).toBe(1);
});
