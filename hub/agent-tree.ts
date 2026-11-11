// What an agent starts through its shell tool, and giving it back when the agent ends.
// A command run by an agent's shell tool sits in its own session (PTY), so the agent's process group (hub/runtime/agent-proc.ts)
// does not hold it, and once the agent is gone it is reparented to pid 1: only a record made WHILE the agent lived can tell it
// from a daemon. So: every listing of the process table (one shared `ps`, also read by hub/memguard.ts and hub/convcapacity.ts)
// replaces each live agent's record with the processes whose parent chain reaches it, each as pid + start time. A process that
// left the chain while the agent lived (reparented to pid 1: a daemon, an app server) drops out of the record at the next listing.
// The record is also written to agent-trees.json, so the next gateway start ends the leftovers of a gateway that died.
// A process is ended only when the table still shows the same pid with the same start time and a parent that is pid 1 or another
// recorded process; TERM first, KILL after a short grace if the start time still matches.
import { readFileSync } from "node:fs";
import { log, paths, writeAtomic } from "./config.ts";
import { trackTimer } from "./shutdown.ts";

export type Row = { pid: number; ppid: number; rss: number; start: string };
type Ref = { pid: number; start: string };
type Agent = { start?: string; kids: Ref[] };

const TABLE_TTL_MS = 20_000;
const WATCH_EVERY_MS = 30_000;
const KILL_GRACE_MS = 2000;
const GRACE_POLL_MS = 100;

const live = new Map<number, Agent>();
const ending = new Map<number, Promise<void>>();
let recordFile = paths.agentTrees;
let gateway: Ref | undefined;
let saved = "";

const ps = async (): Promise<string> => {
	const p = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,lstart="], { stdout: "pipe", stderr: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
	const text = await new Response(p.stdout).text();
	await p.exited;
	return text;
};
let lister: () => Promise<string> = ps;
let cache: { at: number; text: string } | undefined;
let inflight: Promise<string> | undefined;

/** Tests only: where the record goes and which processes the listing shows. */
export function useForTest(file: string, list?: () => Promise<string>): void {
	recordFile = file;
	lister = list ?? ps;
	cache = undefined;
	gateway = undefined;
	saved = "";
}

/** `pid ppid rss lstart` of every process, from one `ps`; a listing younger than maxAgeMs is reused (0 = always a new one). "" when ps failed. */
export async function processTable(maxAgeMs = TABLE_TTL_MS): Promise<string> {
	if (maxAgeMs <= 0) return lister().catch(() => "");
	if (cache && Date.now() - cache.at <= maxAgeMs) return cache.text;
	inflight ??= lister()
		.then(text => {
			if (text) cache = { at: Date.now(), text };
			return text;
		})
		.catch(() => "") // ps could not run: callers see an empty table and end nothing
		.finally(() => (inflight = undefined));
	return inflight;
}

export function parseRows(text: string): Row[] {
	const rows: Row[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
		if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), start: m[4]!.replace(/\s+/g, " ") });
	}
	return rows;
}

/** Every process below the given pids (children, their children, ...), not the pids themselves. */
export function descendantsOf<T extends { pid: number; ppid: number }>(rows: readonly T[], roots: readonly number[]): T[] {
	const kids = new Map<number, T[]>();
	for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
	const out: T[] = [];
	const seen = new Set(roots);
	for (const todo = [...roots]; todo.length; ) {
		for (const k of kids.get(todo.pop()!) ?? []) {
			if (seen.has(k.pid)) continue;
			seen.add(k.pid);
			out.push(k);
			todo.push(k.pid);
		}
	}
	return out;
}

/**
 * The recorded processes that are provably still the same ones: same pid and start time, a parent that is pid 1 or another such
 * process (the agent died and they were handed to init), never the gateway, pid 1 or a live agent; plus what they started since.
 */
export function stillThere(rows: readonly Row[], recorded: readonly Ref[]): Row[] {
	const byPid = new Map(rows.map(r => [r.pid, r]));
	const same = recorded.flatMap(k => {
		const r = byPid.get(k.pid);
		return r && r.start === k.start && r.pid > 1 && r.pid !== process.pid && !live.has(r.pid) ? [r] : [];
	});
	const ids = new Set(same.map(r => r.pid));
	const mine = same.filter(r => r.ppid === 1 || ids.has(r.ppid));
	return [...mine, ...descendantsOf(rows, mine.map(r => r.pid)).filter(r => !live.has(r.pid) && r.pid !== process.pid)];
}

export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

