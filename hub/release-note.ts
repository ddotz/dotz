// The note of a release (docs/releases.md): one patch-note line per user-visible commit since the previous tag, grouped by topic.
// The convention in CONTRIBUTING.md feeds it: a subject says what changed for a user, and the first plain sentence of its 왜: (or else 어떻게:) follows as the reason, labels dropped. Internal work closes the note as one count.
import { scrub, type Term } from "./public-scrub.ts";

export type NoteCommit = { subject: string; body?: string; files: string[] };
// address: how this install's owner is addressed (config identity.address), only to drop a reason naming them; it never reaches the note.
export type NoteInput = { tag: string; commits: readonly NoteCommit[]; terms: readonly Term[]; address?: string };

export const NOTE_LOG_FORMAT = "%x1e%s%x1d%b%x1f";
const NOTE_MAX = 120_000; // GitHub takes 125,000 characters in a release body
const INTERNAL = "내부 정리";
const OTHER = "그 밖의 변경";
const NOT_A_CHANGE = /^(?:release: |Merge )/;
const INTERNAL_SUBJECT = /^내부 정리\s*:/;
const TICKET = /\s*\(#\d+\)$/;
// A one-line subject can only carry its labels inline; in a body only a label at the start of a line starts a part, so a 왜: inside a sentence stays text.
const SUBJECT_LABEL = /(?:^|\s)(왜|어떻게)\s*:\s*/;
const BODY_LABEL = /^[ \t]*(왜|어떻게)[ \t]*:\s*/m;
// A reason that quotes, names a file or runs long reads like the conversation behind the change, not a patch note.
const NOT_A_REASON = /["“”`]|[\w.-]+\/[\w.-]+\.\w+/;
const REASON_MAX = 160;
// Code names a user cannot read: a file, a CSS selector, custom property or flag, a camelCase or snake_case name, a call, a path.
// Product names stay: Discord, iCloud, macOS, Node.js, a slash command like /context, a ratio like 11/16.
const CODE_NAME = new RegExp([
	String.raw`(?<![\w.\/-])(?:[\w.-]+\/)*(?:[a-z0-9]|[A-Z0-9_]{2,}(?![a-z]))[\w.-]*\.(?:[cm]?[jt]sx?|css|html?|md|jsonl?|ya?ml|toml|sh|py|rs|go|swift|kt|sql|txt|log|lock|plist)(?![\w-]|\.\w)`,
	String.raw`(?<![\w.)\]])[.#][a-z][\w-]*`,
	String.raw`(?<![\w-])--[a-z][\w-]*`,
	String.raw`\b[a-z][a-z0-9]+[A-Z][a-z]\w*`,
	String.raw`\b[A-Za-z][A-Za-z0-9]*_\w*[A-Za-z0-9]`,
	String.raw`\b[a-z_$][\w$]*(?:\.[\w$]+)*\([\w$.,'"]*\)`,
	String.raw`(?<![\w.\/~-])(?:(?:~|\.{1,2})\/[\w.-]+|\/[A-Za-z_][\w.-]*(?=\/))`,
].join("|"));
// An aside in brackets that names code goes whole, so the sentence around it still reads; code woven into the sentence itself drops the sentence.
const withoutCodeAsides = (text: string) => text.replace(/\s*\(([^()]*)\)/g, (aside, inside: string) => (CODE_NAME.test(inside) ? "" : aside));
// A reason that retells the conversation behind the change: who asked (the owner, 사용자가 … 요청했다/원했다/말했다, someone who 요청했다) and what
// was wished or settled in chat (~싶어 했다, ~기로 했다, 요청으로, 말한 대로). What the app does stays: 사용자가 고른 칸, 목록을 세 번 요청했어요.
const RETOLD = new RegExp([
	String.raw`(?<!\p{L})오너|\bowners?\b`,
	String.raw`사용자(?:가|께서|는)\s.*(?<!\p{L})(?:요청|말|원|부탁)(?:했|하셨|해서)`,
	String.raw`(?:가|이|께서)\s+요청(?:했|하셨)`,
	String.raw`요청(?:으로|에\s*따라|대로|이\s*있었)`,
	String.raw`싶어\s*(?:했|하셨)`,
	String.raw`\p{L}기로\s*(?:했|하셨|정했|결정)`,
	String.raw`(?<!\p{L})말(?:했|한|하셨|씀)`,
].join("|"), "iu");
// The address as a word of its own, bare or with a particle (형이, 형님께), never inside another word (형태, 모형).
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const addressWord = (address: string) =>
	new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRe(address)}님?(?:께서|께|한테|에게|이랑|랑|처럼|이|가|은|는|을|를|의|도|만|와|과)?(?![\p{L}\p{N}])`, "iu");
const plainReason = (s: string, owner: RegExp | null) =>
	s.length <= REASON_MAX && /\p{L}{2}/u.test(s) && !NOT_A_REASON.test(s) && !CODE_NAME.test(s) && !RETOLD.test(s) && !owner?.test(s);
const TEST_FILE = /\.test\.[jt]sx?$|(?:^|\/)(?:test|tests|fixtures)\//;
// Plain Korean topics, by where a commit's files are; the first match per file wins and the commit goes to the topic with the most files.
const TOPICS: [topic: string, re: RegExp][] = [
	["메신저", /^(?:hub\/(?:messenger|discord|telegram|slack|kakao|jandi)|docs\/messengers|features\/kakao)/],
	["메일·답장·댓글", /^(?:features\/(?:reply-drafts|webmail|comments|publish-voice|youtube)|hub\/(?:mail|comments))/],
	["설치·업데이트", /^(?:install\.sh|setup\.ts|onboard\/|firstrun\/|\.github\/|hub\/(?:selfupdate|release|update|history-rewrite|git-hooks|onboarding))/],
	["세션·작업 실행", /^(?:extension\/|MODE|hub\/(?:lane|orchestrator|runtime\/|session|prompts|bgwork|watch))/],
	["웹 앱", /^web\//],
	["소개 사이트", /^site\//],
	["문서", /^(?:docs\/|README|CONTRIBUTING|THIRD_PARTY)/],
	["부가 기능", /^features\//],
	["게이트웨이", /^hub\//],
];

export function parseNoteCommits(raw: string): NoteCommit[] {
	return raw.split("\x1e").filter(r => r.trim()).map(record => {
		const [head, files] = record.split("\x1f");
		const [subject, body = ""] = head.split("\x1d");
		return { subject: subject.trim(), body: body.trim(), files: files.split("\n").map(f => f.trim()).filter(Boolean) };
	});
}

function topicOf(files: readonly string[]): string {
	const counts = new Map<string, number>();
	const product = files.filter(f => !TEST_FILE.test(f) && f !== "VERSION");
	if (files.length && !product.length) return INTERNAL;
	for (const file of product) {
		const topic = TOPICS.find(([, re]) => re.test(file))?.[0] ?? OTHER;
		counts.set(topic, (counts.get(topic) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? OTHER;
}

// A wrapped body breaks lines mid-sentence, so the first paragraph is one line before it is split into sentences; one left open (ending in a comma) is no reason at all.
function firstSentence(text: string): string {
	const paragraph = text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ");
	const sentence = paragraph.split(/(?<=[.!?])\s+/)[0].replace(TICKET, "").trim();
	if (/[,;:]$/.test(sentence)) return "";
	return sentence && !/[.!?]$/.test(sentence) ? `${sentence}.` : sentence;
}

// One or two sentences: what changed, then why. Labelled parts may sit in the body or, from a one-line commit, in the subject itself.
function noteItem({ subject, body = "" }: NoteCommit, owner: RegExp | null): string {
	const inline = subject.split(SUBJECT_LABEL);
	const what = withoutCodeAsides(inline[0].replace(TICKET, "")).trim();
	const labelled = [...inline.slice(1), ...body.split(BODY_LABEL).slice(1)];
	const parts = (label: string) => labelled.flatMap((part, i) => (i % 2 === 0 && part === label ? [labelled[i + 1] ?? ""] : []));
	const reason = [...parts("왜"), ...parts("어떻게")].map(part => firstSentence(withoutCodeAsides(part))).find(s => plainReason(s, owner));
	if (!reason) return what;
	return `${/[.!?]$/.test(what) ? what : `${what}.`} ${reason}`;
}

export function buildReleaseNote({ tag, commits, terms, address = "" }: NoteInput): string {
	const owner = address.trim() ? addressWord(address.trim()) : null;
	const groups = new Map<string, string[]>();
	for (const c of commits) {
		if (NOT_A_CHANGE.test(c.subject)) continue;
		const topic = INTERNAL_SUBJECT.test(c.subject) ? INTERNAL : topicOf(c.files);
		groups.set(topic, [...(groups.get(topic) ?? []), noteItem(c, owner)]);
	}
	const order = [...TOPICS.map(([topic]) => topic), OTHER].filter(topic => groups.has(topic));
	const sections = order.map(topic => `### ${topic}\n${groups.get(topic)!.map(subject => `- ${subject}`).join("\n")}`);
	if (!sections.length) sections.push("이번 버전에는 바뀐 기능이 없어요.");
	if (groups.has(INTERNAL)) sections.push(`내부 정리 ${groups.get(INTERNAL)!.length}건도 함께 들어갔어요.`);
	const note = scrub([`# dotz ${tag}`, ...sections].join("\n\n"), terms).text;
	return note.length > NOTE_MAX ? `${note.slice(0, note.lastIndexOf("\n", NOTE_MAX))}\n\n… 나머지는 커밋 기록을 봐 주세요.` : note;
}
