import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askedFile, draftAttachRoute } from "./draft-attach.ts";
import { draftFileRoute } from "./draft-files.ts";
import { emit } from "./events.ts";

// A send approval a session wrote by hand (the KDB reply sent with kdb-mail-act.ts --att-file): its `> 첨부:` file is the [file] line of the
// same message, so the sheet counts it as attached and opens it; a file the message does not name stays unchecked and unreachable.
const dir = mkdtempSync(join(tmpdir(), "dotz-asked-"));
const pdf = join(dir, "큐피드_연결정산표_대상회사_보정기준.pdf");
writeFileSync(pdf, "%PDF-1.4 criteria");
const ask = (ref: string, files: string, lines: string) =>
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "th:1", text: `[ask] 답장을 채워 뒀어요.\n\n> 받는이: 김 (kim@example.com)\n> 제목: RE: 기준\n${files}\n> 안녕하세요.\n> 붙임과 같이 전달드립니다.\n\n결정: 이 답장을 보낼까요? (${ref})\n**1) 보내기** ← 추천\n보내요\n**2) 고치기 …**\n고쳐요\n**3) 보내지 않기**\n안 보내요\n\n${lines}` });
const get = (path: string) => new Request(`http://x${path}`);

test("a [file] line of the asking message is the draft's attached file: listed as tracked and served from the sheet", async () => {
	ask("77010001", "> 첨부: 큐피드_연결정산표_대상회사_보정기준.pdf (352KB, 3쪽)", `[file] ${pdf}`);
	const view = await (await draftAttachRoute(get("/api/drafts/77010001/files"), new URL("http://x/api/drafts/77010001/files"), "77010001", "files")).json();
	expect(view).toMatchObject({ tracked: true, editable: false, files: [{ name: "큐피드_연결정산표_대상회사_보정기준.pdf", size: "17B" }] });
	const res = draftFileRoute(get("/api/drafts/77010001/files/0"), new URL("http://x/api/drafts/77010001/files/0"), "77010001", "0", undefined, askedFile);
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("%PDF-1.4 criteria");
	expect(draftFileRoute(get("/api/drafts/77010001/files/1"), new URL("http://x/api/drafts/77010001/files/1"), "77010001", "1", undefined, askedFile).status).toBe(404);
});

test("a file the message only names (no [file] line for it) stays unchecked and cannot be opened", async () => {
	ask("77010002", "> 첨부: 다른파일.pdf (1KB)", `[file] ${pdf}`);
	const view = await (await draftAttachRoute(get("/api/drafts/77010002/files"), new URL("http://x/api/drafts/77010002/files"), "77010002", "files")).json();
	expect(view).toMatchObject({ tracked: false, files: [] });
	expect(draftFileRoute(get("/api/drafts/77010002/files/0"), new URL("http://x/api/drafts/77010002/files/0"), "77010002", "0", undefined, askedFile).status).toBe(404);
});
