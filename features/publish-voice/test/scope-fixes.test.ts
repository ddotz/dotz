import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { run } from "../bin/voice.ts";
import { walkFolder } from "../lib/folders.ts";
import { readFolder } from "../lib/readers.ts";
import { readScope, sameSite, type Target } from "../lib/targets.ts";
import { rootPaths } from "../lib/store.ts";
import { readBlog, realFetch } from "../lib/web.ts";
import { readDocs, readHashes, readProfile, readText } from "../lib/voices.ts";
import type { Deps } from "../lib/deps.ts";
import { noDeps, sized, tempDir, writeFiles } from "./synth.ts";

const MARK = "표식문장입니다";
const blogTarget: Target = { id: "b", type: "blog", kind: "self", voice: "me", url: "https://blog.example.test/@me", limit: 10, sentence: "" };

test("경로가 있는 블로그는 사이트맵에서 그 경로 아래 글만 읽어요", async () => {
	const urls = ["/@me/a", "/@me/b", "/@mentor/c", "/@other/d", "/@me", "/"].map(p => `https://blog.example.test${p}`);
	const sitemap = `<urlset>${urls.map(loc => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
	const fetchText = async (url: string) => (url.endsWith("/sitemap.xml") ? sitemap : url === blogTarget.url ? "<html></html>" : `<html><body>${sized("story", 300, 1)}</body></html>`);
	const got = await readBlog({ targets: [blogTarget] }, blogTarget, fetchText);
	expect(got.docs.map(d => d.key).sort()).toEqual(["https://blog.example.test/@me/a", "https://blog.example.test/@me/b"]);
	const none = { ...blogTarget, url: "https://blog.example.test/@nobody" };
	await expect(readBlog({ targets: [none] }, none, fetchText)).rejects.toThrow("글을 한 편도");
});

test("www.는 양쪽에서 무시하고, 다른 호스트는 같은 사이트로 보지 않아요", () => {
	expect(sameSite("www.blog.example.test", "blog.example.test")).toBe(true);
	expect(sameSite("blog.example.test", "www.blog.example.test")).toBe(true);
	expect(sameSite("m.blog.example.test", "www.blog.example.test")).toBe(true);
	expect(sameSite("blog.example.test.evil.test", "blog.example.test")).toBe(false);
});

test("리다이렉트는 같은 사이트 안에서 5번까지만 따라가고, 밖으로 나가는 길은 요청도 보내지 않아요", async () => {
	let outside = 0;
	const elsewhere = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (outside++, new Response("다른 곳 글")) });
	const site = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: req => {
			const { pathname } = new URL(req.url);
			const hop = /^\/hop(\d+)$/.exec(pathname);
			if (hop) return Number(hop[1]) >= 8 ? new Response("끝에 닿은 글") : Response.redirect(`http://127.0.0.1:${site.port}/hop${Number(hop[1]) + 1}`, 302);
			if (pathname === "/away") return Response.redirect(`http://localhost:${elsewhere.port}/`, 302);
			return new Response("같은 곳 글");
		},
	});
	const at = (path: string) => `http://127.0.0.1:${site.port}${path}`;
	try {
		expect(await realFetch(at("/hop3"))).toBe("끝에 닿은 글");
		await expect(realFetch(at("/hop2"))).rejects.toThrow("hop2");
		await expect(realFetch(at("/away"))).rejects.toThrow("localhost");
		expect(outside).toBe(0);
	} finally {
		await Promise.all([site.stop(true), elsewhere.stop(true)]);
	}
});

const sensitiveFolder = () => {
	const base = tempDir();
	const folder = join(base, "texts");
	writeFiles(folder, { "a.md": `${MARK} ${sized("opinion", 300, 1)}`, "b.txt": sized("story", 300, 2), "급여표.txt": `${MARK}숨김 ${sized("story", 300, 3)}` });
	writeFiles(join(folder, "인사"), { "c.md": sized("guide", 300, 4) });
	return { base, folder, root: join(base, "state") };
};

test("민감해 보이는 하위 경로의 파일은 --asked 없으면 세지도 읽지도 않고, walk와 read가 같은 수를 봐요", async () => {
	const { folder, root, base } = sensitiveFolder();
	expect(walkFolder(folder, false)).toMatchObject({ sensitive: 2 });
	expect(walkFolder(folder, false).files).toHaveLength(2);
	expect(walkFolder(folder, true)).toMatchObject({ sensitive: 0 });
	expect(walkFolder(folder, true).files).toHaveLength(4);
	await run(["needs", "add", "--cell", "medium-opinion"], root, noDeps(base));
	expect((await run(["scope", "add", "--type", "folder", "--path", folder], root, noDeps(base))).code).toBe(0);
	expect(readScope(root).targets[0]?.asked).toBeUndefined();
	const out = await run(["analyze"], root, noDeps(base));
	expect(out.code).toBe(0);
	expect(readDocs(root, "me")).toHaveLength(2);
	expect(out.lines.join("\n")).not.toContain("숨김");
	const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile());
	expect(files.some(e => readFileSync(join(e.parentPath, e.name), "utf8").includes(`${MARK}숨김`))).toBe(false);
});

