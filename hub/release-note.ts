// The note of a release (docs/releases.md): one patch-note line per user-visible commit since the previous tag, grouped by topic.
// Commit subjects are the only source, so the convention in CONTRIBUTING.md feeds it: a subject says what changed for a user. Internal work closes the note as one count.
import { scrub, type Term } from "./public-scrub.ts";

export type NoteCommit = { subject: string; files: string[] };
export type NoteInput = { tag: string; commits: readonly NoteCommit[]; terms: readonly Term[] };

export const NOTE_LOG_FORMAT = "%x1e%s%x1f";
const NOTE_MAX = 120_000; // GitHub takes 125,000 characters in a release body
const INTERNAL = "내부 정리";
const OTHER = "그 밖의 변경";
const NOT_A_CHANGE = /^(?:release: |Merge )/;
const INTERNAL_SUBJECT = /^내부 정리\s*:/;
const TICKET = /\s*\(#\d+\)$/;
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
		const [subject, files] = record.split("\x1f");
		return { subject: subject.trim(), files: files.split("\n").map(f => f.trim()).filter(Boolean) };
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

export function buildReleaseNote({ tag, commits, terms }: NoteInput): string {
	const groups = new Map<string, string[]>();
	for (const c of commits) {
		if (NOT_A_CHANGE.test(c.subject)) continue;
		const topic = INTERNAL_SUBJECT.test(c.subject) ? INTERNAL : topicOf(c.files);
		groups.set(topic, [...(groups.get(topic) ?? []), c.subject.replace(TICKET, "")]);
	}
	const order = [...TOPICS.map(([topic]) => topic), OTHER].filter(topic => groups.has(topic));
	const sections = order.map(topic => `### ${topic}\n${groups.get(topic)!.map(subject => `- ${subject}`).join("\n")}`);
	if (!sections.length) sections.push("이번 버전에는 바뀐 기능이 없어요.");
	if (groups.has(INTERNAL)) sections.push(`내부 정리 ${groups.get(INTERNAL)!.length}건도 함께 들어갔어요.`);
	const note = scrub([`# dotz ${tag}`, ...sections].join("\n\n"), terms).text;
	return note.length > NOTE_MAX ? `${note.slice(0, note.lastIndexOf("\n", NOTE_MAX))}\n\n… 나머지는 커밋 기록을 봐 주세요.` : note;
}
