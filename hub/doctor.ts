import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cardBlock } from "./choices.ts";
import { cfg, DATA_DIR, DEFAULTS, HOME, writeAtomic } from "./config.ts";
import { CHECKS as HEALTH, FILE_CHECKS } from "./doctor-checks.ts";
import { THRESHOLDS as T } from "./doctor-limits.ts";
import { type DoctorArea, type DoctorCheck, type DoctorCtx, DOCTOR_AREAS, EVIDENCE_CHARS, evidenceLines, type Finding, HEAD_CHARS, lineSubject, SUB_LINES, wrapLines } from "./doctor-types.ts";
import { fitSubject, shorten } from "./card-text.ts";
import { lang, msg } from "./i18n.ts";
import { type Catalog, en } from "./i18n-en.ts";
import { ko } from "./i18n-ko.ts";
import { baseLanguage } from "./language.ts";
import type { Notice as StoredNotice } from "./notices-types.ts";
import { ledger } from "./ledger.ts";
import { type Send, morningExtra, startLedger } from "./ledger-tick.ts";
import { promptHealth, runPromptHealth } from "./prompt-health.ts";
import { promptReviewCheck } from "./prompt-review.ts";
import { trackTimer } from "./shutdown.ts";
import { watchSubject } from "./watch-ask.ts";
import { HARNESS_RETRY_TITLE, SELF_UPDATE_CARD_TITLE } from "./worklog-kind.ts";

const DAY = 86400e3;
const FRESH_MS = 20 * 3600e3;
// Prompt health first: the review reads the growth it just measured to decide whether to run early.
const CHECKS: DoctorCheck[] = [...HEALTH, promptHealth, promptReviewCheck];

export type Told = { at: number; level: number };
/** `from`: the `lastRun` the last full run started from, so the morning re-look covers the same window as the night run. */
export type DoctorStore = { version: 1; lastRun: number; from?: number; memo: Record<string, unknown>; findings: Record<string, Finding>; told: Record<string, Told> };
export const storeFile = (dataDir: string): string => join(dataDir, "doctor.json");

const emptyStore = (): DoctorStore => ({ version: 1, lastRun: 0, memo: {}, findings: {}, told: {} });
const OLD_RULE = [/^(?<where>.+?)의 '(?<line>.*)' 줄을 지울까요\? 같은 규칙을 (?<guard>.+)가 이미 막아요\.$/s, /^Delete the line '(?<line>.*)' at (?<where>.+?)\? (?<guard>.+) already blocks the same rule\.$/s];
const OLD_REVIEW = [
	/^(?<why>.*?[.!?。]) '(?<line>.*)' 줄을 제안대로 고칠까요\?$/s,
	/^(?<why>.*?[.!?]) Change the line '(?<line>.*)' as proposed\?$/s,
	/^(?<why>.*) '(?<line>.*)' 줄을 제안대로 고칠까요\?$/s,
	/^(?<why>.*) Change the line '(?<line>.*)' as proposed\?$/s,
];

