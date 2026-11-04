// A machine-checkable Done-when (dori signals.ts, adapted): the brief's `Done when:` line lists checks separated by ";",
// and the gateway reads each one back itself when the lane reports [done] (lanereport.ts), with no orchestrator turn.
// A command runs through the verification receipts (receipts.ts), so a pass on an unchanged checkout is not run again.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runWithReceipt } from "./receipts.ts";

export type Check = { signal: string; ok: boolean; detail: string };
type Signal =
	| { kind: "command"; command: string; stdout?: RegExp }
	| { kind: "file"; path: string }
	| { kind: "url"; url: string; status: number; body?: RegExp }
	| { kind: "merged"; repo: string; n: string };

export const DONE_SYNTAX =
	'"Done when: <check>; <check>", each check one of: command `<shell command>` [stdout~"regex"] (exit 0 in the lane\'s folder) | file <path> (exists; relative to the lane\'s folder) | url <https://...> [status=200] [body~"regex"] | merged <owner/repo>#<N> (GitHub PR merged). Example: Done when: command `bun test`; merged me/app#12';

const KEYWORD = /^(command|file|url|merged)\b/i;

export function doneLine(brief: string): string | undefined {
	return /^\s*[-*]?\s*\**done[- ]when\**\s*:\s*(.+)$/im.exec(brief)?.[1]?.trim();
}

export function splitChecks(line: string): string[] {
	const parts: string[] = [];
	let quote = "";
	let start = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (quote) {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) quote = "";
		} else if (c === "`" || c === '"') quote = c;
		else if (c === ";") {
			parts.push(line.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(line.slice(start));
	return parts.map(p => p.trim()).filter(Boolean);
}

function options(rest: string, allowed: string[], kind: string): Map<string, { op: string; value: string }> {
	const out = new Map<string, { op: string; value: string }>();
	let s = rest.trim();
	while (s) {
		const m = /^([a-z]+)([=~])("(?:[^"\\]|\\.)*"|\S+)\s*/i.exec(s);
		if (!m) throw new Error(`${kind}: expected key=value or key~"regex" at "${s.slice(0, 30)}"`);
		const key = m[1]!.toLowerCase();
		if (!allowed.includes(key)) throw new Error(`${kind}: unknown option ${key}`);
		out.set(key, { op: m[2]!, value: m[3]!.startsWith('"') ? (JSON.parse(m[3]!) as string) : m[3]! });
		s = s.slice(m[0].length);
	}
	return out;
}

function regex(o: { op: string; value: string } | undefined, what: string): RegExp | undefined {
	if (!o) return undefined;
	if (o.op !== "~") throw new Error(`${what} takes ~"regex"`);
	try {
		return new RegExp(o.value);
	} catch {
		throw new Error(`${what}: invalid regex ${o.value}`);
	}
}

export function parseSignal(raw: string): Signal {
	const s = raw.trim();
	const kind = KEYWORD.exec(s)?.[1]?.toLowerCase();
	const rest = s.slice(kind?.length ?? 0).trim();
	if (kind === "merged") {
		const m = /^([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)$/.exec(rest);
		if (!m) throw new Error("merged takes <owner/repo>#<N>");
		return { kind, repo: m[1]!, n: m[2]! };
	}
	if (kind === "command") {
		const m = /^`([^`]+)`(.*)$/.exec(rest);
		if (!m?.[1]?.trim()) throw new Error("command takes a shell command in backticks, e.g. command `bun test`");
		return { kind, command: m[1].trim(), stdout: regex(options(m[2]!, ["stdout"], kind).get("stdout"), "stdout") };
	}
	if (kind === "file") {
		const m = /^(`[^`]+`|"(?:[^"\\]|\\.)*"|\S+)\s*(.*)$/.exec(rest);
		if (!m) throw new Error("file needs a path");
		if (m[2]) throw new Error(`file takes only a path (quote a path with spaces): "${m[2].slice(0, 30)}"`);
		const p = m[1]!.startsWith('"') ? (JSON.parse(m[1]!) as string) : m[1]!.replace(/^`|`$/g, "");
		return { kind, path: p };
	}
	if (kind === "url") {
		const url = /^\S+/.exec(rest)?.[0] ?? "";
		if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("url needs an http(s) URL");
		const o = options(rest.slice(url.length), ["status", "body"], kind);
		const st = o.get("status");
		if (st && (st.op !== "=" || !/^\d{3}$/.test(st.value))) throw new Error("status= takes a 3-digit HTTP status");
		return { kind, url, status: st ? Number(st.value) : 200, body: regex(o.get("body"), "body") };
	}
	throw new Error(`not a check: "${s.slice(0, 60)}"`);
}

