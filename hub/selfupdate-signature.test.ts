// Release tag signatures in self-update, on both install kinds: a git checkout (local bare origin) and a tarball install (fake GitHub API served from
// the same temp repo). Every case runs warn (applies, one alert) and enforce (refuses, old code stays). Keys and tags are real; nothing touches a network.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitTag } from "./release-verify.ts";
import { autoHooks, git, setSelfUpdateCfg } from "./selfupdate-fixture.ts";
import { apply, autoCheck, check, defaultExec, type Exec, type Http, type Options } from "./selfupdate.ts";
import { type Key, newKey, rawTag, signersText, signTag } from "./test-signing.ts";

setDefaultTimeout(30_000);

type Kind = "git" | "tarball";
type Spec = { key?: Key | "light"; signers?: Key[]; alias?: string };
type Scene = {
	root: string;
	pusher: string;
	alerts: string[];
	downloads: string[];
	override: Record<string, string>;
	n: number;
	opts: (extra?: Partial<Options>) => Options;
	installed: () => string;
};

const OLD = "261101.1";
let tplRoot: string, keysDir: string, A: Key, B: Key, C: Key;

beforeAll(() => {
	keysDir = mkdtempSync(join(tmpdir(), "dotz-sigkeys-"));
	[A, B, C] = ["a", "b", "c"].map(n => newKey(keysDir, n)) as [Key, Key, Key];
	tplRoot = mkdtempSync(join(tmpdir(), "dotz-sigtpl-"));
	git(tplRoot, "init", "-q", "--bare", "origin.git");
	git(tplRoot, "clone", "-q", "origin.git", "pusher");
	const p = join(tplRoot, "pusher");
	mkdirSync(join(p, "hub"));
	for (const [f, text] of Object.entries({ "setup.ts": "// setup\n", "hub/main.ts": "// main\n", VERSION: `${OLD}\n`, "release-signers": signersText(A) })) writeFileSync(join(p, f), text);
	git(p, "add", "-A");
	git(p, "commit", "-q", "-m", `release ${OLD}`);
	signTag(p, `v${OLD}`, A);
	git(p, "push", "-q", "origin", "HEAD:main", `refs/tags/v${OLD}`);
	git(tplRoot, "clone", "-q", "origin.git", "work");
});
afterAll(() => {
	rmSync(keysDir, { recursive: true, force: true });
	rmSync(tplRoot, { recursive: true, force: true });
});

