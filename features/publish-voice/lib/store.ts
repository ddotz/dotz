// Where the feature keeps one person's results: <DATA_DIR>/custom/publish-voice/. Nothing personal is ever in the repo. Pure fs; never imports
// hub/config.ts (it loads the gateway config at import time), so DOTZ_DIR is read on every call and tests can point anywhere.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const dataDir = () => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
export const rootDir = (data = dataDir()) => join(data, "custom", "publish-voice");

const VOICE_NAME = /^[\p{L}\p{N}_-]{1,30}$/u;
export const validVoice = (name: string): boolean => VOICE_NAME.test(name);

export const rootPaths = (root: string) => ({
	needs: join(root, "needs.json"),
	scope: join(root, "scope.json"),
	salt: join(root, "salt.json"),
	lastRun: join(root, "analyze.json"),
	voices: join(root, "voices"),
});

export const voicePaths = (root: string, voice: string) => {
	const dir = join(root, "voices", voice);
	return {
		dir,
		meta: join(dir, "voice.json"),
		docs: join(dir, "docs.json"),
		profile: join(dir, "profile.json"),
		hashes: join(dir, "hashes.json"),
		texts: join(dir, "texts"),
		corrections: join(dir, "corrections.jsonl"),
		lastResult: join(dir, "last-result.txt"),
		lastCell: join(dir, "last-cell.txt"),
	};
};

// Temp file then rename, so a process reading the state mid-write never sees half a file.
export function writeAtomic(file: string, text: string, mode = 0o600): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode });
	chmodSync(tmp, mode);
	renameSync(tmp, file);
}

export function saveJson(file: string, value: unknown): void {
	writeAtomic(file, `${JSON.stringify(value)}\n`);
}

// A missing file is the fallback; a file that exists but is not JSON is a real error and says which file.
export function loadJson<T>(file: string, fallback: T): T {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		if (e instanceof SyntaxError) throw new Error(`${file}이(가) 올바른 JSON이 아니에요`);
		throw e;
	}
}

export function voiceNames(root: string): string[] {
	const dir = rootPaths(root).voices;
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
}
