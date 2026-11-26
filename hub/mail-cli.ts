// `bun hub/mail-cli.ts compose|reply|send`: a mail the bot writes, with the same owner approval as every reply; the card it prints is the store's draft.
//   reply <mail key> --body-file <path> [--to <addr>] [--cc <addr>] [--subject <s>]
//     the reply draft of that received mail (hub/mail-manual.ts replyDraft: to its sender, through the mail's own source); again on the same mail = the same draft's new version.
//   compose --app <mail instance> --to <addr> --subject <s> [--account <logged-in zele account>] [--attach <path>]... [--from-library <keywords>] [--origin comment|mail|kakao:<id>] [--with-comment <comment draft code>] (body on stdin)
//     stages the files, records a draft and prints the shared approval block (hub/draft-approval.ts) to post unchanged as an [ask].
//     --with-comment: the mail rides on that pending comment reply draft (hub/comments): the printed block is ONE card with the reply and then the
//     mail, and the owner's 보내기 posts the reply and sends the mail (features/comments/bin/comments.ts send).
//   ask --draft <code>
//     prints the approval block of a pending mail draft again (e.g. the mail of a comment reply that was posted but whose mail failed).
//   send --draft <code>
//     sends only after the owner picked 1) 보내기 for exactly that draft (features/reply-drafts/lib/flow.ts sendDraft, the same check as the reply path).
// Attachments go out through the reply path's sender (zele `--attach`); a mail source that cannot send a new mail is refused at compose time.
import { existsSync, readFileSync, statSync } from "node:fs";
import { addressesOf } from "./reply-draft.ts";
import { readAppsFile } from "./integrations.ts";
import { replyDraft, sourceOf } from "./mail-manual.ts";
import { type HubLike, notifyGateway, reportSendFailed } from "./followup.ts";
import { commentAsk } from "./comments/ask.ts";
import { attachMail, linkedComment, mailPartOf } from "./comments/linked.ts";
import { commentsDir, createStore } from "./comments/store.ts";
import { accountHold, askText, boxOfOutgoing, checkDraft, draftAttachIssues, judgeOf, learningSettled, ownerWarning, realFlowDeps, realRunner, sendAccountOf, sendDraft, settleDraft, type FlowDeps } from "../features/reply-drafts/lib/flow.ts";
import { canAttach, zeleLogins } from "../features/reply-drafts/lib/senders.ts";
import { listLibrary, rankLibrary, LIBRARY_PICK_MAX, MIN_SCORE } from "../features/reply-drafts/lib/library.ts";
import { cloudFile, cloudPlaceholder, retryWanted, STAGED_MAX, stageFiles, type Want } from "../features/reply-drafts/lib/staged.ts";
import { dataDir, loadSettings } from "../features/reply-drafts/lib/settings.ts";
import { addDraft, getDraft, newId, patchDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { autoAttach } from "./auto-attach.ts";

export type MailCliDeps = FlowDeps & { hub?: HubLike };
type Out = { lines: string[]; code: number; notes?: string[] };

const USAGE = "usage: mail-cli.ts compose --app <mail app> --to <addr> --subject <s> [--account <addr>] [--attach <path>]... [--from-library <keywords>] [--origin comment|mail|kakao:<id>] [--with-comment <comment draft code>] (body on stdin) | reply <mail key> --body-file <path> [--to <addr>] [--cc <addr>] [--subject <s>] | send --draft <code> | ask --draft <code>";
const MULTI = new Set(["--attach"]);

function parse(args: string[]): { flags: Record<string, string[]>; rest: string[] } {
	const flags: Record<string, string[]> = {};
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!a.startsWith("--")) rest.push(a);
		else (flags[a] ??= []).push(args[++i] ?? "");
	}
	for (const k of Object.keys(flags)) if (!MULTI.has(k)) flags[k] = [flags[k]!.at(-1)!];
	return { flags, rest };
}

function originOf(spec: string | undefined): DraftRec["origin"] | { error: string } | undefined {
	if (!spec) return undefined;
	const i = spec.indexOf(":");
	const kind = spec.slice(0, i);
	const id = spec.slice(i + 1);
	if (i < 1 || !id || (kind !== "comment" && kind !== "mail" && kind !== "kakao")) return { error: "--origin은 comment:<id>, mail:<id>, kakao:<id> 형식이에요" };
	if (kind === "comment") {
		let link: string | undefined;
		try {
			link = createStore(commentsDir(dataDir())).comments().find(c => c.id === id)?.postLink;
		} catch {}
		return { kind, id, text: "댓글 답글에 이어서", ...(link ? { link } : {}) };
	}
	return { kind, id, text: kind === "mail" ? "메일 답장에 이어서" : "카카오톡 메시지에 이어서" };
}

