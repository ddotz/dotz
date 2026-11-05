// The hub side of mailboxes (docs/mailbox.md): which account a mail is in, where a new mail goes, how a row finds its box, and the routes
// /api/mailbox/move, /learn, /box, /tone, /relearn, /examples and /suggest. The store and the rules are hub/mailbox.ts; mails are read and changed only through hub/mail.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { appEntries, inConv, readAppsFile, type IntegrationEntry } from "./integrations.ts";
import { mailByKey, mailKeep, mailRecords, mailTarget, recordMail, type MailRecord } from "./mail.ts";
import { addressesOf, subjectKey } from "./mail-state.ts";
import {
	BASE_ID, boxesOf, boxOfConv, boxOfSource, cleanBox, conversationOf, learnCond, loadMailboxes, MAX_BOXES, pickBox, pinKey, saveMailboxes, setPin,
	type Box, type MailboxWhy, type Placed,
} from "./mailbox.ts";
import { addressesOf as addressesIn } from "./reply-draft.ts";
import { body, json } from "./routes-util.ts";

const mailEntries = (dir: string): IntegrationEntry[] => appEntries(dir).filter(e => e.app === "mail" && !e.gone);
const instanceIn = (entries: readonly IntegrationEntry[], key: string): string => {
	const mine = entries.filter(e => inConv(e, mailTarget(key)));
	return (mine.find(e => e.created) ?? mine[0])?.key ?? "mail";
};
/** The mail account (app instance id) a mail key belongs to: the instance whose conversation prefix claims it, else the default `mail`. */
export const instanceOf = (dir: string, key: string): string => instanceIn(mailEntries(dir), key);

/** MailDeps.placeMail: rule 1 (pin, else the box of a stored mail of the conversation), 2 (the boxes' rules), 3 (base). Only a non-base box is named. */
export const placeMail = (dir: string) => (m: { key: string; source: string; id: string; from?: string; subject: string; summary?: string; body?: string }): Placed => {
	const boxes = boxesOf(dir, instanceOf(dir, m.key)), instance = instanceOf(dir, m.key);
	const held = loadMailboxes(dir).pins[pinKey(instance, m.source, m.id)] ?? boxOfConv(m.source, m.id);
	// "": the conversation is stored with no box of its own, so it stays where that mail reads: its source's box, else base.
	const kept = held ? boxes.find(b => b.id === held) : held === "" ? boxOfSource(boxes, m.source) ?? boxes.find(b => b.base) : undefined;
	const { box, why } = kept ? { box: kept, why: { kind: "thread" } as MailboxWhy } : pickBox({ src: m.source, from: m.from ?? "", subj: m.subject, body: `${m.summary ?? ""}\n${m.body ?? ""}` }, boxes);
	return { ...(box.base ? {} : { box: box.id, ...(why ? { why } : {}) }), ...(box.mode === "quiet" ? { quiet: true as const } : box.notify === false ? { mute: true as const } : {}) };
};

/** The box id (and why) a stored mail shows in: its own, else the owner's pin of its conversation, else its source's `conds.src` box, else base. One lookup table per pass. */
export function boxPass(dir: string): (m: MailRecord) => { box: string; boxWhy?: MailboxWhy } {
	const entries = mailEntries(dir), pins = loadMailboxes(dir).pins, byInstance = new Map<string, Box[]>();
	return m => {
		const instance = instanceIn(entries, m.key);
		const boxes = byInstance.get(instance) ?? (byInstance.set(instance, boxesOf(dir, instance)), byInstance.get(instance)!);
		if (m.mbox && boxes.some(b => b.id === m.mbox)) return { box: m.mbox, ...(m.mwhy ? { boxWhy: m.mwhy } : {}) };
		const pinned = pins[pinKey(instance, m.source, m.id)];
		if (pinned && boxes.some(b => b.id === pinned)) return { box: pinned, boxWhy: { kind: "moved" } };
		const bySource = boxOfSource(boxes, m.source);
		return bySource ? { box: bySource.id, boxWhy: { kind: "src", value: m.source } } : { box: BASE_ID };
	};
}

/** The facts of a past reply of the owner (features/reply-drafts/lib/settings.ts Pair). */
export type PastMail = { source: string; received: string; conv?: string; from?: string; subj?: string; account?: string };
/**
 * Which mailbox of `instance` each past reply of the owner belongs to, undefined for a reply of another account. Read fresh, never stored, so a move, an undo or a deleted box is
 * right at once: the pin of its conversation, else where the stored mail it answered is now, else `remembered` (a reply learned there, whose mail left the store), else the boxes' rules.
 * A source with no conversation ids is matched by sender and subject.
 */
