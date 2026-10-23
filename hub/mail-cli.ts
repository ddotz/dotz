// `bun hub/mail-cli.ts compose|send`: a NEW mail the bot writes (not an answer to a received one), with the same owner approval as every reply.
//   compose --app <mail instance> --to <addr> --subject <s> [--attach <path>]... [--from-library <keywords>] [--origin comment|mail|kakao:<id>] (body on stdin)
//     stages the files, records a draft and prints the shared approval block (hub/draft-approval.ts) to post unchanged as an [ask].
//   send --draft <code>
//     sends only after the owner picked 1) 보내기 for exactly that draft (features/reply-drafts/lib/flow.ts sendDraft, the same check as the reply path).
// Attachments go out through the reply path's sender (zele `--attach`); a mail source that cannot send a new mail is refused at compose time.
import { existsSync, statSync } from "node:fs";
import { addressesOf, lintReply } from "./reply-draft.ts";
import { appEntries, instanceIdOf, readAppsFile } from "./integrations.ts";
import { type HubLike, notifyGateway } from "./followup.ts";
import { commentsDir, createStore } from "./comments/store.ts";
import { askText, sendDraft, toneKey, type FlowDeps } from "../features/reply-drafts/lib/flow.ts";
import { listLibrary, rankLibrary, LIBRARY_PICK_MAX } from "../features/reply-drafts/lib/library.ts";
import { addStagedFile, STAGED_MAX } from "../features/reply-drafts/lib/staged.ts";
import { dataDir, loadSettings, loadStyle, validApp } from "../features/reply-drafts/lib/settings.ts";
import { addDraft, getDraft, newId, type DraftRec } from "../features/reply-drafts/lib/store.ts";

export type MailCliDeps = FlowDeps & { hub?: HubLike };
type Out = { lines: string[]; code: number; notes?: string[] };

const USAGE = "usage: mail-cli.ts compose --app <mail app> --to <addr> --subject <s> [--attach <path>]... [--from-library <keywords>] [--origin comment|mail|kakao:<id>] (body on stdin) | send --draft <code>";
const MULTI = new Set(["--attach"]);
const WEBMAIL = /^webmail[:/-]([a-z0-9-]+)$/;

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

// The mail source that sends for an instance: zele (the default, or an instance filtered to it) or a webmail-no-api site.
function sourceOf(app: string): { source: string } | { error: string } {
	if (!validApp(app) || !instanceIdOf("mail", app)) return { error: `메일 앱 이름이 아니에요: ${app}` };
	const raw = readAppsFile(dataDir())[app];
	if (app !== "mail" && (!raw || raw.deleted || !appEntries(dataDir()).some(e => e.key === app))) return { error: `그런 메일 앱이 없어요: ${app}` };
	if (raw?.off) return { error: `${app} 앱이 꺼져 있어요` };
	const src = (raw?.filter?.source ?? "").trim().toLowerCase();
	if (!src || src === "zele") return { source: "zele" };
	const site = WEBMAIL.exec(src)?.[1];
	return site ? { source: `webmail:${site}` } : { error: `이 메일 앱(${src})은 새 메일 초안을 지원하지 않아요. 직접 보내야 해요` };
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

export async function runMailCli(args: string[], stdin: string, deps: MailCliDeps = {}): Promise<Out> {
	const [cmd, ...more] = args;
	const { flags } = parse(more);
	const one = (k: string) => flags[k]?.[0]?.trim() || undefined;
	if (cmd === "send") {
		const id = one("--draft");
		if (!id) return { lines: [USAGE], code: 2 };
		const rec = getDraft(id);
		if (rec && !rec.compose) return { lines: ["이 초안은 받은 메일의 답장이에요. features/reply-drafts/bin/draft.ts send로 보내 주세요"], code: 2 };
		const r = await sendDraft(id, deps);
		if (r.ok && rec) await notifyGateway({ path: "/api/mail/compose", body: { ref: rec.id, source: rec.source, state: "sent" } }, deps.hub);
		return { lines: [r.text], code: r.ok ? 0 : 1 };
	}
	if (cmd !== "compose") return { lines: [USAGE], code: 2 };

	const app = one("--app");
	const subject = one("--subject");
	const to = addressesOf(flags["--to"]?.[0]);
	const body = stdin.replace(/\r\n?/g, "\n").trim();
	if (!app || !subject || !to.length || !body) return { lines: [USAGE], code: 2 };
	const via = sourceOf(app);
	if ("error" in via) return { lines: [via.error], code: 2 };
	const origin = originOf(one("--origin"));
	if (origin && "error" in origin) return { lines: [origin.error], code: 2 };

	const paths: string[] = [];
	for (const p of flags["--attach"] ?? []) {
		if (!existsSync(p) || !statSync(p).isFile()) return { lines: [`첨부파일을 찾지 못했어요: ${p}`], code: 2 };
		paths.push(p);
	}
	const notes: string[] = [];
	let libraryMiss = false;
	const keywords = one("--from-library");
	if (keywords) {
		const folder = loadSettings().attachFolders?.[app];
		if (!folder) return { lines: [`${app}에 첨부 파일 폴더가 정해져 있지 않아요 (설정 > 첨부 파일 폴더)`], code: 2 };
		const found = rankLibrary(listLibrary(folder), { subject: keywords, text: keywords }).filter(r => r.score > 0).slice(0, LIBRARY_PICK_MAX);
		for (const r of found) if (!paths.includes(r.file.path)) paths.push(r.file.path);
		if (!found.length) {
			libraryMiss = true;
			notes.push(`확인: 첨부 파일 폴더에서 '${keywords}'에 맞는 파일을 찾지 못했어요`);
		}
	}
	if (paths.length > STAGED_MAX) return { lines: [`첨부파일은 ${STAGED_MAX}개까지 붙일 수 있어요`], code: 2 };

	const item = { kind: "mail" as const, app, from: to.join(", "), text: body };
	const draft = { to: to.join(", "), subject, body };
	const failures = lintReply(draft, item, loadStyle(toneKey({ app })));
	if (failures.length) return { lines: [`초안 검사에서 걸렸어요: ${failures.join("; ")}`], code: 1 };

	const id = newId();
	for (const p of paths) addStagedFile(id, p);
	const rec: DraftRec = { id, kind: "mail", app, source: via.source, mailId: `compose-${id}`, ref: `compose-${id.toLowerCase()}`, compose: true, ...(libraryMiss ? { libraryMiss: true } : {}), ...(origin ? { origin } : {}), ...draft, status: "pending", created: (deps.now ?? (() => new Date()))().toISOString(), changes: [], questions: [], item };
	addDraft(rec);
	await notifyGateway({ path: "/api/mail/compose", body: { ref: id, source: via.source, app, to: draft.to, subject, ...(origin ? { origin: origin.text } : {}) } }, deps.hub);
	return { lines: [askText(rec, [])], code: 0, notes };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const stdin = args[0] === "compose" ? await Bun.stdin.text() : "";
	try {
		const out = await runMailCli(args, stdin);
		for (const l of out.lines) (out.code === 0 ? console.log : console.error)(l);
		for (const n of out.notes ?? []) console.error(n);
		process.exit(out.code);
	} catch (e) {
		console.error(`실패했어요: ${(e as Error).message}`);
		process.exit(1);
	}
}
