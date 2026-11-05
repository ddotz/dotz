// Mailboxes (docs/mailbox.md): the boxes of a mail account, the rules that place a new mail in one, and the owner's pins of a conversation.
// `<data dir>/custom/mailboxes.json` is the only store; a missing or broken file means no boxes (every mail is in the implicit base box).
// Leaf module: hub/mail.ts imports it (trackBox), so it never imports hub/mail.ts; the parts that need the mail records or the app
// instances are in hub/routes-mailbox.ts.
// No hub/config.ts either: its import reads config.json, and the reply-draft code that imports this also runs in setup CLIs before an install has one.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_ID = "base";
export type MailboxWhy = { kind: "from" | "subj" | "body" | "src" | "judge" | "moved" | "thread"; value?: string };
export type BoxMode = "auto" | "ask" | "notify" | "quiet";
export type Box = {
	id: string; name: string; icon: string; mode?: BoxMode; notify: boolean; base?: true;
	conds: { from: string[]; subj: string[]; body: string[]; src: string[] }; not: { from: string[] };
	judge: { on: boolean; text: string }; how: string; greets: { who: string; addr: string; hello: string }[]; folders: string[]; bans: string[];
	rules: Record<string, unknown>[]; /** uses only its own `how` and `rules` and folders, none of the account's (an instance folded by hub/mailbox-cli.ts that had its own) */ alone?: true;
};
export type Mailboxes = { version: 1; accounts: Record<string, { boxes: Box[] }>; pins: Record<string, string> };
/** What the hub does with a new mail: `box` is set only for a non-base box; `quiet` = mode quiet (no notice, thread, wake or draft), `mute` = notify:false (no notice only). */
export type Placed = { box?: string; why?: MailboxWhy; quiet?: true; mute?: true };

export const MAX_BOXES = 50, MAX_LIST = 100, MAX_PINS = 5000, MAX_ACCOUNTS = 100;
const MODES: readonly string[] = ["auto", "ask", "notify", "quiet"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, len = 200): string[] => (Array.isArray(v) ? v.map(x => text(x, len)).filter(Boolean).slice(0, MAX_LIST) : []);

export const implicitBase = (): Box => ({ id: BASE_ID, name: "일반", icon: "mail", notify: true, base: true, conds: { from: [], subj: [], body: [], src: [] }, not: { from: [] }, judge: { on: false, text: "" }, how: "", greets: [], folders: [], bans: [], rules: [] });

/** A box from untrusted input (the file, a route body); undefined when it has no usable id or name. Lists and strings are cut to their caps. */
export function cleanBox(raw: unknown): Box | undefined {
	if (!isObj(raw)) return undefined;
	const base = raw.base === true || raw.id === BASE_ID, id = base ? BASE_ID : text(raw.id, 40), name = text(raw.name, 40) || (base ? "일반" : "");
	if (!/^[\w-]{1,40}$/.test(id) || !name) return undefined;
	const conds = isObj(raw.conds) ? raw.conds : {}, judge = isObj(raw.judge) ? raw.judge : {};
	return {
		id, name, icon: text(raw.icon, 30) || "mail", ...(MODES.includes(raw.mode as string) ? { mode: raw.mode as BoxMode } : {}), notify: raw.notify !== false, ...(base ? { base: true as const } : {}),
		conds: { from: list(conds.from), subj: list(conds.subj), body: list(conds.body), src: list(conds.src) }, not: { from: list(isObj(raw.not) ? raw.not.from : undefined) },
		judge: { on: judge.on === true, text: text(judge.text, 500) }, how: text(raw.how, 4000),
		greets: (Array.isArray(raw.greets) ? raw.greets : []).filter(isObj).map(g => ({ who: text(g.who, 200), addr: text(g.addr, 200), hello: text(g.hello, 200) })).filter(g => g.who || g.addr || g.hello).slice(0, MAX_LIST),
		folders: list(raw.folders, 500), bans: list(raw.bans),
		rules: (Array.isArray(raw.rules) ? raw.rules : []).filter(isObj).filter(r => JSON.stringify(r).length <= 4000).slice(0, MAX_LIST),
		...(raw.alone === true ? { alone: true as const } : {}),
	};
}

const empty = (): Mailboxes => ({ version: 1, accounts: {}, pins: {} });
function parse(v: unknown): Mailboxes {
	const out = empty();
	if (!isObj(v)) return out;
	for (const [inst, a] of Object.entries(isObj(v.accounts) ? v.accounts : {}).slice(0, MAX_ACCOUNTS)) {
		if (!inst || inst.length > 60 || !isObj(a) || !Array.isArray(a.boxes)) continue;
		const seen = new Set<string>(), boxes: Box[] = [];
		for (const b of a.boxes.slice(0, MAX_BOXES)) {
			const box = cleanBox(b);
			if (box && !seen.has(box.id)) boxes.push(box), seen.add(box.id);
		}
		out.accounts[inst] = { boxes };
	}
	const pins = Object.entries(isObj(v.pins) ? v.pins : {}).filter(([k, b]) => k.length <= 300 && typeof b === "string" && b.length <= 40);
	out.pins = Object.fromEntries(pins.slice(-MAX_PINS) as [string, string][]);
	return out;
}