const NARROW_MIN_SCORE = 2;
export type ComposeInput = { app: string; to: string[]; subject: string; body: string; /** The logged-in zele account to send from; refused when it is not one. */ account?: string; attach?: string[]; fromLibrary?: string; /** What the writer asked in his own words: the install's narrow rule (hub/auto-attach.ts) reads it, and a revise of the draft reads it as the received text. */ request?: string; /** What a mail riding on a comment reply was first written from (hub/comments/mail-link.ts): revise and the checks read it as that write did. `box` is the mailbox its recipient falls in. */ written?: { box?: string; configured?: string; instruction?: string; postTitle?: string; /** The style judge's notes on that write (checkDraft takes them instead of asking again). */ judged?: string[] }; origin?: DraftRec["origin"]; /** false = not listed in the web mail app (the mail rides on a comment reply's card). */ notify?: boolean };
export type Composed = { ok: true; rec: DraftRec; notes: string[] } | { ok: false; error: string; code: number };

// A new mail draft: stages the files, lints, records it as pending and (unless `notify` is false) tells the gateway. Sends nothing.
export async function composeMail(i: ComposeInput, deps: MailCliDeps = {}): Promise<Composed> {
	const fail = (error: string, code = 2): Composed => ({ ok: false, error, code });
	const { app, subject, body, to, origin } = i;
	const via = sourceOf(app);
	if ("error" in via) return fail(via.error);
	if (i.account && (via.source !== "zele" || !(await zeleLogins(deps.run ?? realRunner)).includes(i.account))) return fail(`이 앱으로 보낼 수 있는 메일 계정이 아니에요: ${i.account}`);
	if ((i.attach?.length || i.fromLibrary) && !canAttach(via.source)) return fail("이 메일은 파일을 붙여 보낼 수 없어요");
	const paths: string[] = [];
	for (const given of i.attach ?? []) {
		// A file iCloud keeps only in the cloud (its `.<name>.icloud` placeholder, by either path) is attached once it is downloaded.
		const p = cloudFile(given);
		if (existsSync(p) ? !statSync(p).isFile() : !existsSync(cloudPlaceholder(p))) return fail(`첨부파일을 찾지 못했어요: ${given}`);
		paths.push(p);
	}
	const notes: string[] = [];
	let libraryMiss = false;
	const keywords = i.fromLibrary;
	if (keywords) {
		const folder = loadSettings().attachFolders?.[app];
		if (!folder) return fail(`${app}에 첨부 파일 폴더가 정해져 있지 않아요 (설정 > 첨부 파일 폴더)`);
		const rules = autoAttach();
		if (rules.error) notes.push(`확인: auto-attach.json을 쓸 수 없어 첨부는 비워 뒀어요 - ${rules.error}`);
		// The install's withheld files are never picked by keywords; they are attached by hand.
		const ranked = rules.error ? [] : rankLibrary(listLibrary(folder), { subject: keywords, text: keywords }).filter(r => r.score > 0 && !rules.withhold.some(re => re.test(r.file.rel.normalize("NFC"))));
		// Only the best-scoring files, and only when the best is a real match: three different songs on one mail were never asked for.
		const top = ranked[0]?.score ?? 0;
		let found = top >= MIN_SCORE ? ranked.filter(r => r.score === top).slice(0, LIBRARY_PICK_MAX) : [];
		const request = i.request?.normalize("NFC").toLowerCase();
		const narrow = request === undefined ? undefined : rules.narrow?.when.some(w => request.includes(w)) ? rules.narrow : undefined;
		if (narrow) {
			// Only the files of the one work he names; a weak match or files of several works is a guess, so nothing is attached.
			const only = ranked.filter(r => narrow.only.test(r.file.rel.normalize("NFC")));
			const onlyTop = only[0]?.score ?? 0;
			const best = only.filter(r => r.score === onlyTop);
			found = onlyTop >= NARROW_MIN_SCORE && new Set(best.map(r => r.file.rel.split("/")[0])).size === 1 ? best.slice(0, LIBRARY_PICK_MAX) : [];
			if (!found.length) notes.push(narrow.note ?? "확인 필요: 이 요청에 맞는 파일을 확실히 찾지 못했어요. 첨부는 비워 뒀어요");
		}
		for (const r of found) if (!paths.includes(r.file.path)) paths.push(r.file.path);
		if (!found.length && !rules.error) {
			libraryMiss = true;
			if (!narrow) notes.push(`확인: 첨부 파일 폴더에서 '${keywords}'에 맞는 파일을 찾지 못했어요`);
		}
	}
	if (paths.length > STAGED_MAX) return fail(`첨부파일은 ${STAGED_MAX}개까지 붙일 수 있어요`);

	const w = i.written, box = w?.box ?? boxOfOutgoing(app, { src: "", from: to.join(", "), subj: subject, body })?.id, at = box ? { box, instance: app } : {};
	const item = { kind: "mail" as const, app, from: to.join(", "), text: body, ...(w?.instruction ? { instruction: w.instruction } : {}), ...(w?.configured ? { configured: w.configured } : {}), ...(w?.postTitle ? { context: w.postTitle } : {}) };
	const draft = { to: to.join(", "), subject, body };

	const id = newId();
	const rec: DraftRec = { id, kind: "mail", app, source: via.source, mailId: `compose-${id}`, ref: `compose-${id.toLowerCase()}`, compose: true, ...at, ...(i.request ? { request: i.request } : {}), ...(i.account ? { account: i.account } : {}), ...(libraryMiss ? { libraryMiss: true } : {}), ...(origin ? { origin } : {}), ...draft, status: "pending", created: (deps.now ?? (() => new Date()))().toISOString(), changes: [], questions: [], item };
	const check = await checkDraft(rec, judgeOf(deps, item, rec.ref), w?.judged);
	if (check.refuse.length) return fail(`초안 검사에서 걸렸어요: ${check.refuse.join("; ")}`, 1);
	notes.push(...check.warn.map(n => `확인: ${ownerWarning(n)}`));
	await settleDraft(rec, deps.run);
	// The draft is saved before its files: a file that is not on this computer yet (iCloud) waits in wantFiles and is attached as it downloads.
	addDraft(rec);
	const want: Want[] = [];
	notes.push(...(await stageFiles(id, paths, want, deps.stage)));
	if (want.length) {
		rec.wantFiles = want;
		patchDraft(id, { wantFiles: want });
		retryWanted(id, deps.stage);
	}
	if (i.notify !== false) await notifyGateway({ path: "/api/mail/compose", body: { ref: id, source: via.source, app, to: draft.to, subject, ...(origin ? { origin: origin.text } : {}) } }, deps.hub);
	return { ok: true, rec, notes };
}

