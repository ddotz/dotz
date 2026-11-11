// A password or other personal value the owner gives through dotz_auth never lies on disk as plain text (owner 2026-10-28: "로컬에 패스워드
// 두는거는 암호화해서 둬야해"). The file under <data dir>/secrets holds `dotzenc1:` + base64(iv | tag | ciphertext), AES-256-GCM with the
// file's own name as associated data (a file copied under another name does not open). On macOS the 32-byte key lives only in the login
// Keychain (service dotz.secrets, account key), made on first use and written through `security -i` stdin, never argv. Where there is no
// `security` (Linux, WSL) the key file $XDG_CONFIG_HOME/dotz/secret.key (default ~/.config, dir 0700, file 0600) decides, outside the
// data dir so the key never travels with a copy of it: it holds the key itself, or the word `secret-tool` when the key went into the
// desktop keyring (libsecret, used when it stores and reads back at first use). The file is made once and never replaced, so values
// sealed with one key never meet another. Reading goes
// through readSecretFile (the gateway) or `bun hub/secrets-cli.ts get <name>` (the bot's scripts), which also read an older plain file.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const SERVICE = "dotz.secrets";
const ACCOUNT = "key";
const PREFIX = "dotzenc1:";

let key: Buffer | undefined;
// Under bun test (hub/runtime/test-setup.ts) a throwaway key, so a test run never reads or makes the machine's Keychain item.
const testKey = process.env.DOTZ_TEST_DIR && /^[0-9a-f]{64}$/.test(process.env.SECRETBOX_TEST_KEY ?? "") ? Buffer.from(process.env.SECRETBOX_TEST_KEY!, "hex") : undefined;
let keySource = (create: boolean): Buffer => testKey ?? systemKey(create);
/** Tests give their own key (or key source); production reads (and on first need makes) the Keychain or key-file one. */
export const setSecretKey = (k: Buffer | ((create: boolean) => Buffer) | undefined): void => {
	key = undefined;
	keySource = typeof k === "function" ? k : k ? () => k : create => systemKey(create);
};

/** The libsecret keyring through `secret-tool`; lookup gives the stored hex or undefined, store reports whether it took the value. */
export type Keyring = { lookup: () => string | undefined; store: (hex: string) => boolean };
export type KeyEnv = { platform: string; which: (bin: string) => string | null; keyFile: string; keyring?: Keyring };
const HEX = /^[0-9a-f]{64}$/;
const MARK = "secret-tool";
const run = (argv: string[], stdin?: string) => {
	try {
		return Bun.spawnSync(argv, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), timeout: 10_000 });
	} catch {
		return undefined;
	}
};
const secretTool: Keyring = {
	lookup: () => {
		const r = run(["secret-tool", "lookup", "service", SERVICE, "account", ACCOUNT]);
		const hex = r?.exitCode === 0 ? r.stdout.toString().trim() : "";
		return HEX.test(hex) ? hex : undefined;
	},
	store: hex => run(["secret-tool", "store", "--label=dotz secrets", "service", SERVICE, "account", ACCOUNT], hex)?.exitCode === 0,
};
const hostEnv = (): KeyEnv => ({
	platform: process.platform,
	which: bin => Bun.which(bin),
	keyFile: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dotz", "secret.key"),
	keyring: Bun.which("secret-tool") ? secretTool : undefined,
});
/** The macOS Keychain when `security` is there (unchanged macOS behaviour), otherwise what the key file says. */
export function systemKey(create: boolean, env: KeyEnv = hostEnv()): Buffer {
	return env.platform === "darwin" && env.which("security") ? keychainKey(create) : fileKey(env, create);
}

function fileKey({ keyFile: file, keyring }: KeyEnv, create: boolean): Buffer {
	const read = (): Buffer | undefined => {
		if (!existsSync(file)) return undefined;
		const text = readFileSync(file, "utf8").trim();
		if (HEX.test(text)) return Buffer.from(text, "hex");
		if (text !== MARK) throw new Error(`the secrets key file ${file} is damaged (not a key)`);
		const hex = keyring?.lookup();
		if (!hex) throw new Error(`the secrets key is not readable from the keyring (secret-tool, service ${SERVICE}); ${file} points there`);
		return Buffer.from(hex, "hex");
	};
	const have = read();
	if (have) return have;
	if (!create) throw new Error(`the secrets key file ${file} is missing`);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	chmodSync(dirname(file), 0o700);
	const hex = randomBytes(32).toString("hex");
	const inKeyring = !!keyring && keyring.store(hex) && keyring.lookup() === hex;
	try {
		// wx: two processes making the key at once keep the first file; both then read it back, so neither seals with a lost key.
		writeFileSync(file, `${inKeyring ? MARK : hex}\n`, { mode: 0o600, flag: "wx" });
		chmodSync(file, 0o600);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	const made = read();
	if (!made) throw new Error(`could not store the secrets key in ${file}`);
	return made;
}

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
