// What leaves an install for public GitHub (MODE.md, Confirmation gates): one pattern table and the install's own values, shared by the
// shell deny (publicPostDeny, run before an agent's gh call) and the release note (hub/release-note.ts). No personal term lives here: the
// values come from this install's config and secrets at check time. Results carry labels only, so a refusal never repeats a value.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";

export type Term = { value: string; label: string };

const MASK = "[비공개]";
export const PUBLIC_REPO = "ddotz/dotz";
const PUBLIC_URL = `https://github.com/${PUBLIC_REPO}.git`;
const PUBLIC_EMAIL = /@(?:github\.com|users\.noreply\.github\.com|(?:[\w-]+\.)*example\.\w+)$/i;
const PLACEHOLDER_USER = "you|user|username|name|me|example|runner|Shared";
const PATTERNS: [label: string, re: RegExp, mask: string][] = [
	["token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|ya29\.[\w.-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})|\bBearer\s+[\w.~+/-]{16,}/g, "[토큰]"],
	["email", /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "[이메일]"],
	["phone", /(?<![\d.-])(?:\+82[- ]?1|01)[016789][- .]?\d{3,4}[- .]?\d{4}(?![\d-])/g, "[전화번호]"],
	["tailnet host", /\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/g, "[호스트]"],
	["private address", /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g, "[내부 주소]"],
	["local path", new RegExp(`(?:/Users/|/home/|[A-Za-z]:\\\\Users\\\\)(?!(?:${PLACEHOLDER_USER})(?:[/\\\\\\s"'\\x60<>)]|$))[^/\\\\\\s"'\\x60<>)]+`, "g"), "~"],
	["messenger id", /(?<![\w.-])\d{17,20}(?![\w.-])/g, "[id]"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// An ASCII edge needs a word boundary (box1 is not box12); a Korean term takes particles, so its edge stays open.
const termRe = (value: string) => new RegExp(`${/^\w/.test(value) ? "(?<!\\w)" : ""}${escapeRe(value)}${/\w$/.test(value) ? "(?!\\w)" : ""}`, "gi");

export function scrub(input: string, terms: readonly Term[] = []): { text: string; hits: string[] } {
	const hits = new Set<string>();
	let text = input;
	for (const term of [...terms].sort((a, b) => b.value.length - a.value.length)) {
		text = text.replace(termRe(term.value), () => {
			hits.add(term.label);
			return MASK;
		});
	}
	for (const [label, re, mask] of PATTERNS) {
		text = text.replace(re, found => {
			if (label === "email" && PUBLIC_EMAIL.test(found)) return found;
			hits.add(label);
			return mask;
		});
	}
	return { text, hits: [...hits] };
}

const MIN_SECRET = 8;
const MIN_CONFIG = 4;
const MAX_SECRET_BYTES = 64 * 1024;
const IDENTIFYING_KEY = /owner|guild|app_id|user_id|chat_id|(?:^|[._])id$|email|phone|host|domain|login|url|address|token|secret/i;
const NUMERIC_ID = /^\d{9,}$/; // a channel or chat id, under whatever key it is filed
const GENERIC_MACHINE = /^(?:admin|root|user|ubuntu|runner|localhost|127\.0\.0\.1|0\.0\.0\.0|macbook|macbook-pro|macbook-air|mac-mini|imac)$/i;

function jsonLeaves(value: unknown, path: string, out: { path: string; value: string }[]): void {
	if (typeof value === "string" || typeof value === "number") out.push({ path, value: String(value).trim() });
	else if (Array.isArray(value)) for (const item of value) jsonLeaves(item, path, out);
	else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) jsonLeaves(item, path ? `${path}.${key}` : key, out);
}

function secretValues(text: string): string[] {
	try {
		const leaves: { path: string; value: string }[] = [];
		jsonLeaves(JSON.parse(text), "", leaves);
		return leaves.map(l => l.value);
	} catch {
		return text.split("\n").map(line => line.trim().replace(/^[A-Z][A-Z0-9_]*=/, "")); // not JSON: a plain token or KEY=value lines
	}
}

function fileText(file: string): string {
	try {
		return statSync(file).isFile() && statSync(file).size <= MAX_SECRET_BYTES ? readFileSync(file, "utf8") : "";
	} catch {
		return ""; // unreadable or gone: that file has nothing to compare against
	}
}

// This install's identifying values: config fields that name a person, host or account, every secret, the owner's privacy list, and this machine.
export function installTerms(dataDir: string): Term[] {
	const terms: Term[] = [];
	const secrets = join(dataDir, "secrets");
	const config = fileText(join(dataDir, "config.json"));
	if (config) {
		const leaves: { path: string; value: string }[] = [];
		try {
			jsonLeaves(JSON.parse(config), "", leaves);
		} catch {
			leaves.length = 0; // a broken config is reported by the gateway; secrets and the list below still apply
		}
		for (const { path, value } of leaves) if (value.length >= MIN_CONFIG && (IDENTIFYING_KEY.test(path) || NUMERIC_ID.test(value)) && !/_file$/.test(path)) terms.push({ value, label: `config ${path.split(".")[0]}` });
		for (const value of [hostname().replace(/\.local$/, ""), userInfo().username]) if (value.length >= MIN_CONFIG && !GENERIC_MACHINE.test(value)) terms.push({ value, label: "machine or user name" });
	}
	if (existsSync(secrets)) {
		for (const name of readdirSync(secrets, { recursive: true }).map(String)) {
			if (name === "privacy-terms.txt") continue;
			for (const value of secretValues(fileText(join(secrets, name)))) if (value.length >= MIN_SECRET) terms.push({ value, label: "secret" });
		}
	}
	for (const value of fileText(join(secrets, "privacy-terms.txt")).split("\n").map(l => l.trim())) if (value) terms.push({ value, label: "privacy list" });
	return terms.filter(t => !PUBLIC_URL.includes(t.value.toLowerCase()) && !GENERIC_MACHINE.test(t.value));
}

// The release note's terms: this machine's when it has a data folder, plus PRIVACY_TERMS (one per line), the repo secret Actions passes in.
export function releaseTerms(env: Record<string, string | undefined> = process.env): Term[] {
	const listed = (env.PRIVACY_TERMS ?? "").split("\n").map(l => l.trim()).filter(Boolean);
	return [...installTerms(env.DOTZ_DIR ?? join(homedir(), ".dotz")), ...listed.map(value => ({ value, label: "privacy list" }))];
}

const FLAGS = String.raw`(?:-\S+(?:[ =]\S+)?\s+)*`;
// A command's start: a line or a shell separator, or the opening quote of a shell string in eval code. A grep or a commit message that only mentions gh is no post.
const START = String.raw`(?:^|[;&|(]|[:(=,$\[]\s*["'\x60]|\s-c\s+["'\x60])\s*(?:sudo\s+)?(?:(?:timeout\s+\S+|env|command|then|do|else|xargs(?:\s+-\S+)*|nohup|time|exec)\s+)*(?:[A-Za-z_]+=\S*\s+)*(?:[\w.~/-]*/)?`;
const MAYBE_POST = /\bgh\s+(?:issue|pr|release|api)\b|\bgh\s+-|api\.github\.com/;
const GH_POST = new RegExp(`${START}gh\\s+${FLAGS}(?:(?:issue|pr)\\s+${FLAGS}(?:create|comment|edit|review|close|merge)|release\\s+${FLAGS}(?:create|edit))\\b`, "m");
const GH_API = new RegExp(`${START}gh\\s+api\\b(?:[^\\n]*\\b(?:issues|pulls|releases)\\b|[^\\n]*\\bgraphql\\b[\\s\\S]*?\\bmutation\\b)`, "m");
const GH_API_WRITE = /\s-[fF]\s*\S|\s--(?:field|raw-field|input)\b|(?:\s-X\s*|\s--method[ =])(?:POST|PUT|PATCH)\b/i;
const CURL_POST = new RegExp(`${START}curl\\b[^\\n]*api\\.github\\.com/(?:repos/\\S*(?:issues|pulls|releases)|graphql)`, "m");
const CURL_WRITE = /\s(?:-d|--data\S*|--json|-X\s*(?:POST|PUT|PATCH))\b/;
const OTHER_REPO = /(?:^|\s)(?:-R|--repo)[ =]|\brepos\/[\w.-]+\/[\w.-]+/;
const VALUE = String.raw`("[^"]+"|'[^']+'|\x60[^\x60]+\x60|[^\s;&|)"'\x60]+)`;
const BODY_FILE = new RegExp(`(?<=\\s)(?:(?:-F|--field|-d|--data(?:-binary)?|--json)[ =]*["']?(?:[\\w.-]+=)?@|(?:--body-file|--notes-file|--input|-F)[ =]*)${VALUE}|(?:\\bcat\\s+|(?<!<)<(?!<)\\s*)${VALUE}`, "g");
const CHANGE_DIR = new RegExp(`\\b(?:cd\\s+|cwd:\\s*)${VALUE}`, "g");
const NOT_THE_POST = /\b[A-Z_]*PATH=\S+|\bcd\s+\S+|\bgit\s+-C\s+\S+|\bcwd:\s*["'\x60][^"'\x60]*["'\x60]/g;

function postStart(flat: string): number {
	const post = GH_POST.exec(flat);
	if (post) return post.index;
	const api = GH_API.exec(flat);
	if (api && GH_API_WRITE.test(flat.slice(api.index))) return api.index;
	const curl = CURL_POST.exec(flat);
	return curl && CURL_WRITE.test(flat.slice(curl.index)) ? curl.index : -1;
}

function shellPath(raw: string, dir: string): string {
	return resolve(dir, raw.replace(/^["'\x60]|["'\x60]$/g, "").replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir()));
}

// The folder the post runs in: the last cd before it, or a cwd option written after it.
function postDir(flat: string, start: number, cwd: string): string {
	const moves = [...flat.matchAll(CHANGE_DIR)];
	const move = moves.filter(m => m.index < start).at(-1) ?? moves[0];
	return move ? shellPath(move[1], cwd) : cwd;
}

function postsToDotz(post: string, dir: string): boolean {
	if (post.includes(PUBLIC_REPO)) return true;
	if (OTHER_REPO.test(post)) return false;
	try {
		return execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).includes(PUBLIC_REPO);
	} catch {
		return false; // not a checkout, or no origin: nothing says this post goes to the public repo
	}
}

// Refuses an agent's GitHub post to the public repo while its command or body file still holds personal content. The whole command counts, since a
// heredoc or a variable before the post can be the body; only the folder moves and PATH around it do not. Other calls pay one regex.
export function publicPostDeny(command: string, dataDir: string, cwd: string): string | undefined {
	if (!MAYBE_POST.test(command)) return undefined;
	const flat = command.replace(/\\\r?\n\s*/g, " ");
	const start = postStart(flat);
	if (start < 0) return undefined;
	const dir = postDir(flat, start, cwd);
	if (!postsToDotz(flat.slice(start), dir)) return undefined;
	const bodies: { raw: string; file: string }[] = [];
	const redirects = flat.replace(/>\s*/g, ">");
	for (const m of flat.matchAll(BODY_FILE)) {
		const raw = m[1] ?? m[2];
		if (raw === "-" || raw.includes("=")) continue;
		const file = shellPath(raw, dir);
		if (existsSync(file)) bodies.push({ raw, file });
		else if (m[1] && !redirects.includes(`>${raw}`)) return `this post to ${PUBLIC_REPO} names a body file this check cannot read. Put the body at a plain path and post again; do not work around this check`;
	}
	let text = flat.replace(NOT_THE_POST, " ");
	for (const { raw, file } of bodies) text = `${text.replaceAll(raw, " ")}\n${fileText(file)}`;
	const { hits } = scrub(text, installTerms(dataDir));
	if (!hits.length) return undefined;
	return `this post to ${PUBLIC_REPO} still carries personal or sensitive content (${hits.join(", ")}). Remove every such value, de-identify and generalise it, keep the detail (symptom, steps, expected, actual, version, generalised logs), and post again; do not work around this check`;
}