const stamp = (sha: string) =>
	`${Object.entries({ source: "github.com/o/r@main", kind: "github", repo: "o/r", ref: "main", sha, version: OLD, auth: "public", installed: "2026-10-01T00:00:00Z" }).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;

// The GitHub API the tarball install talks to, answered from the pusher repo: tags listing, ref, tag object (payload and signature from `git cat-file tag`), tarball.
const fakeGithub = (s: { pusher: string; downloads: string[]; override: Record<string, string> }): Http => async url => {
	const path = new URL(url).pathname;
	const g = (...a: string[]) => Bun.spawnSync(["git", "-C", s.pusher, ...a], { stdout: "pipe", stderr: "pipe" });
	const out = (...a: string[]) => g(...a).stdout.toString().trim();
	if (path === "/repos/o/r/tags") {
		const names = out("for-each-ref", "refs/tags", "--format=%(refname:short)").split("\n").filter(Boolean);
		return Response.json(names.map(name => ({ name, commit: { sha: s.override[name] ?? out("rev-parse", `${name}^{commit}`) } })));
	}
	const ref = /^\/repos\/o\/r\/git\/ref\/tags\/(.+)$/.exec(path);
	if (ref) return Response.json({ object: { type: out("cat-file", "-t", `refs/tags/${ref[1]}`), sha: out("rev-parse", `refs/tags/${ref[1]}`) } });
	const obj = /^\/repos\/o\/r\/git\/tags\/([0-9a-f]+)$/.exec(path);
	if (obj) {
		const { payload, signature } = splitTag(rawTag(s.pusher, obj[1]));
		return Response.json({ verification: { verified: false, payload, signature } });
	}
	const dl = /\/(?:tar\.gz|tarball)\/([^/]+)$/.exec(path);
	if (dl) {
		s.downloads.push(dl[1]);
		const sha = out("rev-parse", `${dl[1]}^{commit}`);
		return new Response(g("archive", "--format=tar.gz", `--prefix=o-r-${sha.slice(0, 7)}/`, sha).stdout);
	}
	return new Response("not found", { status: 404 });
};

const stub: Exec = async (cmd, cwd, ms) => (cmd[0] === "bun" ? { code: 0, out: "" } : cmd[0] === "gh" ? { code: 1, out: "gh: not logged in" } : defaultExec(cmd, cwd, ms));

function scene(kind: Kind): Scene {
	const root = mkdtempSync(join(tmpdir(), "dotz-sigupdate-"));
	cpSync(tplRoot, root, { recursive: true });
	const pusher = join(root, "pusher");
	const work = join(root, "work");
	for (const d of [work, pusher]) git(d, "remote", "set-url", "origin", join(root, "origin.git"));
	const s = { root, pusher, alerts: [] as string[], downloads: [] as string[], override: {} as Record<string, string>, n: 1 };
	const logDir = join(root, "logs");
	const alert = (t: string) => void s.alerts.push(t);
	if (kind === "git") {
		return { ...s, opts: extra => ({ dir: work, remote: "origin", branch: "main", testCmd: ["true"], logDir, alert, ...extra }), installed: () => readFileSync(join(work, "VERSION"), "utf8").trim() };
	}
	const app = join(root, "app");
	mkdirSync(app);
	const archive = Bun.spawnSync(["sh", "-c", `git -C '${pusher}' archive v${OLD} | tar -x -C '${app}'`]);
	if (archive.exitCode !== 0) throw new Error(`archive: ${archive.stderr}`);
	writeFileSync(join(app, ".dotz-install"), stamp(git(pusher, "rev-parse", `v${OLD}^{commit}`)));
	const http = fakeGithub(s);
	return {
		...s,
		opts: extra => ({ dir: app, logDir, dataDir: join(root, "data"), env: {}, exec: stub, testCmd: ["true"], http, alert, ...extra }),
		installed: () => readFileSync(join(app, "VERSION"), "utf8").trim(),
	};
}

// A release commit in the pusher repo, tagged as the spec says; returns the tag.
function release(s: Scene, spec: Spec = {}): string {
	const version = `261101.${++s.n}`;
	const tag = `v${version}`;
	const p = s.pusher;
	writeFileSync(join(p, "VERSION"), `${version}\n`);
	if (spec.signers) writeFileSync(join(p, "release-signers"), signersText(...spec.signers));
	git(p, "add", "-A");
	git(p, "commit", "-q", "-m", `release ${version}`);
	if (spec.alias) git(p, "update-ref", `refs/tags/${tag}`, git(p, "rev-parse", spec.alias));
	else if (spec.key === "light") git(p, "tag", tag);
	else signTag(p, tag, spec.key ?? A);
	git(p, "push", "-q", "origin", "HEAD:main", `refs/tags/${tag}`);
	return tag;
}
const commitOf = (s: Scene, tag: string) => git(s.pusher, "rev-parse", `${tag}^{commit}`);
const logs = (s: Scene) => {
	const dir = join(s.root, "logs");
	return existsSync(dir) ? readdirSync(dir).map(f => readFileSync(join(dir, f), "utf8")).join("") : "";
};

beforeEach(() => setSelfUpdateCfg(undefined));
afterEach(() => setSelfUpdateCfg(undefined));

type Case = { name: string; make: (s: Scene) => string; status: string; extra?: Partial<Options>; only?: Kind };
const cases: Case[] = [
	{ name: "a lightweight tag", make: s => release(s, { key: "light" }), status: "unsigned" },
	{ name: "a tag signed by a key the installed release-signers does not list", make: s => release(s, { key: B }), status: "bad" },
	{ name: "a new version whose release-signers lists the attacker's key and is signed by it", make: s => release(s, { key: B, signers: [B] }), status: "bad" },
	{ name: "an old signed tag object re-published under a newer tag name", make: s => release(s, { alias: release(s) }), status: "mismatch" },
	{
		name: "a tag whose listed commit is not the one it signed",
		make: s => {
			const tag = release(s);
			writeFileSync(join(s.pusher, "other.txt"), "x\n");
			git(s.pusher, "add", "-A");
			git(s.pusher, "commit", "-q", "-m", "other");
			s.override[tag] = git(s.pusher, "rev-parse", "HEAD");
			return tag;
		},
		status: "mismatch",
		only: "tarball",
	},
	{ name: "an ssh-keygen that cannot run", make: s => release(s), status: "unverifiable", extra: { sshKeygen: "/nonexistent/ssh-keygen" } },
];

for (const kind of ["git", "tarball"] as const) {
	const here = (c: Case) => !c.only || c.only === kind;

	test(`${kind}: a release signed by the installed key is verified and applied without an alert (warn and enforce)`, async () => {
		for (const mode of ["warn", "enforce"] as const) {
			const s = scene(kind);
			const tag = release(s);
			const j = await apply(s.opts({ signatures: mode }));
			expect(j.status).toBe("updated");
			expect(j.check?.signature).toMatchObject({ tag, status: "verified", signer: "dotz-release", mode });
			expect(s.installed()).toBe(tag.slice(1));
			expect(s.alerts).toEqual([]);
			expect(logs(s)).toContain(`signature: ${tag} signer=dotz-release result=verified`);
			if (kind === "tarball") expect(s.downloads).toEqual([commitOf(s, tag)]);
			s.n = 1;
			rmSync(s.root, { recursive: true, force: true });
		}
	});

	for (const c of cases.filter(here)) {
		test(`${kind}: ${c.name} is ${c.status}: warn applies with one alert, enforce refuses and leaves the old code`, async () => {
			const warn = scene(kind);
			const tag = c.make(warn);
			const checked = await check(warn.opts({ signatures: "warn", ...c.extra }));
			expect(checked.signature).toMatchObject({ tag, status: c.status, mode: "warn" });
			expect(warn.alerts).toEqual([]);
			const j = await apply(warn.opts({ signatures: "warn", ...c.extra }));
			expect(j.status).toBe("updated");
			expect(warn.installed()).not.toBe(OLD);
			expect(warn.alerts).toHaveLength(1);
			expect(logs(warn)).toContain(`result=${c.status}`);

			setSelfUpdateCfg(undefined);
			const hard = scene(kind);
			c.make(hard);
			const r = await apply(hard.opts({ signatures: "enforce", ...c.extra }));
			expect(r.status).toBe("refused");
			expect(r.check?.signature).toMatchObject({ status: c.status, mode: "enforce" });
			expect(hard.installed()).toBe(OLD);
			expect(hard.alerts).toHaveLength(1);
			if (kind === "tarball") expect(hard.downloads).toEqual([]);
			for (const x of [warn, hard]) rmSync(x.root, { recursive: true, force: true });
		});
	}

	test(`${kind}: key rotation: a release signed by the old key that carries old and new signers applies, the next one signed only by the new key verifies`, async () => {
		const s = scene(kind);
		const second = release(s, { key: A, signers: [A, C] });
		const first = await apply(s.opts({ signatures: "enforce" }));
		expect(first.status).toBe("updated");
		expect(first.check?.signature).toMatchObject({ tag: second, status: "verified" });
		const third = release(s, { key: C, signers: [C] });
		const next = await apply(s.opts({ signatures: "enforce" }));
		expect(next.status).toBe("updated");
		expect(next.check?.signature).toMatchObject({ tag: third, status: "verified" });
		expect(s.installed()).toBe(third.slice(1));
		expect(s.alerts).toEqual([]);
		rmSync(s.root, { recursive: true, force: true });
	});

	test(`${kind}: the owner hears about a tag once, however often it is checked, and about the next unsigned tag again`, async () => {
		const s = scene(kind);
		const t1 = release(s, { key: "light" });
		for (let i = 0; i < 2; i++) expect((await apply(s.opts({ signatures: "enforce" }))).status).toBe("refused");
		expect(s.alerts).toHaveLength(1);
		expect(s.alerts[0]).toContain(t1);
		const t2 = release(s, { key: "light" });
		await apply(s.opts({ signatures: "enforce" }));
		await apply(s.opts({ signatures: "enforce" }));
		expect(s.alerts).toHaveLength(2);
		expect(s.alerts[1]).toContain(t2);
		rmSync(s.root, { recursive: true, force: true });
	});

	test(`${kind}: the unattended check alerts once per tag, through the auto hooks, and enforce does not apply`, async () => {
		const s = scene(kind);
		release(s, { key: "light" });
		const { h, api } = autoHooks();
		const o = s.opts({ signatures: "enforce", alert: undefined });
		await autoCheck(o, api);
		await autoCheck(o, api);
		expect(h.alerts).toHaveLength(1);
		expect(h.restarts).toBe(0);
		expect(s.installed()).toBe(OLD);
		rmSync(s.root, { recursive: true, force: true });
	});

	test(`${kind}: self_update.signatures from the settings picks the mode; warn is the default`, async () => {
		const s = scene(kind);
		release(s, { key: "light" });
		expect((await check(s.opts())).signature?.mode).toBe("warn");
		setSelfUpdateCfg({ signatures: "enforce" });
		const j = await apply(s.opts());
		expect(j.status).toBe("refused");
		expect(j.check?.signature?.mode).toBe("enforce");
		rmSync(s.root, { recursive: true, force: true });
	});
}
