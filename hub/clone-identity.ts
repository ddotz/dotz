// Keeps a personal name and address out of the commits an agent makes in a dotz clone, at the moment they are made. Before a shell command that creates commits
// runs (commit, merge, rebase, cherry-pick, am, revert, pull), the shell deny's last step calls prepareCommitIdentity: when the clone's effective git identity is not
// a GitHub noreply address with its login as the name, the clone-LOCAL identity is set from the signed-in gh account (login and id are read once and cached under the
// data dir, they are not a secret), so the first commit is already clean and there is nothing to rewrite. A linked worktree writes the shared config of its clone, so
// one write covers every worktree. Never the global config, never a repo that is not a dotz clone, and never a fallback to the machine's identity: with no login
// to be found the command is refused and nothing is written. A `git commit` also gets the value check of hub/upstream-commits.ts on its message (the -m values,
// the content of a -F file or heredoc: what the commit records, never the paths and other words of the command) and staged added lines. The publish-time checks (hub/push-identity.ts, hub/upstream-commits.ts) stay as the backstop for commits made outside an agent or before this existed.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";
import { gitText, identityOk, isDotzClone, noreplyMail } from "./commit-identity.ts";
import { installTerms, postDir, scrub, shellPath } from "./public-scrub.ts";
import { addedByFile, addedLabels } from "./upstream-commits.ts";

export type Login = { login: string; id: string };

