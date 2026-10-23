// Sending an approved draft. Routed by the mail's source: the mail CLI replies to that mail id; a webmail-no-api site goes through
// that feature's own draft/approve/send commands; anything else is refused with a plain message (the owner sends it by hand).
// Comment replies are not sent from here (the youtube-instagram job flow posts them). The runner is injected.
import { join } from "node:path";
import type { DraftRec } from "./store.ts";
import type { Runner } from "./tone.ts";

export type SendOutcome = { ok: boolean; message: string };

const WEBMAIL_MAIL = join(import.meta.dir, "..", "..", "webmail-no-api", "bin", "mail.ts");
const MANUAL = "이 메일은 여기서 보낼 수 없어서 직접 보내야 해요. 초안은 위에 있는 글을 그대로 쓰면 돼요";

export const replyArgv = (mailId: string, body: string): string[] => ["zele", "mail", "reply", mailId, "--body", body];

const fail = (message: string): SendOutcome => ({ ok: false, message });
const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().slice(0, 160);

export async function sendWith(rec: DraftRec, run: Runner): Promise<SendOutcome> {
	if (rec.kind !== "mail") return fail(MANUAL);
	if (rec.source === "zele") {
		const r = await run(replyArgv(rec.mailId, rec.body));
		return r.code === 0 ? { ok: true, message: `${rec.to}에게 답장을 보냈어요` } : fail(`보내지 못했어요: ${tail(r)}`);
	}
	const site = /^webmail[:/]([a-z0-9-]+)$/.exec(rec.source)?.[1];
	if (!site) return fail(MANUAL);
	const saved = await run(["bun", WEBMAIL_MAIL, site, "draft", rec.to, rec.subject ?? "", rec.body]);
	const id = /초안 저장:\s*(\S+)/.exec(saved.stdout)?.[1];
	if (saved.code !== 0 || !id) return fail(`웹메일 초안을 만들지 못했어요: ${tail(saved)}`);
	const approved = await run(["bun", WEBMAIL_MAIL, site, "approve"]);
	if (approved.code !== 0) return fail(`웹메일 전송 승인을 기록하지 못했어요: ${tail(approved)}`);
	const sent = await run(["bun", WEBMAIL_MAIL, site, "send", id]);
	return sent.code === 0 ? { ok: true, message: `${rec.to}에게 답장을 보냈어요` } : fail(`보내지 못했어요: ${tail(sent)}`);
}