function oldCard(f: Finding, question: string): { evidence: string[]; subject: string; question: string } {
	const m = msg(), t = m.doctor;
	if (f.key === "disk:low") return { evidence: evidenceLines([question], t.more), subject: t.diskSubject, question: t.diskQuestion };
	const rule = f.key.startsWith("prompt:enforced:") ? OLD_RULE.map(re => re.exec(question)?.groups).find(Boolean) : undefined;
	if (rule) return { evidence: evidenceLines([`${t.ruleKind} · ${rule.where}: '${rule.line}'`, m.promptEnforced(rule.where!, rule.guard!)], t.more), subject: lineSubject(t, rule.where, rule.line!, t.ruleQuestion), question: t.ruleQuestion };
	const review = f.key.startsWith("prompt:review:") ? OLD_REVIEW.map(re => re.exec(question)?.groups).find(Boolean) : undefined;
	const kind = [ko, en].map(c => Object.keys(c.promptReviewWhat).find(k => c.promptReviewWhat[k] === f.what)).find(Boolean) ?? "conflict";
	if (review) return { evidence: evidenceLines([`${t.reviewKind[kind] ?? kind} · '${review.line}'`, ...wrapLines(review.why!, 2)], t.more), subject: lineSubject(t, undefined, review.line!, t.reviewQuestion), question: t.reviewQuestion };
	return { evidence: evidenceLines([question], t.more), subject: fitSubject(t.areas[f.area], t.reviewQuestion), question: t.reviewQuestion };
}
const storedFinding = (f: Finding): Finding => {
	const evidence: unknown = f.evidence, subject: unknown = f.decide?.subject, question: unknown = f.decide?.question;
	const lines = Array.isArray(evidence) ? evidence.filter((l): l is string => typeof l === "string") : [];
	if (!f.decide || typeof subject === "string") return { ...f, evidence: lines };
	const { evidence: rebuilt, ...card } = oldCard(f, typeof question === "string" ? question : "");
	return { ...f, evidence: rebuilt, decide: { ...card, options: f.decide.options } };
};
/**
 * The store as last saved. A file written before evidence became lines loads too: a finding whose evidence is one string has no lines. A card stored
 * without a subject is rebuilt from its old question the way its check builds one now (an enforced rule's or a review's card: titled by the text and the
 * quoted line, with the kind, where, why and guard as its lines); a card whose old question is not recognised keeps it as its one line under its area's name.
 */
export function loadStore(dataDir: string): DoctorStore {
	const file = storeFile(dataDir);
	if (!existsSync(file)) return emptyStore();
	try {
		const j = JSON.parse(readFileSync(file, "utf8"));
		if (!(j?.version === 1 && typeof j.findings === "object" && typeof j.told === "object")) return emptyStore();
		return { ...emptyStore(), ...j, findings: Object.fromEntries(Object.entries(j.findings as Record<string, Finding>).map(([k, f]) => [k, storedFinding(f)])) };
	} catch {
		return emptyStore(); // a half-written or foreign file is a first run, not an error
	}
}

export type Deps = {
	now: () => number;
	dataDir: string;
	home: string;
	/** The `doctor_at` value ("auto" | "HH:MM" | "off"). */
	at: () => string;
	checks?: DoctorCheck[];
	/** `open`: something not fixed is in it (an alert); only self-fixed lines otherwise (a work log entry). `ids`: the id of each card in the text, in order (Notice.ids). */
	send: (text: string, decision: boolean, open: boolean, ids: string[]) => Promise<{ delivered: boolean; reason?: string } | void> | { delivered: boolean; reason?: string } | void;
	log: (line: string) => void;
	/** Brings the result file up to date when it is stale at the morning pass; the gateway runs the night pass in a child process. Default: runNight here. */
	refresh?: () => Promise<void>;
	/** The ledger's share of the morning (hub/ledger-tick.ts): its part of the text with a commit to run once delivered, and how to send it alone as news. */
	ledgerPart?: { morning: (now: number) => { text: string; commit: () => void } | undefined; news: Send };
	/** Whether another gateway card already covers the finding's matter (cardCovers); the doctor does not tell it then. Default: none does. */
	covered?: (f: Finding) => boolean;
};

// Runs the checks; a check that throws keeps its previous findings (named `<check name>:...`) so a broken check never reads as a fixed problem.
export async function runChecks(checks: DoctorCheck[], d: Pick<Deps, "dataDir" | "home" | "log">, prev: DoctorStore, now: number, dry = false): Promise<DoctorStore> {
	const memo = dry ? structuredClone(prev.memo) : { ...prev.memo };
	const found: Finding[] = [];
	for (const check of checks) {
		try {
			found.push(...(await check({ now, dataDir: d.dataDir, home: d.home, ...(prev.lastRun ? { last: prev.lastRun } : {}), memo, dry })));
		} catch (e) {
			d.log(`doctor: check ${check.name} failed: ${e}`);
			found.push(...Object.values(prev.findings).filter(f => f.key.startsWith(`${check.name}:`) && !f.fixed));
		}
	}
	const findings: Record<string, Finding> = {};
	for (const f of found) findings[f.key] = { ...f, since: prev.findings[f.key]?.since ?? f.since };
	const told = Object.fromEntries(Object.entries(prev.told).filter(([k]) => k in findings));
	return { version: 1, lastRun: now, from: prev.lastRun, memo, findings, told };
}

