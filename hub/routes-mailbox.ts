// The hub side of mailboxes (docs/mailbox.md): which account a mail is in, where a new mail goes, how a row finds its box, and the routes
// /api/mailbox/move, /learn and /box. The store and the rules are hub/mailbox.ts; mails are read and changed only through hub/mail.ts.
import { DATA_DIR } from "./config.ts";
import { appEntries, inConv, readAppsFile, type IntegrationEntry } from "./integrations.ts";
import { mailByKey, mailKeep, mailRecords, mailTarget, recordMail, type MailRecord } from "./mail.ts";
import { addressesOf } from "./mail-state.ts";
import {
	BASE_ID, boxesOf, boxOfConv, boxOfSource, cleanBox, conversationOf, learnCond, loadMailboxes, MAX_BOXES, pickBox, pinKey, saveMailboxes, setPin,
	type Box, type MailboxWhy, type Placed,
} from "./mailbox.ts";
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
	const kept = held ? boxes.find(b => b.id === held) : undefined;
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

/** /api/mailbox/*: the same stage of the route chain (and the same web login) as /api/mail/*. Not forwarded to peers. */
export async function mailboxRoute(req: Request, url: URL, dir = DATA_DIR): Promise<Response> {
	const route = `${req.method} ${url.pathname}`;
	if (route === "POST /api/mailbox/move") return moveRoute(dir, await body(req));
	if (route === "POST /api/mailbox/learn") return learnRoute(dir, await body(req));
	if (route === "PUT /api/mailbox/box") return putRoute(dir, await body(req));
	if (route === "DELETE /api/mailbox/box") return deleteRoute(dir, await body(req));
	return fail("not found", 404);
}
