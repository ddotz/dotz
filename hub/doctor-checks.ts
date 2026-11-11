// The doctor's install-health checks (part A): each reads files only, gets now / dataDir / home injected, never sends and never calls a model.
// The doctor (hub/doctor.ts) runs them once a night and decides what reaches the owner.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { THRESHOLDS as T } from "./doctor-limits.ts";
import type { DoctorCheck, Finding } from "./doctor-types.ts";
import { baselineOf, failureReport, grownClasses, isBaseline } from "./failure-report.ts";
import { msg } from "./i18n.ts";
import { runAudit } from "./token-audit.ts";
import { HARNESS_FAILED_MID, HARNESS_RESTART_TAIL } from "./worklog-kind.ts";

const HOUR = 3600e3, DAY = 24 * HOUR, GB = 1024 ** 3;
const LOGIN_KINDS = /^(?:login|session|auth|expired)$/;
const SHOWN_NAMES = 3;

function readRange(file: string, from: number, to: number): string {
	const len = Math.max(0, to - from);
	if (!len) return "";
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, from);
		return buf.toString("utf8");
	} catch {
		return ""; // a file that vanished between the size and the read is an empty log
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

const tailText = (file: string, bytes: number): string => {
	try {
		const size = statSync(file).size;
		return readRange(file, Math.max(0, size - bytes), size);
	} catch {
		return ""; // no file yet is an empty log
	}
};

type Row = { at: number; text: string };
function logRows(dataDir: string): Row[] {
	const rows: Row[] = [];
	for (const line of tailText(join(dataDir, "hub.log"), T.logTailBytes).split("\n")) {
		const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
		if (m) rows.push({ at: Date.parse(m[1]!), text: m[2]! });
	}
	return rows;
}

function jsonAt<V>(file: string): V | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as V;
	} catch {
		return undefined; // missing or half-written: nothing to look at
	}
}

// A stack trace is a line followed by indented `at ...` frames; one trace counts once however many frames it has.
export function countTraces(text: string): number {
	const lines = text.split("\n");
	let n = 0;
	for (let i = 1; i < lines.length; i++) if (/^\s+at\s/.test(lines[i]!) && !/^\s+at\s/.test(lines[i - 1]!)) n++;
	return n;
}

const found = (key: string, area: Finding["area"], now: number, what: string, evidence: string, level: number): Finding => ({ key, area, what, evidence, since: now, level });
const names = (list: string[]): string => list.slice(0, SHOWN_NAMES).join(", ") + (list.length > SHOWN_NAMES ? ` +${list.length - SHOWN_NAMES}` : "");

export const gateway: DoctorCheck = ({ now, dataDir, memo }) => {
	const t = msg().doctor, out: Finding[] = [];
	const restarts = logRows(dataDir).filter(r => r.at >= now - T.restartWindowH * HOUR && r.text.startsWith("gateway restart (")).length;
	if (restarts >= T.restarts) out.push(found("gateway:restarts", "gateway", now, t.restarts(restarts), "hub.log", restarts));
	const errFile = join(dataDir, "gateway.err.log");
	const size = existsSync(errFile) ? statSync(errFile).size : 0;
	const seen = typeof memo?.errBytes === "number" ? memo.errBytes : undefined;
	if (memo) memo.errBytes = size;
	if (seen !== undefined) {
		const crashes = countTraces(readRange(errFile, size < seen ? 0 : Math.max(seen, size - T.logTailBytes), size));
		if (crashes >= T.crashes) out.push(found("gateway:crashes", "gateway", now, t.crashes(crashes), "gateway.err.log", crashes));
	}
	return out;
};

type LaneFile = { name?: string; status?: string; startedAt?: string; lastReportAt?: string; sessionFile?: string; parked?: boolean; ownerStopped?: boolean; died?: { at?: string }; interrupted?: { resumed?: boolean }; claim?: { state?: string } };
const mtime = (file: string | undefined): number => {
	try {
		return file ? statSync(file).mtimeMs : 0;
	} catch {
		return 0; // a session file that is gone shows no progress
	}
};

export const sessions: DoctorCheck = ({ now, dataDir }) => {
	const t = msg().doctor, root = join(dataDir, "lanes"), stuck: string[] = [], broken: string[] = [];
	for (const dir of existsSync(root) ? readdirSync(root) : []) {
		const file = join(root, dir, "lane.json"), lane = jsonAt<LaneFile>(file);
		if (!lane) continue;
		const name = lane.name ?? dir;
		if (lane.status === "working" || lane.status === "starting") {
			if (lane.parked) continue;
			const progress = Math.max(mtime(file), mtime(lane.sessionFile), Date.parse(lane.lastReportAt ?? "") || 0, Date.parse(lane.startedAt ?? "") || 0);
			if (now - progress > T.laneIdleH * HOUR) stuck.push(name);
		} else if (lane.died && !lane.ownerStopped && lane.claim?.state !== "verified" && !lane.interrupted?.resumed) {
			const age = now - (Date.parse(lane.died.at ?? "") || now);
			if (age > T.laneErrorH * HOUR && age < T.laneErrorMaxDays * DAY) broken.push(name);
		}
	}
	const out: Finding[] = [];
	if (stuck.length) out.push(found("sessions:stuck", "sessions", now, t.sessionsStuck(names(stuck), stuck.length, T.laneIdleH), names(stuck), stuck.length));
	if (broken.length) out.push(found("sessions:error", "sessions", now, t.sessionsError(names(broken), broken.length, T.laneErrorH), names(broken), broken.length));
	return out;
};

