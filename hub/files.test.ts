// Upload storage, the read-only file route's guards (roots, traversal, symlinks, secrets), Range, and the live-lane rule.
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowedRoots, attachmentLines, canvasRoute, FileError, messageFiles, resolveAllowed, safeName, saveUpload, ownerFiles, serveFile, UPLOADS, uploadsFrom } from "./files.ts";
import { isTempLane } from "./lanes.ts";

const DATA = process.env.DOTZ_DIR!;
const ROOT = join(DATA, "fixtures-root");
mkdirSync(join(ROOT, "sub"), { recursive: true });
writeFileSync(join(ROOT, "sub", "a.txt"), "0123456789");
writeFileSync(join(DATA, "outside.txt"), "nope");
writeFileSync(join(ROOT, "anthropic-api-key"), "x");
symlinkSync(join(DATA, "outside.txt"), join(ROOT, "link.txt"));

const status = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		return e instanceof FileError ? e.status : -1;
	}
	return 200;
};

test("safeName keeps Korean, drops path parts and dotfile prefixes", () => {
	expect(safeName("../../etc/passwd")).toBe("passwd");
	expect(safeName("수업 자료 (1).pdf")).toBe("수업 자료 _1_.pdf");
	expect(safeName(".env")).toBe("env");
	expect(safeName("")).toBe("file");
});

test("uploads are stored under the uploads dir and the size limit holds", async () => {
	const up = await saveUpload(new File(["hello"], "note.txt", { type: "text/plain" }));
	expect(up.path.startsWith(UPLOADS)).toBe(true);
	expect(await Bun.file(up.path).text()).toBe("hello");
	expect(up).toMatchObject({ name: "note.txt", size: 5 });
	await expect(saveUpload(new File(["x".repeat(20)], "big.bin"), UPLOADS, 10)).rejects.toMatchObject({ status: 413 });
	const form = new FormData();
	form.append("file", new File(["a"], "one.png", { type: "image/png" }));
	form.append("file", new File(["b"], "two.txt"));
	const got = await uploadsFrom(new Request("http://x/api/upload", { method: "POST", body: form }));
	expect(got.map(f => f.name)).toEqual(["one.png", "two.txt"]);
	expect(attachmentLines(got).split("\n")[0]).toBe(`[attachment] one.png (image/png) ${got[0].path}`);
	expect(messageFiles([{ path: got[0].path, name: "one.png" }, { path: join(DATA, "outside.txt") }]).map(f => f.name)).toEqual(["one.png"]);
});

test("the file route serves only regular files inside allowed roots", () => {
	const roots = allowedRoots([ROOT, DATA, "/"]);
	expect(roots.some(r => r.endsWith("/fixtures-root"))).toBe(true);
	expect(roots).not.toContain("/");
	expect(roots.some(r => r.endsWith("/data"))).toBe(false);
	expect(status(() => resolveAllowed(join(ROOT, "sub", "a.txt"), roots))).toBe(200);
	expect(status(() => resolveAllowed(join(ROOT, "sub", "..", "..", "outside.txt"), roots))).toBe(403);
	expect(status(() => resolveAllowed(join(ROOT, "link.txt"), roots))).toBe(403);
	expect(status(() => resolveAllowed(join(ROOT, "anthropic-api-key"), roots))).toBe(403);
	expect(status(() => resolveAllowed(join(ROOT, "missing.txt"), roots))).toBe(404);
	expect(status(() => resolveAllowed(join(ROOT, "sub"), roots))).toBe(400);
	expect(status(() => resolveAllowed("sub/a.txt", roots))).toBe(400);
});

test("serveFile sets type, disposition and answers byte ranges", async () => {
	const p = resolveAllowed(join(ROOT, "sub", "a.txt"), allowedRoots([ROOT]));
	const full = serveFile(p, new Request("http://x"));
	expect(full.headers.get("content-type")).toContain("text/plain");
	expect(full.headers.get("content-disposition")).toStartWith("inline;");
	expect(full.headers.get("content-security-policy")).toContain("sandbox");
	expect(serveFile(p, new Request("http://x"), true).headers.get("content-disposition")).toStartWith("attachment;");
	const part = serveFile(p, new Request("http://x", { headers: { range: "bytes=2-4" } }));
	expect(part.status).toBe(206);
	expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
	expect(await part.text()).toBe("234");
	const tail = serveFile(p, new Request("http://x", { headers: { range: "bytes=-3" } }));
	expect(await tail.text()).toBe("789");
	expect(serveFile(p, new Request("http://x", { headers: { range: "bytes=50-" } })).status).toBe(416);
});

