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

	test("a commit with 왜:/어떻게: is one or two plain sentences, from its body or inlined in its subject", () => {
		const body = "왜: 재시작하면 보내던 답이 대기열과 함께 없어졌어요. 사용자가 다시 물어야 했어요.\n어떻게: 대기열을 hub/queue.ts에 남겨요.";
		const items = note([
			{ subject: "재시작 뒤에도 보내던 답이 사라지지 않아요", body, files: ["hub/discord.ts"] },
			{ subject: "다음 메일 템플릿 제거 왜: 커스텀 메일 연결로 충분해요. 어떻게: 템플릿 파일을 지웠어요. (#12)", files: ["docs/a.md"] },
			{ subject: "버튼 폭을 고쳐요", body: "왜: 글자가 잘렸어요\n\nCo-Authored-By: someone", files: ["web/a.js"] },
		]).split("\n").filter(l => l.startsWith("- "));
		expect(items).toEqual([
			"- 재시작 뒤에도 보내던 답이 사라지지 않아요. 재시작하면 보내던 답이 대기열과 함께 없어졌어요.",
			"- 버튼 폭을 고쳐요. 글자가 잘렸어요.",
			"- 다음 메일 템플릿 제거. 커스텀 메일 연결로 충분해요.",
		]);
		for (const item of items) {
			expect(item).not.toMatch(/왜:|어떻게:/);
			expect(item.match(/[.!?](?=\s|$)/g)?.length ?? 0).toBeLessThanOrEqual(2);
		}
	});

	test("a 왜: sentence wrapped over lines is taken whole, never cut at a line break", () => {
		// Bodies of two real commits whose reasons came out as "...보였고,." in a release note.
		const wrapped: NoteCommit[] = [
			{ subject: "사용량 한도 알림의 초기화 남은 시간을 내림해 한국어로 표시", body: "왜: 채팅/알림과 usage CLI의 한도 문구는 남은 시간을 반올림해 6일 23시간 59분이 7d0h로 보였고,\n웹 사용량 화면(6일 23시간)과 단위와 값이 달랐다.\n\n어떻게: 남은 시간을 웹 화면과 같은 규칙으로 내림해 두 단위까지 쓴다(6일 23시간 뒤 초기화,\n3시간 12분, 59분), 지난 초기화는 \"초기화 중\".", files: ["hub/usage.ts"] },
			{ subject: "사용량 화면에 Claude 요금제 이름과 내림한 초기화 남은 시간 표시", body: "왜: 사용량 상세 화면이 구독 요금제(Pro, Max 5x, Max 20x, Ultra 등)를 구분하지 않았고,\n초기화까지 남은 시간을 반올림해 6일 23시간이 7일로 보였다.\n\n어떻게: 남은 시간은 내림해 두 단위로만 쓴다.", files: ["web/a.js"] },
			{ subject: "끊긴 이유는 싣지 않아요", body: "왜: 이 문장은 끝나지 않고,\n\n어떻게: 이것도 끝나지 않고,", files: ["web/b.js"] },
		];
		const items = note(wrapped).split("\n").filter(l => l.startsWith("- "));
		expect(items).toEqual([
			"- 사용량 화면에 Claude 요금제 이름과 내림한 초기화 남은 시간 표시. 사용량 상세 화면이 구독 요금제(Pro, Max 5x, Max 20x, Ultra 등)를 구분하지 않았고, 초기화까지 남은 시간을 반올림해 6일 23시간이 7일로 보였다.",
			"- 끊긴 이유는 싣지 않아요",
			"- 사용량 한도 알림의 초기화 남은 시간을 내림해 한국어로 표시. 채팅/알림과 usage CLI의 한도 문구는 남은 시간을 반올림해 6일 23시간 59분이 7d0h로 보였고, 웹 사용량 화면(6일 23시간)과 단위와 값이 달랐다.",
		]);
		for (const item of items) expect(item).not.toMatch(/[,;:]\s*\.?$/);
	});

	test("a 왜: inside a sentence is text; only a label at the start of a line starts a part", () => {
		const body = "왜: 줄바꿈으로 감싼 왜: 본문은 첫 문장이 첫 줄에서 잘렸어요.\n어떻게: 첫 문단을 한 줄로 이어 붙여요.";
		const items = note([{ subject: "이유 문장이 끊기지 않아요", body, files: ["hub/a.ts"] }]).split("\n").filter(l => l.startsWith("- "));
		expect(items).toEqual(["- 이유 문장이 끊기지 않아요. 줄바꿈으로 감싼 왜: 본문은 첫 문장이 첫 줄에서 잘렸어요."]);
	});

	test("a code name in brackets goes with its brackets, and the sentence around it stays", () => {
		const items = note([
			{ subject: "앱바 단추(.ib)가 넓어져요", body: "왜: 앱바 아이콘 단추(.ib)는 그려진 크기만큼만 눌렸어요.", files: ["web/a.js"] },
			{ subject: "앱 목록을 한 번만 불러와요", body: "왜: 같은 앱 목록(GET /api/integrations)을 세 번 요청했어요.", files: ["web/a.js"] },
			{ subject: "입구 검사를 더해요", body: "왜: 보안 검토(transport.md 1, 2, 7)에서 헤더를 위조할 수 있었어요.", files: ["web/a.js"] },
			{ subject: "답이 사라지지 않아요", body: "왜: 대기열(hub/queue.ts)이 재시작 때 비었어요.", files: ["web/a.js"] },
			{ subject: "글자가 더 잘 읽혀요", body: "왜: 보조 글자(--fg-3), 주황(--warn) 글자가 4.5:1에 못 미쳤어요.", files: ["web/a.js"] },
			{ subject: "이유가 괄호뿐이에요", body: "왜: (transport.md).", files: ["web/a.js"] },
			{ subject: "사용량 카드에서 제목만 굵게 보여요", body: "왜: 제목(Claude 구독)과 한도 값(64% 남음)이 모두 굵었어요.", files: ["web/a.js"] },
		]).split("\n").filter(l => l.startsWith("- "));
		expect(items).toEqual([
			"- 앱바 단추가 넓어져요. 앱바 아이콘 단추는 그려진 크기만큼만 눌렸어요.",
			"- 앱 목록을 한 번만 불러와요. 같은 앱 목록을 세 번 요청했어요.",
			"- 입구 검사를 더해요. 보안 검토에서 헤더를 위조할 수 있었어요.",
			"- 답이 사라지지 않아요. 대기열이 재시작 때 비었어요.",
			"- 글자가 더 잘 읽혀요. 보조 글자, 주황 글자가 4.5:1에 못 미쳤어요.",
			"- 이유가 괄호뿐이에요",
			"- 사용량 카드에서 제목만 굵게 보여요. 제목(Claude 구독)과 한도 값(64% 남음)이 모두 굵었어요.",
		]);
	});

	test("a reason woven around a code name gives way to the plain title, and product names are not code", () => {
		const woven = [
			"43-panes-drag.js에서 너비를 재요.",
			".tag·.mon-ptag는 바탕 없이 점과 글자예요.",
			"알림으로 연 세션은 ntKeep에 기억해 둬요.",
			"설정은 dotz_watch로 넣어요.",
			"열 때마다 refresh()를 세 번 불렀어요.",
			"같은 목록을 /api/integrations에서 세 번 읽었어요.",
			"숫자 배지는 --fs-tag 크기로 맞췄어요.",
		];
		const plain = "Discord와 Cloudflare, iCloud 메일, macOS의 Node.js 설치에서도 /context 결과와 11/16 크기 숫자를 글로만 봤어요.";
		const commits = [...woven, plain].map((why, i) => ({ subject: `바뀐 점 ${i + 1}이에요`, body: `왜: ${why}`, files: ["web/a.js"] }));
		const items = note(commits).split("\n").filter(l => l.startsWith("- "));
		expect(items).toEqual([...woven.map((_, i) => `- 바뀐 점 ${i + 1}이에요`), `- 바뀐 점 ${woven.length + 1}이에요. ${plain}`]);
	});

	test("a reason that retells the conversation behind a change gives way to the plain title", () => {
		const subject = "넓은 창에서 대화와 프로젝트를 2~4칸으로 나란히 열 수 있어요";
		const body = "왜: 형이 tmux처럼 대화창을 나눠 보고 싶어 했고, 칸 단위로 화면 코드를 다시 짜기로 했어요.";
		expect(note([{ subject, body, files: ["web/a.js"] }]).split("\n").filter(l => l.startsWith("- "))).toEqual([`- ${subject}`]);
	});

	test("a reason naming who asked or what was settled in chat is dropped, and one about what the app does stays", () => {
		const retold = [
			"오너가 칸을 나눠 보자고 했어요.",
			"The owner asked for side-by-side panes.",
			"사용자가 칸을 나눠 달라고 요청했어요.",
			"사용자가 대화창을 나란히 보기를 원했어요.",
			"사용자가 칸이 좁다고 말했어요.",
			"대화창을 나눠 보고 싶어 했어요.",
			"칸 단위로 화면을 다시 짜기로 했어요.",
			"사용자 요청으로 칸 나누기를 더했어요.",
			"칸 나누기는 디자인팀이 요청했어요.",
			"지난번에 말한 대로 칸을 나눴어요.",
		];
		const product = ["사용자가 고른 칸이 유지돼요.", "사용자가 원하는 만큼 칸을 열 수 있어요."];
		const commits = [...retold, ...product].map((why, i) => ({ subject: `바뀐 점 ${i + 1}이에요`, body: `왜: ${why}`, files: ["web/a.js"] }));
		const items = note(commits).split("\n").filter(l => l.startsWith("- "));
		expect(items).toEqual([...retold.map((_, i) => `- 바뀐 점 ${i + 1}이에요`), ...product.map((why, i) => `- 바뀐 점 ${retold.length + i + 1}이에요. ${why}`)]);
	});

	test("a reason naming how this install's owner is addressed is dropped, never a word that holds the address", () => {
		const commits = ["형이 칸을 나눠 보자고 했어요.", "형님께 보낸 답이 비어 있었어요.", "칸 형태가 창 폭에 맞지 않았어요."].map((why, i) => ({ subject: `바뀐 점 ${i + 1}이에요`, body: `왜: ${why}`, files: ["web/a.js"] }));
		const items = (address?: string) => buildReleaseNote({ tag: "v261110.1", commits, terms: [], address }).split("\n").filter(l => l.startsWith("- "));
		expect(items("형")).toEqual(["- 바뀐 점 1이에요", "- 바뀐 점 2이에요", "- 바뀐 점 3이에요. 칸 형태가 창 폭에 맞지 않았어요."]);
		expect(items()[0]).toBe("- 바뀐 점 1이에요. 형이 칸을 나눠 보자고 했어요.");
	});

	test("nothing to report still gives a note", () => {
		expect(note(FIXTURE.slice(0, 2))).toContain("이번 버전에는 바뀐 기능이 없어요.");
	});
});

test("parseNoteCommits reads the git log records and files", () => {
	const raw = "\x1e제목 하나\x1d왜: 이유예요.\n어떻게: 이렇게요.\n\x1f\n\nhub/a.ts\nweb/b.js\n\x1e제목 둘\x1d\x1f\n\ndocs/c.md\n";
	expect(parseNoteCommits(raw)).toEqual([
		{ subject: "제목 하나", body: "왜: 이유예요.\n어떻게: 이렇게요.", files: ["hub/a.ts", "web/b.js"] },
		{ subject: "제목 둘", body: "", files: ["docs/c.md"] },
	]);
});
