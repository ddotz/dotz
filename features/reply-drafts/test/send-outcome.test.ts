// Every way a mail send ends says where the mail is (design 1.5, 2.3): sent, surely not sent with a reason code, or may have gone out.
// Drives sendWith with a fake tool runner through the mail and webmail rows, then sendDraft's own gate and the CLI's DOTZ_SEND line.
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDraft } from "../bin/draft.ts";
import { sendDraft, type Outcome } from "../lib/flow.ts";
import { sendWith } from "../lib/senders.ts";
import { paths } from "../lib/settings.ts";
import { addStagedFile } from "../lib/staged.ts";
import { addDraft, getDraft, type DraftRec } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), join(env.dir, "custom", "reply-drafts", "sending")]) rmSync(p, { force: true, recursive: true });
	mkdirSync(join(env.dir, "custom", "webmail", "corp"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "webmail", "corp", "spec.json"), "{}");
});

const rec = (o: Partial<DraftRec> = {}): DraftRec =>
	({ id: "ROUT01", kind: "mail", app: "mail", source: "zele", account: "me@example.net", mailId: "m1", ref: "k1", to: "kim@example.com", subject: "Re: 문의", body: "확인해 보고 말씀드릴게요.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { text: "문의드립니다", from: "Kim <kim@example.com>" }, ...o }) as unknown as DraftRec;

// A fake mail tool: `read` and `reply` (or `send`) answer as told; anything else succeeds.
const zele = (o: { read?: [number, string]; reply?: [number, string]; whoami?: string } = {}): Runner => async argv => {
	if (argv[1] === "whoami") return { code: 0, stdout: o.whoami ?? "", stderr: "" };
	const step = argv[2] === "read" ? o.read : argv[2] === "reply" || argv[2] === "send" ? o.reply : undefined;
	return step ? { code: step[0], stdout: "", stderr: step[1] } : { code: 0, stdout: "ok", stderr: "" };
};

describe("sendWith: the mail table", () => {
	const where = async (r: DraftRec, run: Runner) => {
		const o = await sendWith(r, run);
		return `${o.ok ? "ok" : "fail"} ${o.sent}${o.code ? ` ${o.code}` : ""}`;
	};

	test("a reply that went out is sent", async () => {
		expect(await where(rec(), zele())).toBe("ok yes");
	});

	test("refusals before anything was submitted are surely not sent", async () => {
		expect(await where(rec({ kind: "comment" } as Partial<DraftRec>), zele())).toBe("fail no manual_only");
		expect(await where(rec({ source: "corp", cc: ["lee@example.com"] }), zele())).toBe("fail no webmail_recipients");
		expect(await where(rec({ compose: true, account: undefined } as Partial<DraftRec>), zele({ whoami: "a@example.com\nb@example.com\n" }))).toBe("fail no account_needed");
		expect(await where(rec({ source: "nowhere" }), zele())).toBe("fail no manual_only");
	});

	test("files on a source that cannot attach are refused", async () => {
		const file = join(env.dir, "doc.pdf");
		writeFileSync(file, "pdf");
		addStagedFile("ROUT01", file);
		expect(await where(rec({ source: "corp" }), zele())).toBe("fail no cannot_attach");
	});

	test("`mail read` failing before the reply sent nothing, whatever it says", async () => {
		expect(await where(rec(), zele({ read: [1, "invalid_grant: token expired"] }))).toBe("fail no login_expired");
		expect(await where(rec(), zele({ read: [1, "getaddrinfo ENOTFOUND gmail.googleapis.com"] }))).toBe("fail no offline");
		expect(await where(rec(), zele({ read: [1, "ECONNRESET"] }))).toBe("fail no offline");
		expect(await where(rec(), zele({ read: [1, "thread not found"] }))).toBe("fail no tool_before_send");
	});

	test("`mail reply` failing: only words that show nothing left are surely not sent", async () => {
		const reply = (stderr: string) => where(rec(), zele({ reply: [1, stderr] }));
		expect(await reply("Error: invalid_grant")).toBe("fail no login_expired");
		expect(await reply("connect ECONNREFUSED 127.0.0.1:443")).toBe("fail no offline");
		expect(await reply("read ECONNRESET")).toBe("fail maybe net_cut");
		expect(await reply("fetch failed")).toBe("fail maybe net_cut");
		expect(await reply("the thread has a newer message; read it first")).toBe("fail no stale");
		expect(await reply("Invalid To header: recipient address rejected")).toBe("fail no recipient_invalid");
		expect(await reply("400 Bad Request")).toBe("fail no rejected");
		expect(await reply("something odd happened")).toBe("fail maybe unknown");
	});

	test("a new mail through zele is classified the same way", async () => {
		const compose = rec({ compose: true });
		expect(await where(compose, zele())).toBe("ok yes");
		expect(await where(compose, zele({ reply: [1, "socket hang up"] }))).toBe("fail maybe net_cut");
	});

	test("the owner's line never carries the tool's raw words", async () => {
		const o = await sendWith(rec(), zele({ reply: [1, "TypeError: boom\n    at send (x.ts:1:1)"] }));
		expect(o.message).not.toContain("TypeError");
		expect(o.message).not.toContain("x.ts");
	});
});

describe("sendWith: the webmail table", () => {
	// The site's own CLI: `draft` and `approve` answer as told, `send` exits with `send[0]` and prints `send[1]`.
	const site = (o: { draft?: number; approve?: number; send?: [number, string] }): Runner => async argv => {
		if (argv[3] === "draft") return { code: o.draft ?? 0, stdout: o.draft ? "" : "초안 저장: d-1", stderr: o.draft ? "boom" : "" };
		if (argv[3] === "approve") return { code: o.approve ?? 0, stdout: "", stderr: o.approve ? "boom" : "" };
		const [code, stdout] = o.send ?? [0, "보냈어요"];
		return { code, stdout, stderr: "" };
	};
	const where = async (run: Runner) => {
		const o = await sendWith(rec({ source: "corp", account: undefined } as Partial<DraftRec>), run);
		return `${o.ok ? "ok" : "fail"} ${o.sent}${o.code ? ` ${o.code}` : ""}`;
	};
	const line = (o: object) => `DOTZ_SEND ${JSON.stringify(o)}`;

	test("the draft or approve step failing sent nothing", async () => {
		expect(await where(site({ draft: 1 }))).toBe("fail no tool_before_send");
		expect(await where(site({ approve: 1 }))).toBe("fail no tool_before_send");
	});

	test("the send's exit code says where the mail is and its line names the reason", async () => {
		expect(await where(site({}))).toBe("ok yes");
		expect(await where(site({ send: [1, line({ sent: "no", code: "offline" })] }))).toBe("fail no offline");
		expect(await where(site({ send: [1, line({ sent: "no", code: "rejected" })] }))).toBe("fail no rejected");
		expect(await where(site({ send: [1, line({ sent: "no", code: "attach_upload" })] }))).toBe("fail no attach_upload");
		expect(await where(site({ send: [2, line({ sent: "no", code: "not_approved" })] }))).toBe("fail no not_approved");
		expect(await where(site({ send: [3, line({ sent: "maybe", code: "timeout" })] }))).toBe("fail maybe timeout");
		expect(await where(site({ send: [3, line({ sent: "maybe", code: "server_error" })] }))).toBe("fail maybe server_error");
		expect(await where(site({ send: [4, line({ sent: "no", code: "login_expired" })] }))).toBe("fail no login_expired");
	});

	test("without a line the exit code alone decides; a line that contradicts it is not believed", async () => {
		expect(await where(site({ send: [1, "전송 실패"] }))).toBe("fail no tool_before_send");
		expect(await where(site({ send: [3, line({ sent: "no", code: "offline" })] }))).toBe("fail maybe unknown");
		expect(await where(site({ send: [9, "crashed"] }))).toBe("fail maybe unknown");
	});
});

describe("sendDraft: the gate and the outcome", () => {
	const ok = async () => ({ ok: true, message: "보냈어요" });
	const step = async (r: DraftRec, opts: Parameters<typeof sendDraft>[2] = {}, send: () => Promise<{ ok: boolean; message: string }> = ok) => {
		const s = await sendDraft(r.id, { send }, opts);
		return `${s.ok ? "ok" : "fail"} ${s.sent ?? "-"} ${s.code ?? "-"}`;
	};

	test("a draft that is missing or not pending is gone", async () => {
		expect(await step(rec())).toBe("fail no gone");
		addDraft(rec({ status: "sent" }));
		expect(await step(rec())).toBe("fail no gone");
	});

	test("no 보내기 pick, a 고치기 or a 보내지 않기 is not approved", async () => {
		addDraft(rec());
		expect(await step(rec())).toBe("fail no not_approved");
		pick(env, "ROUT01", 2, "더 짧게");
		expect(await step(rec())).toBe("fail no not_approved");
		pick(env, "ROUT01", 3);
		expect(await step(rec())).toBe("fail no not_approved");
		expect(getDraft("ROUT01")?.status).toBe("dropped");
	});

	test("a file still on its way is file_pending; a send-time lint finding carries its own code", async () => {
		addDraft(rec({ wantFiles: [{ name: "brief.pdf" }] } as Partial<DraftRec>));
		pick(env, "ROUT01", 1);
		expect(await step(rec())).toBe("fail no file_pending");
		rmSync(paths.drafts(), { force: true });
		addDraft(rec({ subject: "문의", item: { kind: "mail", text: "문의드립니다", from: "Kim <kim@example.com>", subject: "문의" } } as Partial<DraftRec>));
		expect(await step(rec())).toBe("fail no subject_re");
	});

	test("a claim left by a sender that died may have sent it", async () => {
		addDraft(rec());
		pick(env, "ROUT01", 1);
		const gone = Bun.spawn([process.execPath, "-e", "0"]);
		await gone.exited;
		const claim = join(env.dir, "custom", "reply-drafts", "sending", "ROUT01");
		mkdirSync(join(claim, ".."), { recursive: true });
		writeFileSync(claim, String(gone.pid));
		expect(await step(rec())).toBe("fail maybe interrupted");
	});

	test("a sender that throws may have sent it; one that does not say where the mail is may have too", async () => {
		addDraft(rec());
		pick(env, "ROUT01", 1);
		expect(await step(rec(), {}, async () => Promise.reject(new Error("boom")))).toBe("fail maybe unknown");
		expect(await step(rec(), {}, async () => ({ ok: false, message: "안 됐어요" }))).toBe("fail maybe unknown");
		expect(getDraft("ROUT01")?.status).toBe("pending");
	});

	test("the outcome is told after the transport answered and before the draft is marked sent", async () => {
		addDraft(rec());
		pick(env, "ROUT01", 1);
		const told: { o: Outcome; status?: string }[] = [];
		const r = await sendDraft("ROUT01", { send: ok, onOutcome: o => void told.push({ o, status: getDraft("ROUT01")?.status }) });
		expect(r.ok).toBe(true);
		expect(told).toEqual([{ o: { sent: "yes" }, status: "pending" }]);
		expect(getDraft("ROUT01")?.status).toBe("sent");
	});

	test("a surely-unsent transport answer keeps its code on the step", async () => {
		addDraft(rec());
		pick(env, "ROUT01", 1);
		const told: Outcome[] = [];
		const r = await sendDraft("ROUT01", { send: async () => ({ ok: false, message: "로그인", sent: "no", code: "login_expired" }), onOutcome: o => void told.push(o) });
		expect(r).toMatchObject({ ok: false, sendFailed: true, sent: "no", code: "login_expired" });
		expect(told).toEqual([{ sent: "no", code: "login_expired" }]);
	});
});

describe("draft.ts send under the gateway", () => {
	const lines = async (args: string[], deps: Parameters<typeof runDraft>[2]) => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		process.env.DOTZ_GATEWAY_SEND = "1";
		try {
			await runDraft(args, "", deps);
			return log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("DOTZ_SEND "));
		} finally {
			delete process.env.DOTZ_GATEWAY_SEND;
			log.mockRestore();
		}
	};
	const hub = { post: async () => ({ status: 200 }) };

	test("a gate refusal prints its DOTZ_SEND line", async () => {
		expect(await lines(["send", "RNONE01"], { hub })).toEqual(['DOTZ_SEND {"sent":"no","code":"gone"}']);
	});

	test("the transport's answer prints exactly one line", async () => {
		addDraft(rec());
		pick(env, "ROUT01", 1);
		expect(await lines(["send", "ROUT01"], { hub, send: async () => ({ ok: true, message: "보냈어요" }) })).toEqual(['DOTZ_SEND {"sent":"yes"}']);
		rmSync(paths.drafts(), { force: true });
		addDraft(rec());
		expect(await lines(["send", "ROUT01"], { hub, send: async () => ({ ok: false, message: "?", sent: "maybe", code: "net_cut" }) })).toEqual(['DOTZ_SEND {"sent":"maybe","code":"net_cut"}']);
	});

	test("without DOTZ_GATEWAY_SEND nothing is printed", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			await runDraft(["send", "RNONE01"], "", { hub });
			expect(log.mock.calls.filter(c => String(c[0]).startsWith("DOTZ_SEND"))).toEqual([]);
		} finally {
			log.mockRestore();
		}
	});
});
