// Commands the orchestrator runs for a comment ask: `draft <comment id>` (on request), `send <code>`, `revise <code> --change <text> [--part reply|mail] [--no-mail]`,
// `drop <code>`, `status`. A reply draft can carry a mail (hub/mail-cli.ts compose --with-comment <code>, or the draft API): the one card shows
// both, `send` posts the reply and then sends the mail, `revise --part mail` changes only the mail, `drop` drops both. `send` goes out only when the owner's latest pick for exactly that draft code, made after the draft was
// created, is 1) 보내기 (hub/draft-approval.ts draftVerdict); the engine's gate (hub/comments/contract.ts) then posts it once.
// `send <code> --only reply|mail` sends one part of a reply + mail card: also allowed after the card's 답글만 보내기 / 메일만 보내기 pick, and after
// 어떻게 보낼지 직접 입력 (the owner's own words, printed back so the bot does what they say). The other part stays and is asked again.
// A mail whose files disagree with its words is refused before the reply is posted; `--as-is` sends it as it is, and only after the owner's pick 이대로 보내기.
// (the gateway adds it for that pick). `--only mail --retry` is the owner's 다시 보내기 of a mail that failed after its reply was posted: that mail alone goes out, the reply never again.
// Run by the gateway's send queue (DOTZ_GATEWAY_SEND set), `send` also prints one `DOTZ_SEND {"sent","code","part"}` line per part (hub/approval-send.ts reads
// them): "yes" posted, "no" surely not posted, "maybe" may have gone up. A send still running elsewhere prints none for its part.
import { join } from "node:path";
import { commentAsk } from "../../../hub/comments/ask.ts";
import type { Engine } from "../../../hub/comments/engine.ts";
import { realEngine } from "../../../hub/comments/real.ts";
import { ATTACH_REFUSED, draftVerdict, LINT_REFUSED } from "../../../hub/draft-approval.ts";
import { dataDir } from "../../reply-drafts/lib/settings.ts";
import { notifyGateway } from "../../../hub/followup.ts";

type Out = { lines: string[]; code: number };
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
type Part = "reply" | "mail";
type Sent = "yes" | "no" | "maybe";
const sendLine = (sent: Sent, part: Part, code?: string): string => `DOTZ_SEND ${JSON.stringify({ sent, ...(code ? { code } : {}), part })}`;
// A refusal the engine gives before the gate (the linked mail's checks) has no code of its own: it is named by its first words.
const refusalCode = (r: { reason: string; code?: string }): string => r.code ?? (r.reason.startsWith(ATTACH_REFUSED) ? "attach_mismatch" : r.reason.startsWith(LINT_REFUSED) ? "tool_before_send" : "mail_gone");
// A mail that did not go out after its reply: only a file refusal is known to have sent nothing.
const mailFailure = (text: string): [Sent, string] => (text.startsWith(ATTACH_REFUSED) ? ["no", "attach_mismatch"] : ["maybe", "unknown"]);

export async function run(args: string[], engine: Engine = realEngine(dataDir()), inbox = join(dataDir(), "inbox.jsonl")): Promise<Out> {
	const out = await runCmd(args, engine, inbox);
	return process.env.DOTZ_GATEWAY_SEND && out.send ? { lines: [...out.send, ...out.lines], code: out.code } : { lines: out.lines, code: out.code };
}

