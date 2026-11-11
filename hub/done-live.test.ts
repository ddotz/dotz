import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDoneLive, doneLiveDecision, gitResolver, MARK, repoKey, type Live } from "./done-live.ts";

const NOT_LIVE = "abc1234def";
const LIVE = "1234567abc";
const table = (m: Record<string, Live>) => (h: string): Live => m[h] ?? "unknown";

test("a [done] citing a commit the gateway lacks triggers; the other texts do not", () => {
	const r = table({ [NOT_LIVE]: "not-live", [LIVE]: "live" });
	expect(doneLiveDecision(`[done] fixed in ${NOT_LIVE}`, r)).toEqual({ append: true, notLive: [NOT_LIVE] });
	expect(doneLiveDecision(`  \n[완료] fixed in \`${NOT_LIVE}\``, r).append).toBe(true);
	expect(doneLiveDecision(`[done] fixed in ${LIVE}`, r).append).toBe(false);
	expect(doneLiveDecision(`[done] fixed in ${LIVE} and ${NOT_LIVE}`, r).notLive).toEqual([NOT_LIVE]);
	expect(doneLiveDecision(`[run] fixed in ${NOT_LIVE}`, r).append).toBe(false);
	expect(doneLiveDecision(`fixed [done] in ${NOT_LIVE}`, r).append).toBe(false);
	expect(doneLiveDecision("[done] fixed, no commit named", r).append).toBe(false);
});

test("only commit-shaped tokens are asked about", () => {
	const asked: string[] = [];
	const r = (h: string): Live => (asked.push(h), "unknown");
	doneLiveDecision(["[done] effaced facade 12345 1234567890123456789012345678901234567890123", `https://example.test/o/r/commit/${NOT_LIVE}`, "src/abc1234def.ts", "```", `fenced ${LIVE}`, "```", `kept ${"a".repeat(6)}1`].join("\n"), r);
	expect(asked).toEqual(["aaaaaa1"]);
});

test("an unknown or foreign hash never triggers, and a resolver error appends nothing", () => {
	expect(doneLiveDecision(`[done] see ${NOT_LIVE}`, table({})).append).toBe(false);
	const boom = (): Live => {
		throw new Error("git hung");
	};
	expect(doneLiveDecision(`[done] ${NOT_LIVE}`, boom)).toEqual({ append: false, notLive: [], error: "git hung" });
	const logged: string[] = [];
	expect(appendDoneLive(`[done] ${NOT_LIVE}`, boom, "line", m => logged.push(m))).toBe(`[done] ${NOT_LIVE}`);
	expect(logged).toHaveLength(1);
});

test("the line is appended once, whatever text comes back through", () => {
	const r = table({ [NOT_LIVE]: "not-live" });
	const once = appendDoneLive(`[done] fixed in ${NOT_LIVE}\n\n`, r, "not on this computer yet");
	expect(once).toStartWith(`[done] fixed in ${NOT_LIVE}\n-# not on this computer yet`);
	expect(once).toEndWith(MARK);
	expect(doneLiveDecision(once, r).append).toBe(false);
	expect(appendDoneLive(once, r, "not on this computer yet")).toBe(once);
});

test("repoKey reads the same repo in every spelling of its origin", () => {
	const keys = ["https://example.test/Owner/repo.git", "git@example.test:owner/repo", "ssh://git@example.test/owner/repo.git/", "https://user:tok@example.test/owner/repo"].map(repoKey);
	expect(new Set(keys)).toEqual(new Set(["example.test/owner/repo"]));
	expect(repoKey("https://example.test/owner/other")).not.toBe(keys[0]!);
});

// ---- the real resolver on real repos: an installed copy, a developer checkout of the same origin, and another project's checkout ----
const roots: string[] = [];
const sh = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
		timeout: 20_000,
		env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
	}).trim();
