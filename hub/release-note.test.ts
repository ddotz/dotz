import { describe, expect, test } from "bun:test";
import { buildReleaseNote, parseNoteCommits, type NoteCommit } from "./release-note.ts";

const FIXTURE: NoteCommit[] = [
	{ sha: "aaa1111", subject: "release: v261106.1", body: "바뀐 것 2건", files: ["VERSION"] },
	{ sha: "bbb2222", subject: "Merge branch 'side'", body: "", files: ["hub/main.ts"] },
	{ sha: "ccc3333", subject: "메시지 재전송이 끊기지 않아요", body: "왜: 재시작 뒤 보낸 답이 사라졌어요.\n어떻게: 이제 재시작 뒤에도\n순서대로 다시 보내요.\n\nCo-authored-by: Someone <someone@users.noreply.github.com>\nRefs #44", files: ["hub/discord.ts", "hub/discord.test.ts"] },
	{ sha: "ddd4444", subject: "설정 화면 글자가 잘리지 않아요", body: "", files: ["web/js/22-settings.js"] },
	{ sha: "eee5555", subject: "업데이트 실패를 알려요", body: "실패하면 알림으로 이유를 보여 줘요.\n- 되돌린 버전도 같이 적어요", files: ["hub/selfupdate.ts"] },
	{ sha: "fff6666", subject: "느린 시험을 고칩니다", body: "왜: 시험이 시간에 기댔어요.", files: ["hub/x.test.ts"] },
];
const note = (commits: NoteCommit[], terms: { value: string; label: string }[] = []) => buildReleaseNote({ tag: "v261106.2", previous: "v261106.1", commits, terms });

describe("buildReleaseNote", () => {
	test("each change says what, why and how, grouped by topic, with release and merge commits left out", () => {
		const text = note(FIXTURE);
		expect(text).not.toContain("release: v261106.1");
		expect(text).not.toContain("Merge branch");
		expect(text).toContain("### 메신저");
		expect(text).toContain("### 웹 앱");
		expect(text).toContain("### 설치·업데이트");
		expect(text).toContain("- **무엇**: 메시지 재전송이 끊기지 않아요 (ccc3333)");
		expect(text).toContain("  - **왜**: 재시작 뒤 보낸 답이 사라졌어요.");
		expect(text).toContain("  - **어떻게**: 이제 재시작 뒤에도 순서대로 다시 보내요.");
		expect(text).not.toContain("Co-authored-by");
		expect(text).not.toContain("Refs #44");
	});

	test("a commit without a body says so instead of inventing a reason", () => {
		const text = note(FIXTURE);
		const item = text.slice(text.indexOf("설정 화면 글자가"));
		expect(item).toContain("**왜**: 커밋에 이유가 적혀 있지 않아요.");
		expect(item).toContain("**어떻게**: 커밋 본문이 없어서 제목이 전부예요. 자세한 내용은 커밋 ddd4444를 봐 주세요.");
	});

	test("an unlabelled body is kept as the how, with no reason made up", () => {
		const item = note(FIXTURE).split("eee5555")[1];
		expect(item).toContain("**왜**: 커밋에 이유가 적혀 있지 않아요.");
		expect(item).toContain("**어떻게**: 실패하면 알림으로 이유를 보여 줘요. / 되돌린 버전도 같이 적어요");
	});

	test("a test-only commit goes to the internal list as one line", () => {
		const text = note(FIXTURE);
		expect(text).toContain("### 내부 정리\n- 느린 시험을 고칩니다");
		expect(text.split("### 내부 정리")[1]).not.toContain("**왜**");
	});

	test("personal values never reach the note, from the pattern list or the install's terms", () => {
		const text = note([{ sha: "abc1234", subject: "개인 프로젝트 값 정리", body: "왜: person@corp.test 메일이 /Users/someone/work/a.txt 를 못 읽었어요.\n어떻게: mybox.tail1234.ts.net 호스트에서 ghp_abcdefghijklmnopqrstuvwxyz123456 토큰 없이 돌아요.", files: ["hub/main.ts"] }], [{ value: "개인 프로젝트", label: "privacy list" }]);
		for (const value of ["개인 프로젝트", "person@corp.test", "/Users/someone", "tail1234", "ghp_"]) expect(text).not.toContain(value);
		expect(text).toContain("~/work/a.txt");
	});

	test("a term cut by the field limit does not leave a part behind", () => {
		const body = `왜: ${"가".repeat(590)} 비밀단어입니다`;
		const text = note([{ sha: "abc1234", subject: "긴 본문", body, files: ["hub/main.ts"] }], [{ value: "비밀단어", label: "privacy list" }]);
		expect(text).not.toContain("비밀");
	});

	test("nothing to report still gives a note", () => {
		expect(note(FIXTURE.slice(0, 2))).toContain("이번 버전에는 바뀐 기능이 없어요.");
	});
});

test("parseNoteCommits reads the git log records, bodies and files", () => {
	const raw = "\x1eabc1234\x1f제목 하나\x1f왜: 이유\n어떻게: 동작\n\x1f\n\nhub/a.ts\nweb/b.js\n\x1edef5678\x1f제목 둘\x1f\x1f\n\ndocs/c.md\n";
	expect(parseNoteCommits(raw)).toEqual([
		{ sha: "abc1234", subject: "제목 하나", body: "왜: 이유\n어떻게: 동작", files: ["hub/a.ts", "web/b.js"] },
		{ sha: "def5678", subject: "제목 둘", body: "", files: ["docs/c.md"] },
	]);
});
