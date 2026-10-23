// The files of a mail reply draft, edited from the send sheet and the mail's draft card (web/js/10-decision-card.js draftFilesNode):
//   GET    /api/drafts/<ref>/files         { files: [{name, size}], canAttach, library, editable }
//   POST   /api/drafts/<ref>/files         one of { upload: {path, name} } (a file /api/upload stored), { library: "<path inside the 첨부 파일 폴더>" },
//                                          { name, data: "<base64>" } (a file picked on another computer, sent to the computer that owns the draft),
//                                          { remove: <n> } (take the n-th file off the draft)
//   GET    /api/drafts/<ref>/library[?q=] the files of the 첨부 파일 폴더, best match for the mail first
// Only a pending mail draft of reply-drafts can change; nothing is sent from here (the owner's 보내기 does that).
import { basename } from "node:path";
import { attachFolder } from "../features/reply-drafts/lib/flow.ts";
import { libraryFile, listLibrary, rankLibrary } from "../features/reply-drafts/lib/library.ts";
import { canAttach } from "../features/reply-drafts/lib/senders.ts";
import { addStagedBytes, addStagedFile, removeStagedFile, stagedFiles } from "../features/reply-drafts/lib/staged.ts";
import { getDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { fileSizeText } from "./draft-approval.ts";
import { messageFiles } from "./files.ts";

const FILE_MAX = 25 * 1024 * 1024;
const LIBRARY_LIST_MAX = 100;
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function view(rec: DraftRec | undefined, ref: string) {
	const editable = !!rec && rec.kind === "mail" && rec.status === "pending";
	return {
		files: stagedFiles(rec?.id ?? ref).map(f => ({ name: f.name, size: fileSizeText(f.size) })),
		canAttach: !!rec && canAttach(rec.source),
		library: editable && !!(await attachFolder(rec.ref)),
		editable,
	};
}

export async function draftAttachRoute(req: Request, url: URL, ref: string, tail: string): Promise<Response> {
	const rec = getDraft(ref);
	const editable = !!rec && rec.kind === "mail" && rec.status === "pending";
	try {
		if (tail === "files" && req.method === "GET") return json(await view(rec, ref));
		if (!rec || !editable) return json({ error: "이 초안은 파일을 바꿀 수 없어요" }, rec ? 409 : 404);
		if (tail === "library" && req.method === "GET") {
			const folder = await attachFolder(rec.ref);
			if (!folder) return json({ error: "첨부 파일 폴더가 정해져 있지 않아요" }, 409);
			const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
			const ranked = rankLibrary(listLibrary(folder), { subject: rec.item.subject ?? "", text: rec.item.text }).filter(r => !q || r.file.rel.toLowerCase().includes(q));
			return json({ items: ranked.slice(0, LIBRARY_LIST_MAX).map(r => ({ rel: r.file.rel, name: basename(r.file.rel), size: fileSizeText(r.file.size), match: r.score > 0 })) });
		}
		if (tail === "files" && req.method === "POST") {
			const b = (await req.json().catch(() => ({}))) as Record<string, any>;
			if (Number.isInteger(b.remove)) {
				if (!removeStagedFile(rec.id, b.remove)) return json({ error: "그런 첨부파일이 없어요" }, 404);
			} else if (typeof b.library === "string") {
				const folder = await attachFolder(rec.ref);
				const f = folder ? libraryFile(folder, b.library) : undefined;
				if (!f) return json({ error: "첨부 파일 폴더에서 그 파일을 찾지 못했어요" }, 404);
				addStagedFile(rec.id, f.path);
			} else if (b.upload && typeof b.upload === "object") {
				const up = messageFiles([b.upload])[0];
				if (!up) return json({ error: "올린 파일을 찾지 못했어요" }, 404);
				addStagedFile(rec.id, up.path);
			} else if (typeof b.name === "string" && typeof b.data === "string") {
				const bytes = Buffer.from(b.data, "base64");
				if (!bytes.length || bytes.length > FILE_MAX) return json({ error: "파일은 25MB 이하여야 해요" }, 413);
				addStagedBytes(rec.id, b.name, bytes);
			} else return json({ error: "upload, library, or name and data required" }, 400);
			return json({ ok: true, ...(await view(rec, ref)) });
		}
		return json({ error: "not found" }, 404);
	} catch (error) {
		return json({ error: (error as Error).message }, 400);
	}
}
