// Is a runtime's CLI installed on this machine? One short `<bin> --version` run per runtime, shared by the adapters
// (omp, claude) and by the detect-only entries for runtimes dotz has no adapter for yet (codex, opencode), so the
// runtime menu can list them as "installed, not supported yet". Nothing here ever throws.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
	id: "codex" | "opencode";
	detect(): Promise<DetectResult>;
}

export const codex: DetectOnly = {
	id: "codex",
	detect: () => detectBinary(process.env.DOTZ_CODEX ?? "codex"),
};

const OH_MY_OPENCODE = ["oh-my-opencode", "oh-my-openagent"];

// The oh-my-opencode plugin is present when opencode's config lists it under `plugin` (opencode.json / .jsonc) or its own
// config file sits next to it. opencode reads `$XDG_CONFIG_HOME/opencode` (default ~/.config/opencode).
function ohMyOpencodePresent(): boolean {
	const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
	if (OH_MY_OPENCODE.some(n => existsSync(join(dir, `${n}.json`)) || existsSync(join(dir, `${n}.jsonc`)))) return true;
	for (const file of ["opencode.json", "opencode.jsonc"]) {
		try {
			const text = readFileSync(join(dir, file), "utf8");
			const plugins = (JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")).plugin ?? []) as unknown;
			if (Array.isArray(plugins) && plugins.some(p => typeof p === "string" && OH_MY_OPENCODE.some(n => p === n || p.startsWith(`${n}@`)))) return true;
		} catch {
			continue;
		}
	}
	return false;
}

export const opencode: DetectOnly = {
	id: "opencode",
	async detect() {
		const found = await detectBinary(process.env.DOTZ_OPENCODE ?? "opencode");
		return { ...found, plugins: { "oh-my-opencode": ohMyOpencodePresent() } };
	},
};