const CRASHES = "gateway:crashes", OLD_NIGHT = "oldNightCrashes", REVIEW = "prompt:review:", REVIEWED = /^prompt:(?:review:|unplaced$)/;

const holds = (c: NonNullable<Finding["change"]>): boolean => {
	if (!existsSync(c.file)) return false;
	try {
		return readFileSync(c.file, "utf8").split(/\r?\n/)[c.line - 1] === c.from;
	} catch {
		return true;
	}
};

function prompt(ctx: DoctorCtx): Finding[] {
	return runPromptHealth(ctx, false).findings;
}

/**
 * The morning re-look: the file-only checks among `checks` run again over the window of the last full run (from where it started), and their findings
 * replace the stored ones; the findings of the other checks (failures, tokens) stay as the night left them. Prompt health reads files only, so it runs
 * again too, without moving its size baseline: a rule line deleted or a file trimmed since the night is gone by the morning. The weekly review's proposals
 * stay as the night stored them, except one whose line is no longer in its file as quoted (the line its `change` names). `lastRun` and `from` are kept. A
 * store the night wrote before `from` existed cannot be re-read over the night's window: its crashes stay and the ones added since are counted on top. The
 * night's count is kept in the memo, so a second look the same day adds the crashes since the night once, not again on top of the first look's sum.
 */
export async function recheck(checks: DoctorCheck[], d: Pick<Deps, "dataDir" | "home" | "log">, store: DoctorStore, now: number): Promise<DoctorStore> {
	const again = checks.flatMap(c => (FILE_CHECKS.includes(c) ? [c] : c === promptHealth ? [prompt] : []));
	const reviewed = checks.includes(promptReviewCheck);
	if (!again.length && !reviewed) return store;
	const fresh = await runChecks(again, d, { ...store, lastRun: store.from ?? 0 }, now);
	const kept = Object.entries(store.findings).filter(([k]) => REVIEWED.test(k) || !again.some(c => k.startsWith(`${c.name}:`)));
	const findings = { ...Object.fromEntries(kept), ...fresh.findings };
	for (const [k, { change: c }] of Object.entries(findings)) {
		if (reviewed && k.startsWith(REVIEW) && c && !holds(c)) delete findings[k];
	}
	delete fresh.memo[OLD_NIGHT];
	if (store.from === undefined && again.some(c => CRASHES.startsWith(`${c.name}:`))) {
		const before = store.findings[CRASHES], added = findings[CRASHES], night = typeof store.memo[OLD_NIGHT] === "number" ? store.memo[OLD_NIGHT] : (before?.level ?? 0);
		fresh.memo[OLD_NIGHT] = night;
		const level = night + (added?.level ?? 0), base = added ?? before;
		if (base && level) findings[CRASHES] = { ...base, since: before?.since ?? base.since, level, what: msg().doctor.crashes(level) };
	}
	return { ...store, memo: fresh.memo, findings, told: Object.fromEntries(Object.entries(store.told).filter(([k]) => k in findings)) };
}

/** How cardCovers names a matter's card: a watch by its label (from the watch name in the finding's key, `watches:<name>`), a harness by the label its card text starts with. */
export type CardLabels = { watch: (name: string) => string; harness: (id: string) => string | undefined };

/**
 * Whether a gateway card in `notices` already covers a finding's matter: the card is open, or the owner answered it within a day of `now` (a card that
 * expired unanswered covers nothing). Matters: a failed dotz update (`update:self`, the self-update card), a failed harness install (`update:<id>`, the
 * harness card, whose text starts with that harness's label), and a failing watch (`watches:<name>`, its issue card, matched by the watch's label). A
 * watch's lost login (`logins:<watch id>`, its evidence the watch's name) is that watch's matter: its card covers it as it covers `watches:<name>`. A card
 * that has an id (Decision.card_id) is matched by it alone: its id is the finding's key. The disk finding has no card to match: the disk guard's alert is a
 * plain message without a choice block.
 */