export async function runMailCli(args: string[], stdin: string, deps: MailCliDeps = {}): Promise<Out> {
	const [cmd, ...more] = args;
	const { flags, rest } = parse(more);
	const one = (k: string) => flags[k]?.[0]?.trim() || undefined;
	if (cmd === "reply") {
		const key = rest[0], file = one("--body-file");
		if (!key || !file) return { lines: [USAGE], code: 2 };
		if (!existsSync(file)) return { lines: [`본문 파일을 찾지 못했어요: ${file}`], code: 2 };
		const made = replyDraft(key, { body: readFileSync(file, "utf8").replace(/\r\n?/g, "\n"), to: one("--to"), cc: one("--cc"), subject: one("--subject") });
		if (!made.ok) return { lines: [made.error], code: made.code === 404 ? 2 : 1 };
		// The text the session wrote passes the one pre-card check; its warnings ride on the card, and a refusal is said before any card.
		const check = await checkDraft(made.rec, judgeOf(deps, made.rec.item, made.rec.ref));
		if (check.refuse.length) return { lines: [`초안 검사에서 걸렸어요: ${check.refuse.join("; ")}`], code: 1 };
		return { lines: [askText(made.rec, [])], code: 0, notes: check.warn.map(n => `확인: ${ownerWarning(n)}`) };
	}
	if (cmd === "send") {
		const id = one("--draft");
		if (!id) return { lines: [USAGE], code: 2 };
		const rec = getDraft(id);
		if (rec && !rec.compose) return { lines: ["이 초안은 받은 메일의 답장이에요. 답장 카드에서 사용자가 보내기를 눌러야 나가요"], code: 2 };
		const r = await sendDraft(id, deps);
		if (r.sendFailed && rec) await reportSendFailed(rec, r.text, deps.hub);
		if (r.ok && rec) await notifyGateway({ path: "/api/mail/compose", body: { ref: rec.id, source: rec.source, state: "sent" } }, deps.hub);
		return { lines: [r.text], code: r.ok ? 0 : 1 };
	}
	if (cmd === "move") {
		const key = one("--key"), source = readAppsFile(dataDir())[one("--app") ?? ""]?.filter?.source?.trim();
		if (!key || !source) return { lines: ["usage: mail-cli.ts move --key <mail key> --app <mail app with a filter source>"], code: 2 };
		return (await notifyGateway({ path: "/api/mail/move", body: { key, source } }, deps.hub)) ? { lines: [`${key} 메일을 ${one("--app")} 앱으로 옮겼어요`], code: 0 } : { lines: ["메일을 옮기지 못했어요. 메일 키와 게이트웨이를 확인해 주세요"], code: 1 };
	}
	if (cmd === "ask") {
		const rec = getDraft(one("--draft") ?? "");
		if (!rec?.compose || rec.status !== "pending") return { lines: ["그런 메일 초안이 없거나 이미 처리됐어요"], code: 2 };
		const card = linkedComment(rec.id);
		return card ? { lines: [`이 메일은 댓글 답글(${card})과 한 장으로 승인해요`], code: 2 } : { lines: [askText(rec, [])], code: 0 };
	}
	if (cmd !== "compose") return { lines: [USAGE], code: 2 };

	const app = one("--app");
	const subject = one("--subject");
	const to = addressesOf(flags["--to"]?.[0]);
	const body = stdin.replace(/\r\n?/g, "\n").trim();
	if (!app || !subject || !to.length || !body) return { lines: [USAGE], code: 2 };
	const origin = originOf(one("--origin"));
	if (origin && "error" in origin) return { lines: [origin.error], code: 2 };
	// A mail that answers a comment whose reply draft still waits rides on that reply's card even without --with-comment: one item is
	// one card (owner 2026-10-31: a reply card and a mail card per comment, 28 comments, made her answer twice per item).
	const pairStore = origin?.kind === "comment" && !one("--with-comment") ? createStore(commentsDir(dataDir())) : undefined;
	const paired = pairStore?.drafts().find(d => d.status === "pending" && d.commentId === origin!.id && !d.mail)?.code;
	const withComment = one("--with-comment") ?? paired;
	const store = withComment ? (pairStore ?? createStore(commentsDir(dataDir()))) : undefined;
	const reply = withComment ? store!.drafts().find(d => d.code === withComment) : undefined;
	if (withComment && reply?.status !== "pending") return { lines: [`댓글 답글 초안 ${withComment}이(가) 없거나 이미 처리됐어요`], code: 2 };

	const account = one("--account");
	const made = await composeMail({ app, to, subject, body, ...(account ? { account } : {}), attach: flags["--attach"], fromLibrary: one("--from-library"), ...(origin ? { origin } : {}), notify: !withComment }, deps);
	if (!made.ok) return { lines: [made.error], code: made.code };
	if (!reply) return { lines: [askText(made.rec, [])], code: 0, notes: made.notes };
	const now = (deps.now ?? (() => new Date()))().getTime();
	const linked = attachMail(store!, reply.code, made.rec.id, now);
	const c = store!.comments().find(x => x.id === linked.commentId);
	const src = store!.config().sources[linked.source];
	if (!c || !src) return { lines: ["원댓글을 찾지 못했어요"], code: 2 };
	const hold = accountHold(made.rec);
	return { lines: [commentAsk(src, c, linked, "댓글 답글과 이어서 보낼 메일 초안을 만들었어요", { ...mailPartOf(made.rec, sendAccountOf(made.rec)), attachIssues: draftAttachIssues(made.rec), ...(hold ? { notes: [`확인: ${hold}`] } : {}) })], code: 0, notes: made.notes };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const stdin = args[0] === "compose" ? await Bun.stdin.text() : "";
	try {
		const out = await runMailCli(args, stdin, realFlowDeps());
		for (const l of out.lines) (out.code === 0 ? console.log : console.error)(l);
		for (const n of out.notes ?? []) console.error(n);
		await learningSettled();
		process.exit(out.code);
	} catch (e) {
		console.error(`실패했어요: ${(e as Error).message}`);
		process.exit(1);
	}
}
