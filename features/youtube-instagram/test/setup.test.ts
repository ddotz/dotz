// bin/setup.ts: youtube-auth, instagram-token, apply and status against a temp DOTZ_DIR, a fake gateway/API fetch and a
// driven loopback. The card and pins it writes are read back with hub/custom.ts, the reader that rejects bad ones.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { readCards, readPins } from "../../../hub/custom.ts";
import { run, type Loopback } from "../bin/setup.ts";
import { dataDir, paths, readJson, secretsDir, snsDir, validateConfig, writeJson } from "../lib/config.ts";
import { fakeCtx, GATEWAY, SECRETS, YT_ID } from "./fakes.ts";

const BIN = join(import.meta.dir, "..", "bin");
const mode = (f: string) => statSync(f).mode & 0o777;
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const DRY_BOTH = ["apply", "--dry-run", "--yt-channel", YT_ID, "--yt-title", "My Channel", "--ig-user", "1784", "--ig-username", "owner"];

const resetCustom = () => rmSync(join(dataDir(), "custom"), { recursive: true, force: true });

// The preload's data dir (its config.json sets web.port to GATEWAY's port), which hub/custom.ts also reads; pinned so a
// DOTZ_DIR another test file left behind cannot move the card away from the reader.
const OWN_DIR = process.env.DOTZ_DIR!;

beforeEach(() => {
	process.env.DOTZ_DIR = OWN_DIR;
	resetCustom();
	rmSync(secretsDir(), { recursive: true, force: true });
	mkdirSync(secretsDir(), { recursive: true });
	writeFileSync(join(secretsDir(), "hub-token"), `${SECRETS.hub}\n`);
});

function driven() {
	let resolve!: (p: URLSearchParams) => void;
	let closed = false;
	const lb: Loopback = { port: 4242, redirect: new Promise(r => (resolve = r)), close: () => void (closed = true) };
	return { lb, deliver: (q: Record<string, string>) => resolve(new URLSearchParams(q)), closed: () => closed };
}

test("youtube-auth prints one consent URL, exchanges the code with PKCE and stores 0600 secrets", async () => {
	const f = fakeCtx();
	const d = driven();
	const clientFile = join(dataDir(), "client.json");
	writeFileSync(clientFile, JSON.stringify({ installed: { client_id: "cid", client_secret: SECRETS.clientSecret } }));
	const r = await run(f.ctx, ["youtube-auth", "--client", clientFile], {
		loopback: () => d.lb,
		onLine: l => {
			if (l.startsWith("open ")) d.deliver({ code: "CODE1", state: new URL(l.slice(5)).searchParams.get("state")! });
		},
	});

	expect(r.code).toBe(0);
	expect(r.lines).toHaveLength(2);
	const url = new URL(r.lines[0]!.replace(/^open /, ""));
	expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
	expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.force-ssl");
	expect(url.searchParams.get("access_type")).toBe("offline");
	expect(url.searchParams.get("prompt")).toBe("consent");
	expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4242");
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	expect(r.lines[1]).toBe(`youtube-connected ${YT_ID} My Channel`);

	const exchange = f.api().find(c => c.form?.grant_type === "authorization_code")!;
	expect(exchange.form!.code).toBe("CODE1");
	expect(createHash("sha256").update(exchange.form!.code_verifier!).digest("base64url")).toBe(url.searchParams.get("code_challenge")!);
	expect(read(paths.ytOauth())).toEqual({ client_id: "cid", client_secret: SECRETS.clientSecret, refresh_token: SECRETS.refresh });
	expect(mode(paths.ytOauth())).toBe(0o600);
	expect(d.closed()).toBe(true);
	for (const s of Object.values(SECRETS)) expect(r.lines.join("\n")).not.toContain(s);
});

test("youtube-auth fails without storing anything on a wrong state, a denial or a timeout", async () => {
	const clientFile = join(dataDir(), "client.json");
	writeFileSync(clientFile, JSON.stringify({ client_id: "cid", client_secret: SECRETS.clientSecret }));

	const bad = driven();
	const wrongState = await run(fakeCtx().ctx, ["youtube-auth", "--client", clientFile], { loopback: () => bad.lb, onLine: l => l.startsWith("open ") && bad.deliver({ code: "C", state: "forged" }) });
	expect(wrongState).toMatchObject({ code: 1, lines: [expect.stringMatching(/^open /), "DOTZ_FAIL youtube-auth state"] });

	const denied = driven();
	const r2 = await run(fakeCtx().ctx, ["youtube-auth", "--client", clientFile], { loopback: () => denied.lb, onLine: l => l.startsWith("open ") && denied.deliver({ error: "access_denied" }) });
	expect(r2.lines.at(-1)).toBe("DOTZ_FAIL youtube-auth denied");

	const silent = driven();
	const f = fakeCtx();
	f.ctx.sleep = async () => {};
	const r3 = await run(f.ctx, ["youtube-auth", "--client", clientFile], { loopback: () => silent.lb, waitMs: 5 });
	expect(r3.lines.at(-1)).toBe("DOTZ_FAIL youtube-auth timeout");
	expect(silent.closed()).toBe(true);
	expect(existsSync(paths.ytOauth())).toBe(false);
});

