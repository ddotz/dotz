// Action CLI the orchestrator runs: `new --mail <key>`, `revise <id> --change <text>`, `send <id>`, `drop <id>`, `attach <id> <file>`, `detach <id> <n|name>`, `status`.
// `new` and `revise` print the [ask] block to post unchanged (comment and chat drafts print the reply text only, notes go to stderr);
// `send` refuses unless the user picked 1) 보내기 for that exact id. Stdin of `new` is the text to answer.
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { replyChoiceBlock } from "../../../hub/choices.ts";
import { loadPlugins } from "../../../hub/plugins.ts";
import { type HubLike, mailInstance, notifyGateway, reportSendFailed } from "../../../hub/followup.ts";
import { literalBan, parseBan } from "../../../hub/ban.ts";
import { addressesOf, type ReplyItem } from "../../../hub/reply-draft.ts";
import { PATTERN_NOTE } from "../../../hub/reply-reasons.ts";
import { ensureKakaoRoom, defaultKakaoReader, KAKAO_APP } from "../lib/kakao-tone.ts";
import { askText, attachFolder, buildDraft, candidatesFor, chosenFrom, dropDraft, kindOf, learnLine, learnPattern, type LineLearned, mailAsksFile, realFlowDeps, refineAfterCorrection, reviseDraft, sendDraft, settleDraft, stageForReply, type FlowDeps, type Outcome } from "../lib/flow.ts";
import { compactCorrections } from "../lib/compact.ts";
import { journalEntries, profileKey, profileOf, restoreEntry } from "../lib/curate.ts";
import { dataDir, handSections, HEADINGS, INSTALL, loadSettings, profileBullets, recordForbidden, removeCorrection, removeForbidden, removeRule, toneFile, validApp, type ToneKey } from "../lib/settings.ts";
import { addDraft, type DraftRec, getDraft, listDrafts, patchDraft } from "../lib/store.ts";
import { listLibrary } from "../lib/library.ts";
import { canAttach } from "../lib/senders.ts";
import { cloudFile, cloudPlaceholder, EVICTED_LATER, isEvicted, removeStagedFile, stagedFiles, stageLibraryFile } from "../lib/staged.ts";

// Exit code of `new --kind chat` when the message needs the owner's own decision: stdout is the choice block to post as an [ask] (hub/choices.ts replyChoiceBlock).
export const ASK_EXIT = 4;
const USAGE = "usage: draft.ts new --mail <key> [--app <app>] [--room <id>] [--kind mail|comment|chat] [--from <sender>] [--subject <s>] [--context <c>] [--source <src>] [--id <mail id>] [--choice <the owner's pick>] (text on stdin) | revise <id> --change <text> | send <id> | drop <id> | correct --app <app|install> [--room <id>] [--rule <standing rule>]... [--change <lesson>] [--forbid <wording>]... [--allow <wording or pattern label>]... [--forget <text>]... [--tidy] | correct --restore <n> | tone --app <app|install> [--room <id>] | tone --journal | attach <id> <path or file name in the 첨부 파일 폴더> | detach <id> <n or file name> | status\n  correct stores what the owner asked in exactly one tone profile (--app install = every reply; --room only with a messenger app); at least one of --rule --change --forbid --allow --forget --tidy\n  --rule a standing request the owner made in chat (always, never, from now on): kept undated under 말투, never pushed out by later lessons | --change what one corrected draft showed, a dated 고친 점 line; a rule or change about a wording to avoid (with its wrong and right examples quoted) may also store a checked wording pattern under 금지, printed as 이 표현 모양도 걸러요: <label>\n  --rule and --change first ask which lines of that profile the new line repeats or overrides: a rule an existing rule already says is not added (이미 있는 조건이라 더하지 않았어요), replaced lines (at most 3; a --change never replaces a rule) are taken out and printed with the correct --restore <n> that puts each back\n  --forbid never use this wording again (2-40 characters with whitespace runs as one space, not a /regex/; the owner's quoted wording) | --allow takes a forbidden wording, or a pattern by its label, back | --forget removes the 말투 and 고친 점 lines that contain the text (a line of a hand-written section is only named, with its file to edit)\n  --tidy folds the 고친 점 lines of that profile (at least 2) into at most 8 lasting conditions in one model call, printed as 고친 점 N줄을 M줄로 정리했어요; every line taken out stays in tone --journal for correct --restore (a 고친 점 longer than 12 lines is tidied on its own after a correction)\n  correct --restore <n> puts the line of journal entry n back where it was (unless an equal line is there); exit 1 when there is no entry n\n  tone prints what a draft there follows (말투 with the hand-written sections, 고친 점, 금지; a pattern as <label> (패턴)) with the level of each line | tone --journal prints the newest 20 lines the product replaced, merged or removed (→ 지움), numbered for correct --restore\n  attach / detach change the files of a pending mail draft and print the refreshed [ask] (never edit draft-files/ or drafts.json by hand)\n  new --app kakao --room <chat id> --kind chat (recent messages on stdin; --mail optional) prints only the reply text\n  chat exit codes: 0 reply text on stdout | 3 nothing to answer | 4 the owner must choose first: stdout is a 결정 block (post it as an [ask]); after his pick run the same command again with --choice \"<pick>\"\n  --app: mail (default for mail), youtube | instagram for comments, kakao for chats; --room only for messenger rooms";

