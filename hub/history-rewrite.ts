// Recovery from a rewritten public history (docs/releases.md). A force push leaves every install on commits that no longer exist upstream,
// and the updater alone cannot tell that from a plain divergence, so the rewrite publishes a durable signal: a tag history-rewrite-<n>
// pointing at a blob with one key per old commit (commitKey, one per line), pushed atomically with the new history. Keys, not shas: the
// marker must not hand out a public list of URLs to the very commits the rewrite removed. Only what the new history lacks counts: a listed
// commit the new tip still holds (an untouched prefix) is not old. Of the rest, a listed commit is old public history and anything else in
// the same HEAD is the install's own work. selfupdate.ts moves such an install to the new history (the local commits saved first); the
// guard below, run by .githooks/pre-push and pre-rebase, keeps old commits from going back up.
import { FORMAT, parseCommits } from "./selfupdate-local.ts";
import { gitCapture, keyMissing, signingKeyPath, signTag } from "./release-sign.ts";
import type { Commit, Exec } from "./selfupdate.ts";

const MARKER = /\srefs\/tags\/(history-rewrite-\d+)$/;
export const MARKER_GLOB = "history-rewrite-*";
const LOCAL_REF = "refs/dotz/rewrite/";
const TIP_REF = `${LOCAL_REF}new-tip`;

export const commitKey = (sha: string) => new Bun.CryptoHasher("sha256").update(sha).digest("hex").slice(0, 16);
export const rewriteTags = (lsRemote: string): string[] => lsRemote.split("\n").flatMap(l => MARKER.exec(l.trim())?.[1] ?? []);

// The marker blobs are fetched once, into refs the updater owns; a later check reads them locally.
export async function markerKeys(exec: Exec, dir: string, remote: string, tags: string[]): Promise<Set<string>> {
	const keys = new Set<string>();
	for (const tag of tags) {
		const ref = `${LOCAL_REF}${tag}`;
		if ((await exec(["git", "cat-file", "-e", ref], dir, 15_000)).code !== 0) {
			const f = await exec(["git", "fetch", "--quiet", "--no-tags", remote, `+refs/tags/${tag}:${ref}`], dir, 60_000);
			if (f.code !== 0) throw new Error(`marker ${tag}: ${f.out}`);
		}
		for (const k of (await exec(["git", "cat-file", "blob", ref], dir, 15_000)).out.split("\n")) if (k) keys.add(k.trim());
	}
	return keys;
}

// `local` is what `rev` holds besides old public history and the new tip, oldest first. Undefined: `rev` is not on old history.
async function oldHistory(exec: Exec, dir: string, remote: string, tip: string, rev: string, keys: Set<string>): Promise<{ local: Commit[] } | undefined> {
	const f = await exec(["git", "fetch", "--quiet", "--no-tags", remote, `+${tip}:${TIP_REF}`], dir, 60_000);
	if (f.code !== 0) throw new Error(`new tip ${tip}: ${f.out}`);
	const commits = parseCommits((await exec(["git", "log", "--reverse", "--topo-order", FORMAT, rev, `^${TIP_REF}`], dir, 30_000)).out);
	const local = commits.filter(c => !keys.has(commitKey(c.sha)));
	return local.length === commits.length ? undefined : { local };
}

export async function rewriteState(exec: Exec, dir: string, remote: string, lsRemote: string, tip: string) {
	const keys = await markerKeys(exec, dir, remote, rewriteTags(lsRemote));
	return keys.size ? oldHistory(exec, dir, remote, tip, "HEAD", keys) : undefined;
}

export const rewriteNote = (branch: string | undefined): string => ` 저장소 기록이 다시 쓰여서 새 기록으로 옮겼어요.${branch ? ` 로컬 커밋은 ${branch}에도 보관했어요.` : ""}`;

export const run: Exec = async (cmd, cwd, timeoutMs) => {
	const p = Bun.spawn(cmd, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out: `${out}${err}`.trim() };
};

// An unreachable remote passes: a push to it fails on its own, and a rebase must keep working offline.
export async function guard(exec: Exec, dir: string, remote: string, revs: string[]): Promise<string | undefined> {
	const ls = await exec(["git", "ls-remote", "--tags", remote, MARKER_GLOB], dir, 15_000);
	const tags = ls.code === 0 ? rewriteTags(ls.out) : [];
	if (!tags.length) return undefined;
	const keys = await markerKeys(exec, dir, remote, tags);
	for (const rev of revs) if (await oldHistory(exec, dir, remote, "refs/heads/main", rev, keys)) return `${rev} is on the old history (${tags.join(", ")}): refused so it cannot go back up. Move to the new origin/main first; see docs/releases.md.`;
	return undefined;
}

// The marker: a blob with one key per old commit and a signed annotated tag history-rewrite-<n> on it (`git cat-file blob <tag>` peels the tag).
export async function markRewrite(dir: string, n: string, shas: readonly string[], keyPath: string): Promise<{ code: number; out: string }> {
	if (keyMissing(keyPath)) return { code: 1, out: `서명 키가 없어요 (${keyPath}). 키가 있는 기기에서 실행해 주세요.` };
	const blob = await gitCapture(["hash-object", "-w", "--stdin"], dir, `${shas.map(commitKey).join("\n")}\n`);
	if (blob.code !== 0) return blob;
	return signTag(dir, `history-rewrite-${n}`, keyPath, blob.out);
}

if (import.meta.main) {
	const [cmd, remote, ...revs] = process.argv.slice(2);
	if (cmd === "--guard" && remote && revs.length) {
		const refused = await guard(run, process.cwd(), remote, revs);
		if (refused) {
			console.error(`history-rewrite: ${refused}`);
			process.exit(1);
		}
	} else if (cmd === "--keys") console.log((await Bun.stdin.text()).split("\n").filter(Boolean).map(commitKey).join("\n"));
	else if (cmd === "--mark" && remote && /^\d+$/.test(remote)) {
		const made = await markRewrite(process.cwd(), remote, (await Bun.stdin.text()).split("\n").filter(Boolean), signingKeyPath(process.env));
		if (made.code !== 0) {
			console.error(`history-rewrite: ${made.out}`);
			process.exit(1);
		}
		console.log(`history-rewrite-${remote}`);
	} else {
		console.error("usage: bun hub/history-rewrite.ts --guard <remote> <rev>... | --keys < shas | --mark <n> < shas");
		process.exit(2);
	}
}
