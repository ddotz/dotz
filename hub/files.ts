// Files the owner hands to the agents (web upload: + button, drag-drop, paste) and files the agents point back at
// (read-only preview/download). Uploads land under <data dir>/uploads/<day>/; the message carries their absolute paths.
// Serving is read-only and limited to allowed roots, resolved through realpath so `..` and symlinks cannot leave them.
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import { cfg, DATA_DIR, HOME, writeAtomic } from "./config.ts";
import { FILES, queueSnapshots, snapshotFor } from "./filesnap.ts";
import { readMultipart } from "./upload-stream.ts";

export const UPLOADS = join(DATA_DIR, "uploads");
export const UPLOAD_MAX_BYTES = Math.max(1, Number((cfg as any).web?.upload_max_mb ?? 50)) * 1024 * 1024;

export class FileError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

// label: the composer's token of this file ("이미지1", "파일2"): the message text holds `[이미지1]` where the owner put it, and its [attachment] line names it.
// original: the name it came with, when safeName changed it: what a mail attachment goes out as (features/reply-drafts/lib/staged.ts stagedName makes it safe there).
export type Upload = { path: string; name: string; original?: string; type: string; size: number; label?: string };
const ORIGINAL_MAX = 300;
const FILE_LABEL = /^(?:이미지|파일)\d{1,3}$/;

// Keeps letters (any script), digits, dot, dash and underscore; never empty, never a dotfile, at most 120 chars.
/** A file a mail poster already chose to go out WITH the reply (POST /api/mail `reply_files`), copied onto the reply draft from where it is. */
export type ReplyFile = { path: string };
// The draft's own cap (hub/draft-files.ts DRAFT_FILES_MAX) and the mail file cap (hub/mail.ts).
const REPLY_FILES_MAX = 10, REPLY_FILE_MAX_BYTES = 1024 * 1024 * 1024;

/** `reply_files` as posted: each an absolute path (no `..`) of a non-empty, readable regular file that is not itself a symlink. A bad entry
 *  throws `err` naming it, so the poster learns it at once; none or an empty list is undefined. */
export function replyFilesOf(v: unknown, err: (message: string) => Error): ReplyFile[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (!Array.isArray(v)) throw err("reply_files must be an array");
	if (v.length > REPLY_FILES_MAX) throw err(`reply_files: at most ${REPLY_FILES_MAX} files`);
	if (!v.length) return undefined;
	return v.map((f, i) => {
		const path = f && typeof f === "object" ? (f as Record<string, unknown>).path : undefined;
		if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) throw err(`reply_files[${i}].path must be an absolute path without ..`);
		let st;
		try {
			st = lstatSync(path);
			accessSync(path, constants.R_OK);
		} catch {
			throw err(`reply_files[${i}]: ${path} is not a readable file`);
		}
		if (!st.isFile()) throw err(`reply_files[${i}]: ${path} must be a regular file (not a folder or symlink)`);
		if (!st.size || st.size > REPLY_FILE_MAX_BYTES) throw err(`reply_files[${i}]: size ${st.size} not accepted`);
		return { path };
	});
}

export function safeName(name: string): string {
	const base = basename(String(name || "").replace(/\\/g, "/")).normalize("NFC");
	const clean = base.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
	const ext = extname(clean).slice(0, 16);
	const stem = clean.slice(0, clean.length - extname(clean).length).slice(0, 100);
	return `${stem || "file"}${ext}`;
}

const day = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

const tooBig = (bytes: number, max: number) => new FileError(`파일이 너무 커요 (${Math.ceil(bytes / 1048576)}MB, 최대 ${Math.round(max / 1048576)}MB)`, 413);

