// Sending an approved draft. Routed by the mail's source: the mail CLI replies to that mail id; a webmail-no-api site goes through
// that feature's own draft/approve/send commands; anything else is refused with a plain message (the user sends it by hand).
// Comment replies are not sent from here (the youtube-instagram job flow posts them). The runner is injected.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MailSearch } from "../../../hub/comments/mail-match.ts";
import { log } from "../../../hub/config.ts";
import { msg } from "../../../hub/i18n.ts";
import { type AppRaw, readAppsFile } from "../../../hub/integrations.ts";
import { loadPlugins, pluginNeedsAccount, pluginReply, pluginRepliesWithFiles, pluginsLoaded, pluginsReply } from "../../../hub/plugins.ts";
import { dataDir } from "./settings.ts";
import { recipientList } from "./recipients.ts";
import { stagedFiles } from "./staged.ts";
import type { DraftRec } from "./store.ts";
import type { Runner } from "./tone.ts";

export type SendOutcome = { ok: boolean; message: string };

const WEBMAIL_MAIL = join(import.meta.dir, "..", "..", "webmail-no-api", "bin", "mail.ts");
const MANUAL = "이 메일은 여기서 보낼 수 없어서 직접 보내야 해요. 초안은 위에 있는 글을 그대로 쓰면 돼요";

// zele refuses a reply unless `zele mail read <id>` ran first and showed the latest message of the thread; --to overrides the recipients
// (one address or a comma list) and --cc adds 참조.
// `--account` is always passed when the mail's account is known: with two zele accounts every command without it ends in "Multiple accounts matched".
const accountArgv = (account?: string): string[] => (account ? ["--account", account] : []);
export const readArgv = (mailId: string, account?: string): string[] => ["zele", "mail", "read", mailId, ...accountArgv(account)];
const ccArgv = (cc: readonly string[]): string[] => (cc.length ? ["--cc", cc.join(", ")] : []);
// A new mail (hub/mail-cli.ts compose): no mail to answer, so no `mail read` first.
export const sendArgv = (to: string, subject: string, body: string, files: string[] = [], cc: string[] = [], account?: string): string[] => ["zele", "mail", "send", ...accountArgv(account), "--to", to, "--subject", subject, ...ccArgv(cc), "--body", body, ...files.flatMap(f => ["--attach", f])];
export const replyArgv = (mailId: string, to: string, body: string, files: string[] = [], cc: string[] = [], account?: string): string[] => ["zele", "mail", "reply", mailId, ...accountArgv(account), "--to", to, ...ccArgv(cc), "--body", body, ...files.flatMap(f => ["--attach", f])];

