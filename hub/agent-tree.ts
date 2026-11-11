// What an agent starts through its shell tool, and giving it back when the agent ends.
// A command run by an agent's shell tool sits in its own session (PTY), so the agent's process group (hub/runtime/agent-proc.ts)
// does not hold it, and once the agent is gone it is reparented to pid 1: only a record made WHILE the agent lived can tell it
// from a daemon. So: every listing of the process table (one shared `ps`, also read by hub/memguard.ts and hub/convcapacity.ts)
// replaces each live agent's record with the processes whose parent chain reaches it, each as pid + start time. A process that
// left the chain while the agent lived (reparented to pid 1: a daemon, an app server) drops out of the record at the next listing.
// The record is also written to agent-trees.json, so the next gateway start ends the leftovers of a gateway that died.
// A process is ended only when the table still shows the same pid with the same start time and a parent that is pid 1 or another
// recorded process; TERM first, KILL after a short grace if the start time still matches.
//
// Kept processes: an agent that is parked (an idle stop of a lane or conversation session, markPark) leaves the useful ones of
// them running (hub/kept-procs.ts). They stay in the record under the session that owns them (`kept`), and end when the owner
// is stopped or deleted (`useKeptHooks`) or when nothing used them for IDLE_BOUND_MS. A gateway restart (planned, a self-update or a
// crash) does not touch them: the next start adopts again the ones whose pid and start time still match and whose owner exists
// (`reapLeftovers`), and ends the rest. Each end is one plain line in the owner's channel. Every other exit of the agent (a stop, a
// crash, a memory restart) ends everything, the kept processes of that session too.
import { readFileSync } from "node:fs";
import { log, paths, writeAtomic } from "./config.ts";
import { msg } from "./i18n.ts";
import { cpuSeconds, IDLE_BOUND_MS, MAX_KEPT, pickKept, withCpu, type Kid } from "./kept-procs.ts";
import { trackTimer } from "./shutdown.ts";

export type Row = { pid: number; ppid: number; rss: number; start: string; cpu?: number };
type Ref = { pid: number; start: string };
type Agent = { start?: string; kids: Kid[]; owner?: string; parked?: boolean };
type Kept = { at: number; what: string; kids: Kid[] };
export type KeptEnd = "ended" | "idle";

const TABLE_TTL_MS = 20_000;
const WATCH_EVERY_MS = 30_000;
const KILL_GRACE_MS = 2000;
const GRACE_POLL_MS = 100;
const PENDING_LINES = 16;

const live = new Map<number, Agent>();
const ending = new Map<number, Promise<void>>();
const kept = new Map<string, Kept>();
const pending: [string, string][] = [];
let say: ((owner: string, text: string) => void) | undefined;
let ownerEnded: (owner: string) => boolean = () => false;
let recordFile = paths.agentTrees;
let gateway: Ref | undefined;
let saved = "";

const ps = async (): Promise<string> => {
	const p = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,time=,lstart="], { stdout: "pipe", stderr: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
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
	kept.clear();
	pending.length = 0;
	say = undefined;
	ownerEnded = () => false;
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

/** A line of the listing: the CPU time column is optional (a listing without it still parses). */
export function parseRows(text: string): Row[] {
	const rows: Row[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d[\d:.]*)\s+)?(\S.*?)\s*$/.exec(line);
		if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), start: m[5]!.replace(/\s+/g, " "), cpu: m[4] ? cpuSeconds(m[4]) : undefined });
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

const refOf = ({ pid, start }: Ref): Ref => ({ pid, start });

function save(): void {
	if (!gateway) return;
	const agents = [...live].filter(([, a]) => a.start).map(([pid, a]) => ({ pid, start: a.start, kids: a.kids.map(refOf) }));
	const keptRecord = [...kept].map(([owner, k]) => ({ owner, at: k.at, what: k.what, kids: k.kids.map(({ pid, start, busyAt }) => ({ pid, start, busyAt })) }));
	const body = JSON.stringify({ gateway, agents, kept: keptRecord });
	if (body === saved) return;
	saved = body;
	try {
		writeAtomic(recordFile, body);
	} catch (e) {
		log(`agent trees: could not write ${recordFile}: ${e}`);
	}
}

