import { existsSync, readdirSync } from "node:fs";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "../bin/voice.ts";
import { readDocs } from "../lib/voices.ts";
import { readBlog } from "../lib/web.ts";
import { OutOfScopeError, readScope, type Target } from "../lib/targets.ts";
import { noDeps, sized, tempDir, writeFiles } from "./synth.ts";

const setup = () => {
	const base = tempDir();
	const root = join(base, "state");
	return { base, root, call: (...argv: string[]) => run(argv, root, noDeps(base)) };
};

test("check와 learn은 없는 --voice를 새 목소리로 만들지 않고, --voice 없는 첫 learn은 돼요", async () => {
	const { base, root, call } = setup();
	writeFiles(base, { "bot.txt": "골목 가게 앞에 낙엽이 쌓였다.", "fix.txt": "동네 가게 앞에 낙엽이 쌓였다." });
	const bot = join(base, "bot.txt");
	const fix = join(base, "fix.txt");
	const typoCheck = await call("check", "--result", bot, "--voice", "오타");
	const typoLearn = await call("learn", "--before", bot, "--after", fix, "--voice", "오타", "--cell", "short-story");
	expect([typoCheck.code, typoLearn.code]).toEqual([1, 1]);
	expect(existsSync(join(root, "voices", "오타"))).toBe(false);
	expect((await call("learn", "--before", bot, "--after", fix, "--cell", "short-story")).code).toBe(0);
});

const folderWith = (base: string, name: string) => {
	const dir = join(base, name);
	writeFiles(dir, { "a.md": sized("opinion", 300, 1), "b.md": sized("opinion", 300, 2), "c.md": sized("opinion", 300, 3) });
	return dir;
};

test("같은 목소리에 내 글과 다른 사람 글 대상을 섞어 더할 수 없어요", async () => {
	const { base, root, call } = setup();
	const mine = folderWith(base, "mine");
	const theirs = folderWith(base, "theirs");
	expect((await call("scope", "add", "--type", "folder", "--path", mine, "--voice", "작가")).code).toBe(0);
	const mixed = await call("scope", "add", "--type", "folder", "--path", theirs, "--voice", "작가", "--kind", "other");
	expect(mixed.code).toBe(1);
	expect(readScope(root).targets).toHaveLength(1);
});

test("예전 scope.json에 섞여 있어도 analyze는 그 목소리를 읽지 않고 글을 저장하지 않아요", async () => {
	const { base, root, call } = setup();
	const mine = folderWith(base, "mine");
	const theirs = folderWith(base, "theirs");
	await call("needs", "add", "--cell", "medium-opinion");
	await call("scope", "add", "--type", "folder", "--path", mine, "--voice", "a");
	await call("scope", "add", "--type", "folder", "--path", theirs, "--voice", "b", "--kind", "other");
	const scope = readScope(root);
	const mixedScope = { targets: scope.targets.map(t => ({ ...t, voice: "a" })) };
	await Bun.write(join(root, "scope.json"), JSON.stringify(mixedScope));
	const out = await call("analyze");
	expect(out.code).toBe(1);
	expect(out.lines.join("\n")).toContain("섞여");
	expect(existsSync(join(root, "voices", "a", "texts")) ? readdirSync(join(root, "voices", "a", "texts")) : []).toEqual([]);
	expect(readDocs(root, "a")).toEqual([]);
});

test("피드 링크가 다른 호스트면 그 대상만 실패로 세고 다른 대상은 계속 읽어요", async () => {
	const { base, root } = setup();
	const folder = folderWith(base, "mine");
	const page = '<html><head><link rel="alternate" type="application/rss+xml" href="https://feeds.example.test/me"></head></html>';
	const deps = { ...noDeps(base), fetchText: async () => page };
	const call = (...argv: string[]) => run(argv, root, deps);
	await call("needs", "add", "--cell", "medium-opinion");
	await call("scope", "add", "--type", "blog", "--url", "https://blog.example.test/");
	await call("scope", "add", "--type", "folder", "--path", folder);
	const out = await call("analyze");
	expect(out.code).toBe(1);
	expect(out.lines.join("\n")).toContain("글 목록을 읽지 못했어요");
	expect(readDocs(root, "me")).toHaveLength(3);
	const blog: Target = { id: "b", type: "blog", kind: "self", voice: "me", url: "https://blog.example.test/", limit: 5, sentence: "" };
	await expect(readBlog({ targets: [blog] }, blog, async () => page)).rejects.not.toBeInstanceOf(OutOfScopeError);
});

test("마지막 대상을 빼도 저장된 글이 남아 있으면 status는 analyze를 말하고, 지운 뒤에는 말하지 않아요", async () => {
	const { base, call } = setup();
	const folder = folderWith(base, "mine");
	const next = async () => (await call("status")).lines.at(-1) ?? "";
	await call("needs", "add", "--cell", "medium-opinion");
	await call("scope", "add", "--type", "folder", "--path", folder);
	await call("analyze");
	const [target] = readScope(join(base, "state")).targets;
	await call("scope", "remove", target?.id ?? "");
	expect(await next()).toContain("analyze");
	await call("analyze");
	expect(await next()).toContain("discover");
});
