// Reuse the YouTube/Instagram login a machine already keeps from the owner's earlier setup (오모냥's ~/.ddotz, the OmO harness folders), so the
// owner does not copy token files by hand. One yes/no, then the files are copied into <data dir>/secrets with 0600. Values are never parsed,
// printed or logged: this module only looks at file names and copies bytes. Nothing is overwritten and nothing is copied before the "yes".
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths, secretsDir, snsDir } from "./config.ts";

export const LEGACY_ASK = "기존 유튜브·인스타 연결을 가져올까요?";
export const LEGACY_YES = "--import-legacy";
export const LEGACY_NO = "--no-import-legacy";

// Secret folders of the earlier setups (the same file names as ours). DOTZ_LEGACY_SECRETS (":"-separated, empty = none) replaces the list.
export const legacyDirs = (): string[] => {
	const env = process.env.DOTZ_LEGACY_SECRETS;
	if (env !== undefined) return env.split(":").filter(Boolean);
	const home = homedir();
	return [join(home, ".ddotz", "secrets"), join(home, ".omonyang", "secrets"), join(home, ".omo", "secrets")];
};

const targets = (): Record<string, string> => ({ "youtube-oauth.json": paths.ytOauth(), "instagram.json": paths.instagram() });
const declinedFile = () => join(snsDir(), "legacy-import.json");
const declined = (): boolean => existsSync(declinedFile());

/** The earlier setup's login files this machine has and this install lacks (name -> source file); none once the owner said no. */
export function findLegacy(): Record<string, string> {
	if (declined()) return {};
	const found: Record<string, string> = {};
	for (const [name, dest] of Object.entries(targets())) {
		if (existsSync(dest)) continue;
		const from = legacyDirs().map(d => join(d, name)).find(f => existsSync(f));
		if (from) found[name] = from;
	}
	return found;
}

export type Gate = { lines: string[]; ask: boolean };

/** The one yes/no. Nothing found or already answered = no lines. yes copies (0600, 0700 folder) and continues; no is remembered. */
export function legacyGate(args: readonly string[]): Gate {
	const found = findLegacy(), names = Object.keys(found);
	if (!names.length) return { lines: [], ask: false };
	if (args.includes(LEGACY_YES)) {
		mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
		for (const [name, from] of Object.entries(found)) {
			const dest = targets()[name]!;
			writeFileSync(dest, readFileSync(from), { mode: 0o600 });
			chmodSync(dest, 0o600);
		}
		return { lines: [`기존 연결을 가져왔어요: ${names.join(", ")}`], ask: false };
	}
	if (args.includes(LEGACY_NO)) {
		mkdirSync(snsDir(), { recursive: true });
		writeFileSync(declinedFile(), `${JSON.stringify({ declined: new Date().toISOString() })}\n`);
		return { lines: ["기존 연결은 가져오지 않아요"], ask: false };
	}
	return { lines: ["사용자가 고를 것이 하나 있어요 (한 번만 물어요):", `- ${LEGACY_ASK} (${names.join(", ")})`, `예: 같은 명령에 ${LEGACY_YES}를 붙여 다시 실행해요. 아니요: ${LEGACY_NO}를 붙여요`], ask: true };
}
