import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPublishedWeb } from "./web-committed.ts";

// A release folder without git: the web files and VERSION sit side by side, and an update replaces them under a running process.
const saved = { live: process.env.DOTZ_WEB_LIVE, dir: process.env.DOTZ_WEB_DIR };
const roots: string[] = [];
let n = 0;
const put = (root: string, rel: string, text: string) => writeFileSync(join(root, rel), text);
const site = (root: string, version: string, js: string, html: string) => {
	put(root, "VERSION", `${version}\n`);
	put(root, "web/js/01-app.js", `"use strict";\n${js}\n`);
	put(root, "web/css/01-app.css", "body{}\n");
	put(root, "web/index.html", html);
	put(root, "web/sw.js", `// sw ${version}\n`);
	put(root, "web/i18n/ko/app.json", "{}");
	put(root, "web/i18n/en/app.json", "{}");
};
// A gateway that starts on `version`: its web module reads the files at import, like the real one at start.
async function start(version: string, js: string, html: string) {
	const root = mkdtempSync(join(tmpdir(), "dotz-web-pinned-"));
	roots.push(root);
	for (const d of ["web/js", "web/css", "web/i18n/ko", "web/i18n/en"]) mkdirSync(join(root, d), { recursive: true });
	site(root, version, js, html);
	process.env.DOTZ_WEB_LIVE = "0";
	process.env.DOTZ_WEB_DIR = join(root, "web");
	resetPublishedWeb();
	const web = await import(`./webapp.ts?pinned${++n}`);
	const get = async (path: string) => (await web.appAsset(new Request(`http://hub${path}`), path)!).text();
	const page = async () => (await web.indexPage(new Request("http://hub/"))).text();
	return { root, web, get, page };
}
afterAll(() => {
	for (const [k, v] of [["DOTZ_WEB_LIVE", saved.live], ["DOTZ_WEB_DIR", saved.dir]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	resetPublishedWeb();
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("a running gateway keeps the web app it started on", () => {
	test("files replaced by another version change nothing it serves, and its build id stays the one the page runs", async () => {
		const { root, web, get, page } = await start("261111.1", "const A_PAGE = 1;", "<html>A</html>");
		const buildA = web.webBuild();
		const jsA = await get("/app.js");
		expect(jsA).toContain(`const WEB_BUILD = "${buildA}";`);
		expect(jsA).toContain("const I18N_LANG");

		rmSync(join(root, "web", "js", "01-app.js"));
		site(root, "261111.2", "const B_PAGE = I18N_NEW_ONLY;", "<html>B</html>");
		writeFileSync(join(root, "web", "js", "02-new.js"), "const B_ONLY = 1;\n");

		const jsAfter = await get("/app.js");
		expect(jsAfter).toBe(jsA);
		expect(() => new Function(jsAfter)).not.toThrow();
		expect(await page()).toBe("<html>A</html>");
		expect(web.committedText("sw.js")).toBe("// sw 261111.1\n");
		expect(web.webBuild()).toBe(buildA);
	});

	test("an edit with the same version shows on the next load", async () => {
		const { root, web, get, page } = await start("261111.1", "const A_PAGE = 1;", "<html>A</html>");
		const buildA = web.webBuild();
		put(root, "web/js/01-app.js", '"use strict";\nconst A_PAGE = 2;\n');
		put(root, "web/index.html", "<html>A2</html>");
		const js = await get("/app.js");
		expect(js).toContain("A_PAGE = 2");
		expect(await page()).toBe("<html>A2</html>");
		expect(web.webBuild()).not.toBe(buildA);
	});
});
