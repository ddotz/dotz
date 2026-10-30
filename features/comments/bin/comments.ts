// Commands the orchestrator runs for a comment ask: `draft <comment id>` (on request), `send <code>`, `revise <code> --change <text> [--part reply|mail]`,
// `drop <code>`, `status`. A reply draft can carry a mail (hub/mail-cli.ts compose --with-comment <code>, or the draft API): the one card shows
// both, `send` posts the reply and then sends the mail, `revise --part mail` changes only the mail, `drop` drops both. `send` goes out only when the owner's latest pick for exactly that draft code, made after the draft was
// created, is 1) 보내기 (hub/draft-approval.ts draftVerdict); the engine's gate (hub/comments/contract.ts) then posts it once.
// `send <code> --only reply|mail` sends one part of a reply + mail card: also allowed after the card's 답글만 보내기 / 메일만 보내기 pick, and after
// 어떻게 보낼지 직접 입력 (the owner's own words, printed back so the bot does what they say). The other part stays and is asked again.
import { join } from "node:path";
import { commentAsk } from "../../../hub/comments/ask.ts";
import type { Engine } from "../../../hub/comments/engine.ts";
import { realEngine } from "../../../hub/comments/real.ts";
import { draftVerdict } from "../../../hub/draft-approval.ts";
import { dataDir } from "../../reply-drafts/lib/settings.ts";

type Out = { lines: string[]; code: number };
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

export async function run(args: string[], engine: Engine = realEngine(dataDir()), inbox = join(dataDir(), "inbox.jsonl")): Promise<Out> {
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
			const step = await engine.revise(id, flag(args, "--change") ?? "", part);
			return step.ok ? { lines: [askOf(step.draft.code, part === "mail" ? "함께 보낼 메일 초안을 고쳤어요" : "댓글 답글 초안을 고쳤어요") ?? "초안을 고쳤어요"], code: 0 } : fail(step.reason);
		}
		case "drop": {
			if (!id) return fail("초안 id가 필요해요");
			const r = engine.drop(id);
			return r.ok ? { lines: [`초안 ${id}${engine.store.drafts().find(x => x.code === id)?.mail ? "과 함께 보낼 메일을" : "을(를)"} 버렸어요`], code: 0 } : fail(r.reason ?? "버리지 못했어요");
		}
		case "send": {
			const d = id ? engine.store.drafts().find(x => x.code === id) : undefined;
			if (!d) return fail("그 초안을 찾지 못했어요");
			// A pick made before the mail was put on the card did not show the mail: it counts from `mailAt` on.
			const v = draftVerdict(inbox, d.code, Math.max(d.created, d.mailAt ?? 0));
			const only = flag(args, "--only");
			if (only !== undefined && only !== "reply" && only !== "mail") return fail("--only는 reply 또는 mail이에요");
			// Labels of the send-mode options on the card (hub/draft-approval.ts, when the card offers them).
			const picked: string = v.verdict;
			const allowed = ["send", "own", ...(only === "reply" ? ["send-main"] : only === "mail" ? ["send-mail"] : [])];
			if (!allowed.includes(picked)) return fail(`사용자가 1) 보내기를 고른 기록이 없어서 보내지 않았어요 (${v.verdict === "none" ? "고른 기록 없음" : v.verdict})`);
			const said = picked === "own" && v.detail ? [`사용자 지시: ${v.detail}`] : [];
			if (only === "mail") {
				const m = await engine.sendMailOnly(d.code);
				if (!m.ok) return fail(`메일을 보내지 못했어요: ${m.text}`);
				return { lines: [...said, `메일만 보냈어요. 답글은 아직 올리지 않았어요 (${d.code})`, askOf(d.code, "메일은 보냈어요. 답글은 따로 물어봐요") ?? ""].filter(Boolean), code: 0 };
			}
			const r = engine.send(d.code, { by: "owner", ...(only === "reply" ? { only } : {}) });
			if (!r.ok) return fail(r.reason);
			const done = await r.done;
			if (done.state !== "sent") return fail(`답글을 올리지 못했어요${d.mail ? " (메일도 보내지 않았어요)" : ""}: ${done.reason ?? "알 수 없는 이유"}`);
			if (only === "reply" && d.mail) return { lines: [...said, `답글만 올렸어요 (${d.code}). 메일 초안 ${d.mail}은 따로 물어요: bun hub/mail-cli.ts ask --draft ${d.mail}`], code: 0 };
			if (done.mail?.state === "failed") return fail(`답글은 올렸지만 메일은 보내지 못했어요: ${done.mail.text} (메일 초안 ${d.mail}은 남아 있어요. 사용자에게 알려 주세요)`);
			return { lines: [...said, done.mail ? `답글을 올리고 메일을 보냈어요 (${d.code})` : `답글을 올렸어요 (${d.code})`], code: 0 };
		}
		case "status": {
			const cfg = engine.store.config();
			const cursors = engine.store.cursors();
			const t = engine.tokenStats();
			const rows = Object.values(cfg.sources).map(s => `${s.key}: ${s.watch.length ? `글 ${s.watch.includes("*") ? "전부" : `${s.watch.length}개`}` : "지켜보는 글 없음"}, 자동 초안 ${s.autoDraft ? "켬" : "끔"}${cursors[s.key]?.error ? `, 오류: ${cursors[s.key]!.error}` : ""}`);
			return { lines: [cfg.enabled ? "댓글 연동: 켜짐" : "댓글 연동: 꺼짐", ...rows, `초안 ${t.drafts}건, 초안 한 건당 평균 입력 ${t.avgIn} / 출력 ${t.avgOut} 토큰`], code: 0 };
		}
		default:
			return { lines: ["usage: comments.ts draft <comment id> | send <code> [--only reply|mail] | revise <code> --change <text> [--part reply|mail] | drop <code> | status"], code: 2 };
	}
}

if (import.meta.main) {
	const r = await run(process.argv.slice(2));
	console.log(r.lines.join("\n"));
	process.exit(r.code);
}