type WatchFile = { id: string; name: string; label?: string; session?: unknown; paused?: boolean; state?: { fails?: number; failSince?: number; kind?: string; paused?: string } };
const watchesOf = (dataDir: string): WatchFile[] => {
	const j = jsonAt<unknown>(join(dataDir, "watches.json"));
	return Array.isArray(j) ? (j as WatchFile[]) : [];
};
const failingFor = (w: WatchFile, now: number): number => (w.state?.failSince && (w.state.fails ?? 0) > 0 ? now - w.state.failSince : 0);

export const logins: DoctorCheck = ({ now, dataDir }) => {
	const t = msg().doctor, out: Finding[] = [];
	for (const w of watchesOf(dataDir)) {
		if (!w.session || !LOGIN_KINDS.test(w.state?.kind ?? "")) continue;
		const lost = failingFor(w, now);
		if (lost > T.loginLostH * HOUR) out.push(found(`logins:${w.id}`, "logins", now, t.loginLost(w.label ?? w.name, Math.floor(lost / HOUR)), w.name, Math.floor(lost / HOUR)));
	}
	return out;
};

export const watches: DoctorCheck = ({ now, dataDir, last }) => {
	const t = msg().doctor, out: Finding[] = [];
	for (const w of watchesOf(dataDir)) {
		const fails = w.state?.fails ?? 0, failing = failingFor(w, now);
		if (w.paused || w.state?.paused || LOGIN_KINDS.test(w.state?.kind ?? "")) continue;
		if (fails >= T.watchFails || failing > T.watchFailH * HOUR) out.push(found(`watches:${w.id}`, "watches", now, t.watchFailing(w.label ?? w.name, Math.floor(failing / HOUR), fails), w.name, fails));
	}
	const fixed = new Set<string>();
	for (const r of logRows(dataDir)) {
		const m = /^watch (.+) self-heal: the check passes again$/.exec(r.text);
		if (m && r.at >= (last ?? now - DAY)) fixed.add(m[1]!);
	}
	for (const name of fixed) out.push({ ...found(`watches:fixed:${name}`, "watches", now, t.watchFixed(name), name, 1), fixed: true });
	return out;
};

export const disk: DoctorCheck = ({ now, dataDir }) => {
	let free: number, total: number;
	try {
		const s = statfsSync(dataDir);
		free = Number(s.bavail) * Number(s.bsize);
		total = Number(s.blocks) * Number(s.bsize);
	} catch {
		return []; // a volume that cannot be read cannot be judged
	}
	if (!total) return [];
	const pct = (free / total) * 100;
	if (pct >= T.diskFreePct && free >= T.diskFreeGb * GB) return [];
	const t = msg().doctor, critical = free < T.diskDecideGb * GB;
	const f = found("disk:low", "disk", now, t.disk(Math.round((free / GB) * 10) / 10, Math.round(pct)), `${(free / GB).toFixed(1)} / ${(total / GB).toFixed(0)} GB`, critical ? 2 : 1);
	if (critical) f.decide = { question: t.diskQuestion, options: [{ name: t.diskCleanName, result: t.diskCleanResult }, { name: t.diskKeepName, result: t.diskKeepResult }] };
	return [f];
};

// The newest update line per updater decides: a failure with no success after it is "still failed".
export const update: DoctorCheck = ({ now, dataDir }) => {
	const t = msg().doctor, state = new Map<string, number | undefined>(), fails = new Map<string, number>();
	const mark = (id: string, failed: boolean | undefined) => {
		if (failed === undefined) return;
		state.set(id, failed ? now : undefined);
		fails.set(id, failed ? (fails.get(id) ?? 0) + 1 : 0);
	};
	for (const { text } of logRows(dataDir)) {
		const self = /^self-update #\d+: (\w+):/.exec(text);
		if (self) mark("self", self[1] === "failed" ? true : self[1] === "updated" || self[1] === "current" ? false : undefined);
		const m = /^(\S+) update(?: failed)?: /.exec(text);
		if (m) mark(m[1]!, text.includes(" update failed: ") || text.includes(HARNESS_FAILED_MID) ? true : text.includes(HARNESS_RESTART_TAIL) ? false : undefined);
	}
	return [...state].filter(([, failedAt]) => failedAt !== undefined).map(([id]) => found(`update:${id}`, "update", now, t.updateFailed(id === "self" ? t.selfUpdate : id), id, fails.get(id) ?? 1));
};

export const failures: DoctorCheck = ({ now, dataDir, home, memo }) => {
	const r = failureReport({ home, dataDir, days: T.failureDays, now }), base = isBaseline(memo?.failBase) ? memo.failBase : undefined;
	if (memo) memo.failBase = baselineOf(r);
	const t = msg().doctor;
	return grownClasses(r, base, T.failures).map(g => found(`failures:${g.name}`, "failures", now, t.failuresGrew(g.line), g.name, Math.round(g.weight)));
};

export const tokens: DoctorCheck = ({ now, dry }) => {
	const t = msg().doctor, byKind = new Map<string, { n: number; cost: number }>();
	for (const f of runAudit({ hours: T.tokensH, dry: !!dry, readOnly: !!dry }).told) {
		const k = byKind.get(f.kind) ?? { n: 0, cost: 0 };
		byKind.set(f.kind, { n: k.n + 1, cost: k.cost + (f.cost ?? 0) });
	}
	return [...byKind].map(([kind, k]) => found(`tokens:${kind}`, "tokens", now, t.tokens(kind, k.n), kind, Math.round(k.cost * 100) / 100 || k.n));
};

export const CHECKS: DoctorCheck[] = [gateway, sessions, logins, watches, disk, update, failures, tokens];
