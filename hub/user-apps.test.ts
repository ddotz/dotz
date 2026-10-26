// User apps (hub/user-apps.ts): a manifest that loads, one that does not (with its reason, never a crash), a duplicate id, a
// non-loopback web url, the off switch and 제거.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appHealth, loadUserApps, loopbackOrigin, parseUserApp, removeUserApp, setUserAppOff, userApp } from "./user-apps.ts";

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "user-apps-")); dirs.push(d); return d; };
const manifest = (d: string, id: string, v: unknown) => {
	mkdirSync(join(d, "custom/apps", id), { recursive: true });
	writeFileSync(join(d, "custom/apps", id, "app.json"), typeof v === "string" ? v : JSON.stringify(v));
	return d;
};
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("manifest validation", () => {
	test("a tool app with a loopback url loads with its defaults", () => {
		const d = manifest(fresh(), "mydocs", { label: "문서 도구", kind: "tool", icon: "file", web: { url: "http://127.0.0.1:4417", mode: "rewrite" }, start: { command: "bun src/server.ts", cwd: "~/Code/my-docs" } });
		const { apps, errors } = loadUserApps(d);
		expect(errors).toEqual([]);
		expect(apps).toHaveLength(1);
		expect(apps[0]).toMatchObject({ id: "mydocs", label: "문서 도구", kind: "tool", icon: "file", health: "/", order: 100, off: false, web: { url: "http://127.0.0.1:4417", path: "/", mode: "rewrite" }, start: { command: "bun src/server.ts", cwd: "~/Code/my-docs" } });
	});

	test("a break in one manifest is its own error; the others still load", () => {
		const d = fresh();
		manifest(d, "broken", "{ not json");
		manifest(d, "good", { label: "좋은 앱", kind: "monitor" });
		manifest(d, "nolabel", { kind: "tool", web: { url: "http://127.0.0.1:1234" } });
		manifest(d, "noweb", { label: "웹 없음", kind: "tool" });
		const { apps, errors } = loadUserApps(d);
		expect(apps.map(a => a.id)).toEqual(["good"]);
		expect(errors.map(e => e.id)).toEqual(["broken", "nolabel", "noweb"]);
		expect(errors[0]!.reason).toContain("JSON");
		expect(errors[1]!.reason).toContain("label");
		expect(errors[2]!.reason).toContain("web.url");
	});

	test("a missing app.json and a folder name that is not an id are errors too", () => {
		const d = fresh();
		mkdirSync(join(d, "custom/apps", "empty"), { recursive: true });
		mkdirSync(join(d, "custom/apps", "Bad_Name"), { recursive: true });
		const { apps, errors } = loadUserApps(d);
		expect(apps).toEqual([]);
		expect(errors.map(e => e.id)).toEqual(["Bad_Name", "empty"]);
		expect(errors[0]!.reason).toContain("폴더 이름은 [a-z0-9-]");
		expect(errors[1]!.reason).toBe("app.json이 없어요");
	});

	test("a manifest that reuses a shipped app's id is an error, not a second 메일", () => {
		const d = manifest(fresh(), "mail", { label: "내 메일", kind: "tool", web: { url: "http://127.0.0.1:1234" } });
		const { apps, errors } = loadUserApps(d, ["mail", "kakao"]);
		expect(apps).toEqual([]);
		expect(errors[0]!.reason).toContain("이미 있어요");
		expect(loadUserApps(d).apps.map(a => a.id)).toEqual(["mail"]);
	});

	test("a manifest's own id must equal its folder", () => {
		const d = manifest(fresh(), "docs", { id: "mydocs", label: "문서", kind: "monitor" });
		expect(loadUserApps(d).errors[0]!.reason).toContain("폴더 이름");
	});

	test("non-loopback, https, a path in web.url, login info and a bad health path are refused", () => {
		expect(loopbackOrigin("http://example.com:4417").error).toContain("이 컴퓨터");
		expect(loopbackOrigin("http://127.0.0.1:4417/open").error).toContain("경로");
		expect(loopbackOrigin("http://user:pw@127.0.0.1:4417").error).toContain("로그인");
		expect(loopbackOrigin("https://127.0.0.1:4417").error).toContain("http://");
		expect(loopbackOrigin("http://localhost:4417/").origin).toBe("http://localhost:4417");
		expect(loopbackOrigin("http://[::1]:4417").origin).toBe("http://[::1]:4417");
		for (const url of ["http://10.0.0.5:4417", "http://192.168.0.5:4417", "http://macmini:4417"]) {
			const d = manifest(fresh(), "far", { label: "멀리", kind: "tool", web: { url } });
			expect(loadUserApps(d).errors[0]!.reason).toContain("이 컴퓨터");
		}
		expect(parseUserApp("x", JSON.stringify({ label: "x", kind: "monitor", health: "health" }))).toContain("health");
	});

	test("kind, order, watches and settings are checked as data", () => {
		expect(parseUserApp("x", JSON.stringify({ label: "x", kind: "web" }))).toContain("kind");
		expect(parseUserApp("x", JSON.stringify({ label: "x", kind: "monitor", order: "first" }))).toContain("order");
		expect(parseUserApp("x", JSON.stringify({ label: "x", kind: "monitor", watches: "w" }))).toContain("watches");
		expect(parseUserApp("x", JSON.stringify({ label: "x", kind: "monitor", settings: { a: {} } }))).toContain("settings");
		const ok = parseUserApp("x", JSON.stringify({ label: "x", kind: "monitor", watches: ["mydocs-"], settings: { port: 4417, on: true } }));
		expect(ok).toMatchObject({ watches: ["mydocs-"], settings: { port: 4417, on: true } });
	});
});