test("--asked로 더한 폴더는 민감해 보이는 파일도 읽고, 이 사실이 대상에 남아요", async () => {
	const { folder, root, base } = sensitiveFolder();
	await run(["needs", "add", "--cell", "medium-opinion"], root, noDeps(base));
	await run(["scope", "add", "--type", "folder", "--path", folder, "--asked"], root, noDeps(base));
	const target = readScope(root).targets[0];
	expect(target?.asked).toBe(true);
	const read = await readFolder(readScope(root), target as Target, noDeps(base).run);
	expect(read.docs).toHaveLength(4);
	expect(read.skipped).toEqual({});
});

test("고른 폴더 자신의 이름이 민감해도 그 아래 파일은 이름 때문에 두 번 빠지지 않아요", async () => {
	const base = tempDir();
	const folder = join(base, "회사 자료");
	writeFiles(folder, { "a.txt": sized("story", 300, 1) });
	const root = join(base, "state");
	expect((await run(["scope", "add", "--type", "folder", "--path", folder], root, noDeps(base))).code).toBe(3);
	expect((await run(["scope", "add", "--type", "folder", "--path", folder, "--asked"], root, noDeps(base))).code).toBe(0);
	expect(walkFolder(folder, false).sensitive).toBe(0);
});

const feedOf = (n: number) =>
	`<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>글 ${i}</title><link>https://blog.example.test/p${i}</link><pubDate>2026-01-0${i + 1}</pubDate><description><![CDATA[<p>${sized("opinion", 600, i + 1)}</p>]]></description></item>`).join("")}</channel></rss>`;

function blogAndFolder() {
	const { folder, base, root } = sensitiveFolder();
	let reachable = true;
	const deps: Deps = { ...noDeps(base), fetchText: async () => { if (!reachable) throw new Error("연결 끊김"); return feedOf(3); } };
	return { folder, base, root, deps, cut: () => { reachable = false; }, call: (...argv: string[]) => run(argv, root, deps) };
}

test("범위에서 뺀 대상의 글은 analyze가 지우되, 고친 글은 남겨요", async () => {
	const { folder, root, call } = blogAndFolder();
	await call("needs", "add", "--cell", "medium-opinion");
	await call("scope", "add", "--type", "folder", "--path", folder, "--asked");
	expect(readDocs(root, "me")).toHaveLength(0);
	await call("analyze");
	writeFiles(join(folder, ".."), { "bot.txt": "골목 가게 앞에 낙엽이 쌓였다.", "fixed.txt": "동네 가게 앞에 낙엽이 쌓였다." });
	await call("learn", "--before", join(folder, "..", "bot.txt"), "--after", join(folder, "..", "fixed.txt"), "--cell", "medium-opinion");
	const before = readDocs(root, "me");
	expect(before.filter(d => d.origin === "scope")).toHaveLength(4);
	const ids = before.filter(d => d.origin === "scope").map(d => d.id);
	const [target] = readScope(root).targets;
	expect((await call("scope", "remove", target?.id ?? "")).code).toBe(0);
	const purged = await call("analyze");
	expect(purged.code).toBe(0);
	const after = readDocs(root, "me");
	expect(after.map(d => d.origin)).toEqual(["learn"]);
	expect(ids.some(id => readText(root, "me", id) !== "" || id in readHashes(root, "me"))).toBe(false);
	expect(readProfile(root, "me")?.docs).toBe(1);
});

test("범위도 저장된 글도 없으면 analyze는 지금처럼 실패해요", async () => {
	const { call } = blogAndFolder();
	await call("needs", "add", "--cell", "medium-opinion");
	expect((await call("analyze")).code).toBe(1);
});

test("읽지 못한 대상은 이전 글을 지키고, 빠진 대상의 글은 지우며, status의 다음: 줄이 이를 알려요", async () => {
	const { folder, root, call, cut } = blogAndFolder();
	const next = async () => (await call("status")).lines.at(-1) ?? "";
	const stamp = (offsetMs: number) => {
		const at = new Date(Date.parse(readProfile(root, "me")?.builtAt ?? "") + offsetMs);
		utimesSync(rootPaths(root).scope, at, at);
	};
	await call("needs", "add", "--cell", "medium-opinion");
	await call("scope", "add", "--type", "blog", "--url", "https://blog.example.test/", "--limit", "3");
	await call("scope", "add", "--type", "folder", "--path", folder, "--asked");
	expect((await call("analyze")).code).toBe(0);
	expect(readDocs(root, "me")).toHaveLength(7);
	stamp(-60_000);
	expect(await next()).toContain("준비됐어요");

	const folderId = readScope(root).targets.find(t => t.type === "folder")?.id ?? "";
	await call("scope", "remove", folderId);
	cut();
	expect((await call("analyze")).code).toBe(1);
	expect(readDocs(root, "me")).toHaveLength(3);
	stamp(-60_000);
	expect(existsSync(rootPaths(root).lastRun)).toBe(true);
	expect(await next()).not.toContain("준비됐어요");
});
