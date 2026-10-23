// lib/legacy.ts: the one yes/no before an earlier setup's YouTube/Instagram login is copied. Temp folders only; the value is a placeholder that must never reach the output.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { run } from "../bin/onboard.ts";
import { paths, secretsDir } from "../lib/config.ts";
import { LEGACY_ASK, LEGACY_NO, LEGACY_YES, findLegacy, legacyGate } from "../lib/legacy.ts";
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
