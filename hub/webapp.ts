// The web app's script and styles live as modules in web/js/*.js and web/css/*.css (one topic per file, run in file-name
// order) and are served as one /app.js and one /app.css: one classic script keeps the single global scope and the function
// hoisting the code was written for (a module may call a function another module declares), and the page loads two files.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB_DIR = join(import.meta.dir, "..", "web");
type Kind = "js" | "css";
const cache: Partial<Record<Kind, { key: string; text: string; etag: string }>> = {};

export const moduleFiles = (kind: Kind): string[] => readdirSync(join(WEB_DIR, kind)).filter(f => f.endsWith(`.${kind}`)).sort();

// The joined text, re-read only when a file changed (name list + sizes + mtimes), so an edit shows on the next load.
export function bundle(kind: Kind): { text: string; etag: string } {
	const files = moduleFiles(kind);
	const key = files.map(f => { const st = statSync(join(WEB_DIR, kind, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join("|");
	const hit = cache[kind];
	if (hit && hit.key === key) return hit;
	const text = files.map(f => readFileSync(join(WEB_DIR, kind, f), "utf8")).join("\n");
	const next = { key, text, etag: `"${createHash("sha1").update(text).digest("hex").slice(0, 16)}"` };
	cache[kind] = next;
	return next;
}

// The whole page source (markup + styles + script) for tests that look for a class or a call anywhere in the web app.
export const webSource = (): string => [readFileSync(join(WEB_DIR, "index.html"), "utf8"), bundle("css").text, bundle("js").text].join("\n");

export function appAsset(req: Request, path: string): Response | undefined {
	const kind: Kind | undefined = path === "/app.js" ? "js" : path === "/app.css" ? "css" : undefined;
	if (!kind || (req.method !== "GET" && req.method !== "HEAD")) return undefined;
	const b = bundle(kind);
	const headers = { "Content-Type": kind === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-cache", ETag: b.etag };
	if (req.headers.get("if-none-match") === b.etag) return new Response(null, { status: 304, headers });
	return new Response(req.method === "HEAD" ? null : b.text, { headers });
}
