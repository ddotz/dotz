// Throwaway dotz sessions (tests, runtime probes, a copy of the orchestrator someone started by hand) must not reach the
// owner's real Discord or write the live state: on 2026-10-20 such a copy posted a second [done] to 작업로그 and wrote a
// made-up entry into state.json. Pure helpers, shared by the gateway (hub/discord.ts: a gateway on a temp data dir does
// not connect) and the dotz extension (its gateway calls go to a dry-run sink and its writes into the live data dir are
// refused). DOTZ_ALLOW_LIVE=1 lets a deliberate end-to-end run through.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TEMP_PATH = /^\/(private\/)?(tmp|var\/folders)\//;
const isTempPath = (p: string): boolean => TEMP_PATH.test(resolve(p) + "/") || resolve(p).startsWith(resolve(tmpdir()) + "/");
const allowLive = (env: Record<string, string | undefined> = process.env): boolean => env.DOTZ_ALLOW_LIVE === "1";
const dryRunFile = (): string => join(tmpdir(), "dotz-dry-run.jsonl");

// Why a gateway on this data dir runs without Discord, or undefined for a live one.
export function gatewayDryRun(dataDir: string, env: Record<string, string | undefined> = process.env): string | undefined {
	if (allowLive(env)) return undefined;
	if (env.DOTZ_DRY_RUN === "1") return "DOTZ_DRY_RUN=1";
	if (isTempPath(dataDir)) return `temp data dir ${dataDir}`;
	return undefined;
}

export const hubPid = (dataDir: string): number | undefined => {
	try {
		const n = Number(readFileSync(join(dataDir, "hub.pid"), "utf8").trim());
		return n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
};

// The parent chain of a process, nearest first, from one `ps -axo pid=,ppid=` listing; bounded so a cycle cannot spin.
export function ancestorPids(pid = process.pid, maxDepth = 32): number[] {
	let listing = "";
	try {
		listing = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return [];
	}
	const parentOf = new Map<number, number>();
	for (const line of listing.split("\n")) {
		const [p, pp] = line.trim().split(/\s+/).map(Number);
		if (p && pp !== undefined) parentOf.set(p, pp);
	}
	const chain: number[] = [];
	for (let cur = parentOf.get(pid); cur && cur > 1 && chain.length < maxDepth; cur = parentOf.get(cur)) chain.push(cur);
	return chain;
}

// This process's chain, read once: the extension asks on every tool call, and a fork of ps (~13 ms) each time adds up.
let ownChain: number[] | undefined;
const ownAncestors = (): number[] => (ownChain ??= ancestorPids());

// Why this extension process is a throwaway, or undefined for the owner's live orchestrator or lane. The gateway starts
// those itself (the pid in hub.pid is an ancestor: the direct parent for an orchestrator or lane, further up for a
// worker such as a conversation session's task subagent); an orchestrator or lane process outside the gateway's tree is
// a copy. A terminal session (neither role) is the owner's own and is never treated as one. `ancestors` (parent chain,
// nearest first) is read from ps only when the direct parent is not the gateway.
export function throwawayReason(
	o: { env?: Record<string, string | undefined>; ppid?: number; hubPid?: number; ancestors?: () => number[] } = {},
): string | undefined {
	const env = o.env ?? process.env;
	if (allowLive(env)) return undefined;
	if (env.DOTZ_DRY_RUN === "1") return "DOTZ_DRY_RUN=1";
	if (env.DOTZ_LANE === "probe") return "a runtime probe";
	const role = env.DOTZ_ORCHESTRATOR === "1" ? "orchestrator" : env.DOTZ_LANE ? `lane ${env.DOTZ_LANE}` : undefined;
	if (!role) return undefined;
	const ppid = o.ppid ?? process.ppid;
	if (o.hubPid === undefined) return `a ${role} process with no live gateway (no hub.pid)`;
	if (ppid !== o.hubPid && !(o.ancestors ?? ownAncestors)().includes(o.hubPid)) return `a ${role} process the live gateway did not start (parent ${ppid}, gateway ${o.hubPid})`;
	return undefined;
}

// The live data dir a throwaway must not write: the default ~/.dotz, or DOTZ_DIR unless that is a temp one.
export const liveDataDir = (dataDir: string): string | undefined => (isTempPath(dataDir) ? undefined : resolve(dataDir));
export const defaultDataDir = (): string => join(homedir(), ".dotz");

const SHELL_ANY_ARG = /^(rm|rmdir|mkdir|touch|truncate|chmod|chown|unlink|mv|tee|dd)$/;
const SHELL_LAST_ARG = /^(cp|rsync|ln|install|scp)$/;
const JS_WRITE = /\b(Bun\.write|write|writeFile(?:Sync)?|appendFile(?:Sync)?|mkdir(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|unlink(?:Sync)?|truncate(?:Sync)?|rename(?:Sync)?|cp(?:Sync)?|copyFile(?:Sync)?|symlink(?:Sync)?)\s*\(([^)]*)/g;
const unquote = (t: string): string => t.replace(/^["'`({]+|["'`)};,]+$/g, "");

// The paths a shell or eval text writes: redirect and tee targets, any path of rm/mkdir/touch/mv/sed -i, the destination
// (last argument or -t) of cp/rsync/ln/install, and the target argument of a JS write call. A JS target that is a
// variable is resolved through its one assignment in the text, or kept as `?` (unknown) so the caller stays strict.
function writeTargets(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?<![=<>-])(?:\d|&)?>>?\|?\s*([^\s;&|<>()]+)/g)) out.push(unquote(m[1]!));
	for (const seg of text.split(/\n|;|&&|\|\||\||\$\(|`/)) {
		const words = seg.trim().split(/\s+/).map(unquote).filter(Boolean);
		const i = words.findIndex(w => SHELL_ANY_ARG.test(w) || SHELL_LAST_ARG.test(w) || w === "sed" || w === "perl");
		if (i < 0) continue;
		const cmd = words[i]!;
		const args = words.slice(i + 1);
		if (cmd === "sed" || cmd === "perl") {
			if (args.some(a => /^-[a-zA-Z]*i/.test(a))) out.push(...args.filter(a => !a.startsWith("-")));
		} else if (SHELL_ANY_ARG.test(cmd)) out.push(...args.map(a => a.replace(/^of=/, "")));
		else {
			const t = args.findIndex(a => a === "-t" || a.startsWith("--target-directory"));
			const plain = args.filter(a => !a.startsWith("-"));
			if (t >= 0) out.push(args[t]!.includes("=") ? args[t]!.split("=")[1]! : (args[t + 1] ?? ""));
			else if (plain.length) out.push(plain[plain.length - 1]!);
		}
	}
	for (const m of text.matchAll(JS_WRITE)) {
		const fn = m[1]!;
		const args = m[2]!.split(",").map(a => a.trim());
		const picked = /^(cp|copyFile|symlink)/.test(fn) ? [args[1] ?? ""] : /^rename/.test(fn) ? args.slice(0, 2) : [args[0] ?? ""];
		for (const a of picked) {
			if (/^["'`]/.test(a)) out.push(unquote(a));
			else if (/^[A-Za-z_$][\w$.]*$/.test(a)) out.push(text.match(new RegExp(`\\b${a.replace(/[.$]/g, "\\$&")}\\s*=\\s*([^;\\n]+)`))?.[1] ?? "?");
			else if (a) out.push(a);
		}
	}
	return out;
}