// The launch gate (owner rule: a lane's Done-when is machine-checkable). A check that starts with a check word but does
// not parse is always refused; a plain-text condition only when the owner asked for the lane (the orchestrator checks it
// by hand then, as before). undefined = accepted.
export function doneProblem(brief: string, ownerAsked: boolean): string | undefined {
	const line = doneLine(brief);
	const fallback = "; if the owner asked for this lane and its outcome truly cannot be checked by a machine, relaunch with owner_asked_for_lane=true to keep a plain-text Done-when";
	if (!line) return ownerAsked ? undefined : `brief needs a checkable ${DONE_SYNTAX}${fallback}`;
	const errors: string[] = [];
	let plain = 0;
	for (const part of splitChecks(line)) {
		if (!KEYWORD.test(part)) plain++;
		else
			try {
				parseSignal(part);
			} catch (e) {
				errors.push(`"${part.slice(0, 60)}": ${(e as Error).message}`);
			}
	}
	if (errors.length) return `Done when has a malformed check (${errors.join("; ")}). Write ${DONE_SYNTAX}`;
	if (plain && !ownerAsked) return `Done when is not machine-checkable ("${line.slice(0, 80)}"). Write ${DONE_SYNTAX}${fallback}`;
	return undefined;
}

// The brief's checks when every part of its Done-when parses, else undefined (a plain-text Done-when: the orchestrator verifies).
export function doneChecks(brief: string): string[] | undefined {
	const line = doneLine(brief);
	const parts = line ? splitChecks(line) : [];
	if (!parts.length) return undefined;
	try {
		parts.forEach(parseSignal);
	} catch {
		return undefined;
	}
	return parts;
}

export type SignalIo = {
	fetch?: (url: string) => Promise<{ status: number; text: () => Promise<string> }>;
	gh?: (args: string[]) => Promise<{ code: number; out: string; err: string }>;
	receiptsDir?: string;
};

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 160);

function ghRun(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; out: string; err: string }>();
	const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
	let out = "";
	let err = "";
	child.stdout.on("data", d => (out += d));
	child.stderr.on("data", d => (err += d));
	child.on("error", e => resolve({ code: 127, out, err: String(e) }));
	child.on("close", code => resolve({ code: code ?? 1, out, err }));
	return promise;
}

export async function checkSignal(raw: string, cwd: string, io: SignalIo = {}): Promise<Check> {
	const signal = raw.trim();
	let sig: Signal;
	try {
		sig = parseSignal(signal);
	} catch (e) {
		return { signal, ok: false, detail: (e as Error).message };
	}
	try {
		if (sig.kind === "command") {
			const r = await runWithReceipt({ command: sig.command, cwd, ...(io.receiptsDir ? { dir: io.receiptsDir } : {}) });
			const out = `${r.stdout}\n${r.stderr}`;
			if (r.exitCode !== 0) return { signal, ok: false, detail: `exit ${r.exitCode}: ${short(out.slice(-600)) || "no output"}` };
			// The pattern reads both streams: test runners (bun test) print their summary ("0 fail") on stderr. Each stream is also
			// tried alone without its trailing newline, so an anchored pattern ("^1$" on `grep -c`) means what it does in a shell.
			const bare = [r.stdout, r.stderr].map(s => s.replace(/\n+$/, ""));
			if (sig.stdout && ![out, ...bare].some(s => sig.stdout!.test(s))) return { signal, ok: false, detail: `exit 0 but output does not match ${sig.stdout}: ${short(out.slice(-300)) || "(empty)"}` };
			return { signal, ok: true, detail: `exit 0${r.reused ? " (receipt reused)" : ""}` };
		}
		if (sig.kind === "file") {
			const p = sig.path === "~" ? homedir() : sig.path.startsWith("~/") ? join(homedir(), sig.path.slice(2)) : sig.path;
			const path = isAbsolute(p) ? p : join(cwd, p);
			return existsSync(path) ? { signal, ok: true, detail: "present" } : { signal, ok: false, detail: `missing: ${path}` };
		}
		if (sig.kind === "url") {
			const res = await (io.fetch ?? ((u: string) => fetch(u, { signal: AbortSignal.timeout(20_000) })))(sig.url);
			if (res.status !== sig.status) return { signal, ok: false, detail: `status ${res.status}, want ${sig.status}` };
			if (sig.body && !sig.body.test(await res.text())) return { signal, ok: false, detail: `status ${res.status} but body does not match ${sig.body}` };
			return { signal, ok: true, detail: `status ${res.status}` };
		}
		const r = await (io.gh ?? ghRun)(["pr", "view", sig.n, "--repo", sig.repo, "--json", "state,mergeCommit"]);
		const j = r.code === 0 ? (JSON.parse(r.out) as { state?: string; mergeCommit?: { oid?: string } | null }) : {};
		const sha = j.mergeCommit?.oid ?? "";
		return { signal, ok: j.state === "MERGED" && Boolean(sha), detail: j.state ? `${j.state} ${sha.slice(0, 10)}`.trim() : short(r.err) || "no answer" };
	} catch (e) {
		return { signal, ok: false, detail: `check failed: ${short(String(e))}` };
	}
}

export function checkDone(checks: string[], cwd: string, io: SignalIo = {}): Promise<Check[]> {
	return Promise.all(checks.map(c => checkSignal(c, cwd, io)));
}