const fileOf = (dir: string) => join(dir, "custom", "mailboxes.json");
const cache = new Map<string, { sig: string; store: Mailboxes }>();
/** The store as it is on disk now (read again only when the file changed). The result is shared: copy it (`structuredClone`) before changing it. */
export function loadMailboxes(dir: string): Mailboxes {
	const file = fileOf(dir);
	let sig: string;
	try {
		const st = statSync(file);
		sig = `${st.ino}:${st.mtimeMs}:${st.size}`;
	} catch {
		// no file = no boxes
		cache.delete(file);
		return empty();
	}
	const hit = cache.get(file);
	if (hit?.sig === sig) return hit.store;
	let store = empty();
	try {
		store = parse(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		console.error(`mailbox: ${file} unreadable, no mailboxes: ${error}`);
	}
	cache.set(file, { sig, store });
	return store;
}
export function saveMailboxes(dir: string, store: Mailboxes): void {
	mkdirSync(join(dir, "custom"), { recursive: true });
	const file = fileOf(dir), tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
	renameSync(tmp, file);
	cache.delete(fileOf(dir));
}

/** The boxes of one account (instance id): the stored ones, with the implicit base box in front when none of them is the base. */
export function boxesOf(dir: string, instance: string): Box[] {
	const stored = loadMailboxes(dir).accounts[instance]?.boxes ?? [];
	return stored.some(b => b.base) ? stored : [implicitBase(), ...stored];
}

/** Whether any account has a mailbox besides its base box (one cached stat): what per-mailbox learning waits for. */
export const hasBoxes = (dir: string): boolean => Object.values(loadMailboxes(dir).accounts).some(a => a.boxes.some(b => !b.base));

/** What the rules read of a mail: its source, sender, subject, and the summary and body the post carried. */
export type MailFacts = { src: string; from: string; subj: string; body: string };
const lc = (s: string) => s.trim().toLowerCase();
const addrs = (from: string) => from.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
/** `a@b.c` = that address, `@b.c` = any address of the domain, anything else = a part of the sender text (a name). */
const fromHit = (from: string, pattern: string): boolean => {
	const p = lc(pattern);
	if (!p) return false;
	if (p.startsWith("@")) return addrs(from).some(a => a.slice(a.indexOf("@")) === p);
	return p.includes("@") ? addrs(from).includes(p) : from.toLowerCase().includes(p);
};
/** The first rule of `b` the mail meets: source (exact), sender, subject, body; a sender in `not.from` vetoes the whole box. */
function ruleOf(b: Box, m: MailFacts): MailboxWhy | undefined {
	if (b.base || b.not.from.some(p => fromHit(m.from, p))) return undefined;
	const src = b.conds.src.find(s => lc(s) === lc(m.src));
	if (src) return { kind: "src", value: src };
	const from = b.conds.from.find(p => fromHit(m.from, p));
	if (from) return { kind: "from", value: from };
	const subj = b.conds.subj.find(k => lc(k) && m.subj.toLowerCase().includes(lc(k)));
	if (subj) return { kind: "subj", value: subj };
	const body = b.conds.body.find(k => lc(k) && m.body.toLowerCase().includes(lc(k)));
	return body ? { kind: "body", value: body } : undefined;
}
/** Rules 2 and 3 of docs/mailbox.md: the first box (in order) with a rule the mail meets, else the base box. Pure. */
export function pickBox(mail: MailFacts, boxes: readonly Box[]): { box: Box; why?: MailboxWhy } {
	for (const b of boxes) {
		const why = ruleOf(b, mail);
		if (why) return { box: b, why };
	}
	return { box: boxes.find(b => b.base) ?? implicitBase() };
}
/** The non-base box whose `conds.src` names this source (how old mail with no box is read). */
export const boxOfSource = (boxes: readonly Box[], source: string): Box | undefined => boxes.find(b => !b.base && b.conds.src.some(s => lc(s) === lc(source)));

// A poster's trailing `.N` message count is not part of the thread; `zele` already posts the thread id (same rule as features/reply-drafts/lib/senders.ts
// threadIdOf, which cannot be imported here without a cycle).
export const conversationOf = (source: string, id: string): string => (source === "zele" ? id : id.replace(/\.\d+$/, ""));
const convKey = (source: string, id: string) => `${source}|${conversationOf(source, id)}`;
/** `<instance>|<source>-<conversation>`: the source is part of it because one account can hold several sources with ids that repeat. */
export const pinKey = (instance: string, source: string, id: string) => `${instance}|${source}-${conversationOf(source, id)}`;

// conversation -> box id of the stored mail, "" for a stored mail with no box of its own (filled by hub/mail.ts at load and on every recordMail): rule 1 reads it, no file read per mail.
const convBox = new Map<string, string>();
/** Twice the most mail hub/mail.ts keeps, so dropping the oldest entry only forgets conversations whose mail is long gone. */
export const CONV_MAX = 40_000;
export const trackBox = (r: { source: string; id: string; mbox?: string; dir?: string }): void => {
	if (r.dir === "out") return;
	const key = convKey(r.source, r.id);
	convBox.delete(key);   // a Map keeps first insertion order: this makes the cap below forget the conversation quiet the longest
	convBox.set(key, r.mbox ?? "");
	if (convBox.size > CONV_MAX) convBox.delete(convBox.keys().next().value as string);
};
export const boxOfConv = (source: string, id: string): string | undefined => convBox.get(convKey(source, id));

/** Remembers the owner's move of a conversation past the eviction of its records; the oldest pins go over the cap. */
export function setPin(store: Mailboxes, instance: string, source: string, id: string, box: string): void {
	const k = pinKey(instance, source, id);
	delete store.pins[k];
	store.pins[k] = box;
	const keys = Object.keys(store.pins);
	for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PINS))) delete store.pins[old];
}

/** Adds a learned condition to a box (앞으로는 어떻게 할까요?): a `from` / `subj` condition or a `not.from` veto. False when it is empty, known, or the list is full. */
export function learnCond(box: Box, kind: "from" | "subj" | "not", value: string): boolean {
	const v = text(value, 200).toLowerCase(), to = kind === "not" ? box.not.from : box.conds[kind];
	if (!v || to.includes(v) || to.length >= MAX_LIST) return false;
	to.push(v);
	return true;
}