type Out = { lines: string[]; code: number; notes?: string[] };

// The one stdout line the gateway's send queue reads (hub/approval-send.ts; design 1.11), printed the moment the outcome is known.
const printOutcome = (o: Outcome): void => console.log(`DOTZ_SEND ${JSON.stringify({ sent: o.sent, ...(o.code ? { code: o.code } : {}), ...(o.vars ? { vars: o.vars } : {}) })}`);
export type DraftDeps = FlowDeps & { hub?: HubLike };

export function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

const flagValues = (args: string[], name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const levelName = (key: ToneKey): string => (key.app === INSTALL ? "모든 답장" : key.room !== undefined ? `${key.app} 대화방` : key.app);
const journalLevel = (profile: string): string => {
	const key = profileKey(profile);
	return levelName(key === undefined || key === INSTALL ? { app: INSTALL } : key);
};
const sectionName = (heading: string): string => (heading === HEADINGS.rules ? "말투" : "고친 점");
function learnedNote(learned: LineLearned, key: ToneKey | "install"): string[] {
	if (learned.same !== undefined) return [`이미 있는 조건이라 더하지 않았어요: "${learned.same}"`];
	if (!learned.replaced.length) return [];
	const open = journalEntries().filter(e => e.profile === profileOf(key) && !e.restoredAt);
	const numbers = learned.replaced.flatMap(old => open.find(e => e.line === old)?.n ?? []);
	return [`기존 조건 ${learned.replaced.length}개를 이 조건으로 바꿨어요: ${learned.replaced.map(o => `"${o}"`).join(", ")}${numbers.length ? ` (되돌리려면 ${numbers.map(n => `correct --restore ${n}`).join(", ")})` : ""}`];
}
function learnCallOf(deps: FlowDeps, app: string): FlowDeps["learnCall"] {
	try {
		const call = deps.learnCall?.(app);
		return call && (() => call);
	} catch (e) {
		console.error(`draft correct: no model call for ${app}: ${(e as Error).message}`);
		return undefined;
	}
}
const JOURNAL_SHOWN = 20;
function toneLevels(key: ToneKey): [string, ToneKey | "install"][] {
	const levels: [string, ToneKey | "install"][] = [["install", INSTALL]];
	if (key.app !== INSTALL) levels.push(["app", { app: key.app }]);
	if (key.app !== INSTALL && key.room !== undefined) levels.push(["room", key]);
	return levels;
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
// An absolute path of a file (one only in iCloud too), else a name (or folder-relative path) in the mail app's 첨부 파일 폴더; one match only.
async function fileToAttach(rec: DraftRec, what: string): Promise<string | { error: string }> {
	const path = cloudFile(what);
	if (isAbsolute(path) && (existsSync(path) || existsSync(cloudPlaceholder(path)))) return path;
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
			await settleDraft(built.rec, deps.run);
			addDraft(built.rec);
			return { lines: [askText(built.rec, warnings)], code: 0, notes };
		}
		case "revise": {
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			const change = flag(rest, "--change") ?? "";
			// With a gateway the change runs through its one reply flow (the card shows the new draft in place, the lesson is stored once); only with
			// none does this process rewrite the draft itself.
			if (await notifyGateway({ path: "/api/reply/act", body: { ref: pos[0], action: "revise", change } }, deps.hub))
				return { lines: [`고치기를 맡겼어요. 고친 초안은 카드(${pos[0]})에 바로 나와요. 초안을 붙이지 말고 무엇을 고쳤는지 한 줄로만 답하세요.`], code: 0 };
			return done(await reviseDraft(pos[0], change, deps));
		}
		case "send": {
			if (!pos[0]) return { lines: [USAGE], code: 2 };
			const rec = getDraft(pos[0]);
			// Run by the gateway (DOTZ_GATEWAY_SEND): where the mail is goes out as a DOTZ_SEND line, from the transport's answer or else from the gate's refusal.
			const gateway = Boolean(process.env.DOTZ_GATEWAY_SEND);
			let told = false;
			const tell = (o: Outcome): void => {
				told = true;
				deps.onOutcome?.(o);
				if (gateway) printOutcome(o);
			};
			const r = await sendDraft(pos[0], { ...deps, onOutcome: tell }, rest.includes("--retry") ? { retry: true } : {});
			if (!told && r.sent) tell({ sent: r.sent, ...(r.code ? { code: r.code } : {}), ...(r.vars ? { vars: r.vars } : {}) });
			if (r.sendFailed && rec) await reportSendFailed(rec, r.text, deps.hub);
			// An approved mail reply went out: tell the gateway, which wakes the bot once if the mail app has a 이어서 할 일 rule (hub/followup.ts).
			if (r.ok && rec?.kind === "mail" && !rec.compose) await notifyGateway({ path: "/api/followup", body: { app: mailInstance(rec.ref), kind: "mail", key: rec.id, ids: { draft: rec.id, mail: rec.ref } } }, deps.hub);
			// A new mail he wrote went out: the mail app lists it under 보낸 메일 from here, with its text and files.
			if (r.ok && rec?.kind === "mail" && rec.compose) await notifyGateway({ path: "/api/mail/compose", body: { ref: rec.id, source: rec.source, state: "sent" } }, deps.hub);
			return done(r);
		}
		case "correct": {
			const restore = flag(rest, "--restore");
			if (restore !== undefined) {
				const back = /^\d+$/.test(restore) ? restoreEntry(Number(restore), (deps.now ?? (() => new Date()))()) : undefined;
				if (!back) return { lines: [`${restore}번 기록이 없어요. tone --journal로 번호를 확인해 주세요`], code: 1 };
				const what = `[${journalLevel(back.entry.profile)}] ${sectionName(back.entry.heading)} "${back.entry.line}"`;
				return { lines: [back.put ? `되돌렸어요: ${what}` : `이미 있는 줄이라 바꾼 게 없어요: ${what}`], code: 0 };
			}
			const app = flag(rest, "--app");
			const change = oneLine(flag(rest, "--change") ?? "");
			const room = flag(rest, "--room");
			const forbid = flagValues(rest, "--forbid").map(oneLine);
			const allow = flagValues(rest, "--allow").map(oneLine);
			const forget = flagValues(rest, "--forget").map(oneLine);
			const rules = flagValues(rest, "--rule").map(oneLine).filter(Boolean);
			const tidy = rest.includes("--tidy");
			if (!app || !validApp(app) || (!change && !rules.length && !forbid.length && !allow.length && !forget.length && !tidy)) return { lines: [USAGE], code: 2 };
			if (app === INSTALL && room !== undefined) return { lines: ["--app install은 모든 답장에 적용돼서 --room과 같이 쓸 수 없어요"], code: 2 };
			const bad = forbid.find(w => !literalBan(w));
			if (bad !== undefined) return { lines: [`금지할 표현은 2~40자의 글자여야 하고 /정규식/은 쓸 수 없어요: ${bad}`], code: 1 };
			const key: ToneKey = { app, ...(room !== undefined ? { room } : {}) };
			const target = app === INSTALL ? INSTALL : key;
			const where = levelName(key);
			const lines: string[] = [];
			const learn: DraftDeps = { ...deps, learnCall: rules.length || change || tidy ? learnCallOf(deps, app) : undefined };
			const ruleResults: [string, LineLearned][] = [];
			for (const r of rules) ruleResults.push([r, await learnLine(target, r, "rule", learn)]);
			const changed = change ? await learnLine(key, change, "correction", learn) : undefined;
			const added = ruleResults.filter(([, l]) => l.same === undefined).map(([r]) => `"${r}"`);
			if (added.length) lines.push(`${where} 말투에 늘 지킬 규칙으로 기록했어요: ${added.join(", ")}`);
			for (const [, l] of ruleResults) lines.push(...learnedNote(l, target));
			if (changed) lines.push(`고친 점을 ${where} 말투에 기록했어요: ${change}`, ...learnedNote(changed, key));
			for (const [profile, text] of [...rules.map(r => [target, r] as const), ...(change ? [[key, change] as const] : [])]) {
				try {
					const learned = await learnPattern(profile, text, [text], learn);
					if (learned) lines.push(`${PATTERN_NOTE}${learned.label}`);
				} catch (e) {
					console.error(`draft correct: wording pattern of ${app} not learned: ${(e as Error).message}`);
				}
			}
			if (forbid.length) {
				recordForbidden(target, forbid);
				lines.push(`${where}에서 쓰지 않을 표현으로 기록했어요: ${forbid.map(w => `"${w}"`).join(", ")}`);
			}
			for (const w of allow) lines.push(removeForbidden(target, w) ? `${where}의 금지 표현에서 뺐어요: "${w}"` : `${where}의 금지 표현에 "${w}"이(가) 없어서 바꾼 게 없어요`);
			for (const t of forget) {
				const gone = [...removeRule(target, t).map(l => `- [말투] ${l}`), ...removeCorrection(target, t).map(l => `- [고친 점] ${l}`)];
				const needle = t.toLowerCase();
				const hand = gone.length || !needle ? [] : toneLevels(key).flatMap(([, k]) => handSections(k).flatMap(s => s.items.filter(l => oneLine(l).toLowerCase().includes(needle)).map(l => `- ${l} (손으로 쓴 '${s.heading}' 섹션, ${toneFile(k)})`)));
				if (gone.length) lines.push(`${where}에서 ${gone.length}줄을 지웠어요:\n${gone.join("\n")}`);
				else if (hand.length) lines.push(`"${t}"이(가) 든 줄은 손으로 쓴 섹션에만 있어서 지우지 않았어요. 그 파일에서 직접 고쳐야 해요:\n${hand.join("\n")}`);
				else lines.push(`${where}의 말투와 고친 점에 "${t}"이(가) 든 줄이 없어서 바꾼 게 없어요`);
			}
			if (changed) await refineAfterCorrection(key, deps);
			if (tidy) {
				const count = profileBullets(target, HEADINGS.corrections).length;
				const tidied = count >= 2 ? await compactCorrections(target, learn, { force: true }) : undefined;
				lines.push(count < 2 ? "정리할 것이 없어요" : tidied ? `고친 점 ${tidied.before}줄을 ${tidied.after}줄로 정리했어요 (지운 줄은 tone --journal에 남아 있어요)` : "모델의 답을 쓸 수 없어서 고친 점을 그대로 두었어요");
			}
			return { lines, code: 0 };
		}
		case "tone": {
			if (rest.includes("--journal")) {
				const recent = journalEntries().slice(0, JOURNAL_SHOWN);
				if (!recent.length) return { lines: ["제품이 바꾼 말투 조건 기록이 아직 없어요"], code: 0 };
				return { lines: recent.map(e => `${e.n}. [${journalLevel(e.profile)}] ${sectionName(e.heading)} "${e.line}" → ${e.why === "dropped" ? "지움" : `"${e.newLine}"`} (${e.at.slice(0, 10)})${e.restoredAt ? " 되돌림" : ""}`), code: 0 };
			}
			const app = flag(rest, "--app");
			const room = flag(rest, "--room");
			if (!app || !validApp(app)) return { lines: [USAGE], code: 2 };
			if (app === INSTALL && room !== undefined) return { lines: ["--app install은 --room과 같이 쓸 수 없어요"], code: 2 };
			const key: ToneKey = { app, ...(room !== undefined ? { room } : {}) };
			const sections: [string, string][] = [["말투", HEADINGS.rules], ["고친 점", HEADINGS.corrections], ["금지", HEADINGS.forbidden]];
			const lines = [`${levelName(key)} 답장이 따르는 것`];
			for (const [title, heading] of sections) {
				lines.push(`${title}:`);
				const rows = toneLevels(key).flatMap(([level, k]) =>
					profileBullets(k, heading).map(l => {
						const ban = heading === HEADINGS.forbidden ? parseBan(l) : undefined;
						return `- [${level}] ${ban?.kind === "shape" ? `${ban.label} (표현 규칙)` : l}`;
					}),
				);
				if (heading === HEADINGS.rules) rows.push(...toneLevels(key).flatMap(([level, k]) => handSections(k).flatMap(s => s.items.map(l => `- [${level}] (${s.heading.replace(/^##\s*/, "")}) ${l}`))));
				lines.push(...(rows.length ? rows : ["- 없음"]));
			}
			return { lines, code: 0 };
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
				if (!isEvicted(e)) return { lines: [(e as Error).message], code: 1 };
				// Still downloading from iCloud: the draft waits for it (wantFiles) like a library pick; the gateway keeps trying and the send gate takes it.
				const want = rec.wantFiles ?? [];
				if (!want.some(w => w.path === src)) patchDraft(rec.id, { wantFiles: [...want, { name: basename(src), path: src }] });
				return { lines: [askText(getDraft(rec.id)!, [], EVICTED_LATER(basename(src)))], code: 0 };
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
		// This process is not the gateway: a plugin source says here whether it sends files (senders.ts canAttach) for every command, the send's file check too.
		await loadPlugins(dataDir());
		const out = await runDraft(args, stdin, realFlowDeps());
		// stdout is only ever something to post or pipe on: on a non-zero exit the lines are explanations and go to stderr.
		for (const l of out.lines) (out.code === 0 || out.code === ASK_EXIT ? console.log : console.error)(l);
		for (const n of out.notes ?? []) console.error(n);
		process.exit(out.code);
	} catch (e) {
		console.log(`실패했어요: ${(e as Error).message}`);
		process.exit(1);
	}
}
