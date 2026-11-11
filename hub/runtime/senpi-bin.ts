// OmO starts each task worker as `senpi` found on PATH (or $SENPI_BIN). senpi's cli.js has a `#!/usr/bin/env node` line and
// then re-executes itself under bun, so every worker was a `node` process (~48 MB, doing nothing) above its bun process
// (measured 2026-10-21: 4 workers, 4 node wrappers, ~195 MB). SENPI_BIN pointing at a launcher that execs bun on the same
// cli.js starts the worker as the bun process directly, with the same arguments and environment.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, writeAtomic } from "../config.ts";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
let cached: string | null | undefined;

// The launcher's path, or undefined when `senpi` is not a node-shebang script (a compiled build, not installed, already
// bun) and OmO should resolve it as before.
export function senpiLauncher(path = process.env.PATH, bun = process.execPath, dir = join(DATA_DIR, "bin")): string | undefined {
	if (cached !== undefined && dir === join(DATA_DIR, "bin") && bun === process.execPath) return cached ?? undefined;
	let found: string | undefined;
	try {
		const bin = Bun.which("senpi", { PATH: path ?? "" });
		const cli = bin && realpathSync(bin);
		if (cli && /\.js$/.test(cli) && /^#!.*\bnode\b/.test(readFileSync(cli, "utf8").slice(0, 120)) && existsSync(bun)) {
			const file = join(dir, "senpi-bun");
			const body = `#!/bin/sh\nexec ${quote(bun)} ${quote(cli)} "$@"\n`;
			mkdirSync(dirname(file), { recursive: true });
			if (!existsSync(file) || readFileSync(file, "utf8") !== body) writeAtomic(file, body);
			chmodSync(file, 0o755);
			found = file;
		}
	} catch {
		found = undefined;
	}
	if (dir === join(DATA_DIR, "bin") && bun === process.execPath) cached = found ?? null;
	return found;
}