/** Where the plain line about an ended kept process goes, and whether an owner is stopped or deleted. Lines made before this are held (a few). */
export function useKeptHooks(h: { say: (owner: string, text: string) => void; ended: (owner: string) => boolean }): void {
	say = h.say;
	ownerEnded = h.ended;
	for (const [owner, text] of pending.splice(0)) h.say(owner, text);
}

function tell(owner: string, text: string): void {
	if (say) say(owner, text);
	else if (pending.length < PENDING_LINES) pending.push([owner, text]);
}

/** A kept process of `owner` ended: stopped (the session or its process ended) or idle (nothing used it for the bound). */
async function endKept(owner: string, why: KeptEnd): Promise<void> {
	const k = kept.get(owner);
	if (!k) return;
	const rows = parseRows(await processTable(0));
	if (!rows.length) return; // ps failed: the record stays and the next listing tries again
	kept.delete(owner);
	save();
	const victims = stillThere(rows, k.kids);
	if (!victims.length) return;
	log(`kept processes of ${owner} ended (${why}): ${victims.map(v => v.pid).join(", ")}`);
	await endProcesses(victims);
	tell(owner, msg().keptEnded(k.what, why));
}

/** A listing arrived: kept processes follow their rows (gone ones drop out) and the ones whose owner ended or that sat idle too long end. */
function sweepKept(rows: readonly Row[], now: number): Promise<void> {
	const byPid = new Map(rows.map(r => [r.pid, r]));
	const ends: Promise<void>[] = [];
	for (const [owner, k] of kept) {
		const present = k.kids.flatMap(x => (byPid.get(x.pid)?.start === x.start ? [byPid.get(x.pid)!] : []));
		if (!present.length) {
			kept.delete(owner);
			continue;
		}
		const below = descendantsOf(rows, present.map(r => r.pid)).filter(r => !live.has(r.pid) && r.pid !== process.pid);
		k.kids = withCpu(k.kids, [...present, ...below].slice(0, MAX_KEPT), now);
		const lastUse = Math.max(k.at, ...k.kids.map(x => x.busyAt ?? 0));
		const why: KeptEnd | undefined = ownerEnded(owner) ? "ended" : now - lastUse > IDLE_BOUND_MS ? "idle" : undefined;
		if (why) ends.push(endKept(owner, why).catch(e => log(`kept processes of ${owner}: ending failed: ${e}`)));
	}
	return Promise.all(ends).then(() => undefined);
}

/** A listing arrived: each live agent's record becomes the processes below it now, and the kept processes are looked after. */
export function observe(rows: readonly Row[], now = Date.now()): Promise<void> {
	const byPid = new Map(rows.map(r => [r.pid, r]));
	const self = byPid.get(process.pid);
	if (self) gateway = { pid: self.pid, start: self.start };
	for (const [pid, a] of live) {
		const row = byPid.get(pid);
		if (!row || ending.has(pid)) continue; // gone: the exit handler has the last record
		a.start ??= row.start;
		a.kids = withCpu(a.kids, descendantsOf(rows, [pid]), now);
	}
	const swept = rows.length ? sweepKept(rows, now) : Promise.resolve();
	save();
	return swept;
}

/** `owner` is the session the agent belongs to (lane:<name> or a conversation key); undefined for an agent no session owns. */
export function trackAgent(pid: number, owner?: string): void {
	live.set(pid, { kids: [], owner });
}

/** The agent is about to be parked (an idle stop); false takes it back when the stop was refused. Only an agent with an owner can be. */
export function markPark(pid: number | undefined, on = true): void {
	const a = pid === undefined ? undefined : live.get(pid);
	if (a?.owner) a.parked = on;
}

