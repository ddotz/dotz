// The files a draft sends along, kept as they will go out so the approval can open them (hub/draft-approval.ts `> 첨부:` lines).
// Whoever builds an approval block with attachments stages them first: stageDraftFiles copies each file to
// <data dir>/draft-files/<ref>/<n>/<name> and returns the { name, size } list draftApprovalBlock takes. The n-th `> 첨부:` line of the draft
// `ref` is then served read-only by GET /api/drafts/<ref>/files/<n>[?dl=1]; the route reaches nothing outside that folder.
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { DraftFileIn } from "./draft-approval.ts";
import { FileError, safeName, serveFile } from "./files.ts";

export const DRAFT_FILES = join(DATA_DIR, "draft-files");
export const DRAFT_FILES_MAX = 10;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;

export function stageDraftFiles(ref: string, paths: string[], root: string = DRAFT_FILES): DraftFileIn[] {
	if (!REF.test(ref)) throw new Error(`draft ref ${ref} is not usable as a folder name`);
	if (paths.length > DRAFT_FILES_MAX) throw new Error(`at most ${DRAFT_FILES_MAX} attachments`);
	return paths.map((src, n) => {
		if (!statSync(src).isFile()) throw new Error(`${src} is not a file`);
		const name = safeName(src.split(/[\\/]/).pop() ?? "file");
		mkdirSync(join(root, ref, String(n)), { recursive: true });
		copyFileSync(src, join(root, ref, String(n), name));
		return { name, size: statSync(src).size };
	});
}

// The one file staged as attachment n of draft `ref`, or undefined.
export function stagedDraftFile(ref: string, index: string, root: string = DRAFT_FILES): { path: string; name: string } | undefined {
	if (!REF.test(ref) || !/^\d{1,2}$/.test(index)) return undefined;
	const dir = join(root, ref, String(Number(index)));
	if (!existsSync(dir)) return undefined;
	const name = readdirSync(dir)[0];
	if (!name) return undefined;
	const real = realpathSync(join(dir, name));
	return real.startsWith(realpathSync(root) + sep) ? { path: real, name } : undefined;
}

export function draftFileRoute(req: Request, url: URL, ref: string, index: string, root: string = DRAFT_FILES): Response {
	try {
		const f = stagedDraftFile(ref, index, root);
		if (!f) throw new FileError("첨부파일을 찾을 수 없어요", 404);
		const res = serveFile(f.path, req, url.searchParams.get("dl") === "1");
		const kind = res.headers.get("content-disposition")?.startsWith("attachment") ? "attachment" : "inline";
		res.headers.set("Content-Disposition", `${kind}; filename="${f.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
		return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: error instanceof FileError ? error.status : 400 });
	}
}
