import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { issueBlock } from "./choices.ts";
import { cfg, DATA_DIR, DEFAULTS, HOME, writeAtomic } from "./config.ts";
import { CHECKS as HEALTH, FILE_CHECKS } from "./doctor-checks.ts";
import { THRESHOLDS as T } from "./doctor-limits.ts";
import { type DoctorArea, type DoctorCheck, DOCTOR_AREAS, type Finding } from "./doctor-types.ts";
import { msg } from "./i18n.ts";
import type { Catalog } from "./i18n-en.ts";
import type { Notice as StoredNotice } from "./notices-types.ts";
import { ledger } from "./ledger.ts";
import { type Send, morningExtra, startLedger } from "./ledger-tick.ts";
import { promptHealth } from "./prompt-health.ts";
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
export function loadStore(dataDir: string): DoctorStore {
	const file = storeFile(dataDir);
	if (!existsSync(file)) return emptyStore();
	try {
		const j = JSON.parse(readFileSync(file, "utf8"));
		return j?.version === 1 && typeof j.findings === "object" && typeof j.told === "object" ? { ...emptyStore(), ...j } : emptyStore();
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
	/** `open`: something not fixed is in it (an alert); only self-fixed lines otherwise (a work log entry). */
	send: (text: string, decision: boolean, open: boolean) => Promise<{ delivered: boolean; reason?: string } | void> | { delivered: boolean; reason?: string } | void;
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

const CRASHES = "gateway:crashes", OLD_NIGHT = "oldNightCrashes";

/**
 * The morning re-look: the file-only checks among `checks` run again over the window of the last full run (from where it started), and their findings
 * replace the stored ones; the findings of the other checks (failures, tokens, prompt) stay as the night left them. `lastRun` and `from` are kept. A store
 * the night wrote before `from` existed cannot be re-read over the night's window: its crashes stay and the ones added since are counted on top. The night's
 * count is kept in the memo, so a second look the same day adds the crashes since the night once, not again on top of the first look's sum.
 */
export async function recheck(checks: DoctorCheck[], d: Pick<Deps, "dataDir" | "home" | "log">, store: DoctorStore, now: number): Promise<DoctorStore> {
	const again = checks.filter(c => FILE_CHECKS.includes(c));
	if (!again.length) return store;
	const fresh = await runChecks(again, d, { ...store, lastRun: store.from ?? 0 }, now);
	const kept = Object.entries(store.findings).filter(([k]) => !again.some(c => k.startsWith(`${c.name}:`)));
	const findings = { ...Object.fromEntries(kept), ...fresh.findings };
	delete fresh.memo[OLD_NIGHT];
	if (store.from === undefined && again.some(c => CRASHES.startsWith(`${c.name}:`))) {
		const before = store.findings[CRASHES], added = findings[CRASHES], night = typeof store.memo[OLD_NIGHT] === "number" ? store.memo[OLD_NIGHT] : (before?.level ?? 0);
		fresh.memo[OLD_NIGHT] = night;
		const level = night + (added?.level ?? 0), base = added ?? before;
		if (base && level) findings[CRASHES] = { ...base, since: before?.since ?? base.since, level, what: msg().doctor.crashes(level) };
	}
	return { ...store, memo: fresh.memo, findings, told: Object.fromEntries(Object.entries(store.told).filter(([k]) => k in findings)) };
}

/** How cardCovers names a matter's card: a watch by its label (from the watch name in the finding's evidence), a harness by the label its card text starts with. */
export type CardLabels = { watch: (name: string) => string; harness: (id: string) => string | undefined };

/**
 * Whether a gateway card in `notices` already covers a finding's matter: the card is open, or the owner answered it within a day of `now` (a card that
 * expired unanswered covers nothing). Matters: a failed dotz update (`update:self`, the self-update card), a failed harness install (`update:<id>`, the
 * harness card, whose text starts with that harness's label), and a failing watch (`watches:<id>`, its issue card, matched by the watch's label). The disk
 * finding has no card to match: the disk guard's alert is a plain message without a choice block.
 */
export function cardCovers(notices: Pick<StoredNotice, "title" | "text" | "decision">[], now: number, labels: CardLabels): (f: Finding) => boolean {
	const live = notices.filter(({ decision: c }) => c && !c.expired && c.closed_how !== "expired" && (c.state === "open" || (c.state === "answered" && now - Date.parse(c.answered_at ?? "") < DAY)));
	return f => {
		if (f.fixed) return false;
		if (f.key === "update:self") return live.some(n => n.title === SELF_UPDATE_CARD_TITLE);
		const harness = f.key.startsWith("update:") ? labels.harness(f.key.slice("update:".length)) : undefined;
		if (harness !== undefined) return live.some(n => n.title === HARNESS_RETRY_TITLE && n.text.startsWith(`${harness} `));
		if (f.key.startsWith("watches:")) return live.some(n => watchSubject(n.title) === labels.watch(f.evidence));
		return false;
	};
}

// Told when new, when its level reached 1.5x the level last told, or a week after it was last told while still present.
export function shouldTell(f: Finding, t: Told | undefined, now: number): boolean {
	if (!t) return true;
	if (now - t.at >= T.repeatDays * DAY) return true;
	return t.level > 0 ? f.level >= t.level * T.repeatFactor : f.level > 0;
}

export type Notice = { text: string; decision: boolean; decisions: number; open: boolean; keys: string[] };
const SAID_TOGETHER: Partial<Record<DoctorArea, (t: Catalog["doctor"]) => (items: string[]) => string>> = { failures: t => t.failuresGrew, tokens: t => t.tokens };

type Row = { what: string; todo?: string; ask?: string };

function items(found: Finding[], store: DoctorStore, now: number): Row[] {
	const t = msg().doctor, out: Row[] = [], said = new Set<DoctorArea>();
	for (const f of found) {
		const together = SAID_TOGETHER[f.area];
		if (together && said.has(f.area)) continue;
		said.add(f.area);
		const same = together ? found.filter(g => g.area === f.area) : [f];
		const lasting = store.told[f.key] && now - f.since >= DAY;
		const what = same.length > 1 ? together!(t)(same.map(g => g.short ?? g.what)) : lasting ? `${f.what} ${t.since(t.day(f.since))}` : f.what;
		const ask = same.some(g => g.ask) ? (together ? t.areas[f.area] : f.what.replace(/[.。]$/, "")) : undefined;
		out.push({ what, todo: f.todo, ...(ask ? { ask } : {}) });
	}
	return out;
}

/**
 * The morning item. One decision card per thing the owner decides: the findings with their own question first, then each line that offers a look at its cause,
 * named by that line. `held`: findings another gateway card covers; they are not told this morning and count among the things told before and still there.
 */
export function compose(store: DoctorStore, now: number, all = false, held: (f: Finding) => boolean = () => false): Notice | undefined {
	const t = msg().doctor, every = Object.values(store.findings);
	const due = all ? every : every.filter(f => !held(f) && shouldTell(f, store.told[f.key], now));
	if (!due.length && !all) return undefined;
	const open = due.filter(f => !f.fixed), fixed = due.filter(f => f.fixed), quiet = every.filter(f => !f.fixed && !due.includes(f));
	const asking = open.filter(f => f.decide), rows = items(open.filter(f => !f.decide), store, now), fixedNames = fixed.map(f => f.what).join(", ");
	const cards = [
		...asking.map(f => issueBlock(f.decide!.question, f.decide!.options)),
		...rows.flatMap(r => (r.ask ? [issueBlock(t.askCard(r.ask), [{ name: t.askFind, result: t.askFindResult }, { name: t.askLeave, result: t.askLeaveResult }])] : [])),
	];
	const shared = [...new Set(rows.map(r => r.todo).filter((todo): todo is string => !!todo && rows.filter(r => r.todo === todo).length > 1))];
	const lines = rows.map(r => `- ${r.todo && !shared.includes(r.todo) ? `${r.what} ${r.todo}` : r.what}`);
	const sick = new Set(every.filter(f => !f.fixed).map(f => f.area)), fine = DOCTOR_AREAS.filter(a => !sick.has(a)).map(a => t.areas[a]);
	const head = open.length ? t.head(rows.filter(r => !r.ask).length, cards.length) : fixed.length ? t.fixedHead(fixedNames) : t.clear;
	const body = [head, ...lines, ...shared, open.length && fixed.length ? t.fixedLine(fixedNames) : "", quiet.length ? t.still(items(quiet, store, now).length) : "", (open.length || all) && fine.length ? t.healthy(fine) : ""];
	const text = [body.filter(Boolean).join("\n"), ...cards].join("\n\n");
	return { text, decision: cards.length > 0, decisions: cards.length, open: open.length > 0, keys: due.map(f => f.key) };
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
	const sent = await (notice ? d.send(text, notice.decision, notice.open) : d.ledgerPart?.news(text));
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