export function pastPass(dir: string, instance: string): (p: PastMail, remembered?: string) => string | undefined {
	const entries = mailEntries(dir), boxes = boxesOf(dir, instance), pins = loadMailboxes(dir).pins, shown = boxPass(dir), held = new Map<string, string>(), owners = new Map<string, string>();
	const apps = readAppsFile(dir), addr = (s?: string): string | undefined => addressesIn(s)[0]?.toLowerCase();
	const named = new Map(entries.flatMap(e => { const a = addr(apps[e.key]?.filter?.account); return a ? [[a, e.key] as const] : []; })), plain = entries.find(e => !apps[e.key]?.filter?.account)?.key ?? "mail";
	const known = (id: string | undefined): id is string => !!id && boxes.some(b => b.id === id);
	const talk = (from?: string, subj?: string): string => (from && subj ? `${addr(from) ?? ""}|${subjectKey(subj)}` : "");
	for (const r of mailRecords()) {
		if (r.dir === "out") continue;
		owners.set(r.source.replace(/^webmail[:/]/, ""), instanceIn(entries, r.key));
		const { box, boxWhy } = shown(r);
		if (box === BASE_ID && !boxWhy) continue;   // the base box with no reason says nothing: the rules decide
		held.set(`${r.source}|${conversationOf(r.source, r.id)}`, box);
		held.set(talk(r.from, r.subject), box);
	}
	return (p, remembered) => {
		if ((p.source === "zele" ? named.get(addr(p.account) ?? "") ?? plain : owners.get(p.source) ?? instanceIn(entries, `${p.source}-0`)) !== instance) return undefined;
		const kept = [p.conv ? pins[pinKey(instance, p.source, p.conv)] : undefined, p.conv ? held.get(`${p.source}|${conversationOf(p.source, p.conv)}`) : undefined, held.get(talk(p.from, p.subj)), remembered].find(known);
		return kept ?? pickBox({ src: p.source, from: p.from ?? "", subj: p.subj ?? "", body: p.received }, boxes).box.id;
	};
}

/** A judge hit (features/reply-drafts/lib/offer.ts): the stored mail `key` is placed in `box` with `mwhy` kind judge. False when no such record is stored, or the owner moved it meanwhile. */
export function placeByJudge(key: string, box: string): boolean {
	const r = mailByKey(key);
	if (!r || r.mwhy?.kind === "moved") return false;
	recordMail({ ...r, mbox: box, mwhy: { kind: "judge" } });
	return true;
}

/** A mail item of GET /api/integrations gains its account's mailboxes and the account address (`filter.account`, else the one zele login). */
export function withBoxes<T extends { key: string; app: string }>(item: T, dir = DATA_DIR): T {
	if (item.app !== "mail") return item;
	const named = readAppsFile(dir)[item.key]?.filter?.account?.trim(), logins = [...addressesOf("zele")];
	const account = named || (logins.length === 1 ? logins[0] : undefined);
	return { ...item, boxes: boxesOf(dir, item.key), ...(account ? { account } : {}) };
}

const fail = (error: string, status = 400) => json({ error }, status);
const isKey = (k: unknown): k is string => typeof k === "string" && /^[a-z0-9._-]+$/.test(k);
const drop = (r: MailRecord): MailRecord => {
	const { mbox: _b, mwhy: _w, ...rest } = r;
	return rest;
};

function moveRoute(dir: string, b: Record<string, any>): Response {
	if (!Array.isArray(b.keys) || !b.keys.length || b.keys.length > mailKeep() || !b.keys.every(isKey) || typeof b.box !== "string") return fail("keys and box are required");
	const picked = [...new Set(b.keys as string[])].map(k => mailByKey(k));
	if (picked.some(r => !r)) return fail("메일을 찾을 수 없어요", 404);
	const entries = mailEntries(dir), instances = new Set(picked.map(r => instanceIn(entries, r!.key)));
	if (instances.size !== 1) return fail("다른 계정의 메일은 한 번에 옮길 수 없어요");
	const instance = [...instances][0]!, target = boxesOf(dir, instance).find(x => x.id === b.box);
	if (!target) return fail("이 계정에 없는 메일함이에요");
	const conversations = new Map(picked.map(r => [`${r!.source}|${conversationOf(r!.source, r!.id)}`, r!]));
	const whole = mailRecords().filter(r => conversations.has(`${r.source}|${conversationOf(r.source, r.id)}`));
	const placed = boxPass(dir), was = Object.fromEntries(whole.map(r => [r.key, placed(r).box]));
	const store = structuredClone(loadMailboxes(dir));
	for (const r of conversations.values()) setPin(store, instance, r.source, r.id, target.id);
	saveMailboxes(dir, store);
	for (const r of whole) {
		const next = target.base ? drop(r) : { ...drop(r), mbox: target.id, mwhy: { kind: "moved" } as MailboxWhy };
		if (JSON.stringify(next) !== JSON.stringify(r)) recordMail(next);
	}
	return json({ ok: true, moved: whole.map(r => r.key), was });
}

