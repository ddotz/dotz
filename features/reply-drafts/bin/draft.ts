// Action CLI the orchestrator runs: `new --mail <key>`, `revise <id> --change <text>`, `send <id>`, `drop <id>`, `status`.
// `new` and `revise` print the [ask] block to post unchanged (comment drafts print the reply text only); `send` refuses unless the
// owner picked 1) 보내기 for that exact id. Stdin of `new` is the text to answer.
import { addressesOf, type ReplyItem } from "../../../hub/reply-draft.ts";
import { askText, buildDraft, dropDraft, kindOf, reviseDraft, sendDraft, type FlowDeps } from "../lib/flow.ts";
import { loadSettings } from "../lib/settings.ts";
import { addDraft, listDrafts } from "../lib/store.ts";

const USAGE = "usage: draft.ts new --mail <key> [--kind mail|comment] [--from <sender>] [--subject <s>] [--context <c>] [--source <src>] [--id <mail id>] (text on stdin) | revise <id> --change <text> | send <id> | drop <id> | status";

type Out = { lines: string[]; code: number };

export function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

const positionals = (args: string[]): string[] => {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i]!.startsWith("--")) i++;
		else out.push(args[i]!);
	}
	return out;
};

export async function runDraft(args: string[], stdin: string, deps: FlowDeps = {}): Promise<Out> {
	const [cmd, ...rest] = args;
	const pos = positionals(rest);
	const done = (r: { ok: boolean; text: string }): Out => ({ lines: [r.text], code: r.ok ? 0 : 1 });
	switch (cmd) {
		case "new": {
			if (!loadSettings().enabled) return { lines: ["답장 초안 기능이 꺼져 있어요 (onboard.ts on)"], code: 1 };
			const key = flag(rest, "--mail");
			const kind = kindOf(flag(rest, "--kind"));
			const from = flag(rest, "--from") ?? "";
			if (!key || !stdin.trim()) return { lines: [USAGE], code: 2 };
			if (kind === "mail" && !addressesOf(from).length) return { lines: ["메일 초안은 --from <보낸 사람 주소>가 필요해요"], code: 2 };
			const item: ReplyItem = { kind, from, subject: flag(rest, "--subject"), text: stdin, context: flag(rest, "--context") };
			const built = await buildDraft(item, { source: flag(rest, "--source") ?? "manual", mailId: flag(rest, "--id") ?? key, ref: key }, deps);
			if (built.action === "skip") return { lines: [`답장이 필요 없어 보여요: ${built.reason}`], code: 0 };
			if (kind === "comment") return { lines: [built.rec.body, ...built.warnings.map(w => `확인: ${w}`)], code: 0 };
			addDraft(built.rec);
			return { lines: [askText(built.rec, built.warnings)], code: 0 };
		}
		case "revise":
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			return done(await reviseDraft(pos[0], flag(rest, "--change") ?? "", deps));
		case "send":
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			return done(await sendDraft(pos[0], deps));
		case "drop":
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			return done(dropDraft(pos[0]));
		case "status": {
			const pending = listDrafts().filter(d => d.status === "pending");
			return { lines: pending.length ? pending.map(d => `${d.id} ${d.kind} ${d.to} ${d.subject ?? ""}`.trim()) : ["기다리는 초안이 없어요"], code: 0 };
		}
		default:
			return { lines: [USAGE], code: 2 };
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const stdin = args[0] === "new" ? await Bun.stdin.text() : "";
	try {
		const out = await runDraft(args, stdin);
		for (const l of out.lines) console.log(l);
		process.exit(out.code);
	} catch (e) {
		console.log(`실패했어요: ${(e as Error).message}`);
		process.exit(1);
	}
}
