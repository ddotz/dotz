// KakaoTalk id / password / database key store. The macOS Keychain (service dotz.kakao, accounts id|password|dbkey) is the
// home; when it is unavailable a 0600 JSON file ({username,password,dbkey}) under <dataDir>/secrets is the fallback.
// A value is only ever written to the `security -i` STDIN (never argv), and never put into a log line or an error.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KEYCHAIN_SERVICE, type KakaoPaths, type Runner } from "./types.ts";

export type SecretName = "id" | "password" | "dbkey";
export type CredDeps = { paths: KakaoPaths; runner: Runner };

const NAMES: SecretName[] = ["id", "password", "dbkey"];
// The fallback file keeps the field names the gateway's secret flow writes (hub/auth.ts): id <-> username.
const FIELD: Record<SecretName, string> = { id: "username", password: "password", dbkey: "dbkey" };

// Atomic write of a private file (0600) in a private directory (0700).
export function writePrivate(file: string, text: string): void {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

function readFallback(paths: KakaoPaths): Record<string, string> {
	try {
		const raw = JSON.parse(readFileSync(paths.secretFile, "utf8"));
		const out: Record<string, string> = {};
		if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

function writeFallback(paths: KakaoPaths, data: Record<string, string>): void {
	if (Object.keys(data).length) writePrivate(paths.secretFile, `${JSON.stringify(data)}\n`);
	else rmSync(paths.secretFile, { force: true });
}

async function keychainGet(name: SecretName, { runner }: CredDeps): Promise<string | undefined> {
	try {
		const r = await runner(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
		const value = r.stdout.replace(/\r?\n$/, "");
		return r.code === 0 && value ? value : undefined;
	} catch {
		return undefined;
	}
}

// One line of `security -i` input: a double-quoted word with backslash and quote escaped. A line break cannot be quoted, so such a
// value never goes to the Keychain.
const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// `security -i` can exit 0 after a command it refused to parse, so a write counts only when the value reads back unchanged.
async function keychainSet(name: SecretName, value: string, deps: CredDeps): Promise<boolean> {
	if (!value || /[\r\n\0]/.test(value)) return false;
	try {
		const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -w ${quote(value)}\n`;
		const r = await deps.runner(["security", "-i"], { stdin: line });
		if (r.code !== 0) return false;
	} catch {
		return false;
	}
	return (await keychainGet(name, deps)) === value;
}

export async function getSecret(name: SecretName, deps: CredDeps): Promise<string | undefined> {
	return (await keychainGet(name, deps)) ?? readFallback(deps.paths)[FIELD[name]];
}

// Returns where the value ended up.
export async function setSecret(name: SecretName, value: string, deps: CredDeps): Promise<"keychain" | "file"> {
	const fallback = readFallback(deps.paths);
	if (await keychainSet(name, value, deps)) {
		// No second copy on disk once the Keychain holds it.
		if (FIELD[name] in fallback) {
			delete fallback[FIELD[name]];
			writeFallback(deps.paths, fallback);
		}
		return "keychain";
	}
	writeFallback(deps.paths, { ...fallback, [FIELD[name]]: value });
	return "file";
}

// Moves what the secret flow wrote (<dataDir>/secrets/kakao) into the Keychain; the file is deleted only when every value in it
// was stored there. False when there is no file, it holds no id and password, or a Keychain write failed (the file stays then).
export async function importAuthFile(deps: CredDeps): Promise<boolean> {
	const file = readFallback(deps.paths);
	if (!file.username || !file.password) return false;
	for (const name of NAMES) {
		const value = file[FIELD[name]];
		if (value && !(await keychainSet(name, value, deps))) return false;
	}
	rmSync(deps.paths.secretFile, { force: true });
	return true;
}

export async function hasCredentials(deps: CredDeps): Promise<boolean> {
	return Boolean((await getSecret("id", deps)) && (await getSecret("password", deps)));
}

export async function clearCredentials(deps: CredDeps): Promise<void> {
	for (const name of NAMES) {
		try {
			await deps.runner(["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
		} catch {
			continue;
		}
	}
	if (existsSync(deps.paths.secretFile)) rmSync(deps.paths.secretFile, { force: true });
}