export function cardCovers(notices: Pick<StoredNotice, "title" | "text" | "decision">[], now: number, labels: CardLabels): (f: Finding) => boolean {
	const live = notices.filter(({ decision: c }) => c && !c.expired && c.closed_how !== "expired" && (c.state === "open" || (c.state === "answered" && now - Date.parse(c.answered_at ?? "") < DAY)));
	const plain = live.filter(n => n.decision?.card_id === undefined);
	return f => {
		if (f.fixed) return false;
		const key = f.key.startsWith("logins:") && f.evidence[0] ? `watches:${f.evidence[0]}` : f.key;
		if (/^(update|watches):/.test(key) && live.some(n => n.decision?.card_id === key)) return true;
		if (key === "update:self") return plain.some(n => n.title === SELF_UPDATE_CARD_TITLE);
		const harness = key.startsWith("update:") ? labels.harness(key.slice("update:".length)) : undefined;
		if (harness !== undefined) return plain.some(n => n.title === HARNESS_RETRY_TITLE && n.text.startsWith(`${harness} `));
		if (key.startsWith("watches:")) return plain.some(n => watchSubject(n.title) === labels.watch(key.slice("watches:".length)));
		return false;
	};
}

// Told when new, when its level reached 1.5x the level last told, or a week after it was last told while still present.
export function shouldTell(f: Finding, t: Told | undefined, now: number): boolean {
	if (!t) return true;
	if (now - t.at >= T.repeatDays * DAY) return true;
	return t.level > 0 ? f.level >= t.level * T.repeatFactor : f.level > 0;
}

export type Notice = { text: string; decision: boolean; decisions: number; open: boolean; keys: string[]; ids: string[] };
const SAID_TOGETHER: Partial<Record<DoctorArea, { tell: (t: Catalog["doctor"]) => (names: string[], rest: number) => string; window?: number }>> = {
	failures: { tell: t => t.failuresGrew, window: 1 },
	tokens: { tell: t => t.tokens },
};

type Row = { what: string; todo?: string; ask: boolean; sub: string[] };
const width = (s: string): number => [...s].length;
const headChars = (): number => (baseLanguage(lang()) === "ko" ? HEAD_CHARS.ko : HEAD_CHARS.en);
const fit = (text: string, room: number): string => (width(text) <= room ? text : shorten(text, room));

function joinedHead(tell: (names: string[], rest: number) => string, names: string[], room: number): { text: string; named: number } {
	let k = names.length;
	while (k > 1 && width(tell(names.slice(0, k), names.length - k)) > room) k--;
	return { text: fit(tell(names.slice(0, k), names.length - k), room), named: k };
}

function oneWindow(lines: string[]): string[] {
	const all = [...new Set(lines)];
	if (all.length < 2) return all;
	const words = all.map(l => l.split(" ")), lead = words[0]!, shortest = Math.min(...words.map(w => w.length));
	let start = 0, end = 0;
	while (start < shortest - 1 && words.every(w => w[start] === lead[start])) start++;
	while (start + end < shortest - 1 && words.every(w => w[w.length - 1 - end] === lead[lead.length - 1 - end])) end++;
	const middles = words.map(w => w.slice(start, w.length - end).join(" "));
	return [shorten([...lead.slice(0, start), msg().doctor.windows(middles), ...lead.slice(lead.length - end)].join(" "), EVIDENCE_CHARS)];
}

