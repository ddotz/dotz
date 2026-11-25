import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SHIP_TIMEOUT_MS = 120_000;
const USAGE = "usage: bun scripts/sync-coding-harness.ts <harness-foundation checkout> [--commit <rev>]";

export type Sync = { checkout: string; rev?: string; dest?: string };

/**
 * Ships `rev` (default HEAD) of the harness-foundation `checkout` with its agent/harness/ship.ts into a folder next to `dest`
 * (default <repo>/vendor/coding-harness) and swaps it in with two renames. Returns ship's one-line report. Throws, `dest` untouched, when the ship fails.
 */
export function syncCodingHarness(o: Sync): string {
	const dest = resolve(o.dest ?? join(ROOT, "vendor", "coding-harness"));
	const checkout = resolve(o.checkout);
	const ship = join(checkout, "agent", "harness", "ship.ts");
	if (!existsSync(ship)) throw new Error(`${checkout} has no agent/harness/ship.ts`);
	const fresh = `${dest}.new`;
	const old = `${dest}.old`;
	rmSync(fresh, { recursive: true, force: true });
	rmSync(old, { recursive: true, force: true });
	const r = spawnSync(process.execPath, [ship, fresh, ...(o.rev ? ["--commit", o.rev] : [])], { cwd: checkout, encoding: "utf8", timeout: SHIP_TIMEOUT_MS });
	if (r.status !== 0) {
		rmSync(fresh, { recursive: true, force: true });
		throw new Error(`ship failed (${r.status ?? r.signal}): ${(r.stderr || r.stdout).trim()}`);
	}
	if (existsSync(dest)) renameSync(dest, old);
	renameSync(fresh, dest);
	rmSync(old, { recursive: true, force: true });
	return r.stdout.trim();
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--commit");
	const rev = at >= 0 ? args[at + 1] : undefined;
	const rest = at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
	if (rest.length !== 1 || (at >= 0 && !rev)) {
		console.error(USAGE);
		process.exit(2);
	}
	try {
		console.log(syncCodingHarness({ checkout: rest[0]!, rev }));
	} catch (e) {
		console.error(`sync-coding-harness: ${(e as Error).message}`);
		process.exit(1);
	}
}