// The zele account a mail belongs to: the one the draft recorded, else the one the stored mail came to (mail-conversations.json, read as plain
// data so the CLI process needs no gateway), else the account of the app instance (custom/apps.json filter.account). A new mail takes the account
// of the mail it follows. Never guessed: settleAccount goes on from here with what zele itself can tell.
type StoredMail = { key?: string; source?: string; account?: string; to?: string };
// undefined: the file is there but unreadable, so it can say nothing either way.
function storedMails(): StoredMail[] | undefined {
	try {
		const all: unknown = JSON.parse(readFileSync(join(dataDir(), "mail-conversations.json"), "utf8"));
		if (!Array.isArray(all)) throw new Error("not a list");
		return all as StoredMail[];
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		console.error(`reply draft: stored mails not read: ${(e as Error).message}`);
		return undefined;
	}
}
const storedMail = (ref: string): StoredMail | undefined => storedMails()?.find(r => r.key === ref);
export const mailAccountOf = (ref: string): string | undefined => storedMail(ref)?.account || undefined;
// A draft's `app` is its tone profile (`mail`), so a category mail (source orders = instance mail-orders) finds its instance by the source. `zele` is the
// whole mailbox, not a category: an instance with that source says nothing about which account one mail came to.
export function appAccountOf(app: string, source?: string): string | undefined {
	const apps = readAppsFile(dataDir());
	const own = apps[app]?.filter?.account?.trim();
	if (own || !source || source === "zele") return own || undefined;
	const named = new Set(Object.values(apps).flatMap(a => (!a.deleted && a.filter?.source?.trim().toLowerCase() === source.toLowerCase() && a.filter.account?.trim() ? [a.filter.account.trim()] : [])));
	return named.size === 1 ? [...named][0] : undefined;
}
type AccountRec = Pick<DraftRec, "account" | "compose" | "ref" | "app"> & Partial<Pick<DraftRec, "source" | "origin">>;
const originAccount = (rec: AccountRec) => (rec.origin?.kind === "mail" ? mailAccountOf(rec.origin.id) : undefined);
// A new mail of a category instance with no account of its own: the one account its stored mails came to, else the account of the one whole mailbox
// instance (no category, no narrowing; the built-in mail counts until it is deleted). Anything less settles nothing. Only for a new mail: a received one
// has better evidence (the thread opens on its account).
function categoryAccountOf(app: string): string | undefined {
	const apps = readAppsFile(dataDir());
	const category = apps[app]?.filter?.source?.trim().toLowerCase();
	if (!category || category === "zele") return undefined;
	const mails = storedMails();
	if (!mails) return undefined;
	const came = new Set(mails.flatMap(r => (r.source?.toLowerCase() === category && r.account ? [r.account] : [])));
	if (came.size) return came.size === 1 ? [...came][0] : undefined;
	const whole = (id: string, a: AppRaw) => !a.deleted && (id === "mail" || a.app === "mail") && [undefined, "", "zele"].includes(a.filter?.source?.trim().toLowerCase()) && !a.filter?.conv && !a.filter?.text && !a.filter?.data && !a.filter?.watches && !a.watches;
	const boxes = Object.entries<AppRaw>({ mail: {}, ...apps }).filter(([id, a]) => whole(id, a));
	return boxes.length === 1 ? boxes[0]![1].filter?.account?.trim() || undefined : undefined;
}
export const zeleAccountOf = (rec: AccountRec): string | undefined => rec.account || (rec.compose ? originAccount(rec) : mailAccountOf(rec.ref)) || appAccountOf(rec.app, rec.source) || (rec.compose ? categoryAccountOf(rec.app) : undefined);

// The one logged-in account the stored mail was addressed to: all an older stored mail, with no account of its own, can tell.
function addressedLogin(rec: Pick<DraftRec, "ref">, logins: string[]): string | undefined {
	const to = storedMail(rec.ref)?.to?.toLowerCase() ?? "";
	const hits = logins.filter(a => to.includes(a.toLowerCase()));
	return hits.length === 1 ? hits[0] : undefined;
}

const ADDRESS = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
export const zeleLogins = async (run: Runner): Promise<string[]> => {
	// No zele at all reads as no accounts.
	const r = await run(["zele", "whoami"]).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));
	return r.code === 0 ? [...new Set(r.stdout.match(ADDRESS) ?? [])] : [];
};
// Category mails are posted as "<thread id>.<message count>"; a source `zele` already posts the thread id.
export const threadIdOf = (source: string, id: string): string => (source === "zele" ? id : id.replace(/\.\d+$/, ""));
const threadOf = (rec: DraftRec) => threadIdOf(rec.source, rec.mailId);
/**
 * The account a send goes through. With several accounts and no record of it: the one account the stored mail was addressed to, else the one
 * account that can open the thread. `several` = they are named and none could be settled; with one account zele needs no choice.
 */
export async function settleAccount(rec: DraftRec, run: Runner): Promise<{ account?: string; several?: string[] }> {
	const known = zeleAccountOf(rec);
	if (known) return { account: known };
	const logins = await zeleLogins(run);
	if (logins.length < 2) return {};
	if (rec.compose) return { several: logins };
	const addressed = addressedLogin(rec, logins);
	if (addressed) return { account: addressed };
	const holders: string[] = [];
	for (const a of logins) if ((await run(readArgv(threadOf(rec), a))).code === 0) holders.push(a);
	return holders.length === 1 ? { account: holders[0] } : { several: logins };
}

