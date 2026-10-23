// Self-update of an install.sh tarball install (no .git, a .dotz-install stamp): version detection, the check against a stubbed
// GitHub (no network), the GitHub auth order, and apply with a local tarball: staging, tests, the dir swap, the rollback copy
// and the untouched old code when a step fails.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cfg } from "./config.ts";
import { apply, authOrder, check, defaultExec, type Exec, type Http, type Options, version } from "./selfupdate.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const commitJson = (sha: string, msg: string) => ({ sha, commit: { message: `${msg}\n\nbody`, committer: { date: "2026-10-23T00:00:00Z" } } });

let root: string, app: string, data: string, logDir: string;
const put = (dir: string, files: Record<string, string>) => {
	for (const [f, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, f)), { recursive: true });
		writeFileSync(join(dir, f), text);
	}
};
const stamp = (extra: Record<string, string> = {}) => `${Object.entries({ source: "github.com/o/r@main", kind: "github", repo: "o/r", ref: "main", sha: OLD, auth: "public", installed: "2026-10-01T00:00:00Z", ...extra }).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
// <prefix>/ wrapper like a GitHub tarball
const tarball = (name: string, files: Record<string, string>): string => {
	const src = join(root, `src-${name}`);
	put(join(src, "o-r-bbbbbbb"), { "setup.ts": "// setup\n", "hub/main.ts": "// main\n", ...files });
	const out = join(root, `${name}.tar.gz`);
	const r = Bun.spawnSync(["tar", "-czf", out, "-C", src, "o-r-bbbbbbb"]);
	if (r.exitCode !== 0) throw new Error(`tar: ${r.stderr}`);
	return out;
};
// bun install and gh are stubbed (no network, no deps, never the machine's own gh login); tar and the test command run for real.
const exec = (extra?: Exec): Exec => async (cmd, cwd, ms) => (extra ? await extra(cmd, cwd, ms) : undefined) ?? (cmd[0] === "bun" ? { code: 0, out: "" } : cmd[0] === "gh" ? { code: 1, out: "gh: not logged in" } : defaultExec(cmd, cwd, ms));
const opts = (o: Partial<Options> = {}): Options => ({ dir: app, logDir, dataDir: data, env: {}, exec: exec(), testCmd: ["sh", "-c", "test ! -f FAIL"], ...o });
type Seen = { url: string; auth: string | undefined };
const github = (tgz: string, seen: Seen[] = [], accept: (auth: string | undefined) => boolean = () => true): Http => async (url, init) => {
	const auth = init?.headers?.authorization;
	seen.push({ url, auth });
	if (!accept(auth)) return new Response(JSON.stringify({ message: auth ? "Bad credentials" : "Not Found" }), { status: auth ? 401 : 404 });
	if (url.endsWith("/commits/main")) return Response.json(commitJson(NEW, "newest change"));
	if (url.includes("/compare/")) return Response.json({ status: "ahead", total_commits: 2, commits: [commitJson("c".repeat(40), "older change"), commitJson(NEW, "newest change")] });
	if (url.includes("/tar.gz/") || url.includes("/tarball/")) return new Response(Bun.file(tgz));
	return new Response("not found", { status: 404 });
};
const logs = () => (existsSync(logDir) ? readdirSync(logDir).map(f => readFileSync(join(logDir, f), "utf8")).join("") : "");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-tarupdate-"));
	app = join(root, "dotz");
	data = join(root, "data");
	logDir = join(root, "logs");
	put(app, { "setup.ts": "// old setup\n", "hub/main.ts": "// old main\n", "old-only.txt": "old\n", ".dotz-install": stamp() });
});
afterEach(() => {
	(cfg as Record<string, unknown>).self_update = undefined;
	rmSync(root, { recursive: true, force: true });
});

test("version reads the stamp: repo, ref, sha, auth; older and foreign stamps degrade", async () => {
	const v = await version(opts());
	expect(v).toMatchObject({ kind: "tarball", origin: "github", repo: "o/r", ref: "main", auth: "public", commit: { sha: OLD, short: "aaaaaaa" } });
	// install.sh from before the sha was recorded: repo and ref come from `source`, the sha is unknown
	put(app, { ".dotz-install": "source=github.com/o/r@dev\ninstalled=2026-09-01T00:00:00Z\n" });
	expect(await version(opts())).toMatchObject({ kind: "tarball", repo: "o/r", ref: "dev", commit: { sha: "", short: "?" } });
	// a DOTZ_TARBALL install of that time has nothing to check against
	put(app, { ".dotz-install": "source=/tmp/x.tar.gz\ninstalled=2026-09-01T00:00:00Z\n" });
	expect((await version(opts())).kind).toBe("install");
	// a DOTZ_TARBALL install of now is a url tarball
	put(app, { ".dotz-install": stamp({ source: "file:///tmp/x.tar.gz", kind: "url", tarball: "file:///tmp/x.tar.gz", repo: "", ref: "" }) });
	expect(await version(opts())).toMatchObject({ kind: "tarball", origin: "url" });
	rmSync(join(app, ".dotz-install"));
	expect((await version(opts())).kind).toBe("unknown");
});

test("auth order: GITHUB_TOKEN, GH_TOKEN, the saved token file, gh, then nobody; a repeated token counts once", () => {
	put(data, { "secrets/github-token": "file-token\n" });
	const order = authOrder(opts({ env: { GITHUB_TOKEN: "t1", GH_TOKEN: "t2" } }));
	expect(order.map(c => (c.how === "token" ? c.token : c.how))).toEqual(["t1", "t2", "file-token", "gh", "none"]);
	rmSync(join(data, "secrets"), { recursive: true });
	expect(authOrder(opts({ env: { GITHUB_TOKEN: "same", GH_TOKEN: "same" } })).map(c => c.how)).toEqual(["token", "gh", "none"]);
	expect(authOrder(opts()).map(c => c.how)).toEqual(["gh", "none"]);
});

test("check against GitHub: latest commit, incoming list newest first, nothing changes on disk", async () => {
	const seen: Seen[] = [];
	const c = await check(opts({ http: github("", seen) }));
	expect(c.ok).toBe(true);
	expect(c.upstream).toBe("o/r@main");
	expect(c.remoteHead).toBe(NEW);
	expect(c.incomingTotal).toBe(2);
	expect(c.incoming.map(i => i.subject)).toEqual(["newest change", "older change"]);
	expect(c.blocked).toEqual([]);
	// public repo: no gh on this PATH is needed, requests carry no credentials
	expect(seen.every(s => s.auth === undefined)).toBe(true);
	expect(seen[0].url).toBe("https://api.github.com/repos/o/r/commits/main");
	expect(seen[1].url).toBe(`https://api.github.com/repos/o/r/compare/${OLD}...${NEW}`);
	expect(readFileSync(join(app, "old-only.txt"), "utf8")).toBe("old\n");
	expect(logs()).toContain("2 incoming");
});