function uploadPath(fileName: string, dir: string): { path: string; name: string } {
	const folder = join(dir, day());
	mkdirSync(folder, { recursive: true });
	const name = safeName(fileName || "pasted");
	return { name, path: join(folder, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${name}`) };
}

export function uploadRecord(path: string, name: string, fileName: string, type: string, size: number): Upload {
	const original = fileName && fileName !== name ? fileName.slice(0, ORIGINAL_MAX) : undefined;
	// A CLI that is only given the path finds it here (features/reply-drafts/lib/staged.ts); the day folder's cleanup takes it along.
	if (original) writeAtomic(`${path}.name`, original);
	return { path, name, ...(original ? { original } : {}), type: type || Bun.file(path).type || "application/octet-stream", size };
}

export async function saveUpload(file: File, dir = UPLOADS, max = UPLOAD_MAX_BYTES): Promise<Upload> {
	if (file.size > max) throw tooBig(file.size, max);
	if (!file.size) throw new FileError("빈 파일이에요", 400);
	const { path, name } = uploadPath(file.name, dir);
	await Bun.write(path, file);
	return uploadRecord(path, name, file.name, file.type, file.size);
}

// One network read of a file to its .part: FileHandle.write may take only some of the bytes.
export async function writeAll(fh: FileHandle, bytes: Uint8Array) {
	for (let at = 0; at < bytes.length;) at += (await fh.write(bytes, at, bytes.length - at)).bytesWritten;
}

// Reads a multipart body (one or more "file" fields) straight to disk (hub/upload-stream.ts), so an upload's size costs the hub no memory. The size
// limit is checked per file as the bytes arrive and on the whole body. A file gets its name only when the whole body is in: a client that goes away
// (× on the chip aborts the request) or any refusal leaves nothing behind.
export async function uploadsFrom(req: Request, dir = UPLOADS, max = UPLOAD_MAX_BYTES): Promise<Upload[]> {
	const len = Number(req.headers.get("content-length") ?? 0);
	if (len > max * 2 + 65536) throw new FileError(`한 번에 보낼 수 있는 양을 넘었어요 (최대 ${Math.round((max * 2) / 1048576)}MB)`, 413);
	const boundary = /^multipart\/form-data\b.*\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(req.headers.get("content-type") ?? "");
	if (!boundary || !req.body) throw new FileError("multipart/form-data with a file field is required", 400);
	const saved: { path: string; name: string; fileName: string; type: string; size: number }[] = [];
	let writing: FileHandle | undefined;
	try {
		await readMultipart(req.body, boundary[1] ?? boundary[2]!, async head => {
			if (head.field !== "file" || head.filename === undefined) return undefined;
			if (saved.length === 10) throw new FileError("한 번에 10개까지 보낼 수 있어요", 400);
			const file = { ...uploadPath(head.filename, dir), fileName: head.filename, type: head.type, size: 0 };
			saved.push(file);
			const fh = (writing = await open(`${file.path}.part`, "wx"));
			return {
				write: async bytes => {
					file.size += bytes.length;
					if (file.size > max) throw tooBig(Math.max(file.size, len), max);
					await writeAll(fh, bytes);
				},
				end: async () => {
					writing = undefined;
					await fh.close();
				},
			};
		});
		if (!saved.length) throw new FileError("file field is required", 400);
		if (saved.some(f => !f.size)) throw new FileError("빈 파일이에요", 400);
		for (const f of saved) renameSync(`${f.path}.part`, f.path);
		return saved.map(f => uploadRecord(f.path, f.name, f.fileName, f.type, f.size));
	} catch (error) {
		throw error instanceof FileError ? error : new FileError("올리는 중에 끊겼어요", 400);
	} finally {
		await (writing as FileHandle | undefined)?.close();
		for (const f of saved) rmSync(`${f.path}.part`, { force: true });
	}
}

// Names that never leave the machine through this route, even inside an allowed root.
const DENY = /(^|\/)(secrets?|\.ssh|\.gnupg|\.aws|\.git)(\/|$)|(^|\/)\.env(\.|$)|api[-_]?key|token|password|credential|id_(rsa|ed25519|ecdsa)|\.(pem|key|p12|pfx|keychain|keychain-db|db|sqlite)$|(^|\/)(Keychains|\.kube)(\/|$)|(^|\/)\.(netrc|npmrc|zsh_history|bash_history)$/i;

const real = (p: string): string | undefined => {
	try {
		return realpathSync(p);
	} catch {
		return undefined;
	}
};

// Allowed roots: uploads, the lanes' report folders, each lane's working folder (never the home folder itself or the data
// dir root, which holds secrets), and config web.file_roots.
export function allowedRoots(laneCwds: string[] = []): string[] {
	const extra = ((cfg as any).web?.file_roots ?? []) as string[];
	const list = [UPLOADS, join(DATA_DIR, "lanes"), ...laneCwds, ...extra];
	const home = real(HOME) ?? HOME, data = real(DATA_DIR) ?? DATA_DIR;
	const roots = new Set<string>();
	for (const p of list) {
		const r = p && real(p);
		if (r && r !== "/" && r !== home && r !== data) roots.add(r);
	}
	return [...roots];
}

// The `[file]` lines of a message (outside a ``` block), as written. Shared by the Discord sender, the history scan and the web.
export function fileLinePaths(text: string): string[] {
	const out: string[] = [];
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		const m = fence ? null : /^\s*\[file\]\s+`?(.+?)`?\s*$/.exec(line);
		if (m) out.push(m[1]!);
	}
	return out;
}

// Inside the data dir only uploads, the lanes' report folders, qa/ (QA shots and findings) and projects/ (work-channel result files) may leave through a listed file.
const listedDataDirs = () => [UPLOADS, FILES, join(DATA_DIR, "lanes"), join(DATA_DIR, "qa"), join(DATA_DIR, "projects")].map(d => real(d) ?? d);
// Elsewhere in the data dir a listed file may leave when it is a result-type file (an image, a document, a page, media) in a sub folder that
// holds no account, session or state data (owner 2026-11-01: a lane's shots in logs/notify-update-shots/ showed "열 수 없는 파일이에요").
// Config, records (.json/.jsonl) and the top-level files stay shut.
const ARTIFACT = /\.(png|jpe?g|gif|webp|avif|heic|svg|pdf|md|markdown|txt|html?|csv|tsv|xlsx?|docx?|pptx?|hwpx?|numbers|pages|mp4|mov|webm|mp3|m4a|wav|zip)$/i;
const PRIVATE_DATA = new Set(["accounts", "approvals", "conv-sessions", "identity", "kakao", "memory", "secrets", "state"]);
// One owner-specific private folder, kept as a salted hash so this public source does not spell its name.
const PRIVATE_DATA_HASHED = new Set(["4ee39e07918d2e07f58713b49e621b673f675a59e86dd4ba56ad48579cb7fc44"]);
const privateData = (name: string) => PRIVATE_DATA.has(name) || PRIVATE_DATA_HASHED.has(createHash("sha256").update(`dotz-data:${name}`).digest("hex"));
const dataArtifact = (r: string, data: string): boolean => {
	const parts = r.slice(data.length + 1).split(sep);
	return parts.length > 1 && !privateData(parts[0]!) && ARTIFACT.test(r);
};

export const LOST = "원본이 지워졌어요";

// Where an unlisted file may still be served from (old messages, files an agent only named in text): the owner's home and the temp dirs.
const looseRoots = () => [...new Set([HOME, "/tmp", tmpdir()].map(d => real(d) ?? d))];
const under = (r: string, root: string) => r.startsWith(root + sep);
const expand = (input: string) => (input.startsWith("~/") ? join(HOME, input.slice(2)) : input);
// The real path of `input` when it is a regular file inside one of `roots`, or when it is `listed`: written, exactly like
// this, in a [file] line of a message the gateway sent (events.ts sentFiles). A listed file still has to be a regular file,
// off the secret deny-list and outside the data dir (except uploads, lanes, qa/ and projects/); a listed relative path is looked up
// under the data dir and the roots. Otherwise a FileError (400/403/404).
export function resolveAllowed(input: string, roots: string[], listed: ReadonlySet<string> = new Set()): string {
	if (!input || input.includes("\0")) throw new FileError("path required", 400);
	const copy = snapshotFor(expand(input));
	if (copy.path) return copy.path;
	try {
		return resolveLive(input, roots, listed);
	} catch (error) {
		if (error instanceof FileError && error.status === 404 && copy.tooBig) throw new FileError(`${LOST} (${Math.round(copy.tooBig / 1048576)}MB라서 복사해 두지 않았어요)`, 404);
		throw error;
	}
}

// The original file only (no stored copy). The chip must open for any regular file under the home folder or a temp dir, so those are served
// unlisted too; the secret deny-list and the data dir (except files/) stay shut.
function resolveLive(input: string, roots: string[], listed: ReadonlySet<string>): string {
	const isListed = listed.has(input);
	let p = expand(input);
	if (!p.startsWith("/")) {
		if (!isListed || p.split("/").includes("..")) throw new FileError("absolute path required", 400);
		const rel = p;
		p = [DATA_DIR, ...roots].map(base => join(base, rel)).find(c => existsSync(c)) ?? join(DATA_DIR, rel);
	}
	const r = existsSync(p) ? real(p) : undefined;
	if (!r) throw new FileError(LOST, 404);
	if (!roots.some(root => r === root || under(r, root))) {
		const data = real(DATA_DIR) ?? DATA_DIR;
		const inData = r === data || under(r, data);
		const inStore = listedDataDirs().some(d => under(r, d)) || (inData && dataArtifact(r, data));
		const fine = (isListed && (!inData || inStore)) || (looseRoots().some(root => under(r, root)) && (!inData || under(r, real(FILES) ?? FILES)));
		if (!fine) throw new FileError("열 수 없는 파일이에요", 403);
	}
	if (DENY.test(r)) throw new FileError("열 수 없는 파일이에요", 403);
	if (!statSync(r).isFile()) throw new FileError("파일이 아니에요", 400);
	return r;
}

// Copies the files named in the [file] lines of a message just sent into the data dir's files/ (filesnap.ts), in the background.
const kept = () => [UPLOADS, FILES].map(d => real(d) ?? d);
export function snapshotSent(text: string): void {
	snapshotResults(fileLinePaths(text));
}
// The same copy for the files a result chip names, so they open after the original is deleted.
export function snapshotResults(files: string[]): void {
	const paths = files.map(expand).filter(p => p.startsWith("/"));
	if (!paths.length) return;
	const store = kept();
	queueSnapshots(paths, p => {
		try {
			const r = resolveLive(p, allowedRoots(), new Set([p]));
			return store.some(d => under(r, d)) ? undefined : r;
		} catch {
			return undefined;
		}
	});
}

// Shown in the browser (images, pdf, text); every other type is offered as a download.
const INLINE = /\.(png|jpe?g|gif|webp|avif|heic|svg|pdf|md|markdown|txt|log|json|jsonl|ya?ml|toml|csv|tsv|ts|tsx|js|jsx|mjs|py|rs|go|sh|css|html?|xml|diff|patch)$/i;
const TEXTISH = /\.(md|txt|log|json|jsonl|ya?ml|toml|csv|tsv|ts|tsx|js|jsx|mjs|py|rs|go|sh|css|html?|xml|svg|diff|patch)$/i;

// GET /api/file?path=...&download=1 (or dl=1). Inline for preview unless asked to download; Range for media and big files. The CSP sandbox keeps an
// HTML or SVG file opened directly from running script on the gateway's origin.
export function serveFile(path: string, req: Request, dl = false): Response {
	const f = Bun.file(path);
	const size = f.size;
	let type = f.type || "application/octet-stream";
	if (TEXTISH.test(path) && !/^image\//.test(type)) type = /\.html?$/i.test(path) ? "text/plain; charset=utf-8" : type.startsWith("text/") || type.includes("json") ? (type.includes("charset") ? type : `${type}; charset=utf-8`) : "text/plain; charset=utf-8";
	const name = basename(path);
	const headers: Record<string, string> = {
		"Content-Type": type,
		"Content-Disposition": `${dl || !INLINE.test(path) ? "attachment" : "inline"}; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		"Accept-Ranges": "bytes",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
		"Cache-Control": "private, max-age=60",
	};
	// A timeline redraw asks for every thumbnail again: past max-age an unchanged file answers 304, not its bytes.
	const etag = `"${size.toString(36)}-${Math.round(f.lastModified).toString(36)}"`;
	headers.ETag = etag;
	const range = req.headers.get("range");
	if (!range && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
	if (range) {
		const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
		let start = m && m[1] !== "" ? Number(m[1]) : NaN;
		let end = m && m[2] !== "" ? Number(m[2]) : size - 1;
		if (m && m[1] === "" && m[2] !== "") {
			start = Math.max(0, size - Number(m[2]));
			end = size - 1;
		}
		if (!m || Number.isNaN(start) || start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
		end = Math.min(end, size - 1);
		return new Response(f.slice(start, end + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
	}
	return new Response(f, { headers: { ...headers, "Content-Length": String(size) } });
}

// ?thumb=1: a small webp for the chat, so a timeline never holds the originals in memory (the lightbox asks for the original). The ETag is
// the original's, so a redraw answers 304 without decoding; what the decoder refuses falls back to the file itself.
const THUMBABLE = /\.(png|jpe?g|webp)$/i, THUMB_MIN_BYTES = 200_000;
async function fileThumb(res: Response, path: string): Promise<Response> {
	if (res.status !== 200 || !THUMBABLE.test(path) || Bun.file(path).size < THUMB_MIN_BYTES) return res;
	try {
		const bytes = await Bun.file(path).image().resize(480, 480, { fit: "inside" }).webp({ quality: 75 }).bytes();
		const headers = new Headers(res.headers);
		headers.set("Content-Type", "image/webp"); headers.set("Content-Length", String(bytes.length)); headers.set("Cache-Control", "private, max-age=86400"); headers.delete("Accept-Ranges");
		return new Response(bytes, { headers });
	} catch {
		return res;
	}
}

// GET/HEAD /api/file?path=...[&download=1][&thumb=1]: the whole route (main.ts adds the web auth in front). `listed` = events.ts sentFiles.
export function fileRoute(req: Request, url: URL, roots: string[], listed: ReadonlySet<string>): Response | Promise<Response> {
	try {
		const input = url.searchParams.get("path") ?? "", path = resolveAllowed(input, roots, listed);
		// An original served live (an old message, sent before its copy was made) is copied now, so it still opens once it is deleted.
		if (expand(input).startsWith("/") && !kept().some(d => under(path, d))) queueSnapshots([expand(input)], () => path);
		const res = serveFile(path, req, url.searchParams.get("dl") === "1" || url.searchParams.get("download") === "1");
		if (req.method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
		return url.searchParams.get("thumb") === "1" ? fileThumb(res, path) : res;
	} catch (error) {
		const message = (error as Error).message;
		return Response.json({ error: message }, { status: error instanceof FileError ? error.status : 400, headers: { "X-File-Note": encodeURIComponent(message) } });
	}
}

// GET/HEAD /api/canvas?path=<file>.html: an HTML file the bot made, rendered as a page for the 캔버스 panel (web/js/30-canvas.js) under the
// same roots and rules as /api/file. The page's own script runs (a page built by its script is not blank) only inside an opaque-origin
// sandbox (allow-scripts, never allow-same-origin) with no network (connect-src 'none'): it cannot read the hub's cookies or token or call
// /api as the owner. Styles, images and fonts load. The canvas panel's picker frame is built from the fetched text instead (30-canvas.js).
const CANVAS_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:";
// With ?pick=1 (the 캔버스 panel asked for it) the page gets the picker bridge below: an opaque-origin page cannot be read by the
// panel, so the Cmd/Ctrl+click, long press, hover outline and numbered badges live inside the page and send one pick over
// postMessage. It only posts that pick (text, HTML, selector) and draws badges from the panel's ids; it reaches nothing of dotz.
const PICK_BRIDGE = String.raw`<script>(() => {
  var F = function (s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); };
  var MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
  var FIELD = /^(input|textarea|select)$/;
  var mod = function (e) { return !!e && (MAC ? e.metaKey : e.ctrlKey); };
  var modKey = function (k) { return k === (MAC ? "Meta" : "Control"); };
  var esc = function (s) { return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&"); };
  var q = function (c) { try { return document.querySelectorAll(c); } catch (e) { return []; } };
  var cls = function (c) {
    if (!/^[A-Za-z][\w-]{0,40}$/.test(c)) return false;
    if (/^(css|sc|jsx|emotion|svelte)-/.test(c) || c[0] === "_") return false;
    if (/\d{3,}/.test(c)) return false;
    return !(/\d/.test(c) && /[A-Z]/.test(c) && c.length > 10);
  };
  var byId = function (e) { return e.id && q("#" + esc(e.id)).length === 1 ? "#" + esc(e.id) : ""; };
  var sel = function (n) {
    if (byId(n)) return byId(n);
    var parts = [];
    for (var cur = n, i = 0; cur && cur.nodeType === 1 && i < 5; cur = cur.parentElement, i++) {
      if (cur !== n) {
        if (cur === document.body || cur === document.documentElement) break;
        var top = byId(cur);
        if (top) { parts.unshift(top); break; }
      }
      var tag = cur.tagName.toLowerCase();
      var css = Array.prototype.filter.call(cur.classList, cls).slice(0, 2).map(function (c) { return "." + esc(c); }).join("");
      var seg = tag + css;
      var sibs = cur.parentElement ? Array.prototype.filter.call(cur.parentElement.children, function (s) { return s.tagName === cur.tagName; }) : [];
      if (sibs.length > 1) seg += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      parts.unshift(seg);
    }
    return parts.join(" > ");
  };
  var text = function (n) {
    if ((n.type || "").toLowerCase() === "password") return "";
    if (FIELD.test(n.tagName.toLowerCase())) return F(n.getAttribute("placeholder") || n.getAttribute("aria-label") || n.getAttribute("name") || n.type || "");
    return F(n.innerText || n.textContent || "").slice(0, 200);
  };
  var html = function (n) { return F(n.outerHTML || "").replace(/\s(?:value|checked|selected)="[^"]*"/gi, "").slice(0, 600); };
  var hit = function (e) {
    var n = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    return n && n.isConnected && n !== document.body && n !== document.documentElement ? n : null;
  };
  var at = function (t) { try { var n = document.elementFromPoint(t.clientX, t.clientY); return n && n !== document.body && n !== document.documentElement ? n : null; } catch (e) { return null; } };
  var style = document.createElement("style");
  style.textContent = "html.dz-picking,html.dz-picking *{cursor:crosshair!important}" +
    ".dz-pick-box{position:fixed;z-index:2147483646;display:none;pointer-events:none;border:2px solid #3182f6;border-radius:4px;background:rgba(49,130,246,.12)}" +
    ".dz-pick-badge{position:fixed;z-index:2147483647;display:none;min-width:20px;height:20px;border-radius:10px;background:#3182f6;color:#fff;font:600 12px/20px -apple-system,system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.25)}";
  var box = document.createElement("div");
  box.className = "dz-pick-box";
  var picked = {}, marks = {}, armed = false, timer = 0, touchAt = 0, press = null;
  // A page that rebuilds its body (its own script) keeps the overlay: put it back when it is gone.
  var ensure = function () {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
    if (!box.isConnected) document.body.appendChild(box);
  };
  var show = function (n) {
    var r = n && n.isConnected ? n.getBoundingClientRect() : null;
    if (!r || r.width <= 0 || r.height <= 0) { box.style.display = "none"; return; }
    ensure();
    box.style.display = "block";
    box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = r.width + "px"; box.style.height = r.height + "px";
  };
  var arm = function (on) {
    on = !!on;
    if (on === armed) return;
    armed = on;
    document.documentElement.classList.toggle("dz-picking", on);
    if (!on) box.style.display = "none";
  };
  var place = function () {
    ensure();
    for (var id in marks) {
      var n = picked[id], m = marks[id], r = null;
      try { r = n && n.isConnected ? n.getBoundingClientRect() : null; } catch (e) { r = null; }
      if (!r || r.width <= 0 || r.height <= 0) { m.style.display = "none"; continue; }
      if (!m.isConnected) document.body.appendChild(m);
      m.style.display = "block";
      m.style.left = (r.left >= 30 ? r.left - 26 : r.left) + "px";
      m.style.top = r.top + "px";
    }
  };
  var tick = function () {
    if (!Object.keys(marks).length) { if (timer) { clearInterval(timer); timer = 0; } return; }
    if (!timer) timer = setInterval(place, 400);
  };
  var pick = function (n) {
    if (!n) return;
    var id = "dz" + Math.random().toString(36).slice(2, 10);
    picked[id] = n;
    parent.postMessage({ source: "dotz-pick", kind: "pick", pick: { id: id, tag: n.tagName.toLowerCase(), sel: sel(n), text: text(n), html: html(n), title: String(document.title || "") } }, "*");
    if (armed) show(n);
  };
  var stop = function (e) { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); };
  var end = function () { if (press) clearTimeout(press.t); press = null; };
  document.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") return;
    if (mod(e) !== armed) arm(mod(e));
    if (armed) show(hit(e));
  }, true);
  document.documentElement.addEventListener("mouseleave", function () { if (armed) show(null); });
  ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"].forEach(function (t) {
    document.addEventListener(t, function (e) { if (mod(e) && e.pointerType !== "touch") stop(e); }, { capture: true, passive: false });
  });
  document.addEventListener("click", function (e) {
    if (Date.now() - touchAt < 600) { stop(e); return; }
    if (!mod(e)) return;
    stop(e);
    var n = hit(e);
    if (n) pick(n);
  }, true);
  document.addEventListener("touchstart", function (e) {
    end();
    if (e.touches.length !== 1) return;
    var t = e.touches[0], n = at(t);
    if (!n) return;
    var p = { x: t.clientX, y: t.clientY, n: n, done: false, t: 0 };
    p.t = setTimeout(function () {
      if (press !== p || !n.isConnected) return;
      p.done = true;
      touchAt = Date.now();
      try { document.getSelection().removeAllRanges(); } catch (err) {}
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (err) {}
      pick(n);
    }, 500);
    press = p;
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", function (e) {
    var t = e.touches[0];
    if (press && !press.done && t && Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) end();
  }, { capture: true, passive: true });
  document.addEventListener("touchend", function (e) {
    var p = press;
    end();
    if (p && p.done) { touchAt = Date.now(); stop(e); }
  }, { capture: true, passive: false });
  document.addEventListener("touchcancel", end, { capture: true, passive: true });
  document.addEventListener("contextmenu", function (e) { if (press || Date.now() - touchAt < 800) stop(e); }, true);
  document.addEventListener("selectstart", function (e) { if (press) stop(e); }, true);
  addEventListener("keydown", function (e) { if (modKey(e.key)) arm(true); else if (armed && !mod(e)) arm(false); }, true);
  addEventListener("keyup", function (e) { if (modKey(e.key) || !mod(e)) arm(false); }, true);
  addEventListener("blur", function () { arm(false); });
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
  addEventListener("message", function (e) {
    var d = e.data || {};
    if (e.source !== parent || d.source !== "dotz-pick" || d.kind !== "sync" || !Array.isArray(d.ids)) return;
    var want = {};
    d.ids.forEach(function (id) { want[String(id)] = true; });
    for (var id in marks) if (!want[id]) { marks[id].remove(); delete marks[id]; }
    d.ids.forEach(function (id, i) {
      id = String(id);
      var m = marks[id];
      if (!m) { m = document.createElement("div"); m.className = "dz-pick-badge"; document.body.appendChild(m); marks[id] = m; }
      m.textContent = String(i + 1);
    });
    place();
    tick();
  });
  ensure();
})();</script>`;
const withPick = (html: string): string => {
	let at = -1;
	for (const m of html.matchAll(/<\/body\s*>/gi)) at = m.index ?? at;
	return at < 0 ? html + PICK_BRIDGE : html.slice(0, at) + PICK_BRIDGE + html.slice(at);
};
export function canvasRoute(req: Request, url: URL, roots: string[], listed: ReadonlySet<string>): Response {
	try {
		const path = resolveAllowed(url.searchParams.get("path") ?? "", roots, listed);
		if (!/\.html?$/i.test(path)) throw new FileError("HTML 파일만 캔버스에서 열 수 있어요", 415);
		const f = Bun.file(path);
		const base = { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": CANVAS_CSP, "Cache-Control": "private, no-cache" };
		if (url.searchParams.get("pick") !== "1") return new Response(req.method === "HEAD" ? null : f, { headers: { ...base, "Content-Length": String(f.size) } });
		const page = withPick(readFileSync(path, "utf8"));
		const headers = { ...base, "Content-Length": String(Buffer.byteLength(page)) };
		return new Response(req.method === "HEAD" ? null : page, { headers });
	} catch (error) {
		const message = (error as Error).message;
		return Response.json({ error: message }, { status: error instanceof FileError ? error.status : 400, headers: { "X-File-Note": encodeURIComponent(message) } });
	}
}

// The lines appended to a message for the agent: one per file, with its absolute path.
export const attachmentLine = (f: { label?: string; name: string; type?: string }, at: string): string => `[attachment] ${f.label ? `${f.label}: ` : ""}${f.name}${f.type ? ` (${f.type})` : ""} ${at}`;
export const attachmentLines = (files: Upload[]): string => files.map(f => attachmentLine(f, f.path)).join("\n");

// Validates the files a /api/message body names: each must be an upload this gateway stored.
// The files of an owner's message, all or nothing: a staged upload that is gone (or a path outside the uploads) is an error the
// owner sees, not a message that silently goes out without it.
export function ownerFiles(input: unknown): Upload[] {
	const asked = Array.isArray(input) ? input.slice(0, 10).length : 0;
	const files = messageFiles(input);
	if (files.length < asked) throw new FileError(`첨부파일 ${asked - files.length}개를 찾지 못했어요. 파일을 다시 붙여 주세요`, 400);
	return files;
}
export function messageFiles(input: unknown): Upload[] {
	if (!Array.isArray(input)) return [];
	const root = real(UPLOADS);
	return input.slice(0, 10).flatMap(x => {
		const p = typeof x?.path === "string" ? real(x.path) : undefined;
		if (!p || !root || !p.startsWith(root + sep) || !statSync(p).isFile()) return [];
		return [{ path: p, name: safeName(String(x.name ?? basename(p))), ...(typeof x.original === "string" && x.original ? { original: x.original.slice(0, ORIGINAL_MAX) } : {}), type: String(x.type ?? Bun.file(p).type ?? ""), size: statSync(p).size, ...(FILE_LABEL.test(String(x.label)) ? { label: String(x.label) } : {}) }];
	});
}
