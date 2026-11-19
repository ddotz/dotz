// The files a draft sends along, kept as they will go out so the approval can open them (hub/draft-approval.ts `> 첨부:` lines).
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import { FileError, serveFile } from "./files.ts";

export const DRAFT_FILES = join(DATA_DIR, "draft-files");
const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;

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

// `named`: the file a draft dotz did not stage names for attachment n (hub/draft-attach.ts askedFile), served when nothing is staged.
export function draftFileRoute(req: Request, url: URL, ref: string, index: string, root: string = DRAFT_FILES, named?: (ref: string, n: number) => { path: string; name: string } | undefined): Response {
	try {
		const f = stagedDraftFile(ref, index, root) ?? (/^\d{1,2}$/.test(index) ? named?.(ref, Number(index)) : undefined);
		if (!f) throw new FileError("첨부파일을 찾을 수 없어요", 404);
		const res = serveFile(f.path, req, url.searchParams.get("dl") === "1");
		const kind = res.headers.get("content-disposition")?.startsWith("attachment") ? "attachment" : "inline";
		res.headers.set("Content-Disposition", `${kind}; filename="${f.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
		return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: error instanceof FileError ? error.status : 400 });
	}
}