/**
 * The agent exited: end what it started (from the last record, checked against a new listing). A parked agent keeps the useful
 * processes its owner's shell tool started instead. Resolves when that is done.
 */
export function agentEnded(pid: number): Promise<void> {
	const a = live.get(pid);
	if (!a) return Promise.resolve();
	const owned = a.owner ? kept.get(a.owner) : undefined;
	if (a.owner) kept.delete(a.owner);
	const done = (async () => {
		if (!a.kids.length && !owned) return;
		const rows = parseRows(await processTable(0));
		const recorded = [...a.kids, ...(owned?.kids ?? [])];
		const victims = stillThere(rows, recorded);
		const { keep, what } = a.owner && a.parked ? await pickKept(victims, recorded, Date.now()) : { keep: [], what: "" };
		if (a.owner && keep.length) kept.set(a.owner, { at: Date.now(), what, kids: withCpu(recorded, keep, Date.now()) });
		const staying = new Set(keep.map(r => r.pid));
		const ended = victims.filter(v => !staying.has(v.pid));
		if (ended.length) log(`agent ${pid} ended: ending ${ended.length} process(es) it started through its shell tool`);
		save();
		await endProcesses(ended);
		if (a.owner && owned && !keep.length && ended.some(v => owned.kids.some(k => k.pid === v.pid))) tell(a.owner, msg().keptEnded(owned.what, "ended"));
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

/**
 * After a gateway that stopped (planned restart, self-update or crash): ends what its agents left running. The kept processes of a
 * session that still exists (same pid and start time, `ownerEnded` false) are adopted again with their record; those of an
 * ended session are ended. The previous gateway still running (same pid and start time) leaves everything alone.
 */
export async function reapLeftovers(): Promise<number[]> {
	let rec: { gateway?: unknown; agents?: unknown; kept?: unknown };
	try {
		rec = JSON.parse(readFileSync(recordFile, "utf8"));
	} catch {
		return []; // no record: no gateway left agents behind
	}
	const rows = parseRows(await processTable(0));
	if (!rows.length) return [];
	const [old] = refs([rec.gateway]);
	if (old && rows.some(r => r.pid === old.pid && r.start === old.start)) return [];
	const heldBefore = (Array.isArray(rec.kept) ? rec.kept : []).filter((k): k is { owner: string; at?: unknown; what?: unknown; kids?: unknown } => typeof k?.owner === "string");
	const now = Date.now();
	const adopted = new Set<number>();
	const lines: [string, string][] = [];
	const victims: Row[] = [];
	for (const h of heldBefore) {
		const there = stillThere(rows, refs(h.kids));
		if (!there.length) continue;
		const what = typeof h.what === "string" ? h.what : "";
		if (ownerEnded(h.owner)) {
			victims.push(...there);
			lines.push([h.owner, msg().keptEnded(what, "ended")]);
			continue;
		}
		const before = refs(h.kids).map(r => ({ pid: r.pid, start: r.start, busyAt: typeof (r as Kid).busyAt === "number" ? (r as Kid).busyAt : undefined }));
		kept.set(h.owner, { at: typeof h.at === "number" ? h.at : now, what, kids: withCpu(before, there, now) });
		for (const r of there) adopted.add(r.pid);
	}
	const recorded = (Array.isArray(rec.agents) ? rec.agents : []).flatMap((a: { pid?: number; start?: string; kids?: unknown }) => refs([a]).concat(refs(a?.kids)));
	victims.push(...stillThere(rows, recorded).filter(r => !adopted.has(r.pid)));
	if (adopted.size) log(`agent trees: adopted ${adopted.size} kept process(es) of the gateway before this one`);
	if (victims.length) log(`agent trees: the gateway before this one left ${victims.length} process(es) running, ending them: ${victims.map(v => v.pid).join(", ")}`);
	await endProcesses(victims);
	for (const [owner, text] of lines) tell(owner, text);
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
