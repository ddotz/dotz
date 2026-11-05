// Action CLI the orchestrator runs: `new --mail <key>`, `revise <id> --change <text>`, `send <id>`, `drop <id>`, `attach <id> <file>`, `detach <id> <n|name>`, `status`.
// `new` and `revise` print the [ask] block to post unchanged (comment and chat drafts print the reply text only, notes go to stderr);
// `send` refuses unless the user picked 1) 보내기 for that exact id. Stdin of `new` is the text to answer.
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { replyChoiceBlock } from "../../../hub/choices.ts";
import { type HubLike, mailInstance, notifyGateway, reportSendFailed } from "../../../hub/followup.ts";
import { addressesOf, type ReplyItem } from "../../../hub/reply-draft.ts";
import { ensureKakaoRoom, defaultKakaoReader, KAKAO_APP, type OwnerReader } from "../lib/kakao-tone.ts";
import { askText, attachFolder, buildDraft, candidatesFor, chosenFrom, defaultCall, dropDraft, kindOf, mailAsksFile, refineAfterCorrection, reviseDraft, sendDraft, stageForReply, type FlowDeps } from "../lib/flow.ts";
import { INSTALL, loadSettings, recordCorrection, validApp } from "../lib/settings.ts";
import { addDraft, type DraftRec, getDraft, listDrafts, patchDraft } from "../lib/store.ts";
import { listLibrary } from "../lib/library.ts";
import { canAttach } from "../lib/senders.ts";
import { removeStagedFile, stagedFiles, stageLibraryFile } from "../lib/staged.ts";

// Exit code of `new --kind chat` when the message needs the owner's own decision: stdout is the choice block to post as an [ask] (hub/choices.ts replyChoiceBlock).
export const ASK_EXIT = 4;
const USAGE = "usage: draft.ts new --mail <key> [--app <app>] [--room <id>] [--kind mail|comment|chat] [--from <sender>] [--subject <s>] [--context <c>] [--source <src>] [--id <mail id>] [--choice <the owner's pick>] (text on stdin) | revise <id> --change <text> | send <id> | drop <id> | correct --app <app> [--room <id>] --change <text> | attach <id> <path or file name in the 첨부 파일 폴더> | detach <id> <n or file name> | status\n  attach / detach change the files of a pending mail draft and print the refreshed [ask] (never edit draft-files/ or drafts.json by hand)\n  new --app kakao --room <chat id> --kind chat (recent messages on stdin; --mail optional) prints only the reply text\n  chat exit codes: 0 reply text on stdout | 3 nothing to answer | 4 the owner must choose first: stdout is a 결정 block (post it as an [ask]); after his pick run the same command again with --choice \"<pick>\"\n  --app: mail (default for mail), youtube | instagram for comments, kakao for chats; --room only for messenger rooms";

type Out = { lines: string[]; code: number; notes?: string[] };
export type DraftDeps = FlowDeps & { kakaoReader?: (chatId: string) => Promise<OwnerReader>; hub?: HubLike };

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

