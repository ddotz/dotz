// A password or other personal value the owner gives through dotz_auth never lies on disk as plain text (owner 2026-10-28: "로컬에 패스워드
// 두는거는 암호화해서 둬야해"). The file under <data dir>/secrets holds `dotzenc1:` + base64(iv | tag | ciphertext), AES-256-GCM with the
// file's own name as associated data (a file copied under another name does not open). The 32-byte key lives only in the macOS login
// Keychain (service dotz.secrets, account key), made on first use and written through `security -i` stdin, never argv. Reading goes
// through readSecretFile (the gateway) or `bun hub/secrets-cli.ts get <name>` (the bot's scripts), which also read an older plain file.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const SERVICE = "dotz.secrets";
const ACCOUNT = "key";
const PREFIX = "dotzenc1:";

let key: Buffer | undefined;
// Under bun test (hub/runtime/test-setup.ts) a throwaway key, so a test run never reads or makes the machine's Keychain item.
const testKey = process.env.DOTZ_TEST_DIR && /^[0-9a-f]{64}$/.test(process.env.SECRETBOX_TEST_KEY ?? "") ? Buffer.from(process.env.SECRETBOX_TEST_KEY!, "hex") : undefined;
let keySource = (create: boolean): Buffer => testKey ?? keychainKey(create);
/** Tests give their own key; production reads (and on first need makes) the Keychain one. */
export const setSecretKey = (k: Buffer | undefined): void => {
	key = undefined;
	keySource = k ? () => k : keychainKey;
};

function keychainKey(create: boolean): Buffer {
	const read = () => {
		const r = Bun.spawnSync(["security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
		const hex = r.exitCode === 0 ? r.stdout.toString().trim() : "";
		return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : undefined;
	};
	const have = read();
	if (have || !create) {
		if (!have) throw new Error("the secrets key is not in the Keychain (service dotz.secrets)");
		return have;
	}
	const hex = randomBytes(32).toString("hex");
	Bun.spawnSync(["security", "-i"], { stdin: Buffer.from(`add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${hex}\n`) });
	const made = read();
	if (!made || made.toString("hex") !== hex) throw new Error("could not store the secrets key in the Keychain");
	return made;
}
const keyFor = (create: boolean): Buffer => (key ??= keySource(create));

export const isSealed = (text: string): boolean => text.startsWith(PREFIX);

export function seal(name: string, plain: string): string {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", keyFor(true), iv);
	c.setAAD(Buffer.from(name));
	const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
	return `${PREFIX}${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}\n`;
}

export function unseal(name: string, text: string): string {
	const raw = Buffer.from(text.trim().slice(PREFIX.length), "base64");
	const d = createDecipheriv("aes-256-gcm", keyFor(false), raw.subarray(0, 12));
	d.setAAD(Buffer.from(name));
	d.setAuthTag(raw.subarray(12, 28));
	return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/** The value of a secrets file: decrypted when sealed, as written when an older plain file. */
export function readSecretFile(file: string): string {
	const text = readFileSync(file, "utf8");
	return isSealed(text) ? unseal(basename(file), text) : text;
}

// No config.ts here: light tools (adapters, CLIs) read secrets without loading the gateway's config.
export function writeSecretFile(file: string, plain: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, seal(basename(file), plain), { mode: 0o600 });
	renameSync(tmp, file);
}

// What a dotz_auth answer leaves behind is a JSON object (username / password, or a form's fields). Gateway-owned key files of the same shape
// that other programs read as they are stay plain; so do plain-string tokens (hub-token, API keys), which are not the owner's passwords.
const OWN_JSON = new Set(["vapid.json", "instagram.json", "youtube-oauth.json"]);
const isAuthValue = (text: string): boolean => {
	try {
		const v = JSON.parse(text);
		return !!v && typeof v === "object" && !Array.isArray(v);
	} catch {
		return false;
	}
};

/** Seals every plain dotz_auth value left in the secrets folder (and its one-time `once/` folder). Returns the file names it sealed. */
export function sealPlainSecrets(dir: string): string[] {
	const out: string[] = [];
	for (const sub of [dir, join(dir, "once")]) {
		if (!existsSync(sub)) continue;
		for (const name of readdirSync(sub)) {
			const file = join(sub, name);
			if (OWN_JSON.has(name) || name.endsWith(".tmp") || !statSync(file).isFile()) continue;
			const text = readFileSync(file, "utf8");
			if (isSealed(text) || !isAuthValue(text)) continue;
			writeSecretFile(file, text);
			out.push(sub === dir ? name : `once/${name}`);
		}
	}
	return out;
}