test("check says current when the installed sha is the latest commit", async () => {
	put(app, { ".dotz-install": stamp({ sha: NEW }) });
	const c = await check(opts({ http: github("") }));
	expect(c.ok).toBe(true);
	expect(c.incomingTotal).toBe(0);
	// the 7-character sha of an API tarball folder name matches too
	put(app, { ".dotz-install": stamp({ sha: NEW.slice(0, 7) }) });
	expect((await check(opts({ http: github("") }))).incomingTotal).toBe(0);
});

test("a refused token falls through to gh, then to no auth; the one that worked goes first afterwards", async () => {
	const seen: Seen[] = [];
	const ghCalls: string[][] = [];
	const e = exec(async cmd => (cmd[0] === "gh" ? (ghCalls.push(cmd), { code: 1, out: "gh: To get started with GitHub CLI, please run: gh auth login" }) : undefined));
	const c = await check(opts({ env: { GITHUB_TOKEN: "ghp_staletoken0000" }, exec: e, http: github("", seen, auth => !auth) }));
	expect(c.ok).toBe(true);
	expect(seen[0].auth).toBe("Bearer ghp_staletoken0000");
	expect(ghCalls).toHaveLength(1);
	expect(ghCalls[0].slice(0, 3)).toEqual(["gh", "api", "repos/o/r/commits/main"]);
	expect(seen[1].auth).toBeUndefined();
	// compare goes straight to the credential that worked: no second stale-token attempt, no second gh
	expect(seen).toHaveLength(3);
	expect(seen[2].auth).toBeUndefined();
	expect(ghCalls).toHaveLength(1);
});

