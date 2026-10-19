// Is a runtime's CLI installed on this machine? One short `<bin> --version` run per runtime, shared by the adapters
// (omp, claude) and by the detect-only entries for runtimes dotz has no adapter for yet (codex, omo), so the
// runtime menu can list them as "installed, not supported yet". Nothing here ever throws.
import { existsSync } from "node:fs";
import type { DetectResult } from "./types.ts";

const VERSION_TIMEOUT_MS = 8000;

// `bin` is a command name or a path. The first semver-looking token of the output is the version (else its first line).
export async function detectBinary(bin: string, args: string[] = ["--version"]): Promise<DetectResult> {
	const path = bin.includes("/") ? (existsSync(bin) ? bin : undefined) : (Bun.which(bin) ?? undefined);
	if (!path) return { installed: false, reason: `\`${bin}\` was not found on PATH` };
	try {
		const proc = Bun.spawn([path, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL" });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		const text = (out.trim() || err.trim()).split("\n")[0] ?? "";
		if (code !== 0) return { installed: false, path, reason: `\`${bin} ${args.join(" ")}\` exited with ${code}${text ? `: ${text.slice(0, 120)}` : ""}` };
		return { installed: true, path, version: /\d+\.\d+\.\d+[\w.+-]*/.exec(text)?.[0] ?? (text.slice(0, 60) || undefined) };
	} catch (e) {
		return { installed: false, path, reason: `\`${bin} ${args.join(" ")}\` failed: ${(e as Error).message}` };
	}
}

export interface DetectOnly {
	id: "codex" | "omo";
	detect(): Promise<DetectResult>;
}

export const codex: DetectOnly = {
	id: "codex",
	detect: () => detectBinary(process.env.DOTZ_CODEX ?? "codex"),
};

// OmO (github.com/code-yeongyu/oh-my-openagent, formerly oh-my-opencode): since 5.0 a standalone `omo` CLI on senpi, a pi
// fork, installed by its own script or as the npm package `omo-ai`.
export const omo: DetectOnly = {
	id: "omo",
	detect: () => detectBinary(process.env.DOTZ_OMO ?? "omo"),
};
