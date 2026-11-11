// What leaves an install for public GitHub (MODE.md, Confirmation gates): one pattern table and the install's own values, shared by the
// shell deny (publicPostDeny, run before an agent's gh call) and the release note (hub/release-note.ts). No personal term lives here: the
// values come from this install's config and secrets at check time. Scrub results carry labels only, so that refusal never repeats a value.
// A post to the public repo is also refused for the owner's work (a file name outside the repo, a word only this install's notes use, naming
// the token and a neutral form so the agent can rewrite it) and, for a new issue, for a missing section of the nine a fix needs.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";

// `except`: ordinary words holding the value (a short name inside a common word), never masked.
export type Term = { value: string; label: string; except?: readonly string[] };

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
const termRe = ({ value, except = [] }: Term) => new RegExp([...except.map(escapeRe), `${/^\w/.test(value) ? "(?<!\\w)" : ""}${escapeRe(value)}${/\w$/.test(value) ? "(?!\\w)" : ""}`].join("|"), "gi");

export function scrub(input: string, terms: readonly Term[] = []): { text: string; hits: string[] } {
	const hits = new Set<string>();
	let text = input;
	for (const term of [...terms].sort((a, b) => b.value.length - a.value.length)) {
		text = text.replace(termRe(term), found => {
			if (term.except?.includes(found.toLowerCase())) return found;
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
const MAX_NOTES_BYTES = 2 * 1024 * 1024; // memory and repo text outgrow a secret's size
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

function fileText(file: string, max = MAX_SECRET_BYTES): string {
	try {
		return statSync(file).isFile() && statSync(file).size <= max ? readFileSync(file, "utf8") : "";
	} catch {
		return ""; // unreadable or gone: that file has nothing to compare against
	}
}

export const PRIVACY_ALLOW = "privacy-terms-allow.txt"; // beside the list, one ordinary word per line
export const listLines = (file: string) => fileText(file).split("\n").map(l => l.trim()).filter(Boolean);
const NOT_A_SECRET = /^(?:privacy-terms(?:-allow)?\.txt$|[^/]+-tools\/)/; // the list itself, and folders of private scripts: their lines are code, not values

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
			if (NOT_A_SECRET.test(name)) continue;
			for (const value of secretValues(fileText(join(secrets, name)))) if (value.length >= MIN_SECRET) terms.push({ value, label: "secret" });
		}
	}
	const allow = listLines(join(secrets, PRIVACY_ALLOW)).map(w => w.toLowerCase());
	for (const value of listLines(join(secrets, "privacy-terms.txt"))) terms.push({ value, label: "privacy list", except: allow.filter(w => w.includes(value.toLowerCase())) });
	return terms.filter(t => !PUBLIC_URL.includes(t.value.toLowerCase()) && !GENERIC_MACHINE.test(t.value));
}

// The release note's terms: this machine's when it has a data folder, plus PRIVACY_TERMS (one per line), the repo secret Actions passes in.
export function releaseTerms(env: Record<string, string | undefined> = process.env): Term[] {
	const listed = (env.PRIVACY_TERMS ?? "").split("\n").map(l => l.trim()).filter(Boolean);
	return [...installTerms(env.DOTZ_DIR ?? join(homedir(), ".dotz")), ...listed.map(value => ({ value, label: "privacy list" }))];
}

// How this install's owner is addressed (config identity.address): too short and common a word to mask as a term, so the release note drops
// a reason that names it instead. Empty without a data folder, as in CI.
export function ownerAddress(env: Record<string, string | undefined> = process.env): string {
	try {
		const address = JSON.parse(fileText(join(env.DOTZ_DIR ?? join(homedir(), ".dotz"), "config.json")) || "{}").identity?.address;
		return typeof address === "string" ? address.trim() : "";
	} catch {
		return ""; // a broken config is reported by the gateway
	}
}

const FLAGS = String.raw`(?:-\S+(?:[ =]\S+)?\s+)*`;
// A command's start: a line or a shell separator, or the opening quote of a shell string in eval code. A grep or a commit message that only mentions gh is no post.
const START = String.raw`(?:^|[;&|(]|[:(=,$\[]\s*["'\x60]|\s-c\s+["'\x60])\s*(?:sudo\s+)?(?:(?:timeout\s+\S+|env|command|then|do|else|xargs(?:\s+-\S+)*|nohup|time|exec)\s+)*(?:[A-Za-z_]+=\S*\s+)*(?:[\w.~/-]*/)?`;
export const MAYBE_POST = /\bgh\s+(?:issue|pr|release|api|gist)\b|\bgh\s+-|api\.github\.com/;
const GH_POST = new RegExp(`${START}gh\\s+${FLAGS}(?:(?:issue|pr)\\s+${FLAGS}(?:create|comment|edit|review|close|merge)|release\\s+${FLAGS}(?:create|edit)|gist\\s+${FLAGS}(?:create|edit))\\b`, "m");
const GH_API = new RegExp(`${START}gh\\s+api\\b(?:[^\\n]*\\b(?:issues|pulls|releases|comments)\\b|[^\\n]*\\bgraphql\\b[\\s\\S]*?\\bmutation\\b)`, "m");
const GH_API_WRITE = /\s-[fF]\s*\S|\s--(?:field|raw-field|input)\b|(?:\s-X\s*|\s--method[ =])(?:POST|PUT|PATCH)\b/i;
const CURL_POST = new RegExp(`${START}curl\\b[^\\n]*api\\.github\\.com/(?:repos/\\S*(?:issues|pulls|releases|comments)|graphql)`, "m");
const CURL_WRITE = /\s(?:-d|--data\S*|--json|-X\s*(?:POST|PUT|PATCH))\b/;
// `gh gist create|edit f1 f2`: the files named on the line are the gist's body (a gist is public whatever repo the shell sits in).
const GIST = /\bgh\s+gist\s+(?:create|edit)\b([^\n;&|]*)/;
const GIST_VALUE_FLAGS = new Set(["-d", "--desc", "-f", "--filename"]);
const OTHER_REPO = /(?:^|\s)(?:-R|--repo)[ =]|\brepos\/[\w.-]+\/[\w.-]+/;
const VALUE = String.raw`("[^"]+"|'[^']+'|\x60[^\x60]+\x60|[^\s;&|)"'\x60]+)`;
const BODY_FILE = new RegExp(`(?<=\\s)(?:(?:-F|--field|-d|--data(?:-binary)?|--json)[ =]*["']?(?:[\\w.-]+=)?@|(?:--body-file|--notes-file|--input|-F)[ =]*)${VALUE}|(?:\\bcat\\s+|(?<!<)<(?!<)\\s*)${VALUE}`, "g");
const CHANGE_DIR = new RegExp(`\\b(?:cd\\s+|cwd:\\s*)${VALUE}`, "g");
const NOT_THE_POST = /\b[A-Z_]*PATH=\S+|\bcd\s+\S+|\bgit\s+-C\s+\S+|\bcwd:\s*["'\x60][^"'\x60]*["'\x60]/g;
const API_PATH = /(?:api\.github\.com\/|\bgh\s+api\s(?:[^\n]*?\s)??["']?\/?)(repos\/[^\s?"'\x60]+)/;
const API_READ = /(?:\s-X\s*|\s--request[ =]|\s--method[ =])GET\b|\s--get\b|\s-[a-zA-Z]*G\b/;
const API_ARGS = /\s(?:-[HfF]|--header|--field|--raw-field)[ =]?(?:"[^"]*"|'[^']*'|\S+)/g;
const GH_POSTS = new RegExp(GH_POST, "gm");
// Quoted strings and heredocs: a body can quote a command, so verbs and flags are read outside them.
export const QUOTED = /"(?:\\[\s\S]|[^"\\])*"|'[^']*'|<<-?\s*["']?(\w+)["']?\n[\s\S]*?\n\s*\1\b/g;
const API_FILE = /^repos\/[^/]+\/[^/]+\/(issues|pulls)\/?$/;
const API_MERGE = /\/pulls\/\d+\/merge\/?$/;
const GQL_FILE = /\bmutation\b[^{]*\{\s*create(Issue|PullRequest)\s*\(/;
const GQL_MERGE = /\bmutation\b[^{]*\{\s*(?:mergePullRequest|enablePullRequestAutoMerge)\s*\(/;
// A line of its own: the start of a line or of the body's own value (--body, -b, a body field or variable, a JSON body, what echo, printf or <<< feeds stdin), up to the line's end.
const CLASS_LINE = /(?:^|\\n|(?:--body[ =]|\s-b[ =]|\b\w*body=|\\?"body\\?":\s*|\bbody:\s*|\b(?:echo|printf)\s+(?:-\w+\s+)*|<<<\s*)\$?\\?["'\x60]?)[ \t]*분류:[ \t]*(소스 오류|보편 개선|개인 설정)[ \t\r]*(?=$|\\+[nr"']|["'\x60])/gim;
const PERSONAL_SETTING = "개인 설정";
const NEEDS_CLASS = `this post to ${PUBLIC_REPO} needs one line in its body: 분류: 소스 오류 or 분류: 보편 개선. Decide by evidence: reproduce on a clean default config or show the shipped default or code path at fault, after checking that this install's custom layer, RULES.md, features or config does not cause it. A body this check cannot see counts as having no line`;
const PERSONAL_POST = "this is a personal setting: it belongs in this install's custom layer (docs/customization.md) and nothing goes upstream";
const MERGE_POST = `a PR lands on ${PUBLIC_REPO} only through dotz_merge (action=review with scope, then action=merge), which records that it is right for every install`;

export function postKind(post: string): "issue" | "pr" | "merge" | undefined {
	const code = post.slice(Math.max(0, post.search(/\b(?:gh|curl)\s/))).replace(QUOTED, " ");
	const verbs = [...code.matchAll(GH_POSTS)].map(m => m[0]);
	if (verbs.length) return verbs.some(v => /\bissue\b[\s\S]*\bcreate$/.test(v)) ? "issue" : verbs.some(v => /\bpr\b[\s\S]*\bcreate$/.test(v)) ? "pr" : verbs.some(v => /\bpr\b[\s\S]*\bmerge$/.test(v)) ? "merge" : undefined;
	if (API_READ.test(code)) return undefined;
	const path = API_PATH.exec(post.replace(API_ARGS, " "))?.[1] ?? "";
	const filed = API_FILE.exec(path)?.[1] ?? GQL_FILE.exec(post)?.[1]?.toLowerCase();
	if (filed) return filed === "issue" || filed === "issues" ? "issue" : "pr";
	return API_MERGE.test(path) || GQL_MERGE.test(post) ? "merge" : undefined;
}

// Personal settings stay out of the shared code (MODE.md, Customization): a new issue or PR says which kind it is, and a PR lands only through the gate that asks.
function upstreamDeny(post: string, text: string): string | undefined {
	const kind = postKind(post);
	if (kind === "merge") return MERGE_POST;
	if (kind !== "issue" && kind !== "pr") return undefined;
	const classes = [...text.matchAll(CLASS_LINE)].map(m => m[1]);
	if (classes.includes(PERSONAL_SETTING)) return PERSONAL_POST;
	if (!classes.length) return NEEDS_CLASS;
	const missing = kind === "issue" ? missingSections(text) : [];
	return missing.length ? `this new issue to ${PUBLIC_REPO} cannot be fixed from its text alone. Missing or empty: ${missing.join(", ")}. Write each as a "## " heading with content, every one required: ${ISSUE_SECTIONS.map(s => s.name).join(", ")}. 관련 코드 위치 needs at least one file:line. If a section truly has nothing, say why in it. A body this check cannot see counts as empty` : undefined;
}

// What a maintainer needs to fix an issue from its text alone. Each is a heading whose section holds content; `shape` is what that content must show.
const ISSUE_SECTIONS: readonly { name: string; shape?: RegExp }[] = [{ name: "증상" }, { name: "재현 순서" }, { name: "기대 결과" }, { name: "실제 결과" }, { name: "버전" }, { name: "관련 코드 위치", shape: /[\w.-]+\.\w+:\d+/ }, { name: "로그 일부" }, { name: "원인 추정" }, { name: "시도한 것" }];
const HEADING = /(?:^|["'\x60\n])[ \t]*#{1,6}[ \t]+([^\n]*)/g;
const HEREDOC = /<<-?\s*["']?(\w+)/;
const COMMAND_TAIL = /["'\x60]\s*(?:(?:-{1,2}\w|&&|\||;|\})[\s\S]*)?$/; // what follows the last section when the body is an inline argument
const BARE_MARKER = /^[ \t]*(?:\d+[.)]|[-*])[ \t]*$/gm; // the template's empty list line

function missingSections(text: string): string[] {
	let body = text.replace(/\\n/g, "\n").replace(/<!--[\s\S]*?-->/g, " ");
	const tag = HEREDOC.exec(body);
	const close = tag ? body.slice(tag.index).search(new RegExp(`\\n[ \\t]*${tag[1]}\\b`)) : -1;
	if (tag && close >= 0) body = body.slice(0, tag.index + close);
	const heads = [...body.matchAll(HEADING)].filter(h => ISSUE_SECTIONS.some(s => h[1].trim().startsWith(s.name))); // a "# comment" in a log is no section
	return ISSUE_SECTIONS.flatMap(({ name, shape }) => {
		const at = heads.findIndex(h => h[1].trim().startsWith(name));
		if (at < 0) return [name];
		const end = heads[at + 1]?.index ?? body.length;
		const section = body.slice(heads[at].index + heads[at][0].length, end);
		const content = (at === heads.length - 1 ? section.replace(COMMAND_TAIL, "") : section).replace(BARE_MARKER, "");
		return /[\p{L}\p{N}]/u.test(content) && (!shape || shape.test(content)) ? [] : [name];
	});
}

// What this install knows is its owner's work, for the post check below: no word lives here, each comes from this install's own files at check time.
// A word the shipped repo also uses is ordinary (filtered in workTextDeny), so only what is this install's alone is refused.
const HANGUL = /[\uac00-\ud7a3]/;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;
const PARTICLE = /(?:으로써|으로서|에게서|에서는|으로|에서|에게|까지|부터|처럼|보다|이나|이랑|라고|하고|들이|들은|들을|와|과|을|를|은|는|이|가|의|에|도|만|로|나|랑)$/;
const nfc = (text: string) => text.normalize("NFC"); // macOS folder names arrive decomposed
const stem = (word: string) => { const cut = word.replace(PARTICLE, ""); return HANGUL.test(word.at(-1) ?? "") && cut.length >= 2 ? cut : word; };
const parts = (word: string) => [word, ...(/[-_]/.test(word) ? word.split(/[-_]+/) : [])];
const wordWorthy = (w: string) => /\p{L}/u.test(w) && w.length >= (HANGUL.test(w) ? 2 : 3);
const INFLECTED = /(?:다|요|며|면|도록|해서|지만|는데|려고)$/; // a Korean verb form, in prose
const PROSE_REPEATS = 2; // a word of the owner's field recurs in their notes; a one-off word is just how a sentence went

function addWords(into: Map<string, string>, text: string, neutral: string): void {
	for (const raw of text.toLowerCase().match(WORD) ?? []) for (const part of parts(raw)) {
		const word = stem(part);
		if (wordWorthy(word) && !into.has(word)) into.set(word, neutral);
	}
}

function addProse(into: Map<string, string>, text: string, neutral: string): void {
	const seen = new Map<string, number>();
	for (const raw of text.toLowerCase().match(WORD) ?? []) for (const part of parts(raw)) {
		const word = stem(part);
		if (wordWorthy(word) && !INFLECTED.test(word) && !(word.length === 2 && PARTICLE.test(word))) seen.set(word, (seen.get(word) ?? 0) + 1);
	}
	for (const [word, count] of seen) if (count >= PROSE_REPEATS && !into.has(word)) into.set(word, neutral);
}

function jsonText(file: string): string {
	try {
		const leaves: { path: string; value: string }[] = [];
		jsonLeaves(JSON.parse(fileText(file) || "null"), "", leaves);
		return leaves.map(l => l.value).join("\n");
	} catch {
		return ""; // a broken file is reported by whatever owns it; the other sources still apply
	}
}

function folderNames(dir: string): string[] {
	try {
		return readdirSync(dir).filter(name => !name.startsWith(".")).map(nfc);
	} catch {
		return []; // not on this install
	}
}

// word -> the neutral form to suggest. The first source to name a word sets its form, so the precise ones come first.
export function installVocabulary(dataDir: string): Map<string, string> {
	const words = new Map<string, string>();
	const config = fileText(join(dataDir, "config.json"));
	let identity: unknown;
	try {
		identity = JSON.parse(config || "{}").identity;
	} catch {
		identity = undefined; // a broken config is reported by the gateway
	}
	const named = identity as { name?: unknown; address?: unknown } | undefined;
	addWords(words, [named?.name, named?.address].filter(v => typeof v === "string").join("\n"), "주인");
	addWords(words, folderNames(join(dataDir, "projects")).join("\n"), "프로젝트A");
	let lanes: Record<string, unknown> = {};
	try {
		lanes = JSON.parse(fileText(join(dataDir, "channels.json")) || "{}").lanes ?? {};
	} catch {
		lanes = {}; // same as the config above
	}
	addWords(words, Object.keys(lanes).join("\n"), "작업 채널");
	const custom = join(dataDir, "custom");
	addWords(words, [jsonText(join(custom, "apps.json")), jsonText(join(custom, "mailboxes.json")), jsonText(join(custom, "projects.json"))].join("\n"), "메일 앱 A");
	addWords(words, [...folderNames(join(custom, "apps")), ...folderNames(join(custom, "plugins")).map(f => f.split(".")[0])].join("\n"), "앱 A");
	addProse(words, [jsonText(join(dataDir, "channel-setups.json")), fileText(join(dataDir, "identity", "IDENTITY.md")), ...["owner.md", "boundaries.md", "observations.md"].map(f => fileText(join(dataDir, "memory", f), MAX_NOTES_BYTES)), fileText(join(dataDir, "RULES.md")), fileText(join(dataDir, "LESSONS.md"))].join("\n"), "일반 표현");
	return words;
}

// Any file-shaped name, a space-holding name by its last word. A call (res.json()) or a longer domain (x.ts.net) is not a file.
const FILE_EXT = "pdf|docx?|docm|xls[xmb]?|pptx?|pptm|odt|ods|odp|hwpx?|dwg|psd|epub|txt|rtf|csv|tsv|md|json|ya?ml|toml|xml|html?|css|log|sql|sqlite|zip|tar|gz|tgz|7z|rar|png|jpe?g|gif|webp|svg|bmp|heic|mp3|wav|m4a|flac|ogg|aac|mp4|mov|avi|mkv|webm|tsx?|jsx?|mjs|cjs|py|rb|java|sh|ipynb|eml|ics|vcf";
const FILE_TOKEN = new RegExp(String.raw`(?<![\p{L}\p{N}_/.…$%{}-])(?:~/|\.{0,2}/|\$\{?\w+\}?/)?(?:\([^\s()]{1,40}\))?(?:[\p{L}\p{N}_…]|(?<![*>}])-)[\p{L}\p{N}_….~/-]*\)?\.(${FILE_EXT})(?![A-Za-z0-9(-]|_[\p{L}\p{N}]|\.[A-Za-z0-9])`, "giu");
const DOCUMENT = /^(?:pdf|docx?|docm|xls[xmb]?|pptx?|pptm|odt|ods|odp|hwpx?|epub|txt|rtf|csv|tsv)$/i;
const PLACEHOLDER_FILE = /^(?:(?:dotz[-_])?(?:문서|파일|자료|첨부|사진|그림|영상|음원|file|doc|document|attachment|image|photo|audio|video|sample|example|test|foo|bar|baz)[-_]?[a-z0-9]{0,2}|[a-z]+[-_](?:before|after)|[a-z0-9])\.\w+$/i;
const LIBRARY_NAME = /^[A-Z][a-z]+\.js$/; // Node.js, Next.js
// Names every project of a kind has, which say nothing about anyone's work.
const COMMON_FILE = /^(?:(?:vite|vitest|webpack|next|tailwind|jest|eslint|rollup|postcss|babel)\.config\.\w+|tsconfig\.json|cargo\.(?:toml|lock)|pyproject\.toml|requirements\.txt|setup\.py|(?:main|index|app|config|settings)\.\w+|(?:readme|license|changelog)\.\w+)$/i;
// How the body gets here, never what it says: the file a command writes it to, posts it from or removes after. A scratch path and a body-file flag can sit
// inside the string of an eval call, so they count anywhere; `cat > name`, tee, rm and a release's own files right after its tag read as prose in quotes and heredocs, so only the shell's own text counts.
const SCRATCH = String.raw`(?=(?:/private)?/tmp/|\$\{?TMPDIR\}?/|/var/folders/)`;
const BODY_ROUTE = new RegExp(String.raw`(?:--(?:body|notes)-file[ =]|--input[ =]|(?:>>?\s*|\brm\s+(?:-\w+\s+)*)["']?${SCRATCH})["']?[^\s"']+`, "g");
const SHELL_ROUTE = /\bcat\s+>>?\s*["']?[^\s"']+|\btee\s+["']?[^\s"']+|(?:^|[;&]\s*)rm\s+(?:-\w+\s+)*["']?[^\s"']+|\brelease[ \t]+create[ \t]+\S+(?:[ \t]+[^\s"';&|<>-][^\s"';&|<>]*)+/;
const SHELL_ROUTES = new RegExp(`${QUOTED.source}|${SHELL_ROUTE.source}`, "gm");
const withoutRoutes = (command: string) => command.replace(BODY_ROUTE, " ").replace(SHELL_ROUTES, quoted => (SHELL_ROUTE.test(quoted) && !/^["'<]/.test(quoted) ? " " : quoted));
const DOTZ_URL = /https?:\/\/(?:(?:api|raw|www)\.)?github(?:usercontent)?\.com\/(?:repos\/)?ddotz\/dotz(?!\/files\/)(?:[/?#]\S*)?/gi;
const ATTACHMENT_PATH = /https?:\/\/\S*\/(?=[^\s/]+\.\w+)/g; // an attachment's URL shows its file name: only that stays
const NOT_REPO_TEXT = /(?:\.test\.[jt]sx?|\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|mp4|pdf|lock))$/i;
const REPO = join(import.meta.dir, "..");
const MAX_REPORTED = 12;

function repoFiles(root: string, into: string[] = []): string[] {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".omo") continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) repoFiles(path, into);
		else into.push(path);
	}
	return into;
}

// The branch being posted from can hold files the installed code does not have yet (a PR's new file). Only a dotz checkout is listed.
function branchFiles(dir: string): string[] {
	try {
		if (!execFileSync("git", ["remote", "-v"], { cwd: dir, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).includes(PUBLIC_REPO)) return [];
		return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: dir, encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\n");
	} catch {
		return []; // not a checkout: the installed tree alone decides
	}
}

// A Korean word takes its particles after it, so only its start is a boundary.
const wholeWord = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${HANGUL.test(word.at(-1) ?? "") ? "" : "(?![\\p{L}\\p{N}])"}`, "u");

// Which words the shipped repo itself uses, tests aside (their fixtures name what this check must refuse). Runs only for a word a post actually holds, so a clean post reads nothing.
function usedByRepo(words: readonly string[], files: readonly string[]): Set<string> {
	const left = new Set(words);
	const found = new Set<string>();
	for (const file of files) {
		if (!left.size) break;
		if (NOT_REPO_TEXT.test(file)) continue;
		const text = fileText(file, MAX_NOTES_BYTES).toLowerCase();
		for (const word of left) if (wholeWord(word).test(text)) { found.add(word); left.delete(word); }
	}
	return found;
}

const INNER_MIN = 3; // a two-syllable run inside a longer word is mostly chance
// Longest prefix first (the word and its particles), then a known word inside a compound.
function koreanHit(word: string, vocabulary: Map<string, string>): string | undefined {
	for (let end = word.length; end >= 2; end--) if (vocabulary.has(word.slice(0, end))) return word.slice(0, end);
	for (let start = 1; start + INNER_MIN <= word.length; start++) for (let end = word.length; end >= start + INNER_MIN; end--) if (vocabulary.has(word.slice(start, end))) return word.slice(start, end);
	return undefined;
}

// Refuses a post naming the owner's own work, however public-looking the words: file names outside the repo and this install's own vocabulary.
// The reply names each token and a neutral form: this check runs on the owner's machine and the refusal goes only to the owner's agent, so the value stays local.
function workTextHits(raw: string, dataDir: string, dir: string): string[] {
	const text = nfc(raw).replace(/\\n/g, "\n").replace(DOTZ_URL, " ").replace(ATTACHMENT_PATH, " ");
	const files = repoFiles(REPO);
	const names = new Set([...files, ...branchFiles(dir)].map(f => basename(f).toLowerCase()));
	const tops = new Set(readdirSync(REPO).map(name => name.toLowerCase()));
	const allow = new Set(listLines(join(dataDir, "secrets", PRIVACY_ALLOW)).map(w => w.toLowerCase()));
	const fileHits = new Map<string, string>();
	for (const m of text.matchAll(FILE_TOKEN)) {
		const name = basename(m[0]);
		if (names.has(name.toLowerCase()) || allow.has(name.toLowerCase()) || PLACEHOLDER_FILE.test(name) || LIBRARY_NAME.test(name) || COMMON_FILE.test(name) || tops.has(m[0].split("/")[0].toLowerCase()) && m[0].includes("/")) continue;
		if (!fileHits.has(m[0])) fileHits.set(m[0], `${DOCUMENT.test(m[1]) ? "문서" : "파일"}${fileHits.size + 1}.${m[1].toLowerCase()}`);
	}
	const vocabulary = installVocabulary(dataDir);
	const wordHits = new Map<string, string>();
	let rest = text;
	for (const token of fileHits.keys()) rest = rest.replaceAll(token, " ");
	for (const raw of rest.toLowerCase().match(WORD) ?? []) for (const part of parts(raw)) {
		const hit = HANGUL.test(part) ? koreanHit(part, vocabulary) : vocabulary.has(part) ? part : undefined;
		if (hit && !allow.has(hit)) wordHits.set(hit, vocabulary.get(hit) as string);
	}
	const ordinary = usedByRepo([...new Set([...fileHits.keys()].map(t => basename(t).toLowerCase()).concat([...wordHits.keys()]))], files);
	return [...[...fileHits].filter(([token]) => !ordinary.has(basename(token).toLowerCase())), ...[...wordHits].filter(([word]) => !ordinary.has(word))].map(([token, form]) => `"${token}" -> ${form}`);
}

function workTextDeny(raw: string, dataDir: string, dir: string): string | undefined {
	const hits = workTextHits(raw, dataDir, dir);
	if (!hits.length) return undefined;
	const more = hits.length > MAX_REPORTED ? ` and ${hits.length - MAX_REPORTED} more` : "";
	return `this post to ${PUBLIC_REPO} shows this install's own work, which tells readers what field its user is in. Generalise each: ${hits.slice(0, MAX_REPORTED).join(", ")}${more}. Keep the behaviour, flow, counts, logs and code locations; a file name that is not a repo path becomes a placeholder like 문서A.pdf or 파일1.xlsx. The whole command counts as the post, so move unrelated work out of it. An ordinary word refused by mistake goes in ${PRIVACY_ALLOW} in this install's secrets folder; do not work around this check`;
}

export function postStart(flat: string): number {
	const post = GH_POST.exec(flat);
	if (post) return post.index;
	const api = GH_API.exec(flat);
	if (api && GH_API_WRITE.test(flat.slice(api.index))) return api.index;
	const curl = CURL_POST.exec(flat);
	return curl && CURL_WRITE.test(flat.slice(curl.index)) ? curl.index : -1;
}

export function shellPath(raw: string, dir: string): string {
	return resolve(dir, raw.replace(/^["'\x60]|["'\x60]$/g, "").replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir()));
}

// The folder the post runs in: the last cd before it, or a cwd option written after it.
export function postDir(flat: string, start: number, cwd: string): string {
	const moves = [...flat.matchAll(CHANGE_DIR)];
	const move = moves.filter(m => m.index < start).at(-1) ?? moves[0];
	return move ? shellPath(move[1], cwd) : cwd;
}

export function postsToDotz(post: string, dir: string): boolean {
	if (post.includes(PUBLIC_REPO)) return true;
	if (OTHER_REPO.test(post)) return false;
	try {
		return execFileSync("git", ["remote", "-v"], { cwd: dir, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).includes(PUBLIC_REPO); // any remote: a fork's gh targets its upstream
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
	// Every public GitHub post is checked for the install's personal values; only the dotz repo also gets its own rules (class line, sections, work text).
	const gist = GIST.exec(flat);
	const toDotz = !gist && postsToDotz(flat.slice(start), dir);
	const target = toDotz ? PUBLIC_REPO : "a public GitHub repo or gist";
	const bodies: { raw: string; file: string }[] = [];
	let prev = "";
	for (const raw of gist?.[1].match(/\S+/g) ?? []) {
		const word = raw.replace(/^["'\x60]|["'\x60]$/g, "");
		const isValue = GIST_VALUE_FLAGS.has(prev);
		prev = raw;
		if (isValue || word.startsWith("-")) continue;
		const file = shellPath(raw, dir);
		if (existsSync(file) && statSync(file).isFile()) bodies.push({ raw, file });
	}
	const redirects = flat.replace(/>\s*/g, ">");
	for (const m of flat.matchAll(BODY_FILE)) {
		const raw = m[1] ?? m[2];
		if (raw === "-" || raw.includes("=")) continue;
		const file = shellPath(raw, dir);
		const refused = (why: string) => `this post to ${target} names a body file ${why}; do not work around this check`;
		if (existsSync(file) && statSync(file).size > MAX_NOTES_BYTES) return refused(`this check cannot read: it is too big, over ${MAX_NOTES_BYTES / 1024 / 1024} MB. Shorten it and post again`);
		if (existsSync(file)) bodies.push({ raw, file });
		else if (m[1] && !redirects.includes(`>${raw}`)) return refused(/[$\x60]/.test(file) ? "this check cannot read: its path holds a shell variable or command, which is not expanded yet when the check runs. Write the path out in full and post again" : "that does not exist yet: this check runs before the command does. Save the file first, then post in a separate call");
	}
	let shell = flat.replace(NOT_THE_POST, " ");
	for (const { raw } of bodies) shell = shell.replaceAll(raw, " ");
	const files = bodies.map(({ file }) => fileText(file, MAX_NOTES_BYTES));
	const text = [shell, ...files].join("\n");
	const { hits } = scrub(text, installTerms(dataDir));
	if (!hits.length) {
		if (!toDotz) return undefined;
		const upstream = upstreamDeny(flat.slice(start), text);
		if (upstream === MERGE_POST || upstream === PERSONAL_POST) return upstream;
		return workTextDeny([withoutRoutes(shell), ...files].join("\n"), dataDir, dir) ?? upstream;
	}
	return `this post to ${target} still carries personal or sensitive content (${hits.join(", ")}). Remove every such value, de-identify and generalise it, keep the detail (symptom, steps, expected, actual, version, generalised logs), and post again; do not work around this check`;
}

// Secrets at rest: what an agent or the owner pasted stays in the OmO session files and the recall index copied from them. maskSecrets
// replaces each credential with a fixed marker naming its kind, never a value, before text is stored or indexed (hub/recall-index.ts at
// ingest, hub/session-hygiene.ts in session files). Ordinary content (commit ids, sha hashes, uuids, paths) matches no rule: a key=value
// pair is masked only when its key names a secret and its value looks random. Hits are counts per kind, so a report never repeats a value.
export const secretMark = (kind: string): string => `[가림:${kind}]`;
const NOT_A_VALUE = /^(?:[$<{[%*!]|\.{3}|x{4,}|(?:true|false|null|undefined|none|redacted|changeme|password|secret|token)$)/i;
const MEMBER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/; // opts.token, process.env.X: code, not a value
function entropy(s: string): number {
	const seen = new Map<string, number>();
	for (const c of s) seen.set(c, (seen.get(c) ?? 0) + 1);
	let h = 0;
	for (const n of seen.values()) h -= (n / s.length) * Math.log2(n / s.length);
	return h;
}
// A value that looks generated: letters and digits with some spread, or a long high-spread mixed-case run. Words, camelCase
// identifiers, numbers and member paths are not.
export function looksRandom(v: string): boolean {
	if (v.length < 8 || NOT_A_VALUE.test(v) || MEMBER.test(v) || /^[/~.]|^https?:/.test(v) || /^[a-z]+(?:[_-][a-z]+)*$/.test(v) || /^\d+$/.test(v)) return false;
	const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(v)).length;
	if (/[A-Za-z]/.test(v) && /\d/.test(v)) return classes >= 2 && entropy(v) >= 2.5;
	return v.length >= 24 && /[a-z]/.test(v) && /[A-Z]/.test(v) && entropy(v) >= 4;
}
const SEP = String.raw`\\?["']?\s*[:=]\s*\\?["']?`; // key: value, key=value, "key": "value", and the same JSON-escaped
type SecretRule = { kind: string; re: RegExp; prefixed?: boolean; random?: boolean };
// Order matters: a specific shape is masked before a generic one sees its text. `prefixed`: group 1 (a header or key name) is kept.
const SECRET_RULES: readonly SecretRule[] = [
	{ kind: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g },
	{ kind: "jwt", re: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g },
	{ kind: "github", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{40,})/g },
	{ kind: "gitlab", re: /\bgl(?:pat|ptt|dt|rt|ft|oas|cbt|imt|soat)-[\w-]{20,}/g },
	{ kind: "anthropic", re: /\bsk-ant-[\w-]{20,}/g },
	{ kind: "openai", re: /\bsk-(?:proj-|svcacct-|admin-)?(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}/g },
	{ kind: "google", re: /\b(?:AIza[\w-]{35}|ya29\.[\w.-]{20,}|GOCSPX-[\w-]{20,}|1\/\/0[\w-]{40,})/g },
	{ kind: "aws", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
	{ kind: "slack", re: /\b(?:xox[abposr]-\d+-[\w-]{8,}|xapp-\d-[\w-]{10,})|https:\/\/hooks\.slack\.com\/services\/[\w/]{20,}/g },
	{ kind: "discord", re: /\b[MNO][\w-]{23,27}\.[\w-]{6}\.[\w-]{27,40}\b|https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/g },
	{ kind: "auth-header", re: new RegExp(`\\b((?:Proxy-)?Authorization${SEP}(?:(?:Bearer|Basic|Token|Bot|Digest)\\s+)?)([\\w.~+/=-]{8,})`, "gi"), prefixed: true, random: true },
	{ kind: "auth-header", re: /\b(Bearer\s+)([\w.~+/=-]{16,})/g, prefixed: true, random: true },
	{ kind: "cookie", re: new RegExp(`\\b((?:Set-)?Cookie${SEP})([\\w.-]{1,100}=[\\w.~+/%-]{8,}(?:;\\s*[\\w.-]{1,100}=[\\w.~+/%-]*)*)`, "gi"), prefixed: true, random: true },
	// The key must end in the secret word (token, api_key, SECRET_KEY), so tokenFile, maxTokens or tokens.css:12: are not keys.
	{ kind: "pair", re: new RegExp(`(?<![\\w.-])([\\w-]*?(?:passw(?:or)?d|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret[_-]?key|client[_-]?secret)${SEP})([\\w.~+/=@!#$%^*-]{8,})(?![\\w(\\[])`, "gi"), prefixed: true, random: true },
];
const valuesRe = new Map<string, RegExp>();
// The exact values of this install's secret files, longest first, as one pattern (built once per value set).
function exactRe(values: readonly string[]): RegExp | undefined {
	if (!values.length) return undefined;
	const key = values.join("\0");
	let re = valuesRe.get(key);
	if (!re) {
		re = new RegExp([...values].sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "g");
		valuesRe.clear();
		valuesRe.set(key, re);
	}
	return re;
}

export function maskSecrets(input: string, values: readonly string[] = []): { text: string; hits: Record<string, number> } {
	const hits: Record<string, number> = {};
	const hit = (kind: string) => { hits[kind] = (hits[kind] ?? 0) + 1; return secretMark(kind); };
	let text = input;
	const exact = exactRe(values);
	if (exact) text = text.replace(exact, () => hit("secret-file"));
	for (const { kind, re, prefixed, random } of SECRET_RULES)
		text = text.replace(re, (found, ...groups: unknown[]) => {
			if (!prefixed) return hit(kind);
			const [head, value] = groups as [string, string];
			if (value.startsWith("[가림:") || (random && !looksRandom(value))) return found;
			return head + hit(kind);
		});
	return { text, hits };
}

// The values of the files in <dataDir>/secrets that could be pasted somewhere: long, unspaced and random-looking (a mail address or a
// setting inside a JSON secret file is not one). Read at call time, never logged.
export function secretFileValues(dataDir: string): string[] {
	const secrets = join(dataDir, "secrets");
	if (!existsSync(secrets)) return [];
	const out = new Set<string>();
	for (const name of readdirSync(secrets, { recursive: true }).map(String)) {
		if (NOT_A_SECRET.test(name)) continue;
		for (const value of secretValues(fileText(join(secrets, name)))) if (value.length >= 12 && !/\s/.test(value) && looksRandom(value)) out.add(value);
	}
	return [...out];
}