test("private repo: the saved token file is used when the environment has none", async () => {
	put(data, { "secrets/github-token": "filetok\n" });
	const seen: Seen[] = [];
	const c = await check(opts({ http: github("", seen, auth => auth === "Bearer filetok") }));
	expect(c.ok).toBe(true);
	expect(seen[0].auth).toBe("Bearer filetok");
	expect(seen.every(s => s.auth === "Bearer filetok")).toBe(true);
});

test("private repo: gh api answers when GitHub refuses everyone else", async () => {
	const ghCalls: string[] = [];
	const e = exec(async cmd => {
		if (cmd[0] !== "gh") return undefined;
		ghCalls.push(cmd[2]);
		return { code: 0, out: JSON.stringify(cmd[2].includes("compare") ? { status: "ahead", total_commits: 1, commits: [commitJson(NEW, "private change")] } : commitJson(NEW, "private change")) };
	});
	const c = await check(opts({ exec: e, http: github("", [], () => false) }));
	expect(c.ok).toBe(true);
	expect(c.incoming.map(i => i.subject)).toEqual(["private change"]);
	expect(ghCalls[0]).toBe("repos/o/r/commits/main");
});

test("check failures name the reason in Korean and what fixes it, without any token", async () => {
	const c = await check(opts({ env: { GITHUB_TOKEN: "ghp_secrettoken000000" }, http: github("", [], () => false) }));
	expect(c.ok).toBe(false);
	expect(c.error?.reason).toContain("인증");
	expect(c.error?.fix).toContain("gh auth login");
	expect(JSON.stringify(c)).not.toContain("ghp_secrettoken000000");
	const down = await check(opts({ http: async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); } }));
	expect(down.ok).toBe(false);
	expect(down.error?.reason).toContain("네트워크");
	const limited = await check(opts({ http: async () => new Response(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4" }), { status: 403 }) }));
	expect(limited.error?.reason).toContain("한도");
});

test("apply downloads into staging, installs, tests, swaps the dirs and keeps one rollback copy", async () => {
	const tgz = tarball("new", { "new-only.txt": "new\n" });
	const seen: string[] = [];
	const e = exec(async cmd => (seen.push(cmd.join(" ")), undefined));
	const j = await apply(opts({ http: github(tgz), exec: e }));
	expect(j.status).toBe("updated");
	expect(j.from).toBe(OLD);
	expect(j.to).toBe(NEW);
	expect(readFileSync(join(app, "new-only.txt"), "utf8")).toBe("new\n");
	expect(existsSync(join(app, "old-only.txt"))).toBe(false);
	expect(readFileSync(join(`${app}.prev`, "old-only.txt"), "utf8")).toBe("old\n");
	expect(existsSync(`${app}.update`)).toBe(false);
	expect(seen).toContain("bun install");
	const v = await version(opts());
	expect(v).toMatchObject({ kind: "tarball", repo: "o/r", ref: "main", auth: "public", commit: { sha: NEW } });
	expect(j.message).toContain(`${app}.prev`);
	expect(logs()).toContain("bun install");
	// a second update replaces the rollback copy: still exactly one
	put(app, { ".dotz-install": stamp({ sha: OLD }) });
	const j2 = await apply(opts({ http: github(tarball("newer", { "newer-only.txt": "x\n" })) }));
	expect(j2.status).toBe("updated");
	expect(existsSync(join(`${app}.prev`, "new-only.txt"))).toBe(true);
	expect(existsSync(join(`${app}.prev`, "old-only.txt"))).toBe(false);
	expect(readdirSync(root).filter(f => f.startsWith("dotz.")).sort()).toEqual(["dotz.prev"]);
});

test("a failing check keeps the old code, removes staging and says why", async () => {
	const tgz = tarball("bad", { FAIL: "boom\n" });
	const j = await apply(opts({ http: github(tgz) }));
	expect(j.status).toBe("failed");
	expect(j.message).toContain("테스트 실패");
	expect(j.message).toContain("이전 버전(aaaaaaa)이 그대로 있어요");
	expect(readFileSync(join(app, "old-only.txt"), "utf8")).toBe("old\n");
	expect(existsSync(join(app, "FAIL"))).toBe(false);
	expect((await version(opts())).kind === "tarball" && (await version(opts()) as { commit: { sha: string } }).commit.sha).toBe(OLD);
	expect(existsSync(`${app}.update`)).toBe(false);
	expect(existsSync(`${app}.prev`)).toBe(false);
});

test("a failing bun install, a bad download and a non-dotz tarball keep the old code too", async () => {
	const tgz = tarball("ok", {});
	const e = exec(async cmd => (cmd[0] === "bun" ? { code: 1, out: "error: lockfile had changes" } : undefined));
	const a = await apply(opts({ http: github(tgz), exec: e }));
	expect(a.status).toBe("failed");
	expect(a.message).toContain("bun install 실패");
	const b = await apply(opts({ http: async url => (url.includes("/commits/") ? Response.json(commitJson(NEW, "x")) : url.includes("/compare/") ? new Response("", { status: 404 }) : new Response("nope", { status: 500 })) }));
	expect(b.status).toBe("failed");
	expect(b.message).toContain("내려받지 못했어요");
	const junk = join(root, "junk.tar.gz");
	put(join(root, "junk-src", "x"), { "readme.txt": "not dotz\n" });
	Bun.spawnSync(["tar", "-czf", junk, "-C", join(root, "junk-src"), "x"]);
	const c = await apply(opts({ http: github(junk) }));
	expect(c.status).toBe("failed");
	expect(c.message).toContain("dotz가 아니에요");
	for (const j of [a, b, c]) expect(j.message).toContain("그대로 있어요");
	expect(readFileSync(join(app, "old-only.txt"), "utf8")).toBe("old\n");
	expect(readdirSync(root).filter(f => f.startsWith("dotz.") || f === "dotz.update")).toEqual([]);
});

test("apply with nothing new is 'current' and touches nothing", async () => {
	put(app, { ".dotz-install": stamp({ sha: NEW }) });
	const j = await apply(opts({ http: github("") }));
	expect(j.status).toBe("current");
	expect(existsSync(`${app}.prev`)).toBe(false);
});

test("apply downloads through gh for a private repo and records the auth", async () => {
	const tgz = tarball("ghnew", { "gh-only.txt": "gh\n" });
	const e = exec(async cmd => {
		if (cmd[0] === "gh") return { code: 0, out: JSON.stringify(commitJson(NEW, "private change")) };
		if (cmd[0] === "sh" && cmd[2]?.includes("gh api")) {
			expect(cmd[4]).toBe(`repos/o/r/tarball/${NEW}`);
			copyFileSync(tgz, cmd[5]);
			return { code: 0, out: "" };
		}
		return undefined;
	});
	const j = await apply(opts({ exec: e, http: github("", [], () => false) }));
	expect(j.status).toBe("updated");
	expect(readFileSync(join(app, "gh-only.txt"), "utf8")).toBe("gh\n");
	expect(await version(opts())).toMatchObject({ auth: "gh", commit: { sha: NEW } });
});

test("a DOTZ_TARBALL (file://) install updates when the tarball changes, and fails safe on a bad one", async () => {
	const first = tarball("u1", { "v.txt": "1\n" });
	const url = `file://${first}`;
	// what install.sh stores: the sha256 of the bytes
	const digest = new Bun.CryptoHasher("sha256").update(readFileSync(first)).digest("hex");
	put(app, { ".dotz-install": stamp({ source: url, kind: "url", tarball: url, repo: "", ref: "", sha: digest, auth: "public" }) });
	const same = await check(opts());
	expect(same.ok).toBe(true);
	expect(same.incomingTotal).toBe(0);
	copyFileSync(tarball("u2", { "v.txt": "2\n" }), first);
	const c = await check(opts());
	expect(c.incomingTotal).toBe(1);
	expect(c.incoming[0].subject).toContain("바뀌었어요");
	const j = await apply(opts());
	expect(j.status).toBe("updated");
	expect(readFileSync(join(app, "v.txt"), "utf8")).toBe("2\n");
	expect((await check(opts())).incomingTotal).toBe(0);
	// the tarball goes missing: the check says so
	rmSync(first);
	const gone = await check(opts());
	expect(gone.ok).toBe(false);
	expect(gone.error?.reason).toContain("tarball");
});
