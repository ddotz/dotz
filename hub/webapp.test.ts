import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appAsset, bundle, moduleFiles } from "./webapp.ts";

describe("web app modules", () => {
	test("the joined script compiles as one classic script", () => {
		expect(moduleFiles("js").length).toBeGreaterThan(10);
		expect(() => new Function(bundle("js").text)).not.toThrow();
	});

	test("/app.js and /app.css are served with an ETag and answer 304 when unchanged", async () => {
		for (const [path, type] of [["/app.js", "text/javascript"], ["/app.css", "text/css"]]) {
			const res = appAsset(new Request(`http://x${path}`), path);
			expect(res?.status).toBe(200);
			expect(res?.headers.get("content-type")).toContain(type);
			expect((await res?.text())?.length).toBeGreaterThan(1000);
			const etag = res?.headers.get("etag") ?? "";
			expect(appAsset(new Request(`http://x${path}`, { headers: { "if-none-match": etag } }), path)?.status).toBe(304);
		}
		expect(appAsset(new Request("http://x/other.js"), "/other.js")).toBeUndefined();
	});

	test("the notification bell is in the shell and its module and styles are served", async () => {
		const html = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");
		expect(html).toContain('id="bell"');
		expect(await appAsset(new Request("http://x/app.js"), "/app.js")?.text()).toContain("function openNotices");
		expect(await appAsset(new Request("http://x/app.css"), "/app.css")?.text()).toContain(".nt-panel");
	});
});