test("instagram-token validates with me(), stores 0600 with obtained_at and never prints the token", async () => {
	const f = fakeCtx();
	const from = join(dataDir(), "ig.json");
	writeFileSync(from, JSON.stringify({ access_token: SECRETS.instagram }));
	const r = await run(f.ctx, ["instagram-token", "--from", from]);

	expect(r).toEqual({ code: 0, lines: ["instagram-connected 1784 owner"] });
	expect(read(paths.instagram())).toMatchObject({ access_token: SECRETS.instagram, user_id: "1784", username: "owner", obtained_at: "2026-10-22T03:00:00.000Z" });
	expect(mode(paths.instagram())).toBe(0o600);
});

test("apply --dry-run writes a valid config, card, pins and project, and makes no non-gateway fetch", async () => {
	const f = fakeCtx();
	const r = await run(f.ctx, [...DRY_BOTH, "--languages", "en,ja", "--base", "ko", "--times", "18:00,21:00", "--approval", "batch", "--quiet", "off", "--timezone", "Asia/Seoul", "--youtube-via", "aside", "--budget", "5000", "--channel", "ch:123"]);

	expect(r.code).toBe(0);
	expect(f.api()).toHaveLength(0);
	const config = read(paths.config());
	expect(validateConfig(config)).toBeUndefined();
	expect(config).toMatchObject({ youtube: { channel_id: YT_ID, title: "My Channel", base_language: "ko", languages: ["en", "ja"], privacy: "private", upload_via: "aside" }, instagram: { user_id: "1784", username: "owner", post_via: "api" }, posting_times: ["18:00", "21:00"], approval: "batch", quota: { daily_budget: 5000 }, channel: "ch:123" });
	expect(config.quiet_hours).toBeUndefined();
	expect(statSync(join(config.inbox_dir, "done")).isDirectory()).toBe(true);
	expect(readFileSync(paths.tone(), "utf8")).toContain("말투");

	const errors: { file: string; error: string }[] = [];
	const card = readCards(errors).find(c => c.id === "sns-channels")!;
	expect(errors).toEqual([]);
	expect(card).not.toHaveProperty("error");
	expect((card as any).spec).toMatchObject({ title: "유튜브·인스타", view: "kv", command: `bun ${join(BIN, "card.ts")}`, every_minutes: 60, timeout_seconds: 20 });
	expect((card as any).spec.actions.map((a: any) => a.label)).toEqual(["댓글 지금 확인", "영상 올리는 법"]);

	const pins = readPins({ sync: false });
	expect(pins.errors).toEqual([]);
	expect(pins.pins.projects).toEqual([{ name: "유튜브·인스타 관리", path: snsDir(), channel: "123", note: "유튜브와 인스타 올리기, 댓글, 통계를 맡아요" }]);

	expect(r.lines.slice(0, 3)).toEqual([`config ${paths.config()}`, "card sns-channels", "project ch:123"]);
	expect(r.lines.slice(3)).toEqual(["watch sns-yt-comments every 30m", "watch sns-ig-comments every 60m", "watch sns-inbox every 5m", "watch sns-due every 5m", "watch sns-tokens every 720m", "watch sns-yt-metadata every 1440m", "ok"]);
	for (const g of f.gateway()) {
		expect(g.url.startsWith(GATEWAY)).toBe(true);
		expect(g.hubToken).toBe(SECRETS.hub);
	}
});

