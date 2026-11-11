import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../lib/cmd-analyze.ts";
import { ownText, readMessages, readSentMail } from "../lib/mailbox.ts";
import { readFolder } from "../lib/readers.ts";
import { addTarget, guardPath, guardUrl, OutOfScopeError, readScope, type Scope, type Target } from "../lib/targets.ts";
import { parseFeed, parseSitemap, readBlog } from "../lib/web.ts";
import { readDocs, writeNeeds } from "../lib/voices.ts";
import { noDeps, sized, tempDir, writeFiles } from "./synth.ts";

const MARK = "비밀표식문장입니다";

function twoFolders() {
	const root = tempDir();
	const inside = join(root, "inside");
	const outside = join(root, "outside");
	writeFiles(inside, { "a.md": sized("opinion", 300, 1), "b.txt": sized("story", 300, 2) });
	writeFiles(outside, { "c.md": `${MARK} ${sized("opinion", 300, 3)}` });
	return { root, state: join(root, "state"), inside, outside };
}

describe("말한 범위 안에서만 읽어요", () => {
	test("범위에 없는 파일은 열기 전에 실패하고, 바로가기로 나가는 길도 막혀요", () => {
		const { state, inside, outside } = twoFolders();
		symlinkSync(join(outside, "c.md"), join(inside, "link.md"));
		expect(addTarget(state, { type: "folder", kind: "self", path: inside, asked: false }).code).toBe(0);
		const scope = readScope(state);
		expect(guardPath(scope, join(inside, "a.md"))).toContain("a.md");
		expect(() => guardPath(scope, join(outside, "c.md"))).toThrow(OutOfScopeError);
		expect(() => guardPath(scope, join(inside, "link.md"))).toThrow(OutOfScopeError);
	});

	test("범위에 없는 폴더를 가리키는 대상은 읽다가 실패해요", async () => {
		const { state, inside, outside } = twoFolders();
		addTarget(state, { type: "folder", kind: "self", path: inside, asked: false });
		const stray: Target = { id: "x", type: "folder", kind: "self", voice: "me", path: outside, sentence: "" };
		await expect(readFolder(readScope(state), stray, noDeps(state).run)).rejects.toBeInstanceOf(OutOfScopeError);
	});

	test("analyze는 범위 안의 파일만 읽고 밖의 글은 어디에도 남기지 않아요", async () => {
		const { state, inside, outside } = twoFolders();
		symlinkSync(join(outside, "c.md"), join(inside, "link.md"));
		writeNeeds(state, ["medium-opinion"]);
		addTarget(state, { type: "folder", kind: "self", path: inside, asked: false });
		const out = await analyze(state, undefined, noDeps(state));
		expect(out.code).toBe(0);
		expect(readDocs(state, "me")).toHaveLength(2);
		expect(out.lines.join("\n")).toContain("2건 읽음");
		const all = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? all(join(dir, e.name)) : [readFileSync(join(dir, e.name), "utf8")]));
		expect(all(state).some(t => t.includes(MARK))).toBe(false);
	});

	test("analyze는 니즈가 없으면 먼저 정하라고 막아요", async () => {
		const { state, inside } = twoFolders();
		addTarget(state, { type: "folder", kind: "self", path: inside, asked: false });
		expect((await analyze(state, undefined, noDeps(state))).code).toBe(3);
	});
});

describe("물어야 하는 곳과 끝 없는 대상", () => {
	test("회사 메일은 --asked 없으면 종료 코드 3으로 거부하고 범위를 늘리지 않아요", () => {
		const state = tempDir();
		const refused = addTarget(state, { type: "mail", kind: "self", account: "kim@corp.example", asked: false });
		expect(refused.code).toBe(3);
		expect(readScope(state).targets).toEqual([]);
		expect(addTarget(state, { type: "mail", kind: "self", account: "kim@corp.example", asked: true }).code).toBe(0);
		expect(readScope(state).targets[0]?.sentence).toContain("회사 메일 kim@corp.example의 보낸 메일 최근 200통");
	});

	test("개인 메일은 바로 되고 문장에 건수가 들어가요", () => {
		const state = tempDir();
		const out = addTarget(state, { type: "mail", kind: "self", account: "hong@gmail.com", limit: "100", asked: false });
		expect(out.code).toBe(0);
		expect(out.lines[0]).toContain("개인 메일 hong@gmail.com의 보낸 메일 최근 100통");
	});

	test.each(["0", "all", "-5", "99999"])("끝 없는 범위(--limit %s)는 받지 않아요", limit => {
		expect(addTarget(tempDir(), { type: "blog", kind: "self", url: "https://blog.example.test/", limit, asked: false }).code).toBe(1);
	});

	test("limit이 없으면 기본값을 문장에 밝혀 적어요", () => {
		const out = addTarget(tempDir(), { type: "messages", kind: "self", asked: false });
		expect(out.lines[0]).toContain("최근 500개");
	});

	test("민감한 이름의 폴더는 묻고, 다른 사람의 메일은 받지 않아요", () => {
		const root = tempDir();
		const folder = join(root, "인사자료");
		writeFiles(folder, { "a.txt": sized("story", 100, 1) });
		expect(addTarget(join(root, "s"), { type: "folder", kind: "self", path: folder, asked: false }).code).toBe(3);
		const work = join(root, "회사 자료");
		writeFiles(work, { "a.txt": sized("story", 100, 1) });
		expect(addTarget(join(root, "s"), { type: "folder", kind: "self", path: work, asked: false }).code).toBe(3);
		expect(addTarget(join(root, "s"), { type: "mail", kind: "other", voice: "x", account: "a@gmail.com", asked: false }).code).toBe(1);
	});
});