async function runCmd(args: string[], engine: Engine, inbox: string): Promise<Out & { send?: string[] }> {
	const [cmd, id] = args;
	const fail = (line: string): Out => ({ lines: [line], code: 1 });
	const askOf = (code: string, headline?: string): string | undefined => {
		const d = engine.store.drafts().find(x => x.code === code);
		const c = d && engine.store.comments().find(x => x.id === d.commentId);
		const src = d && engine.store.config().sources[d.source];
		return d && c && src ? commentAsk(src, c, d, headline, engine.mailView(d)) : undefined;
	};
	switch (cmd) {
		case "draft": {
			if (!id) return fail("댓글 id가 필요해요");
			const step = await engine.makeDraft(id);
			return step.ok ? { lines: [askOf(step.draft.code) ?? "초안을 만들었어요"], code: 0 } : fail(step.reason);
		}
		case "revise": {
			if (!id) return fail("초안 id가 필요해요");
			const part = flag(args, "--part") ?? "reply";
			if (part !== "reply" && part !== "mail") return fail("--part는 reply 또는 mail이에요");
			const noMail = args.includes("--no-mail");
			if (noMail && part === "mail") return fail("--no-mail은 --part mail과 함께 쓸 수 없어요");
			const change = flag(args, "--change") ?? "";
			// With a gateway the change runs through its one reply flow and the card shows the new draft; only with none does this process rewrite it.
			if (!noMail && (await notifyGateway({ path: "/api/reply/act", body: { ref: id, action: "revise", change, part } })))
				return { lines: [`고치기를 맡겼어요. 고친 초안은 카드(${id})에 바로 나와요. 무엇을 고쳤는지 한 줄로만 답하세요.`], code: 0 };
			const step = await engine.revise(id, change, part, noMail);
			return step.ok ? { lines: [askOf(step.draft.code, part === "mail" ? "함께 보낼 메일 초안을 고쳤어요" : "댓글 답글 초안을 고쳤어요") ?? "초안을 고쳤어요"], code: 0 } : fail(step.reason);
		}
		case "drop": {
			if (!id) return fail("초안 id가 필요해요");
			const r = engine.drop(id);
			return r.ok ? { lines: [`초안 ${id}${engine.store.drafts().find(x => x.code === id)?.mail ? "과 함께 보낼 메일을" : "을(를)"} 버렸어요`], code: 0 } : fail(r.reason ?? "버리지 못했어요");
		}
		case "send": {
			const d = id ? engine.store.drafts().find(x => x.code === id) : undefined;
			if (!d) return { ...fail("그 초안을 찾지 못했어요"), send: [sendLine("no", "reply", "gone")] };
			const only = flag(args, "--only");
			// The parts this command answers for, each told in one line; a refusal before anything went out tells them all "no".
			const parts: Part[] = only === "reply" || only === "mail" ? [only] : d.mail ? ["reply", "mail"] : ["reply"];
			const refused = (line: string, code: string) => ({ ...fail(line), send: parts.map(p => sendLine("no", p, code)) });
			// A pick made before the mail was put on the card did not show the mail: it counts from `mailAt` on.
			const v = draftVerdict(inbox, d.code, Math.max(d.created, d.mailAt ?? 0));
			if (only !== undefined && only !== "reply" && only !== "mail") return refused("--only는 reply 또는 mail이에요", "config");
			// Labels of the send-mode options on the card (hub/draft-approval.ts, when the card offers them).
			const picked: string = v.verdict;
			const allowed = ["send", "own", "send-as-is", ...(only === "reply" ? ["send-main"] : only === "mail" ? ["send-mail"] : [])];
			if (args.includes("--as-is") && picked !== "send-as-is") return refused("사용자가 이대로 보내기를 고른 기록이 없어서 보내지 않았어요", "not_approved");
			if (!allowed.includes(picked)) return refused(`사용자가 1) 보내기를 고른 기록이 없어서 보내지 않았어요 (${v.verdict === "none" ? "고른 기록 없음" : v.verdict})`, "not_approved");
			const said = picked === "own" && v.detail ? [`사용자 지시: ${v.detail}`] : [];
			if (only === "mail") {
				const m = await engine.sendMailOnly(d.code, { ...(args.includes("--retry") ? { retry: true as const } : {}), ...(picked === "send-as-is" ? { asIs: true as const } : {}) });
				// A refusal for the files keeps its first words: the card opens again on them (hub/notices-drafts.ts markDraftSend).
				if (!m.ok) {
					const [sent, code] = mailFailure(m.text);
					return { ...fail(m.text.startsWith(ATTACH_REFUSED) ? m.text : `메일을 보내지 못했어요: ${m.text}`), send: [sendLine(sent, "mail", code)] };
				}
				const sent = [sendLine("yes", "mail")];
				if (d.status === "sent") return { lines: [...said, `메일만 다시 보냈어요. 답글은 이미 올라가 있어요 (${d.code})`], code: 0, send: sent };
				return { lines: [...said, `메일만 보냈어요. 답글은 아직 올리지 않았어요 (${d.code})`, askOf(d.code, "메일은 보냈어요. 답글은 따로 물어봐요") ?? ""].filter(Boolean), code: 0, send: sent };
			}
			const r = engine.send(d.code, { by: "owner", ...(only === "reply" ? { only } : {}), ...(picked === "send-as-is" ? { asIs: true as const } : {}) });
			if (!r.ok) {
				// Another sender still runs (no line: the queue keeps it sending), or an earlier send may have gone up (needs_resolve: no line, never "no").
				if (r.code === "already_sending" || r.code === "needs_resolve") return fail(r.reason);
				if (r.code === "already_sent") return { ...fail(r.reason), send: [sendLine("yes", "reply")] };
				return refused(r.reason, refusalCode(r));
			}
			const done = await r.done;
			if (done.state !== "sent") {
				const sent: Sent = done.state === "failed" ? "no" : "maybe";
				// The mail goes only after the reply is up: a reply that did not go up sent no mail.
				return { ...fail(`답글을 올리지 못했어요${d.mail ? " (메일도 보내지 않았어요)" : ""}: ${done.reason ?? "알 수 없는 이유"}`), send: parts.map(p => (p === "reply" ? sendLine(sent, "reply", done.code ?? "unknown") : sendLine("no", "mail", done.code ?? "unknown"))) };
			}
			const replyUp = sendLine("yes", "reply");
			if (only === "reply" && d.mail) return { lines: [...said, `답글만 올렸어요 (${d.code}). 메일 초안 ${d.mail}은 따로 물어요: bun hub/mail-cli.ts ask --draft ${d.mail}`], code: 0, send: [replyUp] };
			if (done.mail?.state === "failed") {
				const [sent, code] = mailFailure(done.mail.text);
				return { ...fail(`답글은 올렸지만 메일은 보내지 못했어요: ${done.mail.text} (메일 초안 ${d.mail}은 남아 있어요. 사용자에게 알려 주세요)`), send: [replyUp, sendLine(sent, "mail", code)] };
			}
			return { lines: [...said, done.mail ? `답글을 올리고 메일을 보냈어요 (${d.code})` : `답글을 올렸어요 (${d.code})`], code: 0, send: done.mail ? [replyUp, sendLine("yes", "mail")] : [replyUp] };
		}
		case "status": {
			const cfg = engine.store.config();
			const cursors = engine.store.cursors();
			const t = engine.tokenStats();
			const rows = Object.values(cfg.sources).map(s => `${s.key}: ${s.watch.length ? `글 ${s.watch.includes("*") ? "전부" : `${s.watch.length}개`}` : "지켜보는 글 없음"}, 자동 초안 ${s.autoDraft ? "켬" : "끔"}${cursors[s.key]?.error ? `, 오류: ${cursors[s.key]!.error}` : ""}`);
			return { lines: [cfg.enabled ? "댓글 연동: 켜짐" : "댓글 연동: 꺼짐", ...rows, `초안 ${t.drafts}건, 초안 한 건당 평균 입력 ${t.avgIn} / 출력 ${t.avgOut} 토큰`], code: 0 };
		}
		default:
			return { lines: ["usage: comments.ts draft <comment id> | send <code> [--only reply|mail] [--as-is] [--retry] | revise <code> --change <text> [--part reply|mail] [--no-mail] | drop <code> | status"], code: 2 };
	}
}

if (import.meta.main) {
	const r = await run(process.argv.slice(2));
	console.log(r.lines.join("\n"));
	process.exit(r.code);
}