test("apply posts the watches of DESIGN, woken in the project channel, and only for the connected platforms", async () => {
	const f = fakeCtx();
	await run(f.ctx, [...DRY_BOTH, "--channel", "ch:123"]);
	const want = (name: string, script: string, every: number, on: string) => ({ name, command: `bun ${join(BIN, script)}`, every_minutes: every, on, ...(on === "match" ? { pattern: "." } : {}), to: "orchestrator", channels: ["123"] });
	expect(f.watches.map(w => ({ ...w, timeout_seconds: undefined }))).toMatchObject([
		want("sns-yt-comments", "yt-comments.ts", 30, "match"),
		want("sns-ig-comments", "ig-comments.ts", 60, "match"),
		want("sns-inbox", "inbox.ts", 5, "match"),
		want("sns-due", "due.ts", 5, "match"),
		want("sns-tokens", "tokens.ts", 720, "change"),
	]);
	expect(f.watches.find(w => w.name === "sns-tokens")).not.toHaveProperty("pattern");

	resetCustom();
	const ig = fakeCtx();
	await run(ig.ctx, ["apply", "--dry-run", "--ig-user", "1784", "--ig-username", "owner"]);
	expect(ig.watches.map(w => w.name)).toEqual(["sns-ig-comments", "sns-inbox", "sns-due", "sns-tokens"]);
	expect(ig.watches[0]).toMatchObject({ to: "orchestrator" });
	expect(ig.watches[0]).not.toHaveProperty("channels");
	expect(ig.gateway()[0]).toMatchObject({ method: "PUT", body: { key: `dir:${snsDir()}`, title: "유튜브·인스타 관리" } });

	resetCustom();
	const yt = fakeCtx();
	await run(yt.ctx, ["apply", "--dry-run", "--yt-channel", YT_ID, "--languages", "en"]);
	expect(yt.watches.map(w => w.name)).toEqual(["sns-yt-comments", "sns-inbox", "sns-due", "sns-tokens", "sns-yt-metadata"]);
	expect(yt.watches.at(-1)).toMatchObject({ command: `bun ${join(BIN, "yt-metadata.ts")}`, every_minutes: 1440, on: "match", pattern: "." });
});

test("multilingual metadata is opt-in: no languages and no sns-yt-metadata by default, --languages adds it, --languages off pauses it", async () => {
	const plain = fakeCtx();
	const first = await run(plain.ctx, DRY_BOTH);
	expect(first.code).toBe(0);
	expect(read(paths.config()).youtube.languages).toEqual([]);
	expect(validateConfig(read(paths.config()))).toBeUndefined();
	expect(first.lines.join("\n")).not.toContain("sns-yt-metadata");
	expect(plain.gateway().some(c => c.method === "PATCH" || c.method === "DELETE")).toBe(false);

	const on = fakeCtx();
	const enabled = await run(on.ctx, [...DRY_BOTH, "--languages", "en,ja"]);
	expect(read(paths.config()).youtube.languages).toEqual(["en", "ja"]);
	expect(enabled.lines).toContain("watch sns-yt-metadata every 1440m");

	expect(on.watches.map(w => w.name)).toContain("sns-yt-metadata");
	const off = on;
	const removed = await run(off.ctx, [...DRY_BOTH, "--languages", "off"]);
	expect(removed.code).toBe(0);
	expect(read(paths.config()).youtube.languages).toEqual([]);
	expect(off.gateway().filter(c => c.method === "PATCH").map(c => [c.url, c.body])).toEqual([[`${GATEWAY}/api/watches/sns-yt-metadata`, { paused: true }]]);
	expect(off.watches.find(w => w.name === "sns-yt-metadata")).toMatchObject({ paused: true });
	expect(removed.lines).toContain("watch sns-yt-metadata paused");
	expect(removed.lines).not.toContain("watch sns-yt-metadata every 1440m");
});

test("apply merges the project into pins.json without touching other entries, and a second run changes nothing", async () => {
	const pinsFile = join(dataDir(), "custom", "pins.json");
	mkdirSync(dirname(pinsFile), { recursive: true });
	const other = { name: "다른 프로젝트", path: "/tmp/other-project", note: "x" };
	writeFileSync(pinsFile, JSON.stringify({ projects: [other], hide_projects: ["dir:~/old"], links: [{ name: "문서", url: "https://example.com" }] }));

	const f = fakeCtx();
	await run(f.ctx, DRY_BOTH);
	const first = readFileSync(pinsFile, "utf8");
	const cfg = readFileSync(paths.config(), "utf8");
	await run(f.ctx, DRY_BOTH);

	expect(readFileSync(pinsFile, "utf8")).toBe(first);
	expect(readFileSync(paths.config(), "utf8")).toBe(cfg);
	const pins = read(pinsFile);
	expect(pins.projects).toHaveLength(2);
	expect(pins.projects[0]).toEqual(other);
	expect(pins.projects.filter((p: any) => p.name === "유튜브·인스타 관리")).toHaveLength(1);
	expect(pins.hide_projects).toEqual(["dir:~/old"]);
	expect(pins.links).toHaveLength(1);
	expect(readPins({ sync: false }).errors).toEqual([]);
});

