// A claim left by a sender that died may have sent the mail already (the mailbox accepted it, `setStatus("sent")` never ran): a replayed answer must not send again.
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claimSend } from "../../../hub/draft-claim.ts";
import { outcomeOf } from "../../../hub/approval-send.ts";
import { runDraft } from "../bin/draft.ts";
import { sendDraft } from "../lib/flow.ts";
import { paths } from "../lib/settings.ts";
import { addDraft, claimFile, getDraft, type DraftRec } from "../lib/store.ts";
import { pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	// The claim and the approval its last run went under (hub/draft-claim.ts claimToken): each test starts with neither.
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), claimFile("RDEAD1"), `${claimFile("RDEAD1")}.token`]) rmSync(p, { force: true, recursive: true });
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

test("a mail that left but whose status could not be saved is reported sent and never goes out twice", async () => {
	addDraft(draft());
	pick(env, "RDEAD1", 1);
	const dir = dirname(paths.drafts());
	let sends = 0;
	const send = async () => {
		sends++;
		chmodSync(dir, 0o500);
		return { ok: true as const, message: "보냈어요" };
	};
	const told: string[] = [];
	try {
		const first = await sendDraft("RDEAD1", { send, onOutcome: o => void told.push(o.sent) });
		expect(first.ok).toBe(true);
	} finally {
		chmodSync(dir, 0o700);
	}
	expect(told).toEqual(["yes"]);
	const second = await sendDraft("RDEAD1", { send });
	expect(second.ok).toBe(false);
	expect(sends).toBe(1);
});

test("the loser of two senders of one draft is told it is surely not sent, never that it may have gone out", async () => {
	addDraft(draft());
	pick(env, "RDEAD1", 1);
	let open!: () => void;
	const gate = new Promise<void>(r => (open = r));
	let sends = 0;
	const send = async () => (sends++, await gate, { ok: true as const, message: "보냈어요" });
	const first = sendDraft("RDEAD1", { send });
	const second = sendDraft("RDEAD1", { send });
	const results = [await Promise.race([first.then(r => ({ who: "first", r })), second.then(r => ({ who: "second", r }))])];
	open();
	const [a, b] = [await first, await second];
	const loser = a.ok ? b : a;
	expect(results[0]!.r.ok).toBe(false);
	expect(sends).toBe(1);
	expect(loser).toMatchObject({ ok: false, sent: "no", code: "already_sending" });
});

test("draft.ts send beside a live sender says so as a definite no under the gateway", async () => {
	addDraft(draft());
	pick(env, "RDEAD1", 1);
	const release = claimSend(claimFile("RDEAD1"))!;
	process.env.DOTZ_GATEWAY_SEND = "1";
	const log = spyOn(console, "log").mockImplementation(() => undefined);
	let sends = 0;
	try {
		const r = await runDraft(["send", "RDEAD1"], "", { send: async () => (sends++, { ok: true as const, message: "" }) });
		const printed = log.mock.calls.map(x => String(x[0])).join("\n");
		expect(sends).toBe(0);
		expect(outcomeOf({ code: r.code, out: `${printed}\n${r.lines.join("\n")}` })).toMatchObject({ sent: "no", code: "already_sending" });
	} finally {
		log.mockRestore();
		delete process.env.DOTZ_GATEWAY_SEND;
		release();
	}
});

test("an address-less draft whose first send failed is not refused as changed on the retry", async () => {
	addDraft({ ...draft(), to: "Kim" });
	pick(env, "RDEAD1", 1);
	const first = await sendDraft("RDEAD1", { send: async () => ({ ok: false as const, message: "offline", sent: "no" as const, code: "offline" }) });
	expect(first.ok).toBe(false);
	let sends = 0;
	const second = await sendDraft("RDEAD1", { send: async () => (sends++, { ok: true as const, message: "보냈어요" }) });
	expect(second.code).not.toBe("changed");
	expect(second.ok).toBe(true);
	expect(sends).toBe(1);
	expect(getDraft("RDEAD1")?.to).toBe("Kim <kim@example.com>");
});
