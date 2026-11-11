// The one rule for who a commit may name when it is about to reach public ddotz/dotz, shared by the pre-push hook (hub/push-identity.ts), the shell deny
// that checks a `git push` and a `gh pr create` before they run (hub/upstream-commits.ts) and the fix command: author and committer mail are a GitHub noreply
// address and the name is the login inside it. The release identity (hub/release-sign.ts) and GitHub's own web committer satisfy it as they are.
// Everything here reads local refs only: no network, and a refusal built from it names commits by short sha and labels, never a name or an address.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_REPO } from "./public-scrub.ts";

export const FIX_COMMAND = "bun hub/push-identity.ts fix";
export const PUBLIC_URL = `https://github.com/${PUBLIC_REPO}.git`;
const PUBLIC_REMOTE = new RegExp(`(?:^|[:/])${PUBLIC_REPO}(?:\\.git)?/*$`, "i");
const NOREPLY = /^(?:\d+\+)?([\w.[\]-]+)@users\.noreply\.github\.com$/i;
const WEB_COMMITTER = /^noreply@github\.com$/i;
const SHA = /^[0-9a-f]{40,64}$/;
const MAX_NAMED = 8;

export const isPublicRemote = (url: string): boolean => PUBLIC_REMOTE.test(url.trim());
export const isGithubRemote = (url: string): boolean => /github\.com[:/]/i.test(url) || isPublicRemote(url);
export const noreplyMail = (login: string, id: string | number): string => `${id}+${login}@users.noreply.github.com`;

export const LOG_FORMAT = "%H%x09%an%x09%ae%x09%cn%x09%ce%x09%s";
export type Row = { sha: string; authorName: string; authorMail: string; committerName: string; committerMail: string; subject: string };
export type Bad = { sha: string; labels: string[] };

// Only commit lines count: the hook's runner mixes stderr into the output.
export function parseRows(out: string): Row[] {
	const rows: Row[] = [];
	for (const line of out.split("\n")) {
		const [sha = "", authorName = "", authorMail = "", committerName = "", committerMail = "", ...subject] = line.split("\t");
		if (SHA.test(sha)) rows.push({ sha, authorName, authorMail, committerName, committerMail, subject: subject.join("\t") });
	}
	return rows;
}

function side(role: string, name: string, mail: string): string[] {
	if (WEB_COMMITTER.test(mail)) return [];
	const login = NOREPLY.exec(mail)?.[1];
	if (!login) return [`${role} mail`];
	return login.toLowerCase() === name.trim().toLowerCase() ? [] : [`${role} name`];
}

export const identityOk = (name: string, mail: string): boolean => side("author", name, mail).length === 0;

export const identityLabels = (r: Row): string[] => [...side("author", r.authorName, r.authorMail), ...side("committer", r.committerName, r.committerMail)];

export const badRows = (rows: readonly Row[]): Bad[] => rows.map(r => ({ sha: r.sha, labels: identityLabels(r) })).filter(b => b.labels.length > 0);

export const named = (bad: readonly Bad[]): string => bad.slice(0, MAX_NAMED).map(b => `${b.sha.slice(0, 8)} (${b.labels.join(", ")})`).join("; ") + (bad.length > MAX_NAMED ? ` and ${bad.length - MAX_NAMED} more` : "");

export const identityRefusal = (bad: readonly Bad[]): string =>
	`refused, ${bad.length} commit(s) new to ${PUBLIC_REPO} carry a personal identity: ${named(bad)}. Run \`${FIX_COMMAND}\` in this clone: it sets the clone-local GitHub noreply identity and rewrites those commits. A ref that is behind the public main can list commits that are already public: git fetch first.`;

// git's answer, or undefined when it could not give one (a non-zero exit, no such folder, a timeout).
export function gitText(dir: string, args: readonly string[], ms = 10_000): string | undefined {
	try {
		return execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: ms, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined; // the callers refuse or skip on undefined, each in its own words
	}
}

// Every remote of the clone with the url as written in its config (git remote -v shows it after url.<base>.insteadOf).
export function remoteUrls(dir: string): [name: string, url: string][] {
	const out = gitText(dir, ["config", "--local", "--get-regexp", String.raw`^remote\..+\.(pushurl|url)$`]) ?? "";
	return out.split("\n").flatMap(line => {
		const m = /^remote\.(.+)\.(?:pushurl|url) (.+)$/.exec(line.trim());
		return m ? [[m[1] as string, m[2] as string] as [string, string]] : [];
	});
}

// A dotz clone has the public repo as a remote, or its top level is dotz's own source whatever its remotes are called (a fork under another repo name): a package.json named dotz
// next to hub/public-scrub.ts. Neither depends on history, so a rewrite of the public history cannot change the answer, and no history is walked.
function isDotzTree(dir: string): boolean {
	const top = (gitText(dir, ["rev-parse", "--show-toplevel"]) ?? "").trim();
	if (!top || !existsSync(join(top, "hub", "public-scrub.ts"))) return false;
	try {
		return (JSON.parse(readFileSync(join(top, "package.json"), "utf8")) as { name?: unknown }).name === "dotz";
	} catch {
		return false; // no package.json or an unreadable one: not dotz
	}
}

export const isDotzClone = (dir: string): boolean => remoteUrls(dir).some(([, url]) => isPublicRemote(url)) || isDotzTree(dir);

export const publicRemoteNames = (dir: string): string[] => [...new Set(remoteUrls(dir).filter(([, url]) => isPublicRemote(url)).map(([name]) => name))];

// What public main holds as far as this clone knows: the main tracking ref of each remote that is ddotz/dotz. A ref behind the real main only makes
// commits that are already public look new, which refuses more, never less.
export const publicRefs = (dir: string): string[] => publicRemoteNames(dir).map(n => `refs/remotes/${n}/main`).filter(ref => gitText(dir, ["rev-parse", "--verify", "-q", ref]) !== undefined);

export function newCommits(dir: string, revs: readonly string[], refs: readonly string[]): Row[] | undefined {
	const out = gitText(dir, ["log", "--no-show-signature", `--format=${LOG_FORMAT}`, ...revs, "--not", ...refs], 30_000);
	return out === undefined ? undefined : parseRows(out);
}
