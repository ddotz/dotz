import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCredentials, getSecret, hasCredentials, importAuthFile, setSecret } from "./creds.ts";
import { kakaoPaths, type Runner } from "./types.ts";

type Call = { argv: string[]; stdin?: string };
let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kk-creds-"));
	paths = kakaoPaths(dir, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A fake `security`: a map for the Keychain, the `security -i` line parser, and switches for the failures.
function fakeSecurity(opts: { failWrites?: boolean; failFor?: string } = {}) {
	const store = new Map<string, string>();
	const calls: Call[] = [];
	const runner: Runner = async (argv, o) => {
		calls.push({ argv, stdin: o?.stdin });
		expect(argv[0]).toBe("security");
		if (argv[1] === "find-generic-password") {
			const v = store.get(argv[argv.indexOf("-a") + 1]!);
			return v === undefined ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: `${v}\n`, stderr: "" };
		}
		if (argv[1] === "delete-generic-password") {
			store.delete(argv[argv.indexOf("-a") + 1]!);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (argv[1] === "-i") {
			const m = /^add-generic-password -U -s dotz\.kakao -a (\w+) -w "((?:[^"\\]|\\.)*)"\n$/.exec(o?.stdin ?? "");
			if (!m || opts.failWrites || m[1] === opts.failFor) return { code: 1, stdout: "", stderr: "denied" };
			store.set(m[1]!, m[2]!.replace(/\\(.)/g, "$1"));
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 2, stdout: "", stderr: "?" };
	};
	return { store, calls, runner };
}

const mode = (p: string) => statSync(p).mode & 0o777;

test("a stored id and password go to the Keychain through stdin and never through argv", async () => {
	const k = fakeSecurity();
	const deps = { paths, runner: k.runner };
	const password = 'p"w\\9 zz';
	await setSecret("id", "tester@example.com", deps);
	await setSecret("password", password, deps);
	for (const c of k.calls) {
		expect(c.argv.join(" ")).not.toContain(password);
		expect(c.argv.join(" ")).not.toContain("tester@example.com");
	}
	const write = k.calls.find(c => c.argv[1] === "-i" && c.stdin?.includes("-a password"))!;
	expect(write.stdin).toBe('add-generic-password -U -s dotz.kakao -a password -w "p\\"w\\\\9 zz"\n');
	expect(await getSecret("password", deps)).toBe(password);
	expect(await hasCredentials(deps)).toBe(true);
	expect(existsSync(paths.secretFile)).toBe(false);
});

test("a failing Keychain write throws without the value and leaves nothing on disk", async () => {
	for (const runner of [fakeSecurity({ failWrites: true }).runner, async (argv: string[], o?: { stdin?: string }) => (argv[1] === "-i" ? { code: 0, stdout: "", stderr: "" } : fakeSecurity().runner(argv, o))] as Runner[]) {
		const err = await setSecret("password", "pw-1", { paths, runner }).catch(e => e as Error);
		expect(err).toBeInstanceOf(Error);
		expect(String(err)).not.toContain("pw-1");
		expect(existsSync(paths.secretFile)).toBe(false);
		expect(await getSecret("password", { paths, runner })).toBeUndefined();
	}
	const k = fakeSecurity();
	await expect(setSecret("dbkey", "a\nb", { paths, runner: k.runner })).rejects.toThrow();
	expect(k.calls.some(c => c.argv[1] === "-i")).toBe(false);
});

test("importAuthFile moves username and password into the Keychain and deletes the file only after both succeeded", async () => {
	mkdirSync(join(dir, "secrets"), { recursive: true });
	writeFileSync(paths.secretFile, JSON.stringify({ username: "tester@example.com", password: "pw-2" }), { mode: 0o600 });
	const k = fakeSecurity();
	expect(await importAuthFile({ paths, runner: k.runner })).toBe(true);
	expect(existsSync(paths.secretFile)).toBe(false);
	expect(k.store.get("id")).toBe("tester@example.com");
	expect(k.store.get("password")).toBe("pw-2");
	for (const c of k.calls) expect(c.argv.join(" ")).not.toContain("pw-2");
});

test("importAuthFile deletes the plaintext file even when a Keychain write fails, and does nothing without a file", async () => {
	expect(await importAuthFile({ paths, runner: fakeSecurity().runner })).toBe(false);
	mkdirSync(join(dir, "secrets"), { recursive: true });
	writeFileSync(paths.secretFile, JSON.stringify({ username: "tester@example.com", password: "pw-3" }), { mode: 0o600 });
	const k = fakeSecurity({ failFor: "password" });
	expect(await importAuthFile({ paths, runner: k.runner })).toBe(false);
	expect(existsSync(paths.secretFile)).toBe(false);
	expect(await getSecret("password", { paths, runner: k.runner })).toBeUndefined();
});

test("clearCredentials removes the Keychain items and the fallback file", async () => {
	const k = fakeSecurity();
	const deps = { paths, runner: k.runner };
	await setSecret("id", "a", deps);
	await setSecret("password", "b", deps);
	writeFileSync(join(dir, "x"), "");
	mkdirSync(join(dir, "secrets"), { recursive: true });
	writeFileSync(paths.secretFile, "{}");
	await clearCredentials(deps);
	expect(k.store.size).toBe(0);
	expect(existsSync(paths.secretFile)).toBe(false);
	expect(await hasCredentials(deps)).toBe(false);
});