test("a re-run keeps the earlier choices and an owner-written tone.md", async () => {
	const f = fakeCtx();
	await run(f.ctx, [...DRY_BOTH, "--languages", "es", "--times", "20:00"]);
	writeFileSync(paths.tone(), "내 말투");
	await run(f.ctx, DRY_BOTH);
	expect(read(paths.config())).toMatchObject({ youtube: { languages: ["es"] }, posting_times: ["20:00"] });
	expect(readFileSync(paths.tone(), "utf8")).toBe("내 말투");
});

test("apply uses the connected accounts, keeps secrets 0600 and prints none of them", async () => {
	const f = fakeCtx();
	writeJson(paths.ytOauth(), { client_id: "cid", client_secret: SECRETS.clientSecret, refresh_token: SECRETS.refresh }, true);
	writeJson(paths.instagram(), { access_token: SECRETS.instagram, user_id: "1784", username: "owner", obtained_at: "2026-10-20T00:00:00.000Z" }, true);
	const r = await run(f.ctx, ["apply"]);

	expect(r.code).toBe(0);
	expect(read(paths.config())).toMatchObject({ youtube: { channel_id: YT_ID, title: "My Channel" }, instagram: { user_id: "1784", username: "owner" } });
	expect(f.watches).toHaveLength(5);
	expect(mode(paths.ytOauth())).toBe(0o600);
	expect(mode(paths.instagram())).toBe(0o600);
	for (const s of Object.values(SECRETS)) {
		expect(r.lines.join("\n")).not.toContain(s);
		expect(readFileSync(paths.config(), "utf8")).not.toContain(s);
	}
});

test("a gateway failure is reported after the files are written, and the next run completes", async () => {
	const f = fakeCtx();
	f.state.gatewayStatus = 500;
	const r = await run(f.ctx, DRY_BOTH);
	expect(r.code).toBe(1);
	expect(r.lines.at(-1)).toBe("DOTZ_FAIL gateway 500");
	expect(validateConfig(read(paths.config()))).toBeUndefined();
	expect(existsSync(join(dataDir(), "custom", "cards", "sns-channels", "card.json"))).toBe(true);
	expect(read(join(dataDir(), "custom", "pins.json")).projects).toHaveLength(1);

	f.state.gatewayStatus = 200;
	expect((await run(f.ctx, DRY_BOTH)).lines.at(-1)).toBe("ok");

	const down = fakeCtx();
	down.state.gatewayDown = true;
	expect((await run(down.ctx, DRY_BOTH)).lines.at(-1)).toBe("DOTZ_FAIL gateway unreachable");
});

test("the gateway port comes from DOTZ_PORT, else config.json web.port", async () => {
	const viaEnv = fakeCtx({ env: { DOTZ_PORT: "5555" } });
	await run(viaEnv.ctx, DRY_BOTH);
	expect(viaEnv.gateway()[0]!.url).toBe("http://127.0.0.1:5555/api/projects");
	const viaConfig = fakeCtx();
	await run(viaConfig.ctx, DRY_BOTH);
	expect(viaConfig.gateway()[0]!.url).toBe(`${GATEWAY}/api/projects`);
});

test("apply rejects bad flags before writing anything", async () => {
	for (const bad of [["--languages", "EN!"], ["--quiet", "9-10"], ["--times", "6pm"], ["--approval", "auto"], ["--budget", "5"]]) {
		const f = fakeCtx();
		const r = await run(f.ctx, [...DRY_BOTH, ...bad]);
		expect(r.code).toBe(1);
		expect(r.lines.at(-1)).toMatch(/^DOTZ_FAIL setup /);
		expect(existsSync(paths.config())).toBe(false);
		expect(f.gateway()).toHaveLength(0);
	}
});

test("status prints one Korean line per part, before and after setup", async () => {
	const f = fakeCtx();
	const before = await run(f.ctx, ["status"]);
	expect(before.code).toBe(0);
	expect(before.lines).toHaveLength(4);
	expect(before.lines[0]).toContain("아직 안 했어요");
	expect(before.lines[3]).toContain("아직");

	await run(f.ctx, [...DRY_BOTH, "--channel", "ch:123"]);
	const after = await run(f.ctx, ["status"]);
	expect(after.lines).toHaveLength(4);
	expect(after.lines[1]).toContain("My Channel");
	expect(after.lines[2]).toContain("@owner");
	expect(after.lines[3]).toContain("5개");
	for (const l of after.lines) expect(l).toMatch(/요(\)|\.)?$|요 \(/);
	expect(readJson(paths.config())).toBeDefined();
});