// Whether a mail of this source goes out through a zele account, so several accounts leave a choice: zele itself and a plugin that says so (needsAccount).
// Any other plugin sends from its own mailbox, however many accounts zele has here: nothing can be asked of it, and holding its draft would stop a mail that goes out fine.
export async function sendsThroughZele(source: string): Promise<boolean> {
	if (source === "zele") return true;
	if (webmailSite(source)) return false;
	if (!pluginsLoaded()) await loadPlugins(dataDir());
	return pluginNeedsAccount(source);
}

// A webmail-no-api site: "webmail:<site>" (a new mail composed for it), or the plain site name its watch posts as the mail's `source`
// (features/webmail-no-api/lib/watchkit.ts postToGateway) when this install onboarded that site.
export const webmailSite = (source: string): string | undefined =>
	/^webmail[:/]([a-z0-9-]+)$/.exec(source)?.[1] ?? (/^[a-z0-9][a-z0-9-]{0,39}$/.test(source) && existsSync(join(dataDir(), "custom", "webmail", source, "spec.json")) ? source : undefined);

// The text of one mail for the gateway offer: zele reads it by id, a webmail-no-api site through its own read command; any other source has none
// unless it names a zele account.
export async function readMailBody(source: string, id: string, run: Runner, account?: string): Promise<string | undefined> {
	const site = webmailSite(source);
	// Any other source reads through zele only when its mail app names an account and zele is installed (`zele mail read` does not mark mail read).
	const viaZele = source === "zele" || (!site && !!account && !!Bun.which("zele"));
	const argv = site ? ["bun", WEBMAIL_MAIL, site, "read", id] : viaZele ? readArgv(threadIdOf(source, id), account) : undefined;
	if (!argv) return undefined;
	const r = await run(argv);
	return r.code === 0 && r.stdout.trim() ? r.stdout : undefined;
}

// Up to 5 earlier mails from one sender, one line each (`<date> <subject>: <snippet>`), the thread being drafted left out. Read-only (zele mail search).
const HISTORY_MAX = 5, HISTORY_SNIPPET = 200;
export async function senderHistory(search: MailSearch, address: string, account?: string, thread?: string): Promise<string[]> {
	const items = await search.search(`from:${address}`, account);
	return items.filter(m => m.id !== thread).slice(0, HISTORY_MAX).map(m => `${m.date ?? ""} ${m.subject}: ${m.snippet.replace(/\s+/g, " ").trim().slice(0, HISTORY_SNIPPET)}`.trim());
}

// hub/zele.ts (also behind mail-match.ts) loads only here: it reads config.json on import, and the onboard CLIs that reach this file run before one exists.
export const zeleHistory = async (address: string, account?: string, thread?: string): Promise<string[]> => {
	if (!Bun.which("zele")) return [];
	const [{ zeleMailSearch }, { zeleAccounts }] = await Promise.all([import("../../../hub/comments/mail-match.ts"), import("../../../hub/zele.ts")]);
	return senderHistory(zeleMailSearch(zeleAccounts), address, account, thread);
};

// Whether a mail source can send the files staged for a draft: zele can (`mail reply --attach`), a webmail-no-api site cannot (its adapter only saves a text draft),
// another source only when its custom plugin says so (hub/plugins.ts repliesWithFiles; docs/custom-plugins.md).
export const canAttach = (source: string): boolean => source === "zele" || (!webmailSite(source) && pluginRepliesWithFiles(source));