describe("switch and removal", () => {
	test("끄기 writes custom/apps.json next to the app instances' own entries and leaves the manifest alone", () => {
		const d = manifest(fresh(), "mydocs", { label: "문서 도구", kind: "tool", web: { url: "http://127.0.0.1:4417" } });
		mkdirSync(join(d, "custom"), { recursive: true });
		writeFileSync(join(d, "custom/apps.json"), JSON.stringify({ mail: { off: true } }));
		setUserAppOff(d, "mydocs", true);
		expect(JSON.parse(readFileSync(join(d, "custom/apps.json"), "utf8"))).toEqual({ mail: { off: true }, mydocs: { off: true } });
		expect(userApp(d, "mydocs")!.off).toBe(true);
		setUserAppOff(d, "mydocs", false);
		expect(JSON.parse(readFileSync(join(d, "custom/apps.json"), "utf8"))).toEqual({ mail: { off: true } });
		expect(existsSync(join(d, "custom/apps/mydocs/app.json"))).toBe(true);
	});

	test("제거 moves the folder to custom/apps-removed and the app disappears", () => {
		const d = manifest(fresh(), "mydocs", { label: "문서 도구", kind: "tool", web: { url: "http://127.0.0.1:4417" } });
		setUserAppOff(d, "mydocs", true);
		const r = removeUserApp(d, "mydocs")!;
		expect(existsSync(join(d, "custom/apps/mydocs"))).toBe(false);
		expect(existsSync(join(r.kept, "app.json"))).toBe(true);
		expect(r.kept).toContain("custom/apps-removed/");
		expect(loadUserApps(d).apps).toEqual([]);
		expect(JSON.parse(readFileSync(join(d, "custom/apps.json"), "utf8"))).toEqual({});
		expect(removeUserApp(d, "mydocs")).toBeUndefined();
	});
});

describe("health", () => {
	test("answers of a loopback server read as running; a closed port as unreachable", async () => {
		const up = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => new URL(req.url).pathname === "/ok" ? new Response("ok") : new Response("not found", { status: 404 }) });
		const app = { ...(parseUserApp("h", JSON.stringify({ label: "h", kind: "tool", web: { url: `http://127.0.0.1:${up.port}` }, health: "/ok" })) as object), id: "h", dir: "", off: false } as never;
		expect((await appHealth(app)).status).toBe("running");
		const missing = { ...(app as Record<string, unknown>), id: "gone", web: { url: "http://127.0.0.1:1", path: "/", mode: "prefix" } } as never;
		expect((await appHealth(missing)).status).toBe("unreachable");
		up.stop(true);
	});
});
