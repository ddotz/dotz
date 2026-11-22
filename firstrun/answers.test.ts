import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Answers, priorOf, validateAnswers } from "./answers.ts";
import { type Env, writeConfig } from "./apply.ts";

const dirs: string[] = [];
function tempDir(files: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "dotz-answers-"));
	dirs.push(dir);
	for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const IDENTITY = { name: "땃쥐", character: "차분한 비서", tone: "존댓말" };
const GUILD = "123456789012345678";
const OWNER = "223456789012345678";

function check(dir: string, given: Partial<Answers>): Answers {
	const r = validateAnswers({ identity: IDENTITY, ...given }, priorOf(dir), dir);
	if (!r.ok) throw new Error(r.errors.join("; "));
	return r.answers;
}

describe("prior.access", () => {
	test("web-access.json beats config.json, config beats allow_logins, nothing saved means local", () => {
		expect(priorOf(tempDir({ "web-access.json": { mode: "cloudflare" }, "config.json": { web: { access: "tailscale", allow_logins: ["a@b.c"] } } })).access).toBe("cloudflare");
		expect(priorOf(tempDir({ "config.json": { web: { access: "local", allow_logins: ["a@b.c"] } } })).access).toBe("local");
		expect(priorOf(tempDir({ "config.json": { web: { allow_logins: ["a@b.c"] } } })).access).toBe("tailscale");
		expect(priorOf(tempDir({ "config.json": { web: { allow_logins: [] } } })).access).toBe("local");
		expect(priorOf(tempDir()).access).toBe("local");
	});

	test("an unknown mode in either file is skipped for the next source", () => {
		expect(priorOf(tempDir({ "web-access.json": { mode: "funnel" }, "config.json": { web: { access: "tailscale" } } })).access).toBe("tailscale");
		expect(priorOf(tempDir({ "web-access.json": { mode: 3 }, "config.json": { web: { access: "everywhere", allow_logins: ["a@b.c"] } } })).access).toBe("tailscale");
	});
});

describe("validateAnswers access and connect", () => {
	test("access falls back to the saved mode and a given access wins", () => {
		const dir = tempDir({ "web-access.json": { mode: "cloudflare" } });
		expect(check(dir, {}).access).toBe("cloudflare");
		expect(check(dir, { access: "tailscale" }).access).toBe("tailscale");
	});

	test("with nothing saved, the answers' own Tailscale logins decide the access, as before this step", () => {
		expect(check(tempDir(), { allow_logins: ["a@b.c"] }).access).toBe("tailscale");
		expect(check(tempDir(), { allow_logins: [] }).access).toBe("local");
		expect(check(tempDir({ "config.json": { web: { access: "local" } } }), { allow_logins: ["a@b.c"] }).access).toBe("local");
	});

	test("a rerun that does not ask for Discord keeps the saved server and owner", () => {
		const a = check(tempDir({ "config.json": { discord: { guild: GUILD, owner_id: OWNER } } }), {});
		expect([a.guild, a.owner_id, a.connect]).toEqual([GUILD, OWNER, []]);
	});

	test("an unknown access is an error", () => {
		const r = validateAnswers({ identity: IDENTITY, access: "funnel" as never }, priorOf(tempDir()), "/tmp");
		expect(r.ok ? [] : r.errors.some(e => e.startsWith("access:"))).toBe(true);
	});

	test("an answers file from before this step (guild only) connects Discord; with a saved token or no guild it connects nothing", () => {
		const bare = tempDir();
		expect(check(bare, {}).connect).toEqual([]);
		expect(check(bare, { guild: GUILD, owner_id: OWNER }).connect).toEqual(["discord"]);
		expect(check(bare, { guild: GUILD, owner_id: OWNER, bot_token: "x".repeat(60) }).connect).toEqual([]);
		const tokenFile = join(bare, "bot-token");
		writeFileSync(tokenFile, "x");
		const saved = tempDir({ "config.json": { discord: { token_file: tokenFile } } });
		expect(check(saved, { guild: GUILD, owner_id: OWNER }).connect).toEqual([]);
	});

	test("a given connect list keeps its order and drops duplicates, an unknown key is an error naming the field, and an empty list beats the guild default", () => {
		const dir = tempDir();
		expect(check(dir, { connect: ["slack", "discord", "slack"] }).connect).toEqual(["slack", "discord"]);
		for (const bad of [["slack", "bogus"], ["Discord"], "discord"]) {
			const r = validateAnswers({ identity: IDENTITY, connect: bad as never }, priorOf(dir), "/tmp");
			expect(r.ok ? [] : r.errors.filter(e => e.startsWith("connect:"))).toHaveLength(1);
		}
		expect(check(dir, { guild: GUILD, owner_id: OWNER, connect: [] }).connect).toEqual([]);
	});
});

