// Commands the orchestrator runs for a comment ask: `draft <comment id>` (on request), `send <code>`, `revise <code> --change <text>`,
// `drop <code>`, `status`. `send` goes out only when the owner's latest pick for exactly that draft code, made after the draft was
// created, is 1) 보내기 (hub/draft-approval.ts draftVerdict); the engine's gate (hub/comments/contract.ts) then posts it once.
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
		return d && c && src ? commentAsk(src, c, d, headline) : undefined;
	};
	switch (cmd) {
		case "draft": {
			if (!id) return fail("댓글 id가 필요해요");
			const step = await engine.makeDraft(id);
			return step.ok ? { lines: [askOf(step.draft.code) ?? "초안을 만들었어요"], code: 0 } : fail(step.reason);
		}
		case "revise": {
			if (!id) return fail("초안 id가 필요해요");
			const step = await engine.revise(id, flag(args, "--change") ?? "");
			return step.ok ? { lines: [askOf(step.draft.code, "댓글 답글 초안을 고쳤어요") ?? "초안을 고쳤어요"], code: 0 } : fail(step.reason);
		}
		case "drop": {
			if (!id) return fail("초안 id가 필요해요");
			const r = engine.drop(id);
			return r.ok ? { lines: [`초안 ${id}을(를) 버렸어요`], code: 0 } : fail(r.reason ?? "버리지 못했어요");
		}
		case "send": {
			const d = id ? engine.store.drafts().find(x => x.code === id) : undefined;
			if (!d) return fail("그 초안을 찾지 못했어요");
			const v = draftVerdict(inbox, d.code, d.created);
			if (v.verdict !== "send") return fail(`사용자가 1) 보내기를 고른 기록이 없어서 보내지 않았어요 (${v.verdict === "none" ? "고른 기록 없음" : v.verdict})`);
			const r = engine.send(d.code, { by: "owner" });
			if (!r.ok) return fail(r.reason);
			const done = await r.done;
			return done.state === "sent" ? { lines: [`답글을 올렸어요 (${d.code})`], code: 0 } : fail(`답글을 올리지 못했어요: ${done.reason ?? "알 수 없는 이유"}`);
		}
		case "status": {
			const cfg = engine.store.config();
			const cursors = engine.store.cursors();
			const t = engine.tokenStats();
			const rows = Object.values(cfg.sources).map(s => `${s.key}: ${s.watch.length ? `글 ${s.watch.includes("*") ? "전부" : `${s.watch.length}개`}` : "지켜보는 글 없음"}, 자동 초안 ${s.autoDraft ? "켬" : "끔"}${cursors[s.key]?.error ? `, 오류: ${cursors[s.key]!.error}` : ""}`);
			return { lines: [cfg.enabled ? "댓글 연동: 켜짐" : "댓글 연동: 꺼짐", ...rows, `초안 ${t.drafts}건, 초안 한 건당 평균 입력 ${t.avgIn} / 출력 ${t.avgOut} 토큰`], code: 0 };
		}
		default:
			return { lines: ["usage: comments.ts draft <comment id> | send <code> | revise <code> --change <text> | drop <code> | status"], code: 2 };
	}
}

if (import.meta.main) {
	const r = await run(process.argv.slice(2));
	console.log(r.lines.join("\n"));
	process.exit(r.code);
}