describe("메일, 메시지, 블로그 읽기", () => {
	const thread = ["제목: 안내", "──────────", "From: 홍길동 <hong@gmail.com>", "To: 상대 <you@example.test>", "Date: 2026-01-01", "", "내일 두 시에 뵙겠습니다.", "> 이전 메일의 인용", "", "On Mon, 상대 wrote:", "예전 내용", "──────────", "From: 상대 <you@example.test>", "", "상대방이 쓴 글입니다."].join("\n");

	test("보낸 메일에서 내가 쓴 새 글만 뽑아요", () => {
		expect(ownText(thread, "hong@gmail.com")).toBe("내일 두 시에 뵙겠습니다.");
	});

	test("zele 목록과 읽기 결과를 주입한 실행기로 읽어요", async () => {
		const run = async (argv: string[]) => (argv[2] === "list" ? { code: 0, out: "items:\n  - id: t1\n" } : { code: 0, out: thread });
		const got = await readSentMail({ id: "m", type: "mail", kind: "self", voice: "me", account: "hong@gmail.com", limit: 5, sentence: "" }, run);
		expect(got.docs.map(d => [d.source, d.text])).toEqual([["mail", "내일 두 시에 뵙겠습니다."]]);
	});

	test("메시지는 최근 limit개만, 결정 답과 깨진 줄은 건너뛰어요", () => {
		const data = tempDir();
		const lines = ["{\"kind\":\"message\",\"ts\":\"a\",\"text\":\"첫 번째 메시지입니다\"}", "깨진줄", "{\"kind\":\"message\",\"text\":\"결정 답: 1) 보내기\"}", "{\"kind\":\"message\",\"ts\":\"b\",\"text\":\"두 번째 메시지입니다\"}", "{\"kind\":\"message\",\"ts\":\"c\",\"text\":\"세 번째 메시지입니다\"}"];
		writeFileSync(join(data, "inbox.jsonl"), `${lines.join("\n")}\n`);
		const got = readMessages(data, { id: "m", type: "messages", kind: "self", voice: "me", limit: 2, sentence: "" });
		expect(got.docs.map(d => d.text)).toEqual(["두 번째 메시지입니다", "세 번째 메시지입니다"]);
		expect(got.skipped["깨진 줄"]).toBe(1);
	});

	const rss = `<?xml version="1.0"?><rss><channel>${[1, 2, 3].map(i => `<item><title>글 ${i}</title><link>https://blog.example.test/p${i}</link><pubDate>2026-01-0${i}</pubDate><description><![CDATA[<p>${sized("opinion", 600, i).replace(/\n\n/g, "</p><p>")}</p>]]></description></item>`).join("")}</channel></rss>`;
	const target: Target = { id: "b", type: "blog", kind: "self", voice: "me", url: "https://blog.example.test/", limit: 2, sentence: "" };
	const scope: Scope = { targets: [target] };

	test("RSS에서 최근 글을 limit개만 읽고, 같은 호스트만 불러요", async () => {
		const asked: string[] = [];
		const got = await readBlog(scope, target, async url => (asked.push(url), rss));
		expect(got.docs.map(d => d.hint)).toEqual(["글 3", "글 2"]);
		expect(asked).toEqual(["https://blog.example.test/"]);
		expect(() => guardUrl(scope, "https://elsewhere.example.test/x")).toThrow(OutOfScopeError);
	});

	test("블로그 문장에 호스트와 경로가 들어가 어느 블로그인지 알 수 있어요", () => {
		const out = addTarget(tempDir(), { type: "blog", kind: "self", url: "https://blog.example.test/someid/", asked: false });
		expect(out.lines[0]).toContain("blog.example.test/someid 블로그의 글 최근 50개");
	});

	test("블로그의 하위 주소는 같은 블로그로 보고, 남의 호스트는 막아요", () => {
		expect(guardUrl(scope, "https://rss.blog.example.test/a.xml")).toBeDefined();
		expect(guardUrl(scope, "https://m.blog.example.test/a/1")).toBeDefined();
		for (const url of ["https://notblog.example.test/a", "https://example.test/a", "https://blog.example.test.evil.test/a"]) expect(() => guardUrl(scope, url)).toThrow(OutOfScopeError);
	});

	test("범위 밖 링크가 든 글 하나는 건너뛰고 세며, 나머지는 읽어요", async () => {
		const feed = rss.replace("https://blog.example.test/p2", "https://elsewhere.example.test/p2");
		const got = await readBlog(scope, { ...target, limit: 3 }, async () => feed);
		expect(got.docs.map(d => d.hint)).toEqual(["글 3", "글 1"]);
		expect(got.skipped["범위 밖 링크"]).toBe(1);
	});

	test("요약만 주는 피드는 글 페이지에서 본문을 읽고, 네이버는 모바일 주소를 써요", async () => {
		const naver: Target = { ...target, url: "https://blog.naver.com/someid", limit: 1 };
		const feed = "<rss><channel><item><title>짧은 요약</title><link>https://blog.naver.com/someid/123?fromRss=true</link><description>요약 한 줄입니다.</description></item></channel></rss>";
		const body = sized("story", 600, 4);
		const asked: string[] = [];
		const got = await readBlog({ targets: [naver] }, naver, async url => (asked.push(url), url.startsWith("https://m.blog.naver.com/") ? `<html><body><div>${body}</div></body></html>` : feed));
		expect(asked).toEqual(["https://blog.naver.com/someid", "https://m.blog.naver.com/someid/123"]);
		expect(got.docs[0]?.text.replace(/\s/g, "").length).toBeGreaterThanOrEqual(600);
	});

	test("글을 한 편도 못 찾으면 0건이라 하지 않고 사이트 이름을 대며 알려요", async () => {
		await expect(readBlog(scope, target, async () => "<rss><channel></channel></rss>")).rejects.toThrow("blog.example.test");
		await expect(readBlog(scope, target, async () => { throw new Error("응답 404"); })).rejects.toThrow("blog.example.test");
	});

	test("읽기에 실패한 대상의 이전 글은 지우지 않고 실패는 종료 코드에 남아요", async () => {
		const state = tempDir();
		writeNeeds(state, ["medium-opinion"]);
		addTarget(state, { type: "blog", kind: "self", url: "https://blog.example.test/", limit: "3", asked: false });
		let reachable = true;
		const deps = { ...noDeps(state), fetchText: async (): Promise<string> => { if (!reachable) throw new Error("연결 끊김"); return rss; } };
		expect((await analyze(state, undefined, deps)).code).toBe(0);
		expect(readDocs(state, "me")).toHaveLength(3);
		reachable = false;
		const again = await analyze(state, undefined, deps);
		expect(again.code).toBe(1);
		expect(again.lines.join("\n")).toContain("읽지 못했어요");
		expect(readDocs(state, "me")).toHaveLength(3);
	});

	test("영어·코드가 더 많은 메시지는 건너뛰고 세요", () => {
		const data = tempDir();
		const lines = [{ kind: "message", ts: "a", text: "const x = await fetch(url); return x.json();" }, { kind: "message", ts: "b", text: "오늘은 일찍 퇴근해서 산책을 했어요 ok" }];
		writeFileSync(join(data, "inbox.jsonl"), `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
		const got = readMessages(data, { id: "m", type: "messages", kind: "self", voice: "me", sentence: "" });
		expect(got.docs.map(d => d.key)).toEqual(["b#1"]);
		expect(got.skipped["영어·코드 위주"]).toBe(1);
	});

	test("피드와 사이트맵 파서", () => {
		expect(parseFeed(rss)).toHaveLength(3);
		expect(parseFeed("<feed><entry><title>t</title><link rel=\"alternate\" href=\"https://x.test/a\"/><content>본문</content></entry></feed>")[0]?.link).toBe("https://x.test/a");
		expect(parseSitemap("<urlset><url><loc>https://x.test/a</loc><lastmod>2026-01-01</lastmod></url></urlset>")).toEqual([{ loc: "https://x.test/a", lastmod: "2026-01-01" }]);
	});
});
