// The files of a mail reply draft, edited from the send sheet and the mail's draft card (web/js/10-decision-card.js draftFilesNode):
//   GET    /api/drafts/<ref>/files         { files: [{name, size}], canAttach, library, editable }
//   POST   /api/drafts/<ref>/files         one of { upload: {path, name} } (a file /api/upload stored), { library: "<path inside the 첨부 파일 폴더>" },
//                                          { name, data: "<base64>" } (a file picked on another computer, sent to the computer that owns the draft),
//                                          { remove: <n> } (take the n-th file off the draft)
//   GET    /api/drafts/<ref>/library[?q=] the files of the 첨부 파일 폴더, best match for the mail first
//   GET    /api/drafts/<ref>/original     what this draft answers (the sheet's 원문 보기); 404 when it is gone. A mail: { kind: "mail", key, from, to?, date, subject?, text, html, attachments }.
//                                          A comment (YouTube, Instagram, site): { kind: "comment", key, author, date?, text, post: { title?, link?, thumb?, kind }, parent? } (hub/comments/original.ts)
// Only a pending mail draft of reply-drafts can change; nothing is sent from here (the owner's 보내기 does that).
import { basename } from "node:path";
import { attachFolder } from "../features/reply-drafts/lib/flow.ts";
import { libraryFile, listLibrary, rankLibrary } from "../features/reply-drafts/lib/library.ts";
import { canAttach } from "../features/reply-drafts/lib/senders.ts";
import { addStagedBytes, addStagedFile, removeStagedFile, stagedFiles } from "../features/reply-drafts/lib/staged.ts";
import { getDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { fileSizeText } from "./draft-approval.ts";
import { messageFiles } from "./files.ts";
import { commentOriginalOf } from "./comments/gateway.ts";
import type { CommentOriginal } from "./comments/original.ts";
import { attachmentList, mailByKey } from "./mail.ts";

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
		// false: dotz holds no record of this draft (a block written by hand, another tool sends it), so the files it names are not
		// files dotz has staged and nothing here can say they go out.
		tracked: !!rec,
	};
}

const GONE = () => json({ error: "원문을 찾을 수 없어요" }, 404);

// A comment draft of reply-drafts (the older watch path) keeps only the comment's author, text and a context line (`YouTube video "<title>" (<id>)`).
function commentOfRec(rec: DraftRec): CommentOriginal {
	const ctx = rec.item.context ?? "";
	const title = /"([^"]+)"/.exec(ctx)?.[1];
	return { kind: "comment", key: rec.ref, author: rec.item.from, text: rec.item.text, post: { ...(title ? { title } : {}), kind: rec.app } };
}

// What a reply draft answers. A mail: what the gateway recorded of it (sender, date, files, whether an HTML body is kept) and the text the draft was written from;
// `html` true = GET /api/mail/<key>/body has the sanitized HTML. A new-mail draft (compose) answers nothing, and a mail that fell out of the record has nothing to show.
// A comment: the comment engine's draft (not in reply-drafts' store) reads its stored comment, post and thread parent.
function original(rec: DraftRec | undefined, ref: string): Response {
	if (!rec) {
		const c = commentOriginalOf(ref);
		return c ? json(c) : GONE();
	}
	if (rec.kind === "comment") return rec.item.text.trim() ? json(commentOfRec(rec)) : GONE();
	if (rec.kind !== "mail" || rec.compose) return GONE();
	const mail = mailByKey(rec.ref);
	if (!mail && !rec.item.text.trim()) return GONE();
	return json({ kind: "mail", key: rec.ref, from: mail?.from ?? rec.item.from, ...(mail?.to ? { to: mail.to } : {}), ...(mail?.cc ? { cc: mail.cc } : {}), date: mail?.at ?? rec.created, ...(mail?.subject || rec.item.subject ? { subject: mail?.subject ?? rec.item.subject } : {}), text: rec.item.text, html: !!mail?.html, attachments: mail ? attachmentList(mail) : [] });
}

export async function draftAttachRoute(req: Request, url: URL, ref: string, tail: string): Promise<Response> {
	const rec = getDraft(ref);
	const editable = !!rec && rec.kind === "mail" && rec.status === "pending";
	try {
		if (tail === "original" && req.method === "GET") return original(rec, ref);
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