const LOGIN = /^[\w.[\]-]+$/;
const ID = /^\d+$/;
const CACHE = "github-login.json";
const GH_PATHS = ["gh", "/opt/homebrew/bin/gh"];
const MAYBE_CREATES = /\bgit\b[^\n]*\b(?:commit|merge|rebase|cherry-pick|am|revert|pull)(?![\w-])/;
const CREATES = /(?:^|[;&|(\n])\s*(?:\w+=\S+\s+)*git((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+(commit|merge|rebase|cherry-pick|am|revert|pull)(?![\w-])/g; // the subcommand ends where no word character or - follows: merge-base and commit-graph are not commits
const MESSAGE_FILE_MAX = 64 * 1024; // a message file above this is refused unread, never read whole (scrub is quadratic on one huge unbroken word: about 1 s at this size, 15 s at 256 KB)
const TOO_BIG = Symbol("message file too big");
// The pieces of a command's text: a double-quoted `$(cat <<EOF ... EOF)` (quotes inside its body stay inside), a heredoc, a quoted string, a shell separator, white space, a bare word.
const PIECE = new RegExp([
	'(?<sub>"\\$\\(\\s*cat\\s*<<-?\\s*["\']?(?<t1>\\w+)["\']?[ \\t]*\\n[\\s\\S]*?\\n[ \\t]*\\k<t1>[ \\t]*\\n?\\s*\\)")',
	'(?<here><<-?\\s*["\']?(?<t2>\\w+)["\']?[ \\t]*\\n[\\s\\S]*?\\n[ \\t]*\\k<t2>\\b)',
	'(?<dq>"(?:\\\\[\\s\\S]|[^"\\\\])*")',
	"(?<sq>'[^']*')",
	"(?<sep>;|&&|\\|\\||\\||\\n)",
	"(?<ws>\\s+)",
	"(?<bare>(?:[^\\s\"';&|]|&(?!&))+)",
].join("|"), "g");
const settled = new Set<string>(); // folders known to carry the noreply identity in this process

const valid = (who: Partial<Login> | undefined): who is Login => Boolean(who?.login && who.id && LOGIN.test(who.login) && ID.test(who.id));

export function ghLookup(): Login | undefined {
	for (const gh of GH_PATHS) {
		try {
			const [login = "", id = ""] = execFileSync(gh, ["api", "user", "--jq", '.login + " " + (.id | tostring)'], { encoding: "utf8", timeout: 6000, stdio: ["ignore", "pipe", "ignore"] }).trim().split(" ");
			if (valid({ login, id })) return { login, id };
		} catch {
			continue; // gh missing or not signed in at this path: try the next, then the caller refuses
		}
	}
	return undefined;
}

// The signed-in account: from the cache under the data dir, else asked once and cached. Undefined when neither knows it.
export function knownLogin(dataDir: string, lookup: () => Login | undefined = ghLookup): Login | undefined {
	const file = join(dataDir, CACHE);
	try {
		const cached = JSON.parse(readFileSync(file, "utf8")) as Partial<Login>;
		if (valid(cached)) return { login: cached.login, id: cached.id };
	} catch {
		// no cache yet, or an unreadable one: ask the lookup below
	}
	const who = lookup();
	if (!valid(who)) return undefined;
	try {
		mkdirSync(dataDir, { recursive: true });
		writeAtomic(file, `${JSON.stringify({ login: who.login, id: who.id })}\n`);
	} catch {
		// only a cache: the next command asks again
	}
	return who;
}

// The one place the clone-local identity is written; the fix command (hub/push-identity.ts) uses it too. Throws when git refuses or the account's login or id look wrong.
export function setCloneIdentity(dir: string, who: Login): void {
	if (!valid(who)) throw new Error("the GitHub account answered with an unexpected login or id");
	if (gitText(dir, ["config", "--local", "user.name", who.login]) === undefined || gitText(dir, ["config", "--local", "user.email", noreplyMail(who.login, who.id)]) === undefined) throw new Error("git could not write the identity in this folder");
}

function settle(dir: string, dataDir: string, lookup: () => Login | undefined): string | undefined {
	if (settled.has(dir) || !isDotzClone(dir)) return undefined;
	if (identityOk((gitText(dir, ["config", "user.name"]) ?? "").trim(), (gitText(dir, ["config", "user.email"]) ?? "").trim())) {
		settled.add(dir);
		return undefined;
	}
	const who = knownLogin(dataDir, lookup);
	if (!who) return "this dotz clone has no GitHub noreply identity and dotz cannot read the signed-in GitHub account, so a commit here would carry the machine's personal identity. Sign in with `gh auth login`, then run the command again";
	try {
		setCloneIdentity(dir, who);
	} catch (e) {
		return `could not set this clone's GitHub noreply identity (${(e as Error).message}); the command is not run`;
	}
	settled.add(dir);
	return undefined;
}

// The text of one command: up to the first shell separator that is outside a quoted string and a heredoc body.
function ownText(rest: string): string {
	for (const m of rest.matchAll(PIECE)) if (m.groups?.sep !== undefined) return rest.slice(0, m.index);
	return rest;
}

type CommitArgs = { messages: string[]; files: string[]; stdin: boolean; heredocs: string[]; all: boolean };

// What the options of a `git commit` (the text after the word commit) say: the -m / --message values, the -F / --file paths, whether the message comes on stdin
// (`-F -`) with the heredoc bodies that would feed it, and -a. A short flag cluster is read as git does: the first of m F C c t takes the rest of the word or the next word.
function commitArgs(rest: string): CommitArgs {
	const out: CommitArgs = { messages: [], files: [], stdin: false, heredocs: [], all: false };
	const words: string[] = [];
	let word: string | undefined;
	for (const m of rest.matchAll(PIECE)) {
		const g = m.groups ?? {};
		if (g.ws !== undefined || g.sep !== undefined) {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else if (g.here !== undefined) out.heredocs.push(g.here);
		else {
			const quoted = g.sub ?? g.dq ?? g.sq;
			word = (word ?? "") + (quoted !== undefined ? quoted.slice(1, -1) : (g.bare ?? ""));
		}
	}
	if (word !== undefined) words.push(word);
	const add = (message: boolean, value: string | undefined) => {
		if (value === undefined) return;
		if (message) out.messages.push(value);
		else if (value === "-" || value === "/dev/stdin") out.stdin = true;
		else out.files.push(value);
	};
	for (let i = 0; i < words.length; i++) {
		const w = words[i] as string;
		if (w === "--") break;
		if (w === "--all") out.all = true;
		else if (w.startsWith("--")) {
			const eq = w.indexOf("=");
			const name = eq < 0 ? w : w.slice(0, eq);
			if (name === "--message" || name === "--file") add(name === "--message", eq < 0 ? words[++i] : w.slice(eq + 1));
		} else if (/^-[A-Za-z]/.test(w)) {
			for (let k = 1; k < w.length; k++) {
				const c = w[k] as string;
				if (c === "a") out.all = true;
				else if ("mFCct".includes(c)) {
					const value = w.slice(k + 1) || words[++i];
					if (c === "m" || c === "F") add(c === "m", value);
					break;
				} else if (c === "u" || c === "S") break; // these take only an attached value
			}
		}
	}
	return out;
}

// The content of a message file: "" when it cannot be read (git fails on it as well and records nothing), TOO_BIG above the bound. One stat, one read.
function messageFile(raw: string, dir: string): string | typeof TOO_BIG {
	try {
		const file = shellPath(raw, dir);
		const stat = statSync(file);
		if (!stat.isFile()) return "";
		return stat.size > MESSAGE_FILE_MAX ? TOO_BIG : readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

// What a `git commit` records, checked for the install's own values by label: the message (the -m values, the content of a -F file, or the heredoc that feeds `-F -`)
// and the lines it adds. The paths and other words of the command are not recorded and are not checked. Names no value. `-F -` fed by a pipe cannot be seen from the command
// alone and passes here; an unreadable file passes (git fails on it); a message file above MESSAGE_FILE_MAX is refused; a reused message (-C, --amend) is not checked.
function commitContentRefusal(dir: string, dataDir: string, rest: string): string | undefined {
	const terms = installTerms(dataDir);
	const args = commitArgs(rest);
	const parts = [...args.messages, ...(args.stdin ? args.heredocs : [])];
	for (const raw of args.files) {
		const text = messageFile(raw, dir);
		if (text === TOO_BIG) return "the message file is larger than 64 KB, which dotz does not check. Use a shorter message file, then commit again";
		parts.push(text);
	}
	const labels = scrub(parts.join("\n"), terms).hits.map(h => `message: ${h}`);
	const diffArgs = ["diff", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
	const diff = (args.all ? gitText(dir, [...diffArgs, "HEAD"], 30_000) : undefined) ?? gitText(dir, [...diffArgs, "--cached"], 30_000) ?? "";
	const { labels: lineLabels, files } = addedLabels(addedByFile(diff), terms);
	labels.push(...lineLabels);
	return labels.length ? `this commit would hold personal or sensitive content (${labels.join(", ")}${files.length ? `; in ${files.slice(0, 6).join(", ")}` : ""}). Leave it out of the message and the lines, then commit again` : undefined;
}

// Run once all denies passed, right before the command: sets the identity (a side effect, so it is not part of any deny) and refuses a commit that would hold a value.
export function prepareCommitIdentity(command: string, dataDir: string, cwd: string, lookup: () => Login | undefined = ghLookup): string | undefined {
	if (!MAYBE_CREATES.test(command)) return undefined;
	const flat = command.replace(/\\\r?\n\s*/g, " ");
	for (const m of flat.matchAll(CREATES)) {
		const C = /-C\s+(\S+)/.exec(m[1] ?? "");
		const dir = C ? shellPath(C[1] as string, postDir(flat, m.index, cwd)) : postDir(flat, m.index, cwd);
		const refused = settle(dir, dataDir, lookup);
		if (refused) return `refused: ${refused}.`;
		if (m[2] === "commit" && isDotzClone(dir)) {
			const content = commitContentRefusal(dir, dataDir, ownText(flat.slice(m.index + m[0].length)));
			if (content) return `refused: ${content}.`;
		}
	}
	return undefined;
}