function subLines(same: Finding[], head: string, first: string[], named: number, since: string | undefined): string[] {
	const t = msg().doctor, fresh = (l: string) => !!l && !head.includes(l), after = since ? [since] : [];
	if (same.length === 1) {
		const f = same[0]!, lines = [...first, ...f.evidence].filter(fresh);
		const kept = lines.length <= SUB_LINES ? lines : [...lines.slice(0, SUB_LINES - 1), (f.area === "gateway" ? t.more : t.subMore)(lines.length - SUB_LINES + (f.left ?? 1))];
		return [...kept.slice(0, first.length), ...after, ...kept.slice(first.length)];
	}
	const at = SAID_TOGETHER[same[0]!.area]?.window, windowOf = (g: Finding) => (at === undefined ? "" : (g.evidence[at] ?? ""));
	const classes = same.filter(g => fresh(g.evidence[0] ?? "")), own = classes.map(g => g.evidence[0]!), unsaid = same.slice(named).filter(g => !g.evidence.length).length;
	const shared = same[0]!.evidence.slice(1).filter(l => l !== windowOf(same[0]!) && same.every(g => g.evidence.includes(l))).filter(fresh);
	const room = SUB_LINES - (same.some(g => fresh(windowOf(g))) ? 1 : 0);
	const told = (k: number): string[] => [...own.slice(0, k), ...(own.length - k + unsaid ? [t.subKinds(own.length - k + unsaid)] : [])];
	let k = own.length;
	while (k > 1 && width(told(k).join("; ")) > EVIDENCE_CHARS) k--;
	const packs = k > 1 && own.every(l => width(l) <= EVIDENCE_CHARS / 3), shown = packs ? k : told(own.length).length > room ? room - 1 : own.length;
	const lines = packs ? [told(k).join("; ")] : told(shown);
	return [...after, ...[...lines, ...oneWindow(classes.slice(0, shown).map(windowOf).filter(fresh)), ...shared].slice(0, SUB_LINES)];
}

function items(found: Finding[], store: DoctorStore, now: number): Row[] {
	const t = msg().doctor, out: Row[] = [], said = new Set<DoctorArea>();
	for (const f of found) {
		const together = SAID_TOGETHER[f.area];
		if (together && said.has(f.area)) continue;
		said.add(f.area);
		const same = together ? found.filter(g => g.area === f.area) : [f], ask = same.some(g => g.ask);
		const room = headChars() - width(f.todo ? ` ${f.todo}` : "") - width(ask ? t.look : ""), start = Math.min(...same.map(g => g.since)), since = t.since(t.day(start));
		const again = same.some(g => !!store.told[g.key]) && now - start >= DAY;
		const joined = same.length > 1 ? joinedHead(together!.tell(t), same.map(g => g.short ?? g.what), room) : undefined, full = joined?.text ?? f.what;
		const whole = again && width(`${full} ${since}`) <= room, what = whole ? `${full} ${since}` : (joined?.text ?? fit(f.what, room));
		const cut = !joined && !whole && what !== f.what ? [shorten(`…${f.what.slice(what.length - 1).trimStart()}`, EVIDENCE_CHARS)] : [];
		out.push({ what, ...(f.todo ? { todo: f.todo } : {}), ask, sub: subLines(same, what, cut, joined?.named ?? 1, again && !whole ? since : undefined) });
	}
	return out;
}

/**
 * The morning item: the lead, the date and the counts ("알릴 것 N · 정할 것 M", a zero left out), then the part headed "알릴 것" with one line per thing told
 * (a headline within HEAD_CHARS that ends with the look-up mark when its cause can be looked into, then at most SUB_LINES sub-lines `  - <text>` from its
 * evidence, and one hint line after them says how), the self-fixed line, the count of things told before and still there and the checks that found nothing;
 * then the part headed "정할 것" with one card per finding that has its own question (`decide`), titled `<subject> · <question>` within TITLE_CHARS with the
 * finding's evidence as its lines; two cards that would share a title are told apart by a number. A part with nothing in it is left out. `held`: findings
 * another gateway card covers; they are neither a line nor a card this morning and count among the things told before and still there. `decisions` is the
 * number of cards; `ids` names each card by its finding's key, in the order of the cards.
 */
