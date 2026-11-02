// A pass-through `claude` for the Claude sign-in OmO runs on the owner's behalf (hub/runtime/omo-login.ts points OmO's
// CLAUDE_CODE_EXECUTABLE here, for that short-lived login process only).
//
// Why: `claude auth login --claudeai` writes its paste prompt "Paste code here if prompted > " without a line break, and after an
// accepted pasted code it writes "Login successful.\n" right behind it (it only ends the prompt line itself when no code was
// pasted). senpi 2026.10.31 decides the outcome with /^Login successful\.$/m, so the pasted-code sign-in - the one the web page
// uses - is judged "unexpected_exit" and undone even though the CLI exited 0 signed in. This wrapper runs the real CLI and only
// starts a new line before "Login successful." when it would otherwise share a line; everything else passes through unchanged.
// Upstream: senpi's SUCCESS_LINE should accept the prompt prefix (anthropic-subscription/claude-cli-auth.js).
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUCCESS = "Login successful.";

// Pure, stateful per stream: the output with a line break before "Login successful." wherever it does not start a line.
export function successLineSplitter(): (chunk: string) => string {
	let atLineStart = true;
	return chunk => {
		if (!chunk) return chunk;
		let s = chunk.replace(/([^\n])(?=Login successful\.)/g, "$1\n");
		if (!atLineStart && s.startsWith(SUCCESS)) s = `\n${s}`;
		atLineStart = s.endsWith("\n");
		return s;
	};
}

const isFile = (p: string): boolean => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

// The Claude CLI OmO would run when not pointed here: an explicit CLAUDE_CODE_EXECUTABLE, `claude` on PATH, else the copy bundled with
// the newest OmO runtime. Undefined: none found (OmO then resolves it itself, unwrapped).
export function realClaude(env: Record<string, string | undefined>, agentDir: string, shimDir: string): string | undefined {
	const set = env.CLAUDE_CODE_EXECUTABLE;
	if (set && !set.startsWith(shimDir) && isFile(set)) return set;
	const onPath = Bun.which("claude", { PATH: env.PATH ?? "" });
	if (onPath) return onPath;
	const rel = join("node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
	const root = join(agentDir, "runtime");
	let dirs: string[] = [];
	try {
		dirs = readdirSync(root);
	} catch {
		return undefined;
	}
	return dirs
		.map(d => join(root, d, rel))
		.filter(isFile)
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

// Writes the executable OmO spawns (a tiny sh script: senpi runs CLAUDE_CODE_EXECUTABLE directly, without a shell) and returns the env
// to give the login process. Empty when there is no real CLI to wrap.
export function claudeShimEnv(env: Record<string, string | undefined>, agentDir: string, shimDir = join(tmpdir(), `dotz-claude-shim-${process.getuid?.() ?? 0}`)): Record<string, string> {
	const real = realClaude(env, agentDir, shimDir);
	if (!real) return {};
	try {
		if (!existsSync(shimDir)) mkdirSync(shimDir, { recursive: true, mode: 0o700 });
		const exe = join(shimDir, "claude");
		writeFileSync(exe, `#!/bin/sh\nDOTZ_CLAUDE_REAL=${sq(real)} exec ${sq(process.execPath)} ${sq(import.meta.path)} "$@"\n`);
		chmodSync(exe, 0o700);
		return { CLAUDE_CODE_EXECUTABLE: exe };
	} catch {
		return {};
	}
}

if (import.meta.main) {
	const real = process.env.DOTZ_CLAUDE_REAL;
	if (!real) {
		process.stderr.write("dotz claude shim: DOTZ_CLAUDE_REAL is not set\n");
		process.exit(127);
	}
	const { DOTZ_CLAUDE_REAL: _, ...env } = process.env;
	const child = Bun.spawn([real, ...process.argv.slice(2)], { stdin: "inherit", stdout: "pipe", stderr: "inherit", env });
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
	const split = successLineSplitter();
	const dec = new TextDecoder();
	for await (const chunk of child.stdout) {
		const out = split(dec.decode(chunk, { stream: true }));
		if (out) process.stdout.write(out);
	}
	const code = await child.exited;
	process.exit(child.signalCode ? 1 : code);
}
