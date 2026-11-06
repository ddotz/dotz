// The web composer (web/js/14-slash-commands.js sendChat): "/" plus a word that is no command is sent as a message, with its files
// and reply; a real command still goes to /api/command, and the page's own /terminal and /screen stay exact words. Phone and desktop.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ev, fakeHub, inbox, run, waitFor, type View } from "./test-web.ts";

type Post = { to: string; text: string; files?: { name: string }[]; reply?: { id: string } };
const posts = inbox<Post>();
const hub = fakeHub({
	api: async (req, url) => {
		if (req.method !== "POST" || !["/api/message", "/api/command"].includes(url.pathname)) return undefined;
		posts.push({ to: url.pathname, ...((await req.json()) as Omit<Post, "to">) });
		return Response.json({ ok: true, output: "됨", card: { title: "됨", facts: [], text: "됨" } });
	},
});
afterAll(() => hub.stop());
beforeEach(() => { posts.length = 0; });

const PATH = "/Users/me/Downloads/분기 자료/2026년 2분기 자료/ 이거 자료파일 관리하는데 어떻게 할까";
const open = async (width: number): Promise<View> => {
	const v = await hub.view({ width, height: 800 }, "/");
	await waitFor(v, `typeof sendChat === "function" && !ta.disabled`);
	return v;
};
const send = async (v: View, text: string): Promise<Post> => {
	const n = posts.length;
	await run(v, `ta.value = ${JSON.stringify(text)}; sendChat();`);
	await posts.until(p => p.length > n);
	return posts[n]!;
};
const FILE = `ATT = [{ id: "a1", no: 1, name: "a.xlsx", file: { name: "a.xlsx", type: "text/plain", path: "/tmp/a.xlsx", size: 1 } }];`;

describe.each([1280, 390])("at %ipx", width => {
	test.each([PATH, "/tmp 폴더 정리해줘", "/foo bar", "/tmp/a.txt", "/screen 지금 봐줘", "/Terminal 열어줘"])("%s is sent as a message", async text => {
		expect(await send(await open(width), text)).toMatchObject({ to: "/api/message", text });
	}, 30_000);

	test("an unknown word keeps its files and reply", async () => {
		const v = await open(width);
		await run(v, `${FILE} RP.cur = { t: target, id: "m1", author: "나", content: "앞 메시지" };`);
		const post = await send(v, "/foo bar");
		expect(post.to).toBe("/api/message");
		expect(post.files?.[0]?.name).toBe("a.xlsx");
		expect(post.reply?.id).toBe("m1");
	}, 30_000);

	test("a real command still goes to the gateway, and refuses a file", async () => {
		const v = await open(width);
		expect(await send(v, "/status")).toMatchObject({ to: "/api/command", text: "/status" });
		await run(v, `${FILE} ta.value = "/status"; sendChat();`);
		expect(await ev<string>(v, "ta.value")).toBe("/status");
		expect(await ev<number>(v, "ATT.length")).toBe(1);
		expect(posts).toHaveLength(1);
	}, 30_000);
});