const commit = (dir: string, file: string): string => {
	writeFileSync(join(dir, file), file);
	sh(dir, "add", file);
	sh(dir, "commit", "-q", "-m", file);
	return sh(dir, "rev-parse", "HEAD");
};
afterAll(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function world() {
	const root = mkdtempSync(join(tmpdir(), "done-live-"));
	roots.push(root);
	const upstream = join(root, "upstream.git");
	const other = join(root, "other.git");
	sh(root, "init", "-q", "--bare", upstream);
	sh(root, "init", "-q", "--bare", other);
	const install = join(root, "install");
	const dev = join(root, "dev");
	const foreign = join(root, "foreign");
	sh(root, "clone", "-q", upstream, install);
	const first = commit(install, "a.txt");
	sh(install, "push", "-q", "origin", "HEAD:main");
	sh(root, "clone", "-q", "-b", "main", upstream, dev);
	const second = commit(dev, "b.txt");
	sh(root, "clone", "-q", other, foreign);
	const alien = commit(foreign, "c.txt");
	return { root, install, dev, foreign, first, second, alien };
}
const short = (sha: string): string => sha.slice(0, 10);

test("a commit only a developer checkout of the same origin has is not live; the boot commit and its ancestors are", () => {
	const w = world();
	for (const sha of [w.first, w.second, w.alien]) expect(/\d/.test(short(sha))).toBe(true);
	const resolve = gitResolver({ boot: () => w.first, installDir: w.install, devDirs: () => [w.dev, w.foreign] });
	expect(resolve(short(w.first))).toBe("live");
	expect(resolve(short(w.second))).toBe("not-live");
	expect(resolve(short(w.alien))).toBe("unknown");
	sh(w.dev, "push", "-q", "origin", "HEAD:main");
	sh(w.install, "pull", "-q", "origin", "main");
	const later = gitResolver({ boot: () => w.first, installDir: w.install, devDirs: () => [] });
	expect(later(short(w.second))).toBe("not-live");
	const booted = gitResolver({ boot: () => w.second, installDir: w.install, devDirs: () => [] });
	expect(booted(short(w.second))).toBe("live");
});

test("with no developer checkout the commit is unknown and nothing is appended", () => {
	const w = world();
	const resolve = gitResolver({ boot: () => w.first, installDir: w.install, devDirs: () => [] });
	expect(resolve(short(w.second))).toBe("unknown");
	expect(doneLiveDecision(`[done] ${short(w.second)}`, resolve).append).toBe(false);
	expect(gitResolver({ boot: () => undefined, installDir: w.install, devDirs: () => [w.dev] })(short(w.second))).toBe("unknown");
	expect(gitResolver({ boot: () => w.first, installDir: w.root, devDirs: () => [w.dev] })(short(w.second))).toBe("unknown");
});

test("answers are cached per boot commit; an unknown one is asked again after its time", () => {
	const w = world();
	let calls = 0;
	let clock = 0;
	let boot = w.first;
	const counted = (dir: string, args: string[]) => {
		calls++;
		try {
			return { code: 0, out: sh(dir, ...args) };
		} catch (e) {
			return { code: (e as { status?: number }).status ?? 1, out: "" };
		}
	};
	const resolve = gitResolver({ boot: () => boot, installDir: w.install, devDirs: () => [w.dev, w.foreign], git: counted, now: () => clock, unknownTtlMs: 1000 });
	expect(resolve(short(w.second))).toBe("not-live");
	const afterFirst = calls;
	expect(resolve(short(w.second))).toBe("not-live");
	expect(calls).toBe(afterFirst);
	expect(resolve(short(w.alien))).toBe("unknown");
	const afterUnknown = calls;
	expect(resolve(short(w.alien))).toBe("unknown");
	expect(calls).toBe(afterUnknown);
	clock = 1001;
	expect(resolve(short(w.alien))).toBe("unknown");
	expect(calls).toBeGreaterThan(afterUnknown);
	boot = w.second;
	const before = calls;
	expect(resolve(short(w.second))).toBe("live");
	expect(calls).toBeGreaterThan(before);
});

test("a git call that times out aborts the whole text after one call and caches nothing", () => {
	const w = world();
	let calls = 0;
	let hang = true;
	const flaky = (dir: string, args: string[]) => {
		calls++;
		if (hang) return { code: null, out: "" };
		try {
			return { code: 0, out: sh(dir, ...args) };
		} catch (e) {
			return { code: (e as { status?: number }).status ?? 1, out: "" };
		}
	};
	const resolve = gitResolver({ boot: () => w.first, installDir: w.install, devDirs: () => [w.dev, w.foreign], git: flaky });
	const text = `[done] ${short(w.second)} ${short(w.alien)} ${short(w.first)}`;
	const d = doneLiveDecision(text, resolve);
	expect(d.append).toBe(false);
	expect(d.error).toBeTruthy();
	expect(calls).toBe(1);
	hang = false;
	expect(doneLiveDecision(text, resolve)).toEqual({ append: true, notLive: [short(w.second)] });
});

test("other projects' folders do not crowd out the dotz checkouts, and each origin is asked once", () => {
	const w = world();
	const calls: string[] = [];
	const counted = (dir: string, args: string[]) => {
		calls.push(`${dir} ${args[0]}`);
		try {
			return { code: 0, out: sh(dir, ...args) };
		} catch (e) {
			return { code: (e as { status?: number }).status ?? 1, out: "" };
		}
	};
	const crowd = Array.from({ length: 12 }, () => w.foreign);
	const resolve = gitResolver({ boot: () => w.first, installDir: w.install, devDirs: () => [...crowd, w.dev], git: counted });
	expect(resolve(short(w.second))).toBe("not-live");
	const asked = (dir: string) => calls.filter(c => c === `${dir} remote`).length;
	expect(asked(w.install)).toBe(1);
	expect(asked(w.dev)).toBe(1);
	expect(asked(w.foreign)).toBe(1);
	expect(resolve(short(w.alien))).toBe("unknown");
	expect(asked(w.install) + asked(w.dev) + asked(w.foreign)).toBe(3);
});
