// The web app's script and styles live as modules in web/js/*.js and web/css/*.css (one topic per file, run in file-name
// order) and are served as one /app.js and one /app.css: one classic script keeps the single global scope and the function
// hoisting the code was written for (a module may call a function another module declares), and the page loads two files.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compressResponse } from "./compress.ts";
import { publishedWeb } from "./web-committed.ts";
import { catalogRevision, diskReader, fillPage, fillScript, injectedConsts, loadCatalog, mapReader, ownerStamp, resolveView, setWebView, webText, type Catalog, type Reader, type View } from "./web-i18n.ts";

const WEB_DIR = process.env.DOTZ_WEB_DIR ?? join(import.meta.dir, "..", "web");
// The committed web/ (hub/web-committed.ts), or undefined to read the working tree.
const committed = () => publishedWeb(join(WEB_DIR, ".."));
/** Text of one web/ file from the committed tree, undefined when the disk is the source. */
export const committedText = (rel: string): string | undefined => committed()?.files.get(rel);
type Kind = "js" | "css";
const cache: Partial<Record<Kind, { key: string; text: string; etag: string }>> = {};

export const moduleFiles = (kind: Kind): string[] => {
	const snap = committed();
	if (snap) return [...snap.files.keys()].filter(p => p.startsWith(`${kind}/`)).map(p => p.slice(kind.length + 1)).sort();
	return readdirSync(join(WEB_DIR, kind)).filter(f => f.endsWith(`.${kind}`)).sort();
};
const filesKey = (kind: Kind): string => {
	const snap = committed();
	if (snap) return snap.tree;
	return moduleFiles(kind).map(f => { const st = statSync(join(WEB_DIR, kind, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join("|");
};
// The language the page is served in (routes.ts calls setAppLang once at boot; never called: ko, the text the sources always had).
let appLang = "ko";
export const setAppLang = (code: string): void => {
	appLang = code.trim() || "ko";
};
let viewHit: { key: string; view: View; consts: string } | undefined;
/** The catalog the page carries and a key that changes with it (committed tree or file stamps, language, provider revision). */
function i18nView(): { key: string; view: View; consts: string } {
	const snap = committed();
	let stamp = snap ? snap.tree : "";
	let reader: Reader;
	if (snap) reader = mapReader(snap.files);
	else {
		reader = diskReader(WEB_DIR);
		for (const lang of ["ko", "en"]) for (const a of reader.areas(lang)) { const st = statSync(join(WEB_DIR, "i18n", lang, `${a}.json`)); stamp += `${lang}/${a}:${st.size}:${st.mtimeMs}|`; }
	}
	const key = `${appLang}#${catalogRevision()}#${ownerStamp()}#${stamp}`;
	if (viewHit && viewHit.key === key) return viewHit;
	const view = resolveView(appLang, reader);
	viewHit = { key, view, consts: injectedConsts(view) };
	return viewHit;
}
setWebView(() => i18nView().view);
/** The ko and en lists the page is drawn from (the generator's sources). */
export function webSources(): { ko: Catalog; en: Catalog } {
	const snap = committed();
	const reader = snap ? mapReader(snap.files) : diskReader(WEB_DIR);
	return { ko: loadCatalog("ko", reader), en: loadCatalog("en", reader) };
}
/** Manifest fields that follow the app language. */
export const manifestI18n = (name: string): { lang: string; description: string } => ({ lang: i18nView().view.lang, description: webText("shell.manifest.description", { name }) });
/** sw.js with its notification texts in the app language. */
export const swScript = (js: string): string => fillScript(js, i18nView().view.catalog);
const joined = (kind: Kind): string => moduleFiles(kind).map(f => committedText(`${kind}/${f}`) ?? readFileSync(join(WEB_DIR, kind, f), "utf8")).join("\n");

// The web build id: a hash of every script and style file, so it changes with each web change and needs no hand-kept version.
// The script carries it as WEB_BUILD and /api/state reports it; a page that runs an older one fetches the new shell (23-installable-app-web.js).
let buildHit: { key: string; id: string } | undefined;
export function webBuild(): string {
	const v = i18nView();
	const key = `${filesKey("js")}#${filesKey("css")}#${v.key}`;
	if (buildHit && buildHit.key === key) return buildHit.id;
	buildHit = { key, id: createHash("sha1").update(joined("js")).update(joined("css")).update(v.consts).digest("hex").slice(0, 12) };
	return buildHit.id;
}

// The joined text, re-read only when a file changed (name list + sizes + mtimes), so an edit shows on the next load.
export function bundle(kind: Kind): { text: string; etag: string } {
	const v = i18nView();
	const key = kind === "js" ? `${filesKey("js")}#${filesKey("css")}#${v.key}` : filesKey(kind);
	const hit = cache[kind];
	if (hit && hit.key === key) return hit;
	// WEB_BUILD and the catalog (I18N_LANG, I18N) go after the "use strict" directive, which must stay the first statement.
	const text = kind === "js" ? joined("js").replace('"use strict";', m => `${m}\nconst WEB_BUILD = "${webBuild()}";\n${v.consts}`) : joined(kind);
	const next = { key, text, etag: `W/"${createHash("sha1").update(text).digest("hex").slice(0, 16)}"` };
	cache[kind] = next;
	return next;
}

export function appAsset(req: Request, path: string): Promise<Response> | undefined {
	const kind: Kind | undefined = path === "/app.js" ? "js" : path === "/app.css" ? "css" : undefined;
	if (!kind || (req.method !== "GET" && req.method !== "HEAD")) return undefined;
	const b = bundle(kind);
	const headers = { "Content-Type": kind === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-cache", ETag: b.etag };
	if (notModified(req, b.etag)) return Promise.resolve(new Response(null, { status: 304, headers }));
	return compressResponse(req, new Response(req.method === "HEAD" ? null : b.text, { headers }), b.etag);
}

// The weak validator is the same for the plain and the gzip body, so a client that cached either one revalidates with it.
const notModified = (req: Request, etag: string): boolean => (req.headers.get("if-none-match") ?? "").split(",").some(t => t.trim() === etag);

// GET / : the page markup, revalidated by ETag (size + mtime) so a warm open costs one 304.
// The owner's assistant name (config identity.name, set by main.ts): the page's title, home-screen name and header carry it instead of the
// project's name; the page reads it back from its title before /api/state arrives (web/js/04-state.js botName).
let appName: string | undefined;
export const setAppName = (name: string): void => {
	appName = name.trim() || undefined;
};
const escHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const named = (html: string, name = appName): string => {
	if (!name) return html;
	const n = escHtml(name);
	return html
		.replace('<meta name="apple-mobile-web-app-title" content="dotz">', `<meta name="apple-mobile-web-app-title" content="${n}">`)
		.replace("<title>dotz</title>", `<title>${n}</title>`)
		.replace('<span id="brand-name">dotz</span>', `<span id="brand-name">${n}</span>`)
		.replace('<h1 id="title">dotz</h1>', `<h1 id="title">${n}</h1>`);
};
export function indexPage(req: Request): Promise<Response> {
	const file = join(WEB_DIR, "index.html");
	const raw = committedText("index.html");
	const { view, key } = i18nView();
	const page = (s: string) => fillPage(named(s), view.lang, view.catalog);
	const html = raw === undefined ? undefined : page(raw);
	const st = html === undefined ? statSync(file) : undefined;
	const etag = st ? `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${createHash("sha1").update(`${appName ?? ""}#${key}`).digest("hex").slice(0, 6)}"` : `W/"${createHash("sha1").update(html!).digest("hex").slice(0, 16)}"`;
	const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: etag };
	if (notModified(req, etag)) return Promise.resolve(new Response(null, { status: 304, headers }));
	return compressResponse(req, new Response(req.method === "HEAD" ? null : html ?? page(readFileSync(file, "utf8")), { headers }), etag);
}