describe("cloudflare_hostname", () => {
	test("is cleaned to a bare lowercase hostname", () => {
		expect(check(tempDir(), { access: "cloudflare", cloudflare_hostname: " HTTPS://Dotz.Example.com/ " }).cloudflare_hostname).toBe("dotz.example.com");
	});

	test("an empty value leaves it out; an invalid one is an error naming the field", () => {
		expect("cloudflare_hostname" in check(tempDir(), { cloudflare_hostname: "  " })).toBe(false);
		for (const bad of ["not a host", "dotz", "a..b", "-x.example.com", "https://"]) {
			const r = validateAnswers({ identity: IDENTITY, cloudflare_hostname: bad }, priorOf(tempDir()), "/tmp");
			expect(r.ok ? false : r.errors.some(e => e.startsWith("cloudflare_hostname:"))).toBe(true);
		}
	});
});

describe("writeConfig web.access", () => {
	function write(dir: string, given: Partial<Answers>, access?: "local" | "tailscale"): { web: { access: string } } {
		const env: Env = { dir, home: dir, pkg: dir, say: () => undefined };
		const prior = priorOf(dir);
		const answers = check(dir, given);
		writeConfig(env, answers, prior, access);
		return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
	}

	test("tailscale and local are written as they are", () => {
		expect(write(tempDir(), { access: "tailscale" }).web.access).toBe("tailscale");
		expect(write(tempDir(), { access: "local" }).web.access).toBe("local");
	});

	test("cloudflare starts local, and stays cloudflare only when the live mode already was", () => {
		expect(write(tempDir(), { access: "cloudflare" }).web.access).toBe("local");
		expect(write(tempDir({ "config.json": { web: { access: "tailscale" } } }), { access: "cloudflare" }).web.access).toBe("local");
		expect(write(tempDir({ "web-access.json": { mode: "cloudflare" } }), { access: "cloudflare" }).web.access).toBe("cloudflare");
	});

	test("the web onboarding's own decision overrides the answers", () => {
		expect(write(tempDir(), { access: "tailscale" }, "local").web.access).toBe("local");
	});

	test("a cloudflare hostname is seeded into the engine's input file, 0600, in the shape the flow reads", () => {
		const dir = tempDir();
		write(dir, { access: "cloudflare", cloudflare_hostname: "Dotz.Example.com" });
		const file = join(dir, "onboarding", "web-access-input.json");
		expect(readFileSync(file, "utf8")).toBe(`{"hostname":"dotz.example.com"}\n`);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("no input file without a cloudflare choice and a hostname", () => {
		const tailscale = tempDir();
		write(tailscale, { access: "tailscale", cloudflare_hostname: "dotz.example.com" });
		const noHost = tempDir();
		mkdirSync(join(noHost, "onboarding"));
		write(noHost, { access: "cloudflare" });
		expect([existsSync(join(tailscale, "onboarding", "web-access-input.json")), existsSync(join(noHost, "onboarding", "web-access-input.json"))]).toEqual([false, false]);
	});
});