function learnRoute(dir: string, b: Record<string, any>): Response {
	if (typeof b.box !== "string" || b.box === BASE_ID || !["from", "subj", "not"].includes(b.kind) || typeof b.value !== "string") return fail("box, kind (from, subj, not) and value are required");
	const store = structuredClone(loadMailboxes(dir)), box = Object.values(store.accounts).flatMap(a => a.boxes).find(x => x.id === b.box);
	if (!box) return fail("메일함을 찾을 수 없어요", 404);
	const added = learnCond(box, b.kind, b.value);
	if (added) saveMailboxes(dir, store);
	return json({ ok: true, added });
}

function putRoute(dir: string, b: Record<string, any>): Response {
	if (typeof b.app !== "string" || !mailEntries(dir).some(e => e.key === b.app)) return fail("메일 계정을 찾을 수 없어요", 404);
	const raw = b.box && typeof b.box === "object" ? b.box : undefined;
	if (!raw) return fail("box is required");
	const store = structuredClone(loadMailboxes(dir)), boxes = (store.accounts[b.app] ??= { boxes: [] }).boxes;
	const taken = new Set(boxes.map(x => x.id));
	let id: string = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
	while (!id || (taken.has(id) && !raw.id)) id = `b-${crypto.randomUUID().slice(0, 8)}`;
	const box = cleanBox({ ...raw, id });
	if (!box) return fail("name is required");
	const at = boxes.findIndex(x => x.id === box.id);
	if (at < 0 && boxes.length >= MAX_BOXES) return fail(`메일함은 계정마다 ${MAX_BOXES}개까지예요`);
	if (at >= 0) boxes[at] = box;
	else if (box.base) boxes.unshift(box);
	else boxes.push(box);
	saveMailboxes(dir, store);
	return json({ ok: true, box });
}

function deleteRoute(dir: string, b: Record<string, any>): Response {
	if (typeof b.app !== "string" || typeof b.id !== "string") return fail("app and id are required");
	if (b.id === BASE_ID) return fail("일반 메일함은 지울 수 없어요");
	const store = structuredClone(loadMailboxes(dir)), account = store.accounts[b.app];
	if (!account?.boxes.some(x => x.id === b.id)) return fail("메일함을 찾을 수 없어요", 404);
	account.boxes = account.boxes.filter(x => x.id !== b.id);
	for (const [k, v] of Object.entries(store.pins)) if (v === b.id && k.startsWith(`${b.app}|`)) delete store.pins[k];
	saveMailboxes(dir, store);
	const entries = mailEntries(dir);
	for (const r of mailRecords().filter(x => x.mbox === b.id && instanceIn(entries, x.key) === b.app)) recordMail(drop(r));
	return json({ ok: true });
}

// The tone files are features/reply-drafts' (`<data dir>/custom/reply-drafts/tone/<instance>/<box>.md`, sections `## 정체성` and `## 고친 점`); hub/mailbox-cli.ts already lays them out by path, and
// importing the feature here would add a hub -> features edge, so only these two sections are read.
const toneBullets = (file: string, heading: string): string[] => {
	if (!existsSync(file)) return [];
	const out: string[] = [];
	let on = false;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (/^## /.test(line)) on = line.trim() === heading;
		else if (on && /^\s*[-*]\s+\S/.test(line)) out.push(line.replace(/^\s*[-*]\s+/, "").trim());
	}
	return out;
};
/** GET /api/mailbox/tone?app=&box=: what a mailbox's tone file says, read when its settings item opens (never per card). The summary falls back to the instance's, then the install's profile like a draft does. */
async function toneRoute(dir: string, url: URL): Promise<Response> {
	const app = url.searchParams.get("app") ?? "", id = url.searchParams.get("box") ?? "";
	if (!mailEntries(dir).some(e => e.key === app) || !boxesOf(dir, app).some(x => x.id === id) || !/^[\w-]+$/.test(app)) return fail("메일함을 찾을 수 없어요", 404);
	const tone = join(dir, "custom", "reply-drafts", "tone"), own = join(tone, app, `${id}.md`);
	const summary = [own, join(tone, `${app}.md`), join(tone, "install.md")].map(f => toneBullets(f, "## 정체성")).find(l => l.length) ?? [];
	const { voiceOf } = await import("../features/reply-drafts/lib/box-voice.ts");
	return json({ ok: true, own: existsSync(own), summary: summary.join(" "), corrections: toneBullets(own, "## 고친 점"), voice: voiceOf(app, id) });
}

const findBox = (dir: string, app: unknown, id: unknown): Box | undefined => (typeof app === "string" && mailEntries(dir).some(e => e.key === app) ? boxesOf(dir, app).find(x => x.id === id) : undefined);

