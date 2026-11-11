// lib/legacy.ts: the one yes/no before an earlier setup's YouTube/Instagram login is copied. Temp folders only; the value is a placeholder that must never reach the output.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { run } from "../bin/onboard.ts";
import { paths, secretsDir } from "../lib/config.ts";
import { IMPORT_FROM, IMPORT_HINT, IMPORT_IG, IMPORT_YT, LEGACY_ASK, LEGACY_NO, LEGACY_YES, findLegacy, legacyGate } from "../lib/legacy.ts";
import { fakeCtx } from "./fakes.ts";

const KEPT = { dotz: process.env.DOTZ_DIR, legacy: process.env.DOTZ_LEGACY_SECRETS };
const VALUE = "placeholder-refresh-token-value";
let dir: string;
let old: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-legacy-"));
	old = join(dir, "earlier", "secrets");
	mkdirSync(old, { recursive: true });
	writeFileSync(join(old, "youtube-oauth.json"), JSON.stringify({ client_id: "a", client_secret: "b", refresh_token: VALUE }), { mode: 0o644 });
	writeFileSync(join(old, "instagram.json"), JSON.stringify({ access_token: VALUE }), { mode: 0o644 });
	process.env.DOTZ_DIR = join(dir, "now");
	process.env.DOTZ_LEGACY_SECRETS = old;
});
afterEach(() => {
	for (const [k, v] of [["DOTZ_DIR", KEPT.dotz], ["DOTZ_LEGACY_SECRETS", KEPT.legacy]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
	rmSync(dir, { recursive: true, force: true });
});

test("found files are asked about once, with names only, and nothing is copied before the yes", () => {
	const g = legacyGate([]);
	expect(g.ask).toBe(true);
	expect(g.lines.join("\n")).toContain(LEGACY_ASK);
	expect(g.lines.join("\n")).not.toContain(VALUE);
	expect(existsSync(paths.ytOauth()) || existsSync(paths.instagram())).toBe(false);
});

test("yes copies both files with 0600 into the data dir's secrets and never prints a value", () => {
	const g = legacyGate([LEGACY_YES]);
	expect(g.ask).toBe(false);
	expect(g.lines.join("\n")).not.toContain(VALUE);
	for (const f of [paths.ytOauth(), paths.instagram()]) {
		expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(readFileSync(f, "utf8")).toContain(VALUE);
	}
	expect(statSync(secretsDir()).mode & 0o777).toBe(0o700);
	expect(findLegacy()).toEqual({});
	expect(legacyGate([]).lines).toEqual([]);
});

test("an existing login is never overwritten", () => {
	mkdirSync(secretsDir(), { recursive: true });
	writeFileSync(paths.ytOauth(), "mine");
	expect(Object.keys(findLegacy())).toEqual(["instagram.json"]);
	legacyGate([LEGACY_YES]);
	expect(readFileSync(paths.ytOauth(), "utf8")).toBe("mine");
});

test("no is remembered: the question does not come back and nothing is copied", () => {
	expect(legacyGate([LEGACY_NO]).ask).toBe(false);
	expect(legacyGate([]).lines).toEqual([]);
	expect(existsSync(paths.ytOauth())).toBe(false);
});

test("no earlier setup on this machine = no question", () => {
	process.env.DOTZ_LEGACY_SECRETS = join(dir, "nothing");
	expect(legacyGate([])).toEqual({ lines: [], ask: false });
});

test("onboard run stops with the question (exit 3) before any step, and the yes flag reaches the gate", async () => {
	const f = fakeCtx({});
	const deps = { ctx: f.ctx, aside: { repl: async () => { throw new Error("no step may run"); } }, otp: { probe: () => {}, wait: async () => undefined } };
	const r = await run(deps, ["run"]);
	expect(r.code).toBe(3);
	expect(r.lines.join("\n")).toContain(LEGACY_ASK);
	expect(existsSync(paths.ytOauth())).toBe(false);
});

// --import-from / --import-yt / --import-ig: the bot passes the real place of the earlier tokens. The guessed folders are empty here.
const elsewhere = (files: Record<string, string>, sub = "") => {
	const d = join(dir, "bot-says", sub);
	mkdirSync(d, { recursive: true });
	for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body, { mode: 0o644 });
	process.env.DOTZ_LEGACY_SECRETS = "";
	return d;
};
const body = JSON.stringify({ token: VALUE });

test("--import-from <dir> finds the standard names (also in its secrets/ folder), asks once, copies 0600 on yes", () => {
	const d = elsewhere({ "youtube-oauth.json": body, "youtube-client.json": "client only", "youtube-access.json": "cache" }, "old");
	elsewhere({ "instagram.json": body }, "old/secrets");
	const ask = legacyGate([IMPORT_FROM, d]);
	expect(ask.ask).toBe(true);
	expect(ask.lines.join("\n")).toContain(LEGACY_ASK);
	expect(ask.lines.join("\n")).not.toContain(VALUE);
	expect(existsSync(paths.ytOauth()) || existsSync(paths.instagram())).toBe(false);
	const yes = legacyGate([IMPORT_FROM, d, LEGACY_YES]);
	expect(yes.lines.join("\n")).not.toContain(VALUE);
	for (const f of [paths.ytOauth(), paths.instagram()]) {
		expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(readFileSync(f, "utf8")).toContain(VALUE);
	}
});

test("variant names are matched, and --import-from repeats", () => {
	const a = elsewhere({ "youtube_oauth.json": body }, "a");
	const b = elsewhere({ "instagram-token-new.json": body }, "b");
	expect(Object.keys(findLegacy([IMPORT_FROM, a, IMPORT_FROM, b])).sort()).toEqual(["instagram.json", "youtube-oauth.json"]);
	const t = elsewhere({ "youtube-token.json": body, "instagram-token.json": body }, "t");
	expect(Object.keys(findLegacy([IMPORT_FROM, join(t, "youtube-token.json"), IMPORT_FROM + "=" + join(t, "instagram-token.json")])).sort()).toEqual(["instagram.json", "youtube-oauth.json"]);
	const g = elsewhere({ "google-oauth.json": body, "ig.json": body }, "g");
	expect(Object.keys(findLegacy([IMPORT_FROM, g])).sort()).toEqual(["instagram.json", "youtube-oauth.json"]);
});

test("--import-yt / --import-ig take a file whatever its name is, and win over the guessed folders", () => {
	const d = elsewhere({ "mine-a.json": body, "mine-b.json": "other" }, "x");
	process.env.DOTZ_LEGACY_SECRETS = old;
	legacyGate([IMPORT_YT, join(d, "mine-a.json"), IMPORT_IG, join(d, "mine-b.json"), LEGACY_YES]);
	expect(readFileSync(paths.ytOauth(), "utf8")).toBe(body);
	expect(readFileSync(paths.instagram(), "utf8")).toBe("other");
});

test("the guessed folders still work as the fallback when the given place has nothing", () => {
	const d = elsewhere({ "notes.txt": "x" }, "empty");
	process.env.DOTZ_LEGACY_SECRETS = old;
	expect(Object.keys(findLegacy([IMPORT_FROM, d])).sort()).toEqual(["instagram.json", "youtube-oauth.json"]);
});

test("a given place with nothing in it says so and asks nothing", () => {
	const d = elsewhere({ "notes.txt": "x" }, "empty");
	const g = legacyGate([IMPORT_FROM, d]);
	expect(g.ask).toBe(false);
	expect(g.lines.join("\n")).toContain(d);
});

test("refusal keeps nothing, even with a given place, and a later given place asks again", () => {
	const d = elsewhere({ "youtube-oauth.json": body, "instagram.json": body }, "r");
	const no = legacyGate([IMPORT_FROM, d, LEGACY_NO]);
	expect(no.ask).toBe(false);
	expect(no.lines.join("\n")).not.toContain(VALUE);
	expect(existsSync(paths.ytOauth()) || existsSync(paths.instagram()) || existsSync(secretsDir())).toBe(false);
	expect(legacyGate([]).lines).toEqual([]);
	expect(legacyGate([IMPORT_FROM, d]).ask).toBe(true);
});

test("the comments onboard CLI prints the hint, copies on yes, and the value never reaches stdout or stderr", async () => {
	const d = elsewhere({ "youtube-oauth.json": body }, "cli");
	const cli = join(import.meta.dir, "..", "..", "comments", "bin", "onboard.ts");
	const go = async (...extra: string[]) => {
		const p = Bun.spawn(["bun", cli, "on", "--app", "youtube", ...extra], { env: { ...process.env, DOTZ_DIR: join(dir, "now"), DOTZ_LEGACY_SECRETS: "" }, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { out, err, code };
	};
	const none = await go();
	expect(none.code).toBe(3);
	expect(none.out).toContain(IMPORT_HINT);
	expect(IMPORT_HINT).toBe("기존 토큰 위치를 알면 --import-from <경로>로 다시 실행해요");
	const ask = await go(IMPORT_FROM, d);
	expect(ask.code).toBe(3);
	expect(ask.out).toContain(LEGACY_ASK);
	expect(existsSync(paths.ytOauth())).toBe(false);
	const yes = await go(IMPORT_FROM, d, LEGACY_YES);
	expect(statSync(paths.ytOauth()).mode & 0o777).toBe(0o600);
	for (const t of [ask, yes]) expect(t.out + t.err).not.toContain(VALUE);
});

test("onboard run passes --import-from to the gate: exit 3 with the question, value not printed", async () => {
	const d = elsewhere({ "youtube-oauth.json": body }, "run");
	const fk = fakeCtx({});
	const deps = { ctx: fk.ctx, aside: { repl: async () => { throw new Error("no step may run"); } }, otp: { probe: () => {}, wait: async () => undefined } };
	const r = await run(deps, ["run", IMPORT_FROM, d]);
	expect(r.code).toBe(3);
	expect(r.lines.join("\n")).toContain(LEGACY_ASK);
	expect(r.lines.join("\n")).not.toContain(VALUE);
	expect(existsSync(paths.ytOauth())).toBe(false);
});
