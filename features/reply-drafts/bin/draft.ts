// Action CLI the orchestrator runs: `new --mail <key>`, `revise <id> --change <text>`, `send <id>`, `drop <id>`, `status`.
// `new` and `revise` print the [ask] block to post unchanged (comment and chat drafts print the reply text only, notes go to stderr);
// `send` refuses unless the user picked 1) 보내기 for that exact id. Stdin of `new` is the text to answer.
import { replyChoiceBlock } from "../../../hub/choices.ts";
import { addressesOf, type ReplyItem } from "../../../hub/reply-draft.ts";
import { ensureKakaoRoom, defaultKakaoReader, KAKAO_APP, type OwnerReader } from "../lib/kakao-tone.ts";
import { askText, buildDraft, defaultCall, dropDraft, kindOf, refineAfterCorrection, reviseDraft, sendDraft, type FlowDeps } from "../lib/flow.ts";
import { INSTALL, loadSettings, recordCorrection, validApp } from "../lib/settings.ts";
import { addDraft, listDrafts } from "../lib/store.ts";

// Exit code of `new --kind chat` when the message needs the owner's own decision: stdout is the choice block to post as an [ask] (hub/choices.ts replyChoiceBlock).
export const ASK_EXIT = 4;
const USAGE = "usage: draft.ts new --mail <key> [--app <app>] [--room <id>] [--kind mail|comment|chat] [--from <sender>] [--subject <s>] [--context <c>] [--source <src>] [--id <mail id>] [--choice <the owner's pick>] (text on stdin) | revise <id> --change <text> | send <id> | drop <id> | correct --app <app> [--room <id>] --change <text> | status\n  new --app kakao --room <chat id> --kind chat (recent messages on stdin; --mail optional) prints only the reply text\n  chat exit codes: 0 reply text on stdout | 3 nothing to answer | 4 the owner must choose first: stdout is a 결정 block (post it as an [ask]); after his pick run the same command again with --choice \"<pick>\"\n  --app: mail (default for mail), youtube | instagram for comments, kakao for chats; --room only for messenger rooms";

type Out = { lines: string[]; code: number; notes?: string[] };
export type DraftDeps = FlowDeps & { kakaoReader?: (chatId: string) => Promise<OwnerReader> };

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

export async function runDraft(args: string[], stdin: string, deps: DraftDeps = {}): Promise<Out> {
	const [cmd, ...rest] = args;
	const pos = positionals(rest);
	const done = (r: { ok: boolean; text: string }): Out => ({ lines: [r.text], code: r.ok ? 0 : 1 });
	switch (cmd) {
		case "new": {
			// A draft the user asks for is their own request: only an explicit `onboard.ts off` refuses it.
			const s = loadSettings();
			if (s.decided && !s.enabled) return { lines: ["답장 초안 기능이 꺼져 있어요 (onboard.ts on)"], code: 1 };
			const kind = kindOf(flag(rest, "--kind"));
			const app = flag(rest, "--app") ?? (kind === "mail" ? "mail" : undefined);
			if (!app) return { lines: ["댓글·채팅 초안은 --app <youtube|instagram|kakao ...>이 필요해요"], code: 2 };
			if (!validApp(app) || app === INSTALL) return { lines: [`앱 이름은 영문 소문자·숫자·-만 쓸 수 있어요: ${app}`], code: 2 };
			const room = flag(rest, "--room");
			const key = flag(rest, "--mail") ?? (kind === "chat" && room ? `chat:${app}:${room}:${(deps.now ?? (() => new Date()))().getTime()}` : undefined);
			const from = flag(rest, "--from") ?? (kind === "mail" ? "" : (room ?? app));
			if (!key || !stdin.trim()) return { lines: [USAGE], code: 2 };
			if (kind === "mail" && !addressesOf(from).length) return { lines: ["메일 초안은 --from <보낸 사람 주소>가 필요해요"], code: 2 };
			const notes: string[] = [];
			if (app === KAKAO_APP && room) {
				try {
					await ensureKakaoRoom(room, () => (deps.kakaoReader ?? defaultKakaoReader)(room), deps.analyze);
				} catch (e) {
					notes.push(`확인: 이 대화방 말투를 못 배웠어요 (${(e as Error).message})`);
				}
			}
			const choice = flag(rest, "--choice")?.trim();
			const item: ReplyItem = { kind, app, ...(room !== undefined ? { room } : {}), from, subject: flag(rest, "--subject"), text: stdin, context: flag(rest, "--context"), ...(kind === "chat" && choice ? { choice } : {}) };
			const built = await buildDraft(item, { source: flag(rest, "--source") ?? "manual", mailId: flag(rest, "--id") ?? key, ref: key }, deps);
			if (built.action === "ask") return { lines: [replyChoiceBlock(built.question, built.choices)], code: ASK_EXIT, notes };
			if (built.action === "skip") return { lines: [`답장이 필요 없어 보여요: ${built.reason}`], code: kind === "chat" ? 3 : 0, notes };
			if (kind === "comment" || kind === "chat") return { lines: [built.rec.body], code: 0, notes: [...notes, ...built.warnings.map(w => `확인: ${w}`)] };
			addDraft(built.rec);
			return { lines: [askText(built.rec, built.warnings)], code: 0, notes };
		}
		case "revise":
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			return done(await reviseDraft(pos[0], flag(rest, "--change") ?? "", deps));
		case "send":
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			return done(await sendDraft(pos[0], deps));
		// A change request of a draft that is not stored here (a KakaoTalk reply): recorded in that room's (else that app's) profile.
		case "correct": {
			const app = flag(rest, "--app");
			const change = flag(rest, "--change")?.trim();
			const room = flag(rest, "--room");
			if (!app || !change || !validApp(app)) return { lines: [USAGE], code: 2 };
			recordCorrection({ app, ...(room !== undefined ? { room } : {}) }, change, (deps.now ?? (() => new Date()))());
			await refineAfterCorrection({ app, ...(room !== undefined ? { room } : {}) }, deps);
			return { lines: [`고친 점을 ${room !== undefined ? `${app} 대화방` : app} 말투에 기록했어요`], code: 0 };
		}
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
		const out = await runDraft(args, stdin, { analyze: defaultCall(loadSettings().model) });
		// stdout is only ever something to post or pipe on: on a non-zero exit the lines are explanations and go to stderr.
		for (const l of out.lines) (out.code === 0 || out.code === ASK_EXIT ? console.log : console.error)(l);
		for (const n of out.notes ?? []) console.error(n);
		process.exit(out.code);
	} catch (e) {
		console.log(`실패했어요: ${(e as Error).message}`);
		process.exit(1);
	}
}
