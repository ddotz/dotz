// The doctor, part A: one gateway-run pass over the install's own files, no model call. It runs the checks of hub/doctor-checks.ts once a night (at the
// old token-audit slot, `token_audit_at`), keeps every finding in ONE file (<data>/doctor.json: the last run, the findings with the time they were first seen,
// and what was told when at which level), and posts at most ONE item at the morning time (`doctor_at`: "auto" | "HH:MM" | "off").
// Quiet when nothing is notable: a log line, nothing posted. A finding is told again only when its level grew 1.5x or a week passed; a resolved one is dropped.
// The token audit and the failure report no longer schedule or alert by themselves; the immediate alerts (gateway down, login lost, a watch failing twice,
// update failure, usage limits) stay where they are. usage: bun hub/doctor.ts --dry   (all checks on the real data dir, writes nothing; last line RESULT {...})
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { issueBlock } from "./choices.ts";
import { cfg, DATA_DIR, DEFAULTS, HOME, writeAtomic } from "./config.ts";
import { CHECKS as HEALTH } from "./doctor-checks.ts";
import { THRESHOLDS as T } from "./doctor-limits.ts";
import type { DoctorCheck, Finding } from "./doctor-types.ts";
import { msg } from "./i18n.ts";
import { ledger } from "./ledger.ts";
import { type Send, morningExtra, startLedger } from "./ledger-tick.ts";
import { promptHealth } from "./prompt-health.ts";
import { promptReviewCheck } from "./prompt-review.ts";
import { trackTimer } from "./shutdown.ts";

const DAY = 86400e3;
const FRESH_MS = 20 * 3600e3;
// Prompt health first: the review reads the growth it just measured to decide whether to run early.
const CHECKS: DoctorCheck[] = [...HEALTH, promptHealth, promptReviewCheck];

export type Told = { at: number; level: number };
export type DoctorStore = { version: 1; lastRun: number; memo: Record<string, unknown>; findings: Record<string, Finding>; told: Record<string, Told> };
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
	return { version: 1, lastRun: now, memo, findings, told };
}

// Told when new, when its level reached 1.5x the level last told, or a week after it was last told while still present.
export function shouldTell(f: Finding, t: Told | undefined, now: number): boolean {
	if (!t) return true;
	if (now - t.at >= T.repeatDays * DAY) return true;
	return t.level > 0 ? f.level >= t.level * T.repeatFactor : f.level > 0;
}

export type Notice = { text: string; decision: boolean; open: boolean; keys: string[] };
export function compose(store: DoctorStore, now: number): Notice | undefined {
	const due = Object.values(store.findings).filter(f => shouldTell(f, store.told[f.key], now));
	const open = due.filter(f => !f.fixed), fixed = due.filter(f => f.fixed);
	if (!due.length) return undefined;
	const t = msg().doctor, ask = open.find(f => f.decide);
	const parts = [open.length ? [t.head(open.length), ...open.map(f => `- ${f.what}${f.decide ? `\n  ${f.evidence}` : ""}`)].join("\n") : "", fixed.length ? t.fixedLine(fixed.map(f => f.what).join(", ")) : "", ask?.decide ? issueBlock(ask.decide.question, ask.decide.options) : ""];
	return { text: parts.filter(Boolean).join("\n\n"), decision: !!ask, open: open.length > 0, keys: due.map(f => f.key) };
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

/** The night run: checks, then the one result file. Does nothing when the doctor is off. */
export async function runNight(d: Deps): Promise<void> {
	if (off(d)) return;
	const now = d.now(), store = await runChecks(d.checks ?? CHECKS, d, loadStore(d.dataDir), now);
	writeAtomic(storeFile(d.dataDir), `${JSON.stringify(store, null, 2)}\n`);
	d.log(`doctor: ${Object.keys(store.findings).length} finding(s) kept`);
}

/**
 * The morning pass: runs the checks first when the last run is not fresh, then posts the one item (or only a log line). The ledger's part (ledgerPart) is
 * appended to the doctor's text in the same send, or goes alone as news when the doctor has nothing. With the doctor off only the ledger's part is left.
 */
export async function runMorning(d: Deps): Promise<void> {
	if (off(d) && !d.ledgerPart) return;
	if (!off(d) && d.now() - loadStore(d.dataDir).lastRun > FRESH_MS) await (d.refresh ? d.refresh() : runNight(d));
	const store = loadStore(d.dataDir), now = d.now(), notice = off(d) ? undefined : compose(store, now), extra = d.ledgerPart?.morning(now);
	if (!notice && !extra) return off(d) ? undefined : d.log("doctor: nothing notable, nothing posted");
	const text = [notice?.text, extra?.text].filter(Boolean).join("\n\n");
	const sent = await (notice ? d.send(text, notice.decision, notice.open) : d.ledgerPart?.news(text));
	if (sent && !sent.delivered) throw new Error(sent.reason ?? "not delivered");
	extra?.commit();
	if (!notice) return d.log("doctor: only the ledger had something, told as news");
	for (const k of notice.keys) store.told[k] = { at: now, level: store.findings[k]!.level };
	writeAtomic(storeFile(d.dataDir), `${JSON.stringify(store, null, 2)}\n`);
	d.log(`doctor: told ${notice.keys.length} finding(s)${notice.decision ? " with a decision" : ""}${extra ? " and the ledger" : ""}`);
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

export function startDoctor(send: Deps["send"], log: Deps["log"], briefHour: () => number | undefined, ledgerOut?: { send: Send; waiting: () => number }): void {
	const d: Deps = { now: Date.now, dataDir: DATA_DIR, home: HOME, at: () => String(conf.doctor_at ?? DEFAULTS.doctor_at), send, log, refresh: () => nightChild(log) };
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
if (import.meta.main) {
	if (!process.argv.includes("--dry")) {
		console.error("usage: bun hub/doctor.ts --dry | --night");
		process.exit(2);
	}
	const t0 = Date.now(), now = Date.now(), prev = loadStore(DATA_DIR);
	const store = await runChecks(CHECKS, { dataDir: DATA_DIR, home: HOME, log: l => console.error(l) }, prev, now, true);
	const notice = compose(store, now);
	for (const f of Object.values(store.findings)) console.log(`- [${f.area}] ${f.what} (level ${f.level}${f.decide ? ", decision" : ""}${f.fixed ? ", fixed" : ""})`);
	console.log(notice ? `--- (dry) would post${notice.decision ? " with a choice block" : ""} ---\n${notice.text}\n---` : "--- (dry) nothing notable, nothing would be posted ---");
	console.log(`RESULT ${JSON.stringify({ ms: Date.now() - t0, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024), findings: Object.keys(store.findings).length })}`);
}