// A write/edit into the live data dir, or a shell/eval command whose write target is inside it (see writeTargets); the
// data dir as a read source (`cp ~/.dotz/x ~/work/`, `cat`) is fine. After a `cd` into the data dir, or with an unknown JS
// write target, any write in a command that names the dir counts.
export function liveWrite(event: any, liveDirs: string[]): string | undefined {
	const tool = String(event?.toolName ?? "");
	const input = event?.input ?? {};
	const dirs = liveDirs.map(d => resolve(d));
	const under = (p: string) => dirs.find(d => resolve(p.replace(/^~(?=\/)/, homedir())) === d || resolve(p.replace(/^~(?=\/)/, homedir())).startsWith(`${d}/`));
	if (tool === "write" || tool === "edit") {
		const p = String(input.path ?? input.file_path ?? "");
		const d = p && under(p);
		return d ? `${tool} ${p} (inside the live data dir ${d})` : undefined;
	}
	if (tool !== "bash" && tool !== "eval") return undefined;
	const text = String(input.command ?? input.code ?? "");
	const names = (s: string) => dirs.find(d => s.includes(d) || (d === resolve(defaultDataDir()) && /~\/\.dotz\b|\$HOME\/\.dotz\b/.test(s)));
	const named = names(text);
	if (!named) return undefined;
	const targets = writeTargets(text);
	const forms = [...dirs.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "~/\\.dotz", "\\$HOME/\\.dotz"].join("|");
	const insideDir = new RegExp(`(\\bcd\\s+|\\bcwd\\s*[:(]\\s*)["'\`]?(${forms})`).test(text);
	const hit = targets.map(names).find(Boolean) ?? ((insideDir && targets.length) || targets.includes("?") ? named : undefined);
	return hit ? `a ${tool} command that writes into the live data dir ${hit}` : undefined;
}

// What a throwaway's gateway call does instead: one line in the dry-run sink, and an answer saying nothing was sent.
export function dryRun(path: string, init: { method?: string; body?: unknown }, reason: string, file = dryRunFile()): Record<string, unknown> {
	appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), reason, method: init.method ?? "GET", path, body: typeof init.body === "string" ? init.body.slice(0, 2000) : undefined })}\n`);
	const why = `dry run: ${reason}; nothing was sent or changed (logged to ${file}). Set DOTZ_ALLOW_LIVE=1 for a deliberate live run.`;
	return { ok: false, delivered: false, dryRun: true, reason: why, error: why };
}
