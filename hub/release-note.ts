// The note of a release (docs/releases.md): one item per commit since the previous tag, saying what changed, why, and how it behaves now.
// Commit messages are the only source, so the convention in CONTRIBUTING.md feeds it: body lines 왜: and 어떻게:. A commit without them says so.
import { scrub, type Term } from "./public-scrub.ts";

export type NoteCommit = { sha: string; subject: string; body: string; files: string[] };
export type NoteInput = { tag: string; previous: string | null; commits: readonly NoteCommit[]; terms: readonly Term[] };

export const NOTE_LOG_FORMAT = "%x1e%h%x1f%s%x1f%b%x1f";
const NO_WHY = "커밋에 이유가 적혀 있지 않아요.";
const NO_HOW = "커밋에 지금 동작이 적혀 있지 않아요.";
const FIELD_MAX = 600;
const NOTE_MAX = 120_000; // GitHub takes 125,000 characters in a release body
const INTERNAL = "내부 정리";
const OTHER = "그 밖의 변경";
const NOT_A_CHANGE = /^(?:release: |Merge )/;
const TRAILER = /^(?:Co-authored-by|Signed-off-by|Reviewed-by|Refs?|Fixes|Closes)\b/i;
const TEST_FILE = /\.test\.[jt]sx?$|(?:^|\/)(?:test|tests|fixtures)\//;
const LABELS: [field: "what" | "why" | "how", re: RegExp][] = [
	["what", /^(?:무엇|what)\s*:\s*/i],
	["why", /^(?:왜|why)\s*:\s*/i],
	["how", /^(?:어떻게|이제|how|now)\s*:\s*/i],
];
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
		const [sha, subject, body, files] = record.split("\x1f");
		return { sha: sha.trim(), subject: subject.trim(), body: body.trim(), files: files.split("\n").map(f => f.trim()).filter(Boolean) };
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

// Labelled lines go to their field and an unlabelled body to how: it is what the commit says it does, and a reason is never guessed from it.
function parseBody(body: string): { what: string; why: string; how: string } {
	const fields = { what: "", why: "", how: "" };
	let current: keyof typeof fields = "how";
	for (const raw of body.split("\n")) {
		let line = raw.trim();
		if (!line || TRAILER.test(line)) continue;
		const label = LABELS.find(([, re]) => re.test(line));
		if (label) {
			current = label[0];
			line = line.replace(label[1], "");
		}
		const bullet = line.startsWith("- ");
		fields[current] = fields[current] ? `${fields[current]}${bullet ? " / " : " "}${line.replace(/^- /, "")}` : line.replace(/^- /, "");
	}
	return fields;
}

const capped = (text: string) => (text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX - 1)}…` : text);

function item(c: NoteCommit): string {
	const { what, why, how } = parseBody(c.body);
	const bare = !what && !why && !how;
	return [
		`- **무엇**: ${c.subject} (${c.sha})${what ? ` ${capped(what)}` : ""}`,
		`  - **왜**: ${why ? capped(why) : NO_WHY}`,
		`  - **어떻게**: ${how ? capped(how) : bare ? `커밋 본문이 없어서 제목이 전부예요. 자세한 내용은 커밋 ${c.sha}를 봐 주세요.` : NO_HOW}`,
	].join("\n");
}

export function buildReleaseNote({ tag, previous, commits, terms }: NoteInput): string {
	// Scrubbed before fields are capped, so a cut can never leave part of a term behind.
	const changes = commits.filter(c => !NOT_A_CHANGE.test(c.subject)).map(c => ({ ...c, subject: scrub(c.subject, terms).text, body: scrub(c.body, terms).text }));
	const groups = new Map<string, NoteCommit[]>();
	for (const c of changes) groups.set(topicOf(c.files), [...(groups.get(topicOf(c.files)) ?? []), c]);
	const since = previous ? `이전 버전 ${previous} 이후` : "첫 버전까지";
	const head = changes.length ? `${since} 바뀐 것 ${changes.length}건이에요. 항목마다 무엇이, 왜, 어떻게 바뀌었는지 적었어요.` : "이번 버전에는 바뀐 기능이 없어요.";
	const order = [...TOPICS.map(([topic]) => topic), OTHER].filter(topic => groups.has(topic));
	const sections = order.map(topic => `### ${topic}\n${groups.get(topic)!.map(item).join("\n")}`);
	if (groups.has(INTERNAL)) sections.push(`### ${INTERNAL}\n${groups.get(INTERNAL)!.map(c => `- ${c.subject}`).join("\n")}`);
	const note = scrub([`# dotz ${tag}`, head, ...sections].join("\n\n"), terms).text;
	return note.length > NOTE_MAX ? `${note.slice(0, note.lastIndexOf("\n", NOTE_MAX))}\n\n… 나머지는 커밋 기록을 봐 주세요.` : note;
}