export function compose(store: DoctorStore, now: number, all = false, held: (f: Finding) => boolean = () => false): Notice | undefined {
	const t = msg().doctor, every = Object.values(store.findings);
	const due = all ? every : every.filter(f => !held(f) && shouldTell(f, store.told[f.key], now));
	if (!due.length && !all) return undefined;
	const open = due.filter(f => !f.fixed), fixed = due.filter(f => f.fixed), quiet = every.filter(f => !f.fixed && !due.includes(f));
	const rows = items(open.filter(f => !f.decide), store, now), fixedNames = fixed.map(f => f.what).join(", ");
	const titles = new Set<string>();
	const cards = open.filter(f => f.decide).map(f => {
		const { subject, question, options } = f.decide!;
		const title = (s: string) => `${s} · ${question}`.replace(/\s+/g, " ").trim();
		let shown = fitSubject(subject, question);
		for (let n = 2; titles.has(title(shown)); n++) shown = fitSubject(subject, question, t.again(n));
		titles.add(title(shown));
		return cardBlock({ subject: shown, question, evidence: f.evidence, options });
	});
	const shared = [...new Set(rows.map(r => r.todo).filter((todo): todo is string => !!todo && rows.filter(r => r.todo === todo).length > 1))];
	const lines = rows.flatMap(r => [`- ${r.todo && !shared.includes(r.todo) ? `${r.what} ${r.todo}` : r.what}${r.ask ? t.look : ""}`, ...r.sub.map(s => `  - ${s}`)]);
	const told = rows.length ? [t.toldPart, ...lines, ...shared, rows.some(r => r.ask) ? t.lookHint : ""] : [];
	const sick = new Set(every.filter(f => !f.fixed).map(f => f.area)), fine = DOCTOR_AREAS.filter(a => !sick.has(a)).map(a => t.areas[a]);
	const first = [t.head(t.day(now)), rows.length ? t.told(rows.length) : "", cards.length ? t.decide(cards.length) : ""].filter(Boolean).join(" · ");
	const body = [first, ...told, fixed.length ? t.fixedLine(fixedNames) : "", quiet.length ? t.still(items(quiet, store, now).length) : "", (open.length || all) && fine.length ? t.healthy(fine) : "", open.length || fixed.length ? "" : t.clear];
	const text = [body.filter(Boolean).join("\n"), ...(cards.length ? [t.decidePart, ...cards] : [])].join("\n\n");
	return { text, decision: cards.length > 0, decisions: cards.length, open: open.length > 0, keys: due.map(f => f.key), ids: open.filter(f => f.decide).map(f => f.key) };
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** The morning time as "HH:MM", or undefined when the doctor is off. "auto" (and anything unreadable) is the zele brief hour when zele is on, else 08:00. */
export function morningTime(at: string, briefHour: number | undefined): string | undefined {
	const v = at.trim().toLowerCase(), m = /^(\d{1,2}):(\d\d)$/.exec(v);
	if (v === "off") return undefined;
	if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return `${pad(Number(m[1]))}:${m[2]}`;
	return `${pad(briefHour !== undefined && briefHour >= 0 && briefHour < 24 ? Math.floor(briefHour) : 8)}:00`;
}
/** The night run time: the old token-audit slot; "off" there only drops the separate night run (the morning pass runs the checks itself when none is fresh). */
export function nightTime(tokenAuditAt: string): string | undefined {
	const m = /^(\d{1,2}):(\d\d)$/.exec(tokenAuditAt.trim());
	return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${pad(Number(m[1]))}:${m[2]}` : undefined;
}
/** The next local-time occurrence of "HH:MM" after `from`. */
export function nextAt(hhmm: string, from: number): number {
	const [h = 0, m = 0] = hhmm.split(":").map(Number), d = new Date(from);
	d.setHours(h, m, 0, 0);
	if (d.getTime() <= from) d.setDate(d.getDate() + 1);
	return d.getTime();
}

const off = (d: Deps): boolean => d.at().trim().toLowerCase() === "off";

/**
 * The night run: checks, then the one result file. Does nothing when the doctor is off.
 * The doctor, part A: one gateway-run pass over the install's own files. Its one model call is the weekly prompt review of hub/prompt-review.ts (skipped when
 * the usage window is tight; `--dry` makes none). It runs the checks of hub/doctor-checks.ts once a night (at the old token-audit slot, `token_audit_at`),
 * keeps every finding in ONE file (<data>/doctor.json: the last run, the findings with the time they were first seen, and what was told when at which level),
 * and posts at most ONE item at the morning time (`doctor_at`: "auto" | "HH:MM" | "off"). Quiet when nothing is notable: a log line, nothing posted.
 * A finding is told again only when its level grew 1.5x or a week passed; a resolved one is dropped. The token audit and the failure report no longer schedule
 * or alert by themselves; the immediate alerts (gateway down, login lost, a watch failing twice, update failure, usage limits) stay where they are.
 * Usage: `bun hub/doctor.ts --dry` runs all checks on the real data dir and writes nothing; the last line is RESULT {...}. `dotz doctor` prints the same report (hub/doctor-cli.ts).
 */
export async function runNight(d: Deps): Promise<void> {
	if (off(d)) return;
	const now = d.now(), store = await runChecks(d.checks ?? CHECKS, d, loadStore(d.dataDir), now);
	writeAtomic(storeFile(d.dataDir), `${JSON.stringify(store, null, 2)}\n`);
	d.log(`doctor: ${Object.keys(store.findings).length} finding(s) kept`);
}

/**
 * The morning pass: runs the checks first when the last run is not fresh, then runs the file-only checks again (recheck) so what it posts still holds and
 * counts as of now, holds back a matter another gateway card covers (Deps.covered: not told and not marked told, so it comes once that card no longer
 * covers it), and posts the one item (or only a log line). The ledger's part (ledgerPart) is appended to the doctor's text in the same send, or goes alone
 * as news when the doctor has nothing. With the doctor off only the ledger's part is left.
 */
export async function runMorning(d: Deps): Promise<void> {
	if (off(d) && !d.ledgerPart) return;
	if (!off(d) && d.now() - loadStore(d.dataDir).lastRun > FRESH_MS) await (d.refresh ? d.refresh() : runNight(d));
	const now = d.now(), store = off(d) ? undefined : await recheck(d.checks ?? CHECKS, d, loadStore(d.dataDir), now);
	const held = new Set(store && d.covered ? Object.values(store.findings).filter(d.covered).map(f => f.key) : []);
	for (const k of held) d.log(`doctor: not telling ${k}: a card on it is open or was answered within a day`);
	const notice = store && compose(store, now, false, f => held.has(f.key)), extra = d.ledgerPart?.morning(now);
	const save = () => store && writeAtomic(storeFile(d.dataDir), `${JSON.stringify(store, null, 2)}\n`);
	if (!notice && !extra) {
		save();
		return store ? d.log("doctor: nothing notable, nothing posted") : undefined;
	}
	const text = [notice?.text, extra?.text].filter(Boolean).join("\n\n");
	const sent = await (notice ? d.send(text, notice.decision, notice.open, notice.ids) : d.ledgerPart?.news(text));
	if (sent && !sent.delivered) throw new Error(sent.reason ?? "not delivered");
	extra?.commit();
	if (notice && store) for (const k of notice.keys) store.told[k] = { at: now, level: store.findings[k]!.level };
	save();
	if (!notice) return d.log("doctor: only the ledger had something, told as news");
	d.log(`doctor: told ${notice.keys.length} finding(s)${notice.decisions ? ` with ${notice.decisions} decision(s)` : ""}${extra ? " and the ledger" : ""}`);
}

// Local-time scheduling like the other nightly jobs: one timer per job, re-armed after each run. "off" arms nothing.
function loop(name: string, time: () => string | undefined, act: () => Promise<void>, log: Deps["log"]): void {
	const t = time();
	if (!t) return;
	const arm = () => loop(name, time, act, log);
	trackTimer(`doctor ${name}`, setTimeout(() => void act().catch(e => log(`doctor ${name} failed: ${e}`)).finally(arm), nextAt(t, Date.now()) - Date.now()));
}

/** `send` posts the one morning item (decision: a choice block is in it). `briefHour`: the zele brief hour when zele is on, else undefined. `ledgerOut`: delivers the ledger's notices and counts the approvals still waiting (hub/ledger-tick.ts), which start here too and use the doctor's morning time ("off" still gives the "auto" time). */
const conf = cfg as { doctor_at?: string; token_audit_at?: string };
// The night pass reads a week of session logs (the failure report, the token audit): several hundred MB at its peak on a busy install, so it runs in
// its own process and the gateway's heap never holds it. The child writes doctor.json; the gateway only reads it in the morning.
async function nightChild(log: Deps["log"]): Promise<void> {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "doctor.ts"), "--night"], { stdout: "ignore", stderr: "pipe", env: process.env });
	const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	for (const line of err.trim().split("\n").filter(Boolean).slice(-5)) log(line);
	if (code !== 0) throw new Error(`night pass exited ${code}`);
}

const cardMeta = (ids: string[], findings: DoctorStore["findings"]): Record<string, { edit?: Finding["change"]; keep: number[] }> =>
	Object.fromEntries(ids.flatMap(id => {
		const f = findings[id], keep = (f?.decide?.options ?? []).flatMap((o, i) => (o.keep ? [i + 1] : []));
		return f && (f.change || keep.length) ? [[id, { ...(f.change ? { edit: f.change } : {}), keep }]] : [];
	}));
/** The morning message's post through the gateway's `out`: an alert when something is not fixed, else a work log entry, each card named by its finding's key (`card_ids`).
 *  `card_meta` gives each card that has them the exact edit its finding proposes and the numbers of its options that change nothing, read from `findings` (the saved store). */
export const doctorPost = (out: (target: string, text: string, replyTo?: string, extra?: Record<string, unknown>) => Promise<{ delivered: boolean; reason?: string }>, findings: () => DoctorStore["findings"] = () => loadStore(DATA_DIR).findings): Deps["send"] =>
	(text, _decision, open, ids) => {
		const meta = ids.length ? cardMeta(ids, findings()) : {};
		return out(open ? "alert" : "worklog", text, undefined, { source: "gateway", wk: "doctor", ...(ids.length ? { card_ids: ids } : {}), ...(Object.keys(meta).length ? { card_meta: meta } : {}) });
	};

/** `covered`: whether another gateway card covers a finding's matter (cardCovers over the notice store). */
export function startDoctor(send: Deps["send"], log: Deps["log"], briefHour: () => number | undefined, ledgerOut?: { send: Send; waiting: () => number }, covered?: Deps["covered"]): void {
	const d: Deps = { now: Date.now, dataDir: DATA_DIR, home: HOME, at: () => String(conf.doctor_at ?? DEFAULTS.doctor_at), send, log, refresh: () => nightChild(log), ...(covered ? { covered } : {}) };
	if (ledgerOut) d.ledgerPart = { morning: now => morningExtra(ledger, ledgerOut.waiting, now), news: ledgerOut.send };
	loop("night", () => (off(d) ? undefined : nightTime(String(conf.token_audit_at ?? DEFAULTS.token_audit_at))), () => nightChild(log), log);
	// With the doctor "off" the morning loop still runs for the ledger, at the "auto" time.
	const morning = () => morningTime(off(d) && ledgerOut ? "auto" : d.at(), briefHour());
	loop("morning", morning, () => runMorning(d), log);
	if (ledgerOut) startLedger({ store: ledger, now: Date.now, morning: () => morning() ?? "08:00", send: ledgerOut.send, log });
}

if (import.meta.main && process.argv.includes("--night")) {
	await runNight({ now: Date.now, dataDir: DATA_DIR, home: HOME, at: () => String(conf.doctor_at ?? DEFAULTS.doctor_at), send: () => undefined, log: l => console.error(l) });
	process.exit(0);
}

export type DryResult = { ms: number; peakRssMb: number; findings: number };
/** The dry run: every check on the real data dir; nothing written, posted or asked of a model. `text` is the owner's report, `result` the machine line. */
export async function dryRun(): Promise<{ text: string; result: DryResult }> {
	const t0 = Date.now(), now = Date.now(), prev = loadStore(DATA_DIR), t = msg().doctor;
	const store = await runChecks(CHECKS, { dataDir: DATA_DIR, home: HOME, log: l => console.error(l) }, prev, now, true);
	const report = compose(store, now, true)!, notice = compose(store, now);
	const morning = !notice ? t.dryNone(T.repeatFactor, T.repeatDays) : notice.text === report.text ? t.drySame : `${t.dryMorning}\n\n${notice.text}`;
	const text = [report.text, "", morning, "", t.dryAt(t.when(now))].join("\n");
	return { text, result: { ms: Date.now() - t0, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024), findings: Object.keys(store.findings).length } };
}

if (import.meta.main) {
	if (!process.argv.includes("--dry")) {
		console.error("usage: bun hub/doctor.ts --dry | --night");
		process.exit(2);
	}
	const { text, result } = await dryRun();
	console.log(`${text}\nRESULT ${JSON.stringify(result)}`);
}