const fail = (message: string): SendOutcome => ({ ok: false, message });
// Node prints its warnings first on stderr; they must not stand in for the reason the owner reads.
const NODE_NOISE = /^\(node:\d+\) |^\(Use `node --trace-warnings/;
// The tool's own words (English, often with stack lines) never reach the owner: they go to the log, and the owner reads one short reason.
const LOGIN_LOST = /invalid_grant|token.*(expired|revoked)|not (logged|signed) in|unauthori[sz]ed|\b401\b|re-?auth/i;
const OFFLINE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up|offline/i;
export const sendReasonKey = (raw: string): keyof ReturnType<typeof msg>["sendFail"] => (LOGIN_LOST.test(raw) ? "login" : OFFLINE.test(raw) ? "offline" : "other");
const tail = (r: { stdout: string; stderr: string }): string => {
	const raw = (r.stderr.split("\n").filter(l => !NODE_NOISE.test(l)).join("\n").trim() || r.stdout.trim()).slice(0, 2000);
	if (raw) log(`reply draft: mail tool failed: ${raw}`);
	return msg().sendFail[sendReasonKey(raw)];
};

export async function sendWith(rec: DraftRec, run: Runner): Promise<SendOutcome> {
	if (rec.kind !== "mail") return fail(MANUAL);
	const files = stagedFiles(rec.id), cc = rec.cc ?? [];
	if (rec.source !== "zele" && !webmailSite(rec.source) && !pluginsLoaded()) await loadPlugins(dataDir());
	if (files.length && !canAttach(rec.source)) return fail("이 메일은 첨부파일을 보낼 수 없어서 보내지 않았어요. 첨부를 빼거나 직접 보내야 해요");
	// This site's adapter saves a text draft with one recipient and no 참조: sending it would drop the rest without a word.
	if (webmailSite(rec.source) && (cc.length || recipientList(rec.to).length > 1))
		return fail("이 웹메일은 참조나 여러 받는 사람에게 보낼 수 없어요. 받는 사람을 한 명만 남기고 참조를 비우면 보내요");
	const settled = (await sendsThroughZele(rec.source)) ? await settleAccount(rec, run) : {};
	if (settled.several) return fail(`메일 계정이 ${settled.several.join(", ")} 여러 개인데 이 메일이 어느 계정 것인지 알 수 없어서 보내지 않았어요. 초안은 그대로 있어요`);
	const account = settled.account;
	if (rec.compose && rec.source === "zele") {
		const r = await run(sendArgv(rec.to, rec.subject ?? "", rec.body, files.map(f => f.path), cc, account));
		return r.code === 0 ? { ok: true, message: `${rec.to}에게 메일을 보냈어요` } : fail(`보내지 못했어요: ${tail(r)}`);
	}
	if (rec.source === "zele") {
		const seen = await run(readArgv(rec.mailId, account));
		if (seen.code !== 0) return fail(`보내기 전에 메일을 읽지 못해서 보내지 않았어요: ${tail(seen)}`);
		const r = await run(replyArgv(rec.mailId, rec.to, rec.body, files.map(f => f.path), cc, account));
		if (r.code === 0) return { ok: true, message: `${rec.to}에게 답장을 보냈어요` };
		return fail(`보내지 못했어요. 그 사이 새 메일이 왔다면 이 초안은 낡은 거예요. 다시 초안을 만들어야 해요: ${tail(r)}`);
	}
	const site = webmailSite(rec.source);
	if (!site) {
		// With no plugin that sends replies the answer is the same whoever's mailbox it is: no `zele whoami` (a CLI that can take seconds) to find out.
		if (rec.compose || !pluginsReply()) return fail(MANUAL);
		// A plugin that did not ask for an account (needsAccount) may not send through zele at all: it gets what is on record and refuses the rest itself.
		const mailbox = account ?? zeleAccountOf(rec) ?? addressedLogin(rec, await zeleLogins(run));
		const sent = await pluginReply({ source: rec.source, id: rec.mailId, ...(mailbox ? { account: mailbox } : {}), to: rec.to, ...(cc.length ? { cc: cc.join(", ") } : {}), ...(rec.mode === "all" ? { all: true } : {}), ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, attachments: files.map(f => ({ name: f.name, path: f.path, size: f.size })) });
		return sent ?? fail(MANUAL);
	}
	const saved = await run(["bun", WEBMAIL_MAIL, site, "draft", rec.to, rec.subject ?? "", rec.body]);
	const id = /초안 저장:\s*(\S+)/.exec(saved.stdout)?.[1];
	if (saved.code !== 0 || !id) return fail(`웹메일 초안을 만들지 못했어요: ${tail(saved)}`);
	const approved = await run(["bun", WEBMAIL_MAIL, site, "approve"]);
	if (approved.code !== 0) return fail(`웹메일 전송 승인을 기록하지 못했어요: ${tail(approved)}`);
	const sent = await run(["bun", WEBMAIL_MAIL, site, "send", id]);
	return sent.code === 0 ? { ok: true, message: `${rec.to}에게 답장을 보냈어요` } : fail(`보내지 못했어요: ${tail(sent)}`);
}
