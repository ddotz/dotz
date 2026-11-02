// OmO engine changed on disk under a running gateway (#26). The omo-ai / senpi packages can be updated from outside dotz
// (`~/node_modules` installs that dotz's own harness update never touches) while the gateway's omo processes keep running
// the old code; an old process misreading the new claude-cli account format wrote a 15-minute auth_error block into the
// shared auth.json and stopped every session. The gateway records the installed omo-ai and senpi versions at start and,
// when the disk differs on two consecutive checks, asks for a restart through the idle gate (main passes restartGateway),
// so no process outlives the engine it was started from. dotz never rewrites the third-party package files.
//
// Cost: one timer tick per minute (unref'd) that resolves `omo` on PATH and reads two small package.json files; no child
// process, no model call, no network, and a few hundred bytes of heap.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../config.ts";
import { trackTimer } from "../shutdown.ts";
import { OMO } from "./omo-hosts.ts";

const SENPI = join("@code-yeongyu", "senpi");
export const CHECK_MS = 60_000;

const versionAt = (pkgDir: string): string => {
	const v = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
	if (typeof v !== "string" || !v) throw new Error(`no version in ${pkgDir}/package.json`);
	return v;
};

// "omo-ai@<version> senpi@<version>" of what is installed now; throws when it cannot be read (not installed, or an install
// in progress with a missing or half-written package.json).
export function readEngineVersions(bin = OMO): string {
	const found = Bun.which(bin);
	if (!found) throw new Error(`${bin} not found on PATH`);
	const omo = dirname(dirname(realpathSync(found)));
	// senpi sits nested under omo-ai or hoisted next to it.
	const senpi = [join(omo, "node_modules", SENPI), join(dirname(omo), SENPI), join(dirname(dirname(omo)), SENPI)].find(d => existsSync(join(d, "package.json")));
	if (!senpi) throw new Error(`senpi package not found for ${omo}`);
	return `omo-ai@${versionAt(omo)} senpi@${versionAt(senpi)}`;
}

type Deps = { read?: () => string; everyMs?: number };

// Starts the watch; the returned function stops it. Nothing is watched when the versions cannot be read at start.
export function startOmoEngineWatch(restart: () => string, deps: Deps = {}): () => void {
	const read = deps.read ?? readEngineVersions;
	const everyMs = deps.everyMs ?? CHECK_MS;
	let started: string;
	try {
		started = read();
	} catch (e) {
		log(`omo engine watch off: ${e}`);
		return () => {};
	}
	let changed: string | undefined; // the differing version seen by the previous check
	let stopped = false;
	let timer: Timer | undefined;
	const arm = () => {
		timer = setTimeout(tick, everyMs);
		timer.unref?.();
		trackTimer("omo engine watch", timer);
	};
	const tick = () => {
		if (stopped) return;
		let now: string | undefined;
		try {
			now = read();
		} catch {
			now = undefined; // a half-written install is not a change, and it breaks the "two in a row"
		}
		if (now === undefined || now === started) changed = undefined;
		else if (now !== changed) changed = now; // first sight, or still moving: one more check
		else {
			stopped = true;
			log(`omo engine changed on disk (${started} -> ${now}); restarting the gateway at the next idle point: ${restart()}`);
			return;
		}
		arm();
	};
	arm();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
