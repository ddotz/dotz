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
	expect(await setSecret("id", "tester@example.com", deps)).toBe("keychain");
	expect(await setSecret("password", password, deps)).toBe("keychain");
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

test("a failing Keychain falls back to a 0600 file in a 0700 directory, and reads come back from it", async () => {
	const k = fakeSecurity({ failWrites: true });
	const deps = { paths, runner: k.runner };
	expect(await setSecret("id", "tester@example.com", deps)).toBe("file");
	expect(await setSecret("password", "pw-1", deps)).toBe("file");
	expect(mode(paths.secretFile)).toBe(0o600);
	expect(mode(join(dir, "secrets"))).toBe(0o700);
	expect(JSON.parse(readFileSync(paths.secretFile, "utf8"))).toEqual({ username: "tester@example.com", password: "pw-1" });
	expect(await getSecret("id", deps)).toBe("tester@example.com");
	expect(await getSecret("password", deps)).toBe("pw-1");
	for (const c of k.calls) expect(c.argv.join(" ")).not.toContain("pw-1");
});

test("a value with a line break cannot be quoted for security -i, so it takes the file fallback", async () => {
	const k = fakeSecurity();
	expect(await setSecret("dbkey", "a\nb", { paths, runner: k.runner })).toBe("file");
	expect(k.calls.some(c => c.argv[1] === "-i")).toBe(false);
	expect(await getSecret("dbkey", { paths, runner: k.runner })).toBe("a\nb");
});

test("a Keychain write that reports success but does not read back counts as failed", async () => {
	const k = fakeSecurity();
	const lying: Runner = async (argv, o) => (argv[1] === "-i" ? { code: 0, stdout: "", stderr: "" } : k.runner(argv, o));
	expect(await setSecret("id", "x", { paths, runner: lying })).toBe("file");
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

test("importAuthFile keeps the file when one Keychain write fails, and does nothing without a file", async () => {
	expect(await importAuthFile({ paths, runner: fakeSecurity().runner })).toBe(false);
	mkdirSync(join(dir, "secrets"), { recursive: true });
	writeFileSync(paths.secretFile, JSON.stringify({ username: "tester@example.com", password: "pw-3" }), { mode: 0o600 });
	const k = fakeSecurity({ failFor: "password" });
	expect(await importAuthFile({ paths, runner: k.runner })).toBe(false);
	expect(existsSync(paths.secretFile)).toBe(true);
	expect(await getSecret("password", { paths, runner: k.runner })).toBe("pw-3");
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
