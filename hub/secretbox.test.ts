import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSealed, readSecretFile, sealPlainSecrets, writeSecretFile } from "./secretbox.ts";

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
