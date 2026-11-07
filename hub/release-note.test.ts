import { describe, expect, test } from "bun:test";
import { buildReleaseNote, parseNoteCommits, type NoteCommit } from "./release-note.ts";

const FIXTURE: NoteCommit[] = [
	{ subject: "release: v261106.1", files: ["VERSION"] },
	{ subject: "Merge branch 'side'", files: ["hub/main.ts"] },
	{ subject: "메시지 재전송이 끊기지 않아요", files: ["hub/discord.ts", "hub/discord.test.ts"] },
	{ subject: "설정 화면 글자가 잘리지 않아요", files: ["web/js/22-settings.js"] },
	{ subject: "업데이트 실패를 알려요 (#59)", files: ["hub/selfupdate.ts"] },
	{ subject: "느린 시험을 고칩니다", files: ["hub/x.test.ts"] },
	{ subject: "내부 정리: 도우미를 새 파일로 옮겼어요", files: ["hub/main.ts", "hub/main-helpers.ts"] },
];
const note = (commits: NoteCommit[], terms: { value: string; label: string }[] = []) => buildReleaseNote({ tag: "v261106.2", commits, terms });

describe("buildReleaseNote", () => {
	test("each change is one plain line under its topic, with release and merge commits left out", () => {
		const lines = note(FIXTURE).split("\n");
		expect(lines[0]).toBe("# dotz v261106.2");
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("### 메신저");
		expect(lines).toContain("- 메시지 재전송이 끊기지 않아요");
		expect(lines).toContain("### 웹 앱");
		expect(lines).toContain("### 설치·업데이트");
		expect(lines.filter(l => l.startsWith("- "))).toHaveLength(3);
		expect(lines.filter(l => l.startsWith(" "))).toEqual([]);
		for (const line of lines) expect(line).not.toMatch(/\*\*|무엇|왜:|release: v|Merge branch/);
	});

	test("internal and test-only commits are one count, not lines of their own", () => {
		const text = note(FIXTURE);
		expect(text).not.toContain("도우미");
		expect(text).not.toContain("느린 시험");
		expect(text).not.toContain("### 내부 정리");
		expect(text.trimEnd().split("\n").at(-1)).toContain("2건");
	});

	test("a pull request number at the end of a subject is dropped", () => {
		expect(note(FIXTURE).split("\n")).toContain("- 업데이트 실패를 알려요");
	});

	test("personal values never reach the note, from the pattern list or the install's terms", () => {
		const text = note([{ subject: "개인 프로젝트 person@corp.test 메일이 /Users/someone/work/a.txt 를 mybox.tail1234.ts.net 호스트에서 ghp_abcdefghijklmnopqrstuvwxyz123456 없이 읽어요", files: ["hub/main.ts"] }], [{ value: "개인 프로젝트", label: "privacy list" }]);
		for (const value of ["개인 프로젝트", "person@corp.test", "/Users/someone", "tail1234", "ghp_"]) expect(text).not.toContain(value);
		expect(text).toContain("~/work/a.txt");
	});

	test("nothing to report still gives a note", () => {
		expect(note(FIXTURE.slice(0, 2))).toContain("이번 버전에는 바뀐 기능이 없어요.");
	});
});

test("parseNoteCommits reads the git log records and files", () => {
	const raw = "\x1e제목 하나\x1f\n\nhub/a.ts\nweb/b.js\n\x1e제목 둘\x1f\n\ndocs/c.md\n";
	expect(parseNoteCommits(raw)).toEqual([
		{ subject: "제목 하나", files: ["hub/a.ts", "web/b.js"] },
		{ subject: "제목 둘", files: ["docs/c.md"] },
	]);
});