/** POST /api/mailbox/relearn {app, box}: the owner's 다시 배우기, one model call when the box has enough of his own mail; too few starts reading the sent folder and learning follows by itself. */
async function relearnRoute(dir: string, b: Record<string, any>): Promise<Response> {
	const box = findBox(dir, b.app, b.box);
	if (!box) return fail("메일함을 찾을 수 없어요", 404);
	const { relearnBox } = await import("../features/reply-drafts/lib/box-voice.ts");
	return json({ ok: true, ...(await relearnBox(b.app, box)) });
}

/** GET /api/mailbox/examples?app=&box=: the newest replies the owner wrote himself in this mailbox, with the mail each answered (예시 보기). */
async function examplesRoute(dir: string, url: URL): Promise<Response> {
	const app = url.searchParams.get("app"), box = findBox(dir, app, url.searchParams.get("box"));
	if (!box) return fail("메일함을 찾을 수 없어요", 404);
	const { voiceExamples } = await import("../features/reply-drafts/lib/box-voice.ts");
	return json({ ok: true, examples: voiceExamples(app!, box.id) });
}

// 묶음 제안: free-mail domains say nothing about a sender's kind, so they never form a group.
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com", "nate.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.kr", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "aol.com"]);
export const SUGGEST_MAX = 8, SUGGEST_MIN = 2, SUGGEST_SENDERS = 3, SUGGEST_KEYS = 100;
const SECOND_LEVEL = new Set(["co", "or", "ac", "go", "ne", "re", "pe", "com", "org", "net", "edu", "gov"]);
/** The name part of a domain: `mail.team.example.org` -> `example`, `x.co.kr` -> `x`. */
const labelOf = (domain: string): string => {
	const parts = domain.split(".");
	parts.pop();
	while (parts.length > 1 && SECOND_LEVEL.has(parts[parts.length - 1]!)) parts.pop();
	return parts[parts.length - 1] ?? domain;
};
const senderName = (from: string, addr: string): string => from.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim() || addr;

/** GET /api/mailbox/suggest?app=: one pass over the stored mail of the account that is still in its base box, grouped by sender domain, at most SUGGEST_MAX groups of SUGGEST_MIN mails or more. No model, no file read. */
function suggestRoute(dir: string, url: URL): Response {
	const app = url.searchParams.get("app") ?? "", entries = mailEntries(dir);
	if (!entries.some(e => e.key === app)) return fail("메일 계정을 찾을 수 없어요", 404);
	const placed = boxPass(dir), by = new Map<string, { count: number; names: Map<string, number>; keys: string[] }>(), keep = Math.min(SUGGEST_KEYS, mailKeep());
	for (const r of mailRecords()) {
		if (r.dir === "out" || instanceIn(entries, r.key) !== app || placed(r).box !== BASE_ID) continue;
		const addr = addressesIn(r.from)[0]?.toLowerCase(), domain = addr?.slice(addr.indexOf("@") + 1);
		if (!addr || !domain || FREE_MAIL.has(domain)) continue;
		const g = by.get(domain) ?? by.set(domain, { count: 0, names: new Map(), keys: [] }).get(domain)!;
		g.count++;
		const name = senderName(r.from, addr);
		g.names.set(name, (g.names.get(name) ?? 0) + 1);
		if (g.keys.length < keep) g.keys.push(r.key);
	}
	const groups = [...by].filter(([, g]) => g.count >= SUGGEST_MIN).sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1)).slice(0, SUGGEST_MAX)
		.map(([domain, g]) => ({ domain: `@${domain}`, label: labelOf(domain), count: g.count, senders: [...g.names].sort((a, b) => b[1] - a[1]).slice(0, SUGGEST_SENDERS).map(([n]) => n), keys: g.keys }));
	return json({ ok: true, groups });
}

/** /api/mailbox/*: the same stage of the route chain (and the same web login) as /api/mail/*. Not forwarded to peers. */
export async function mailboxRoute(req: Request, url: URL, dir = DATA_DIR): Promise<Response> {
	const route = `${req.method} ${url.pathname}`;
	if (route === "POST /api/mailbox/move") return moveRoute(dir, await body(req));
	if (route === "POST /api/mailbox/learn") return learnRoute(dir, await body(req));
	if (route === "PUT /api/mailbox/box") return putRoute(dir, await body(req));
	if (route === "DELETE /api/mailbox/box") return deleteRoute(dir, await body(req));
	if (route === "GET /api/mailbox/tone") return toneRoute(dir, url);
	if (route === "POST /api/mailbox/relearn") return relearnRoute(dir, await body(req));
	if (route === "GET /api/mailbox/examples") return examplesRoute(dir, url);
	if (route === "GET /api/mailbox/suggest") return suggestRoute(dir, url);
	return fail("not found", 404);
}
