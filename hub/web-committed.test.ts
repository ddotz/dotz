import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "./runtime/test-clock.ts";
import { publishedWeb, resetPublishedWeb } from "./web-committed.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const saved = { live: process.env.DOTZ_WEB_LIVE, debounce: process.env.DOTZ_WEB_DEBOUNCE_MS, dir: process.env.DOTZ_WEB_DIR };
let repo = "";
let n = 0;
const write = (rel: string, text: string) => writeFileSync(join(repo, "web", rel), text);
const commit = (js: string) => { write("js/01-app.js", `"use strict";\n${js}\n`); sh(repo, "commit", "-qam", js); };
const tick = (ms = 5000) => { clock.now += ms; };

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), "dotz-web-committed-"));
	mkdirSync(join(repo, "web", "js"), { recursive: true });
	mkdirSync(join(repo, "web", "css"));
	sh(repo, "init", "-q", "-b", "main");
	sh(repo, "config", "user.email", "t@t");
	sh(repo, "config", "user.name", "t");
	write("css/01-app.css", "body{}\n");
	write("index.html", "<html>v1</html>");
	write("js/01-app.js", '"use strict";\nv1\n');
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "v1");
	process.env.DOTZ_WEB_LIVE = "0";
	process.env.DOTZ_WEB_DEBOUNCE_MS = "0";
	process.env.DOTZ_WEB_DIR = join(repo, "web");
	resetPublishedWeb();
});
afterAll(() => {
	for (const [k, v] of [["DOTZ_WEB_LIVE", saved.live], ["DOTZ_WEB_DEBOUNCE_MS", saved.debounce], ["DOTZ_WEB_DIR", saved.dir]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	resetPublishedWeb();
	rmSync(repo, { recursive: true, force: true });
});

describe("committed web build", () => {
	test("an uncommitted edit changes neither the served shell nor web_build; a commit changes both once", async () => {
		const { webBuild, bundle, indexPage } = await import("./webapp.ts?committed");
		const page = async () => (await indexPage(new Request("http://hub/"))).text();
		const build1 = webBuild();
		expect(bundle("js").text).toContain("v1");
		expect(await page()).toBe("<html>v1</html>");

		write("js/01-app.js", '"use strict";\nHALF-FINISHED\n');
		write("js/02-new.js", "untracked();\n");
		write("css/01-app.css", "body{color:red}\n");
		write("index.html", "<html>WIP</html>");
		tick();
		expect(webBuild()).toBe(build1);
		expect(bundle("js").text).toContain("v1");
		expect(bundle("js").text).not.toContain("HALF-FINISHED");
		expect(bundle("js").text).not.toContain("untracked");
		expect(bundle("css").text).toBe("body{}\n");
		expect(await page()).toBe("<html>v1</html>");

		sh(repo, "add", "-A");
		sh(repo, "commit", "-qm", "v2");
		tick();
		const build2 = webBuild();
		expect(build2).not.toBe(build1);
		expect(build2).toMatch(/^[0-9a-f]{12}$/);
		expect(bundle("js").text).toContain("HALF-FINISHED");
		expect(bundle("js").text).toContain(`const WEB_BUILD = "${build2}";`);
		expect(await page()).toBe("<html>WIP</html>");
		tick();
		expect(webBuild()).toBe(build2);
	});

	test("commits inside the debounce window count as one version", () => {
		process.env.DOTZ_WEB_DEBOUNCE_MS = "60000";
		const first = publishedWeb(repo)!;
		commit("v3");
		tick(5000);
		expect(publishedWeb(repo)!.tree).toBe(first.tree);
		commit("v4");
		tick(30_000);
		expect(publishedWeb(repo)!.tree).toBe(first.tree);
		tick(61_000);
		const last = publishedWeb(repo)!;
		expect(last.tree).not.toBe(first.tree);
		expect(last.files.get("js/01-app.js")).toContain("v4");
		process.env.DOTZ_WEB_DEBOUNCE_MS = "0";
	});

	test("a commit that leaves web/ alone announces nothing", () => {
		const before = publishedWeb(repo)!.tree;
		writeFileSync(join(repo, "other.txt"), `${++n}`);
		sh(repo, "add", "other.txt");
		sh(repo, "commit", "-qm", "other");
		tick();
		expect(publishedWeb(repo)!.tree).toBe(before);
	});

	test("the disk is the source outside git and with DOTZ_WEB_LIVE=1", () => {
		const plain = mkdtempSync(join(tmpdir(), "dotz-web-plain-"));
		try {
			mkdirSync(join(plain, "web", "js"), { recursive: true });
			expect(publishedWeb(plain)).toBeUndefined();
		} finally { rmSync(plain, { recursive: true, force: true }); }
		process.env.DOTZ_WEB_LIVE = "1";
		try { expect(publishedWeb(repo)).toBeUndefined(); } finally { process.env.DOTZ_WEB_LIVE = "0"; }
	});

	test("a commit that moves VERSION is not served: the process keeps the snapshot it started on", () => {
		const before = publishedWeb(repo)!;
		write("js/01-app.js", '"use strict";\nNEEDS-NEW-SERVER\n');
		writeFileSync(join(repo, "VERSION"), "261111.2\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-qm", "release");
		tick(120_000);
		const after = publishedWeb(repo)!;
		expect(after.tree).toBe(before.tree);
		expect(after.files.get("js/01-app.js")).not.toContain("NEEDS-NEW-SERVER");
	});

});

describe("web commits and the server side of the process", () => {
	let r2 = "";
	const put2 = (rel: string, text: string) => { mkdirSync(join(r2, rel, ".."), { recursive: true }); writeFileSync(join(r2, rel), text); };
	const commit2 = (msg: string) => { sh(r2, "add", "-A"); sh(r2, "commit", "-qm", msg); tick(); };
	const served = () => publishedWeb(r2)!.files.get("js/01-app.js")!;
	beforeAll(() => {
		r2 = mkdtempSync(join(tmpdir(), "dotz-web-hub-"));
		sh(r2, "init", "-q", "-b", "main");
		sh(r2, "config", "user.email", "t@t");
		sh(r2, "config", "user.name", "t");
		put2("VERSION", "261111.1\n");
		put2("hub/main.ts", "export const v = 1;\n");
		put2("web/js/01-app.js", '"use strict";\nSTART\n');
		commit2("start");
		process.env.DOTZ_WEB_DIR = join(r2, "web");
		resetPublishedWeb();
	});
	afterAll(() => { resetPublishedWeb(); rmSync(r2, { recursive: true, force: true }); });

	test("a commit that changes only web/ is served as before", () => {
		expect(served()).toContain("START");
		put2("web/js/01-app.js", '"use strict";\nWEB-ONLY\n');
		commit2("web only");
		expect(served()).toContain("WEB-ONLY");
	});

	test("a commit that changes hub/ and web/ with the same VERSION keeps the web file the process started with, and so do later web commits", () => {
		put2("hub/main.ts", "export const v = 2;\n");
		put2("web/js/01-app.js", '"use strict";\nNEEDS-NEW-HUB\n');
		commit2("hub and web");
		expect(served()).toContain("WEB-ONLY");
		expect(served()).not.toContain("NEEDS-NEW-HUB");
		put2("web/js/01-app.js", '"use strict";\nLATER-WEB\n');
		commit2("web again");
		expect(served()).toContain("WEB-ONLY");
		expect(served()).not.toContain("LATER-WEB");
	});
});