const signal = (pid: number, sig: NodeJS.Signals): void => {
	try {
		process.kill(pid, sig);
	} catch {
		// gone already
	}
};

/** TERM to each, then KILL after the grace to those that still run as the same process (pid and start time checked again). */
export async function endProcesses(victims: readonly Row[]): Promise<void> {
	for (const v of victims) signal(v.pid, "SIGTERM");
	for (const until = Date.now() + KILL_GRACE_MS; victims.some(v => alive(v.pid)) && Date.now() < until; ) await Bun.sleep(GRACE_POLL_MS);
	if (!victims.some(v => alive(v.pid))) return;
	const now = new Map(parseRows(await processTable(0)).map(r => [r.pid, r.start]));
	for (const v of victims) if (now.get(v.pid) === v.start) signal(v.pid, "SIGKILL");
}

function save(): void {
	if (!gateway) return;
	const agents = [...live].filter(([, a]) => a.start).map(([pid, a]) => ({ pid, start: a.start, kids: a.kids }));
	const body = JSON.stringify({ gateway, agents });
	if (body === saved) return;
	saved = body;
	try {
		writeAtomic(recordFile, body);
	} catch (e) {
		log(`agent trees: could not write ${recordFile}: ${e}`);
	}
}

/** A listing arrived: each live agent's record becomes the processes below it now. */
export function observe(rows: readonly Row[]): void {
	const byPid = new Map(rows.map(r => [r.pid, r]));
	const self = byPid.get(process.pid);
	if (self) gateway = { pid: self.pid, start: self.start };
	for (const [pid, a] of live) {
		const row = byPid.get(pid);
		if (!row || ending.has(pid)) continue; // gone: the exit handler has the last record
		a.start ??= row.start;
		a.kids = descendantsOf(rows, [pid]).map(r => ({ pid: r.pid, start: r.start }));
	}
	save();
}

export function trackAgent(pid: number): void {
	live.set(pid, { kids: [] });
}

/** The agent exited: end what it started (from the last record, checked against a new listing). Resolves when that is done. */
export function agentEnded(pid: number): Promise<void> {
	const a = live.get(pid);
	if (!a) return Promise.resolve();
	const done = (async () => {
		if (a.kids.length) {
			const victims = stillThere(parseRows(await processTable(0)), a.kids);
			if (victims.length) log(`agent ${pid} ended: ending ${victims.length} process(es) it started through its shell tool`);
			await endProcesses(victims);
		}
	})()
		.catch(e => log(`agent ${pid} ended: cleaning up what it started failed: ${e}`))
		.finally(() => {
			live.delete(pid);
			ending.delete(pid);
			save();
		});
	ending.set(pid, done);
	return done;
}

/** Resolves once the cleanup after the agent's exit is finished (at once if there is none). */
export const treeEnded = (pid: number): Promise<void> => ending.get(pid) ?? Promise.resolve();

const refs = (v: unknown): Ref[] => (Array.isArray(v) ? v.filter((x): x is Ref => typeof x?.pid === "number" && typeof x?.start === "string") : []);

/** After a gateway that died: ends what its agents left running. The previous gateway still running (same pid and start time) leaves everything alone. */
export async function reapLeftovers(): Promise<number[]> {
	let rec: { gateway?: unknown; agents?: unknown };
	try {
		rec = JSON.parse(readFileSync(recordFile, "utf8"));
	} catch {
		return []; // no record: no gateway left agents behind
	}
	const rows = parseRows(await processTable(0));
	if (!rows.length) return [];
	const [old] = refs([rec.gateway]);
	if (old && rows.some(r => r.pid === old.pid && r.start === old.start)) return [];
	const recorded = (Array.isArray(rec.agents) ? rec.agents : []).flatMap((a: { pid?: number; start?: string; kids?: unknown }) => refs([a]).concat(refs(a?.kids)));
	const victims = stillThere(rows, recorded);
	if (victims.length) log(`agent trees: the gateway before this one left ${victims.length} process(es) running, ending them: ${victims.map(v => v.pid).join(", ")}`);
	await endProcesses(victims);
	return victims.map(v => v.pid);
}

/** At the gateway start: end what a dead gateway left, then record the live agents' trees from each listing. */
export function startAgentTrees(): void {
	const tick = () => void processTable().then(text => observe(parseRows(text))).catch(e => log(`agent trees: listing failed: ${e}`));
	void reapLeftovers()
		.catch(e => log(`agent trees: ending leftovers failed: ${e}`))
		.finally(() => {
			tick();
			trackTimer("agent trees", setInterval(tick, WATCH_EVERY_MS));
		});
}
