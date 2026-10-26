// Files the owner hands to the agents (web upload: + button, drag-drop, paste) and files the agents point back at
// (read-only preview/download). Uploads land under <data dir>/uploads/<day>/; the message carries their absolute paths.
// Serving is read-only and limited to allowed roots, resolved through realpath so `..` and symlinks cannot leave them.
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { cfg, DATA_DIR, HOME } from "./config.ts";
import { FILES, queueSnapshots, snapshotFor } from "./filesnap.ts";

export const UPLOADS = join(DATA_DIR, "uploads");
const UPLOAD_MAX_BYTES = Math.max(1, Number((cfg as any).web?.upload_max_mb ?? 50)) * 1024 * 1024;

export class FileError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export type Upload = { path: string; name: string; type: string; size: number };

// Keeps letters (any script), digits, dot, dash and underscore; never empty, never a dotfile, at most 120 chars.
export function safeName(name: string): string {
	const base = basename(String(name || "").replace(/\\/g, "/")).normalize("NFC");
	const clean = base.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
	const ext = extname(clean).slice(0, 16);
	const stem = clean.slice(0, clean.length - extname(clean).length).slice(0, 100);
	return `${stem || "file"}${ext}`;
}

const day = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

export async function saveUpload(file: File, dir = UPLOADS, max = UPLOAD_MAX_BYTES): Promise<Upload> {
	if (file.size > max) throw new FileError(`파일이 너무 커요 (${Math.ceil(file.size / 1048576)}MB, 최대 ${Math.round(max / 1048576)}MB)`, 413);
	if (!file.size) throw new FileError("빈 파일이에요", 400);
	const folder = join(dir, day());
	mkdirSync(folder, { recursive: true });
	const name = safeName(file.name || "pasted");
	const path = join(folder, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${name}`);
	await Bun.write(path, file);
	return { path, name, type: file.type || Bun.file(path).type || "application/octet-stream", size: file.size };
}

// Reads a multipart body (one or more "file" fields). The size limit is checked per file and on the whole body.
export async function uploadsFrom(req: Request, dir = UPLOADS, max = UPLOAD_MAX_BYTES): Promise<Upload[]> {
	const len = Number(req.headers.get("content-length") ?? 0);
	if (len > max * 2 + 65536) throw new FileError(`한 번에 보낼 수 있는 양을 넘었어요 (최대 ${Math.round((max * 2) / 1048576)}MB)`, 413);
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		throw new FileError("multipart/form-data with a file field is required", 400);
	}
	const files = form.getAll("file").filter((f): f is File => typeof f !== "string");
	if (!files.length) throw new FileError("file field is required", 400);
	if (files.length > 10) throw new FileError("한 번에 10개까지 보낼 수 있어요", 400);
	const out: Upload[] = [];
	for (const f of files) out.push(await saveUpload(f, dir, max));
	return out;
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

export const LOST = "파일이 지워졌어요";

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
		const inStore = listedDataDirs().some(d => under(r, d));
		const fine = (isListed && (!inData || inStore)) || (looseRoots().some(root => under(r, root)) && (!inData || under(r, real(FILES) ?? FILES)));
		if (!fine) throw new FileError("열 수 없는 파일이에요", 403);
	}
	if (DENY.test(r)) throw new FileError("열 수 없는 파일이에요", 403);
	if (!statSync(r).isFile()) throw new FileError("파일이 아니에요", 400);
	return r;
}

// Copies the files named in the [file] lines of a message just sent into the data dir's files/ (filesnap.ts), in the background.
export function snapshotSent(text: string): void {
	const paths = fileLinePaths(text).map(expand).filter(p => p.startsWith("/"));
	if (!paths.length) return;
	const kept = [UPLOADS, FILES].map(d => real(d) ?? d);
	queueSnapshots(paths, p => {
		try {
			const r = resolveLive(p, allowedRoots(), new Set([p]));
			return kept.some(d => under(r, d)) ? undefined : r;
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
	const range = req.headers.get("range");
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

// GET/HEAD /api/file?path=...[&download=1]: the whole route (main.ts adds the web auth in front). `listed` = events.ts sentFiles.
export function fileRoute(req: Request, url: URL, roots: string[], listed: ReadonlySet<string>): Response {
	try {
		const res = serveFile(resolveAllowed(url.searchParams.get("path") ?? "", roots, listed), req, url.searchParams.get("dl") === "1" || url.searchParams.get("download") === "1");
		return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
	} catch (error) {
		const message = (error as Error).message;
		return Response.json({ error: message }, { status: error instanceof FileError ? error.status : 400, headers: { "X-File-Note": encodeURIComponent(message) } });
	}
}

// The lines appended to a message for the agent: one per file, with its absolute path.
export const attachmentLines = (files: Upload[]): string => files.map(f => `[attachment] ${f.name}${f.type ? ` (${f.type})` : ""} ${f.path}`).join("\n");

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
		return [{ path: p, name: safeName(String(x.name ?? basename(p))), type: String(x.type ?? Bun.file(p).type ?? ""), size: statSync(p).size }];
	});
}
