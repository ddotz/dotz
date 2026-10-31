import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSealed, readSecretFile, sealPlainSecrets, setSecretKey, systemKey, writeSecretFile } from "./secretbox.ts";

const PASS = "Sup3r-secret!pw";

test("a stored value is encrypted on disk, 0600, and reads back; under another file name it does not open", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-sbox-"));
	const file = join(dir, "korail");
	writeSecretFile(file, JSON.stringify({ username: "me", password: PASS }));
	const raw = readFileSync(file, "utf8");
	expect(isSealed(raw)).toBe(true);
	expect(raw).not.toContain(PASS);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(JSON.parse(readSecretFile(file)).password).toBe(PASS);
	renameSync(file, join(dir, "other"));
	expect(() => readSecretFile(join(dir, "other"))).toThrow();
});

test("start-up sealing encrypts the plain dotz_auth values (and one-time ones) and leaves tokens and gateway key files as they are", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-sbox-"));
	mkdirSync(join(dir, "once"));
	writeFileSync(join(dir, "cartier"), JSON.stringify({ username: "u", password: PASS }));
	writeFileSync(join(dir, "once", "shop-1"), JSON.stringify({ card_number: "4539771203846918" }));
	writeFileSync(join(dir, "hub-token"), "abc123\n");
	writeFileSync(join(dir, "vapid.json"), JSON.stringify({ publicKey: "p", privateKey: "k" }));
	writeSecretFile(join(dir, "korail"), JSON.stringify({ password: PASS }));
	const before = readFileSync(join(dir, "korail"), "utf8");
	expect(sealPlainSecrets(dir).sort()).toEqual(["cartier", "once/shop-1"]);
	expect(readFileSync(join(dir, "cartier"), "utf8")).not.toContain(PASS);
	expect(JSON.parse(readSecretFile(join(dir, "cartier"))).password).toBe(PASS);
	expect(JSON.parse(readSecretFile(join(dir, "once", "shop-1"))).card_number).toBe("4539771203846918");
	expect(readFileSync(join(dir, "hub-token"), "utf8")).toBe("abc123\n");
	expect(JSON.parse(readFileSync(join(dir, "vapid.json"), "utf8")).privateKey).toBe("k");
	expect(readFileSync(join(dir, "korail"), "utf8")).toBe(before);
	expect(sealPlainSecrets(dir)).toEqual([]);
});

test("without macOS security (Linux, WSL, or darwin missing the binary) the key is a 0600 file made once; reading never makes one", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-sbox-"));
	const keyFile = join(dir, "data", "secretbox.key");
	const linux = { platform: "linux", which: () => "/usr/bin/security", keyFile };
	expect(() => systemKey(false, linux)).toThrow("missing");
	const made = systemKey(true, linux);
	expect(made.length).toBe(32);
	expect(statSync(keyFile).mode & 0o777).toBe(0o600);
	expect(systemKey(false, linux).equals(made)).toBe(true);
	expect(systemKey(true, { platform: "darwin", which: () => null, keyFile }).equals(made)).toBe(true);
	writeFileSync(keyFile, "broken\n");
	expect(() => systemKey(true, linux)).toThrow("damaged");   // a damaged key is never silently replaced

	// A working keyring (secret-tool) takes the key and the file only points there; a keyring that later fails is an error, not a new key.
	const ring = new Map<string, string>();
	let up = true;
	const keyring = { lookup: () => (up ? ring.get("k") : undefined), store: (hex: string) => up && !!ring.set("k", hex) };
	const withRing = { platform: "linux", which: () => null, keyFile: join(dir, "ring", "secret.key"), keyring };
	const inRing = systemKey(true, withRing);
	expect(readFileSync(withRing.keyFile, "utf8").trim()).toBe("secret-tool");
	expect(statSync(join(dir, "ring")).mode & 0o777).toBe(0o700);
	expect(ring.get("k")).toBe(inRing.toString("hex"));
	up = false;
	expect(() => systemKey(true, withRing)).toThrow("keyring");
	// A keyring that refuses (WSL without a desktop session) leaves the key in the file.
	const refused = { ...withRing, keyFile: join(dir, "refused", "secret.key") };
	const inFile = systemKey(true, refused);
	expect(readFileSync(refused.keyFile, "utf8").trim()).toBe(inFile.toString("hex"));

	const other = join(dir, "other.key");
	setSecretKey(create => systemKey(create, { platform: "linux", which: () => null, keyFile: other }));
	try {
		const file = join(dir, "naver");
		writeSecretFile(file, JSON.stringify({ username: "dummy", password: PASS }));
		expect(readFileSync(file, "utf8")).not.toContain(PASS);
		setSecretKey(create => systemKey(create, { platform: "linux", which: () => null, keyFile: other }));   // a fresh process reads the same key file
		expect(JSON.parse(readSecretFile(file)).password).toBe(PASS);
	} finally {
		setSecretKey(Buffer.from(process.env.SECRETBOX_TEST_KEY!, "hex"));
	}
});

test("an older plain file still reads as it was written", () => {
	const file = join(mkdtempSync(join(tmpdir(), "dotz-sbox-")), "token");
	writeFileSync(file, "plain-token\n");
	expect(readSecretFile(file)).toBe("plain-token\n");
});

test("the CLI hands one field to a pipe and refuses a path outside the secrets folder", async () => {
	const dir = join(process.env.DOTZ_DIR!, "secrets");
	mkdirSync(dir, { recursive: true });
	writeSecretFile(join(dir, "cli-site"), JSON.stringify({ username: "me", password: PASS }));
	const run = (...a: string[]) => Bun.$`bun ${join(import.meta.dir, "secrets-cli.ts")} ${a}`.nothrow().quiet();
	const got = await run("get", "cli-site", "password");
	expect([got.exitCode, got.stdout.toString()]).toEqual([0, PASS]);
	expect((await run("get", "../config.json")).exitCode).toBe(2);
});
