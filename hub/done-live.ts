// A [done] for the owner that cites a dotz commit the RUNNING gateway does not contain yet gets one small line saying so (the owner looked at his
// screen after a [done] and saw nothing: the fix was on main only). Code, not a lesson: no model call, no bounce back to the author.
// Pure: the decision takes the text and a resolver; the git resolver below knows nothing of the gateway (hub/done-live-wire.ts binds it).
import { spawnSync } from "node:child_process";

export type Live = "live" | "not-live" | "unknown";
export type Resolver = (hash: string) => Live;
export type Decision = { append: boolean; notLive: string[]; error?: string };

// Invisible tail of the appended line: the one machine-detectable sign that a text already carries it (an edit or update_key post sends the text again).
export const MARK = "\u2063";
const MAX_HASHES = 5;
// A hex token of 7-40 chars with a digit (a word such as "effaced" is hex but no commit id), not part of a path, URL or longer word.
const HASH = /(?<![\w/.-])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w/.-])/g;
const DONE = /^\s*\[(?:done|완료)\]/i;

// Lines outside code fences: a hash in a code block is an example.
const prose = (text: string): string => {
	let fence = false;
	return text.split("\n").filter(line => (/^\s*```/.test(line) ? ((fence = !fence), false) : !fence)).join("\n");
};

// Whether the line goes on, and the cited commits that are proven dotz commits the running gateway lacks. Any resolver error means nothing is appended.
export function doneLiveDecision(text: string, resolve: Resolver): Decision {
	const none: Decision = { append: false, notLive: [] };
	if (!DONE.test(text) || text.includes(MARK)) return none;
	const hashes = [...new Set(prose(text).match(HASH) ?? [])].slice(0, MAX_HASHES);
	const notLive: string[] = [];
	try {
		for (const h of hashes) if (resolve(h) === "not-live") notLive.push(h);
	} catch (e) {
		return { ...none, error: (e as Error).message };
	}
	return { append: notLive.length > 0, notLive };
}

// The text with the line appended when the decision says so; `line` comes from the language tables.
export function appendDoneLive(text: string, resolve: Resolver, line: string, log: (m: string) => void = () => {}): string {
	const d = doneLiveDecision(text, resolve);
	if (d.error) log(`done-live: left the text as it was (${d.error})`);
	return d.append ? `${text.replace(/\s+$/, "")}\n-# ${line}${MARK}` : text;
}

// ---- the real resolver: dotz commit = an object of a checkout whose origin is the installed copy's origin; live = ancestor of the boot commit ----
type Git = (dir: string, args: string[]) => { code: number | null; out: string };
const gitRun: Git = (dir, args) => {
	const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
	return { code: r.status, out: r.stdout?.trim() ?? "" };
};
// host/owner/repo of an origin URL in any of its spellings (https, ssh://, git@host:o/r); a local path stays as written.
export const repoKey = (url: string): string => {
	const m = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](?:\d+\/)?(.+?)(?:\.git)?\/?$/.exec(url.trim());
	return (m ? `${m[1]}/${m[2]}` : url.trim()).toLowerCase();
};

export type ResolverOptions = {
	boot: () => string | undefined; // the commit the running gateway started from
	installDir: string; // the installed copy
	devDirs: () => string[]; // checkouts the gateway knows (lane folders): candidates, trusted only when their origin matches
	git?: Git;
	now?: () => number;
	unknownTtlMs?: number;
};
const MAX_DIRS = 6;
const CACHE_MAX = 500;

export function gitResolver(o: ResolverOptions): Resolver {
	const raw = o.git ?? gitRun;
	// A call that timed out or did not start (no exit status) aborts the whole text: the worst case is one timeout, and nothing is cached from it.
	const git: Git = (dir, args) => {
		const r = raw(dir, args);
		if (r.code === null) throw new Error(`git ${args[0]} timed out or did not start`);
		return r;
	};
	const now = o.now ?? Date.now;
	const ttl = o.unknownTtlMs ?? 5 * 60_000;
	// Definitive answers hold while the boot commit is the same (it is in the key); an unknown one is asked again after a while (a fetch can make it known).
	const cache = new Map<string, { live: Live; at: number }>();
	const origins = new Map<string, string>();
	let installOrigin: { boot: string; key: string } | undefined;
	const originOf = (dir: string): string => {
		const known = origins.get(dir);
		if (known !== undefined) return known;
		if (origins.size >= CACHE_MAX) origins.delete(origins.keys().next().value!);
		const key = repoKey(git(dir, ["remote", "get-url", "origin"]).out);
		origins.set(dir, key);
		return key;
	};
	const rev = (dir: string, ref: string): string | undefined => {
		const r = git(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
		return r.code === 0 && r.out ? r.out : undefined;
	};
	const probe = (hash: string, boot: string): Live => {
		if (installOrigin?.boot !== boot) installOrigin = { boot, key: originOf(o.installDir) };
		const { key } = installOrigin;
		if (!key) return "unknown"; // not a git install, or no origin: no way to tell what a dotz commit is
		const same = [o.installDir, ...o.devDirs().filter(d => d !== o.installDir)].filter(d => d === o.installDir || originOf(d) === key);
		for (const dir of same.slice(0, MAX_DIRS)) {
			const full = rev(dir, hash);
			if (!full || !rev(dir, boot)) continue; // a checkout without the boot commit cannot judge ancestry
			const r = git(dir, ["merge-base", "--is-ancestor", full, boot]);
			if (r.code === 0) return "live";
			if (r.code === 1) return "not-live";
		}
		return "unknown";
	};
	return hash => {
		const boot = o.boot();
		if (!boot) return "unknown";
		const k = `${boot}\n${hash}`;
		const hit = cache.get(k);
		if (hit && (hit.live !== "unknown" || now() - hit.at < ttl)) return hit.live;
		const live = probe(hash, boot);
		if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
		cache.set(k, { live, at: now() });
		return live;
	};
}