const nfc = (s: string) => s.normalize("NFC");
// The pending mail draft whose files `attach` / `detach` change, or why it cannot.
function editable(id: string | undefined): DraftRec | string {
	const rec = id ? getDraft(id) : undefined;
	if (!rec) return `초안 ${id ?? ""}을(를) 찾지 못했어요`;
	if (rec.status !== "pending" || rec.kind !== "mail") return `초안 ${id}은(는) 기다리는 메일 초안이 아니라서 파일을 바꿀 수 없어요`;
	if (!canAttach(rec.source)) return "이 메일은 파일을 붙여 보낼 수 없어요";
	return rec;
}
// An absolute path of a file, else a name (or folder-relative path) in the mail app's 첨부 파일 폴더; one match only.
async function fileToAttach(rec: DraftRec, what: string): Promise<string | { error: string }> {
	if (isAbsolute(what) && existsSync(what)) return what;
	const folder = await attachFolder(rec.ref);
	if (!folder) return { error: "첨부 파일 폴더가 정해져 있지 않아요. 파일의 전체 경로로 알려 주세요" };
	const all = listLibrary(folder), exact = all.filter(f => nfc(f.rel) === nfc(what));
	const hit = exact.length ? exact : all.filter(f => nfc(basename(f.rel)) === nfc(basename(what)));
	if (hit.length === 1) return hit[0]!.path;
	return { error: hit.length ? `이름이 같은 파일이 여러 개예요: ${hit.map(f => f.rel).join(", ")}` : `첨부 파일 폴더에서 ${what}을(를) 찾지 못했어요` };
}

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
			const meta = { source: flag(rest, "--source") ?? "manual", mailId: flag(rest, "--id") ?? key, ref: key };
			// Same path as the gateway's offer (offer.ts): the model chooses among candidates, then only the chosen files are staged.
			const cands = kind === "mail" && mailAsksFile(item) ? await candidatesFor(item, meta).catch(e => (notes.push(`확인: 첨부 파일 후보를 찾지 못했어요 (${(e as Error).message})`), undefined)) : undefined;
			if (cands?.files.length) item.candidates = cands.files.map(f => f.rel);
			else if (cands) item.files = [];
			const flow = { ...deps, stage: { tries: 5, ...deps.stage } };
			const built = await buildDraft(item, meta, flow);
			if (built.action === "ask") return { lines: [replyChoiceBlock(built.question, built.choices)], code: ASK_EXIT, notes };
			if (built.action === "skip") return { lines: [`답장이 필요 없어 보여요: ${built.reason}`], code: kind === "chat" ? 3 : 0, notes };
			if (kind === "comment" || kind === "chat") return { lines: [built.rec.body], code: 0, notes: [...notes, ...built.warnings.map(w => `확인: ${w}`)] };
			const chosen = chosenFrom(cands, built.files);
			const warnings = [...built.warnings, ...(await stageForReply(built.rec, flow, chosen && Promise.resolve(chosen)).catch(e => [(e as Error).message]))];
			addDraft(built.rec);
			return { lines: [askText(built.rec, warnings)], code: 0, notes };
		}
		case "revise": {
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			const r = await reviseDraft(pos[0], flag(rest, "--change") ?? "", deps);
			const rec = r.ok && r.id ? getDraft(r.id) : undefined;
			// The rewritten mail draft goes to its mail's conversation from here, not through the bot's answer: a second 고치기 changes a word or
			// two, and the runtime cut the near-identical card off as a repeated reply, so the owner never got it (2026-10-28, RZV7KMZ).
			if (rec?.kind === "mail" && (await notifyGateway({ path: "/api/send", body: { target: `mail:${rec.ref}`, text: r.text } }, deps.hub)))
				return { lines: [`고친 초안(${rec.id})을 그 메일 대화에 올렸어요. 초안을 다시 붙이지 말고, 무엇을 고쳤는지 한 줄로만 답하세요.`], code: 0 };
			return done(r);
		}
		case "send": {
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			const rec = getDraft(pos[0]);
			const r = await sendDraft(pos[0], deps);
			if (r.sendFailed && rec) await reportSendFailed(rec, r.text, deps.hub);
			// An approved mail reply went out: tell the gateway, which wakes the bot once if the mail app has a 이어서 할 일 rule (hub/followup.ts).
			if (r.ok && rec?.kind === "mail" && !rec.compose) await notifyGateway({ path: "/api/followup", body: { app: mailInstance(rec.ref), kind: "mail", key: rec.id, ids: { draft: rec.id, mail: rec.ref } } }, deps.hub);
			// A new mail he wrote went out: the mail app lists it under 보낸 메일 from here, with its text and files.
			if (r.ok && rec?.kind === "mail" && rec.compose) await notifyGateway({ path: "/api/mail/compose", body: { ref: rec.id, source: rec.source, state: "sent" } }, deps.hub);
			return done(r);
		}
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
		// The files of a pending mail draft: the owner's card follows them (its 첨부 확인 line too), and the refreshed [ask] is printed.
		case "attach": {
			if (!pos[0] || !pos[1]) return { lines: [USAGE], code: 2 };
			const rec = editable(pos[0]);
			if (typeof rec === "string") return { lines: [rec], code: 1 };
			const src = await fileToAttach(rec, pos[1]);
			if (typeof src !== "string") return { lines: [src.error], code: 1 };
			try {
				await stageLibraryFile(rec.id, src, deps.stage);
			} catch (e) {
				return { lines: [(e as Error).message], code: 1 };
			}
			return { lines: [askText(getDraft(rec.id)!, [], "파일을 붙였어요")], code: 0 };
		}
		case "detach": {
			if (!pos[0] || !pos[1]) return { lines: [USAGE], code: 2 };
			const rec = editable(pos[0]);
			if (typeof rec === "string") return { lines: [rec], code: 1 };
			// A file still waited for (wantFiles) that will not come is taken off by its name too.
			const wanted = (rec.wantFiles ?? []).filter(w => nfc(w.name) !== nfc(pos[1]!));
			if (wanted.length < (rec.wantFiles ?? []).length) {
				patchDraft(rec.id, { wantFiles: wanted.length ? wanted : undefined });
				return { lines: [askText(getDraft(rec.id)!, [], "파일을 뺐어요")], code: 0 };
			}
			const files = stagedFiles(rec.id);
			const at = /^\d+$/.test(pos[1]) ? Number(pos[1]) - 1 : files.findIndex(f => nfc(f.name) === nfc(pos[1]!));
			if (!removeStagedFile(rec.id, at)) return { lines: [`없는 파일이에요: ${pos[1]} (붙은 파일: ${files.map((f, i) => `${i + 1}) ${f.name}`).join(", ") || "없음"})`], code: 1 };
			return { lines: [askText(getDraft(rec.id)!, [], "파일을 뺐어요")], code: 0 };
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
