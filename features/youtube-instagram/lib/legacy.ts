// Reuse the YouTube/Instagram login a machine already keeps from the owner's earlier setup (오모냥's ~/.ddotz, the OmO harness folders), so the
// owner does not copy token files by hand. One yes/no, then the files are copied into <data dir>/secrets with 0600. Values are never parsed,
// printed or logged: this module only looks at file names and copies bytes. Nothing is overwritten and nothing is copied before the "yes".
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { paths, secretsDir, snsDir } from "./config.ts";

export const LEGACY_ASK = "기존 유튜브·인스타 연결을 가져올까요?";
export const LEGACY_YES = "--import-legacy";
export const LEGACY_NO = "--no-import-legacy";
export const IMPORT_FROM = "--import-from";
export const IMPORT_YT = "--import-yt";
export const IMPORT_IG = "--import-ig";
export const IMPORT_HINT = `기존 토큰 위치를 알면 ${IMPORT_FROM} <경로>로 다시 실행해요`;

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

// Where the owner's bot says the earlier tokens are: --import-from <file-or-dir> (repeatable), --import-yt <file>, --import-ig <file>.
export type Explicit = { from: string[]; yt: string[]; ig: string[] };
export function explicitOf(args: readonly string[]): Explicit {
	const e: Explicit = { from: [], yt: [], ig: [] };
	const key: Record<string, keyof Explicit> = { [IMPORT_FROM]: "from", [IMPORT_YT]: "yt", [IMPORT_IG]: "ig" };
	args.forEach((a, i) => {
		const eq = a.indexOf("=");
		const name = eq > 0 ? a.slice(0, eq) : a;
		const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
		if (name in key && value && (eq > 0 || !value.startsWith("--"))) e[key[name]!].push(resolve(value.replace(/^~(?=\/|$)/, homedir())));
	});
	return e;
}

// The old setups named the files youtube-oauth.json / instagram.json, and also youtube_oauth.json, youtube-token.json, instagram-token.json,
// instagram-token-new.json, ig.json, google-oauth.json ... Matched by name only. The client file and the access cache hold no login.
const NOT_LOGIN = /client|access/i;
const kindOf = (file: string): string | undefined => {
	const n = basename(file).toLowerCase();
	if (!n.endsWith(".json") || NOT_LOGIN.test(n)) return undefined;
	if (/youtube|^yt|google/.test(n)) return "youtube-oauth.json";
	if (/insta|^ig/.test(n)) return "instagram.json";
	return undefined;
};
const isFile = (f: string): boolean => {
	try {
		return statSync(f).isFile();
	} catch {
		return false;
	}
};
const isDir = (f: string): boolean => {
	try {
		return statSync(f).isDirectory();
	} catch {
		return false;
	}
};

/** Login files for one source: a file is taken as it is; a folder is searched (it and its secrets/ folder), the exact standard name first. */
function inSource(source: string, name: string): string | undefined {
	if (isFile(source)) return kindOf(source) === name ? source : undefined;
	for (const d of [source, join(source, "secrets")]) {
		if (!isDir(d)) continue;
		const exact = join(d, name);
		if (isFile(exact)) return exact;
		const hit = readdirSync(d).sort().find(f => kindOf(f) === name && isFile(join(d, f)));
		if (hit) return join(d, hit);
	}
	return undefined;
}

/** The earlier setup's login files this machine has and this install lacks (name -> source file). Given paths come first, the guessed folders after.
 * Once the owner said no nothing is offered again, unless he points at paths again. */
export function findLegacy(args: readonly string[] = []): Record<string, string> {
	const e = explicitOf(args);
	if (declined() && !(e.from.length + e.yt.length + e.ig.length)) return {};
	const found: Record<string, string> = {};
	for (const [name, dest] of Object.entries(targets())) {
		if (existsSync(dest)) continue;
		const own = name === "instagram.json" ? e.ig : e.yt;
		const from = [...own.filter(isFile), ...[...e.from, ...legacyDirs()].map(s => inSource(s, name))].find(f => f);
		if (from) found[name] = from;
	}
	return found;
}

export type Gate = { lines: string[]; ask: boolean };

/** The one yes/no. Nothing found or already answered = no lines. yes copies (0600, 0700 folder) and continues; no is remembered. */
export function legacyGate(args: readonly string[]): Gate {
	const found = findLegacy(args), names = Object.keys(found);
	const e = explicitOf(args);
	if (!names.length) {
		const given = [...e.from, ...e.yt, ...e.ig];
		return { lines: given.length && !args.includes(LEGACY_NO) ? [`알려 주신 위치에서 가져올 유튜브·인스타 토큰 파일을 찾지 못했어요: ${given.join(", ")}`] : [], ask: false };
	}
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
	return { lines: ["사용자가 고를 것이 하나 있어요 (한 번만 물어요):", `- ${LEGACY_ASK} (${names.join(", ")})`, `예: 같은 명령(받은 위치 옵션 그대로)에 ${LEGACY_YES}를 붙여 다시 실행해요. 아니요: ${LEGACY_NO}를 붙여요`], ask: true };
}
