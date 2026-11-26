import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, waitFor } from "../hub/test-web.ts";

// The public demo is static, so it picks its language from the visitor's language list (navigator.languages) or ?lang=: Korean for ko,
// English for everything else. Headless Bun.WebView on the committed demo files, served from a temp port; nothing here touches the owner's browser.
const ROOT = join(import.meta.dir);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		let p = new URL(req.url).pathname;
		if (p.endsWith("/")) p += "index.html";
		const f = Bun.file(join(ROOT, p));
		return f.size ? new Response(f) : new Response("not found", { status: 404 });
	},
});
afterAll(() => server.stop(true));

const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => { for (const v of views) v.close(); });

const pick = (tags: string[], query?: string) => {
	const win: Record<string, any> = {};
	new Function("window", readFileSync(join(ROOT, "demo", "demo-lang.js"), "utf8"))(win);
	return win.dotzDemoLang.pick(tags, query) as string;
};

test.each([
	[["en-US", "ko"], undefined, "en"],
	[["ko-KR", "en"], undefined, "ko"],
	[["ja"], undefined, "en"],
	[[], undefined, "ko"],
	[["ko-KR"], "en", "en"],
	[["en-US"], "ko", "ko"],
])("the demo picks its language from %j with ?lang=%j: %s", (tags, query, lang) => {
	expect(pick(tags, query)).toBe(lang);
});

const open = async (query: string) => {
	const v = new Bun.WebView({ width: 1280, height: 800 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/demo/${query}`);
	await waitFor(v, `typeof go === "function" && NM.loaded`);
	return v;
};
const read = async (v: InstanceType<typeof Bun.WebView>, expr: string) => JSON.parse((await v.evaluate(`JSON.stringify(${expr})`)) as string);

test("an English request gets the English page, bar and screen text", async () => {
	const v = await open("?lang=en");
	await run(v, `go("update")`);
	await waitFor(v, `document.querySelector("#update .btn.inrow")`);
	expect(await read(v, `I18N_LANG`)).toBe("en");
	expect(await read(v, `[document.documentElement.lang, document.querySelector("meta[name=description]").content, document.querySelector(".demo-tag").textContent, document.querySelector(".demo-back").textContent]`)).toEqual(["en", "Try the dotz web app yourself.", "Demo", "Back to site"]);
	expect(await read(v, `document.querySelector("#update").innerText`)).not.toMatch(/[가-힣]/);
	expect(await read(v, `document.body.innerHTML.includes("{{")`)).toBe(false);
});

test("a Korean request keeps the Korean page", async () => {
	const v = await open("?lang=ko");
	await run(v, `go("update")`);
	await waitFor(v, `document.querySelector("#update .btn.inrow")`);
	expect(await read(v, `I18N_LANG`)).toBe("ko");
	expect(await read(v, `[document.documentElement.lang, document.querySelector("meta[name=description]").content, document.querySelector(".demo-tag").textContent, document.querySelector(".demo-back").textContent]`)).toEqual(["ko", "dotz 웹 앱을 직접 써 보는 데모예요.", "데모", "랜딩으로"]);
	expect(await read(v, `document.querySelector("#update").innerText`)).toContain("앱 버전");
});

// The demo's own content (fixtures, scripted conversation) follows the same pick: an English visitor sees no Korean on the screens the fixtures fill.
const viewText = (v: InstanceType<typeof Bun.WebView>, view: string) => read(v, `document.getElementById("v-${view}").innerText`);
const filled = (view: string, word: string) => `document.getElementById("v-${view}").innerText.includes(${JSON.stringify(word)})`;

test("an English request gets English chat, notices and project content", async () => {
	const v = await open("?lang=en");
	await waitFor(v, filled("chat", "Sort my mail"));
	expect(await viewText(v, "chat")).not.toMatch(/[가-힣]/);
	await run(v, `go("notices")`);
	await waitFor(v, filled("notices", "Choose the release notice format"));
	expect(await viewText(v, "notices")).not.toMatch(/[가-힣]/);
	await run(v, `go("projects")`);
	await waitFor(v, filled("projects", "Form document automation"));
	expect(await viewText(v, "projects")).not.toMatch(/[가-힣]/);
});

test("an English visitor's own message gets an English scripted reply", async () => {
	const v = await open("?lang=en");
	await run(v, `fetch("/api/message", { method: "POST", body: JSON.stringify({ text: "Sort my mail" }) })`);
	await waitFor(v, filled("chat", "to reply to"));
	expect(await viewText(v, "chat")).not.toMatch(/[가-힣]/);
});

test("a Korean request keeps the Korean chat content", async () => {
	const v = await open("?lang=ko");
	await waitFor(v, filled("chat", "메일 정리해 줘"));
	expect(await viewText(v, "chat")).toContain("dotz 데모예요");
});