test("an HTML page runs its own script only in an opaque, offline sandbox; other files stay script-free", () => {
	writeFileSync(join(ROOT, "flow.html"), "<div id=app></div><script>app.textContent='built'</script>");
	const csp = canvasRoute(new Request("http://x"), new URL(`http://x/api/canvas?path=${encodeURIComponent(join(ROOT, "flow.html"))}`), allowedRoots([ROOT]), new Set()).headers.get("content-security-policy") ?? "";
	expect(csp).toStartWith("sandbox allow-scripts;");
	expect(csp).not.toContain("allow-same-origin");
	expect(csp).toContain("script-src 'self' 'unsafe-inline'");
	expect(csp).toContain("connect-src 'none'");
	expect(serveFile(join(ROOT, "sub", "a.txt"), new Request("http://x")).headers.get("content-security-policy")).toStartWith("sandbox; default-src 'none';");
});

test("a canvas page gets the picker bridge only with pick=1, and never loses its length", async () => {
	writeFileSync(join(ROOT, "bridge.html"), "<!doctype html><html><body><p>hi</p></body></html>");
	writeFileSync(join(ROOT, "bare.html"), "<p>hi</p>");
	const at = (name: string, q: string) => canvasRoute(new Request("http://x"), new URL(`http://x/api/canvas?path=${encodeURIComponent(join(ROOT, name))}${q}`), allowedRoots([ROOT]), new Set());
	const plain = await at("bridge.html", "").text();
	expect(plain).toBe("<!doctype html><html><body><p>hi</p></body></html>");
	const res = at("bridge.html", "&pick=1");
	const page = await res.text();
	expect(page).toContain("<p>hi</p>");
	expect(page).toContain("dotz-pick");
	expect(page.indexOf("dotz-pick")).toBeGreaterThan(page.indexOf("<p>hi</p>"));
	expect(page.endsWith("</body></html>")).toBe(true);
	expect(res.headers.get("content-length")).toBe(String(new TextEncoder().encode(page).byteLength));
	expect(res.headers.get("content-security-policy")).toContain("connect-src 'none'");
	expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
	const bare = await at("bare.html", "&pick=1").text();
	expect(bare.startsWith("<p>hi</p>")).toBe(true);
	expect(bare).toContain("dotz-pick");
});

test("temp-folder lanes never count as live projects", () => {
	expect(isTempLane({ cwd: "/tmp/dotz-fix5-block" })).toBe(true);
	expect(isTempLane({ cwd: "/private/tmp/dotz-latprobe" })).toBe(true);
	expect(isTempLane({ cwd: "/Users/x/.dotz/lanes/a/worktree", worktree: { path: "", repo: "/tmp/repo", branch: "", base: "" } })).toBe(true);
	expect(isTempLane({ cwd: "/Users/x/Code/dotz" })).toBe(false);
});

test("a message whose staged upload is gone is refused with how many are missing, never sent without it", () => {
	mkdirSync(join(UPLOADS, "t"), { recursive: true });
	const kept = join(UPLOADS, "t", "kept.pdf");
	writeFileSync(kept, "%PDF");
	expect(ownerFiles([{ path: kept, name: "kept.pdf" }]).map(f => f.name)).toEqual(["kept.pdf"]);
	expect(status(() => ownerFiles([{ path: kept, name: "kept.pdf" }, { path: join(UPLOADS, "t", "gone.xlsx"), name: "gone.xlsx" }]))).toBe(400);
	expect(status(() => ownerFiles([{ path: join(DATA, "outside.txt") }]))).toBe(400);
	expect(ownerFiles(undefined)).toEqual([]);
	expect(messageFiles([{ path: kept }, { path: join(UPLOADS, "t", "gone.xlsx") }])).toHaveLength(1);   // the lenient reader stays for draft files
});

