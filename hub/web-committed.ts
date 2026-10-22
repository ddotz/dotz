// The web build the hub serves and announces is the committed one, not whatever a worker has half-edited in this checkout.
// A snapshot of web/ is read from the HEAD tree (git cat-file, once per new tree) and kept in memory; a request only compares a
// timestamp. A new tree is published after it stayed HEAD for DOTZ_WEB_DEBOUNCE_MS (default 60 s), so a run of commits is one
// version. Not a git repo, no git, or web/ not committed: undefined, and webapp.ts reads the disk as before.
// Dev escape: DOTZ_WEB_LIVE=1 serves the working tree (hub/runtime/test-setup.ts sets it so tests see the files they edit).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type WebSnapshot = { tree: string; files: Map<string, string> };

const WANTED = /^(js\/[^/]+\.js|css\/[^/]+\.css|index\.html|sw\.js|manifest\.webmanifest)$/;
const CHECK_EVERY_MS = 1000;
const RETRY_NO_GIT_MS = 30_000;
const git = (cwd: string, args: string[], input?: Buffer): Buffer => execFileSync("git", args, { cwd, input, maxBuffer: 64 << 20, stdio: ["pipe", "pipe", "ignore"] });
const mtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };

type State = { gitDir: string; headKey: string; published: WebSnapshot; pending?: { snap: WebSnapshot; since: number }; checkedAt: number };
const states = new Map<string, State | { failedAt: number }>();

// HEAD, the branch ref it names and packed-refs: when none of their mtimes moved, no commit happened and git is not asked.
function headKey(gitDir: string): string {
	let ref = "";
	try { ref = readFileSync(join(gitDir, "HEAD"), "utf8").trim(); } catch { /* detached or unreadable: HEAD mtime alone */ }
	const refFile = ref.startsWith("ref: ") ? join(gitDir, ref.slice(5)) : "";
	return `${mtime(join(gitDir, "HEAD"))}|${refFile ? mtime(refFile) : 0}|${mtime(join(gitDir, "packed-refs"))}`;
}

// One git call for the tree list, one batched cat-file for the wanted blobs.
function snapshot(repo: string): WebSnapshot | undefined {
	const tree = git(repo, ["rev-parse", "--verify", "-q", "HEAD:web"]).toString().trim();
	const wanted = git(repo, ["ls-tree", "-r", "-z", tree]).toString().split("\0").filter(Boolean).map(l => {
		const tab = l.indexOf("\t");
		return { hash: l.slice(0, tab).split(" ")[2]!, path: l.slice(tab + 1) };
	}).filter(e => WANTED.test(e.path));
	if (!wanted.some(e => e.path.startsWith("js/"))) return undefined;
	const out = git(repo, ["cat-file", "--batch"], Buffer.from(wanted.map(e => `${e.hash}\n`).join("")));
	const files = new Map<string, string>();
	let at = 0;
	for (const e of wanted) {
		const nl = out.indexOf(10, at);
		const size = Number(out.subarray(at, nl).toString().split(" ")[2]);
		if (!Number.isFinite(size)) return undefined;
		files.set(e.path, out.subarray(nl + 1, nl + 1 + size).toString("utf8"));
		at = nl + 1 + size + 1;
	}
	return { tree, files };
}

const debounceMs = (): number => { const n = Number(process.env.DOTZ_WEB_DEBOUNCE_MS); return process.env.DOTZ_WEB_DEBOUNCE_MS && Number.isFinite(n) && n >= 0 ? n : 60_000; };

/** The published committed snapshot of `<repo>/web`, or undefined to read the disk. */
export function publishedWeb(repo: string): WebSnapshot | undefined {
	if (process.env.DOTZ_WEB_LIVE === "1") return undefined;
	const now = Date.now();
	let st = states.get(repo);
	if (!st || ("failedAt" in st && now - st.failedAt >= RETRY_NO_GIT_MS)) {
		try {
			const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]).toString().trim();
			const snap = snapshot(repo);
			st = snap ? { gitDir, headKey: headKey(gitDir), published: snap, checkedAt: now } : { failedAt: now };
		} catch { st = { failedAt: now }; }
		states.set(repo, st);
	}
	if ("failedAt" in st) return undefined;
	if (now - st.checkedAt >= CHECK_EVERY_MS) {
		st.checkedAt = now;
		const key = headKey(st.gitDir);
		if (key !== st.headKey) {
			st.headKey = key;
			try {
				const snap = snapshot(repo);
				if (snap && snap.tree !== st.published.tree) { if (st.pending?.snap.tree !== snap.tree) st.pending = { snap, since: now }; }
				else st.pending = undefined;
			} catch { /* keep serving the published one */ }
		}
		if (st.pending && now - st.pending.since >= debounceMs()) { st.published = st.pending.snap; st.pending = undefined; }
	}
	return st.published;
}

/** Forget cached state (tests). */
export const resetPublishedWeb = (): void => states.clear();
