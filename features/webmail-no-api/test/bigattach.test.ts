// Sending a draft with files: each file streams from disk to the site's upload endpoint (in parts when the spec says so),
// a refused part or status blocks the send, and a file over the spec's large threshold goes out as a big-attachment link.
import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveSend, draftPath, runDraft, runSend } from "../bin/mail.ts";
import { type Ctx, paths } from "../lib/config.ts";
import { validateSpec } from "../lib/spec.ts";
import { startFakeServer } from "./fakeserver.ts";

process.env.DOTZ_DIR = mkdtempSync(join(tmpdir(), "wm-bigatt-"));
const dir = mkdtempSync(join(tmpdir(), "wm-bigatt-files-"));
const srv = startFakeServer();
const ctx: Ctx = { fetch: (...a) => fetch(...a), cookieHeader: srv.cookieHeader, now: () => 0, sleep: async () => {}, log: () => {} };
const SITE = "bigatt";
afterAll(() => srv.close());

// A 5MB sparse file (well past the ~1MB command-line limit) with marker bytes at both ends and across part boundaries.
function bigFile(name: string, size = 5 << 20): { path: string; sha: string } {
	const path = join(dir, name);
	const fd = openSync(path, "w");
	ftruncateSync(fd, size);
	for (const at of [0, (1 << 20) - 3, 3 << 20, size - 4]) writeSync(fd, Buffer.from("MARK"), 0, 4, Math.min(at, size - 4));
	closeSync(fd);
	return { path, sha: new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex") };
}

const noLarge = { ...srv.spec, send: { ...srv.spec.send!, upload: { ...srv.spec.send!.upload!, large: undefined } } };

test("a 5MB file uploads from disk in 1MB parts with exact lengths, then the send lists it", async () => {
	const f = bigFile("report.bin");
	const { draft } = runDraft(SITE, Date.now(), { to: "a@b.test", subject: "big", body: "x", files: [f.path] });
	expect(statSync(draftPath(SITE, draft.id)).size).toBeLessThan(1024);
	approveSend(SITE, Date.now());
	const before = srv.uploads.length;
	const out = await runSend(ctx, noLarge, SITE, draft.id, Date.now());
	expect(out.code).toBe(0);
	const up = srv.uploads[before];
	expect([up.name, up.bytes, up.parts, up.maxPart, up.sha, up.big]).toEqual(["report.bin", 5 << 20, 5, 1 << 20, f.sha, false]);
	expect(up.contentLengths.every((n) => n !== null && Number(n) > 1 << 20)).toBe(true);
	expect(srv.sent.at(-1).attachments).toEqual([{ name: "report.bin", size: 5 << 20, id: `f${before + 1}` }]);
	expect(existsSync(draftPath(SITE, draft.id))).toBe(false);
});

test("a refused part or a not-ok status blocks the send and keeps the draft and the approval", async () => {
	const small = join(dir, "note.txt");
	await Bun.write(small, "hello");
	const f = bigFile("refused.bin", 3 << 20);
	const { draft } = runDraft(SITE, Date.now(), { to: "a@b.test", subject: "half", body: "x", files: [small, f.path] });
	approveSend(SITE, Date.now());
	const sentBefore = srv.sent.length;
	srv.failPart(2);
	try {
		const out = await runSend(ctx, noLarge, SITE, draft.id, Date.now());
		expect(out.code).toBe(1);
		expect(out.lines.join("\n")).toContain("refused.bin: 3/3번째 조각");
		expect(out.lines.join("\n")).toContain("1/2개");
	} finally {
		srv.failPart(undefined);
	}
	srv.setUploadStatus("virus");
	try {
		const out = await runSend(ctx, noLarge, SITE, draft.id, Date.now());
		expect(out.code).toBe(1);
		expect(out.lines[0]).toContain("상태 virus");
	} finally {
		srv.setUploadStatus("done");
	}
	expect(srv.sent.length).toBe(sentBefore);
	expect(existsSync(draftPath(SITE, draft.id))).toBe(true);
	expect(existsSync(paths.approval(SITE))).toBe(true);
	const noUpload = { ...srv.spec, send: { ...srv.spec.send!, upload: undefined } };
	expect((await runSend(ctx, noUpload, SITE, draft.id, Date.now())).code).toBe(1);
	expect(srv.sent.length).toBe(sentBefore);
});

test("a file over the large threshold goes to the big-attachment endpoint and is sent as a link", async () => {
	const small = join(dir, "small.txt");
	await Bun.write(small, "tiny");
	const f = bigFile("video.bin");
	const { draft } = runDraft(SITE, Date.now(), { to: "a@b.test", subject: "link", body: "x", files: [small, f.path] });
	approveSend(SITE, Date.now());
	const before = srv.uploads.length;
	const out = await runSend(ctx, srv.spec, SITE, draft.id, Date.now());
	expect(out.code).toBe(0);
	expect(out.lines[0]).toContain("대용량 링크 1개");
	expect(srv.uploads.slice(before).map((u) => [u.name, u.big, u.sha === f.sha])).toEqual([["small.txt", false, false], ["video.bin", true, true]]);
	const [a, b] = srv.sent.at(-1).attachments;
	expect(a).toEqual({ name: "small.txt", size: 4, id: `f${before + 1}` });
	expect(b).toEqual({ name: "video.bin", size: 5 << 20, id: `f${before + 2}`, link: true, url: `${srv.origin}/dl/f${before + 2}` });
});

test("draft refuses a missing file, and validateSpec checks the upload fields", () => {
	expect(() => runDraft(SITE, Date.now(), { to: "a@b.test", subject: "s", body: "b", files: [join(dir, "nope.bin")] })).toThrow("첨부 파일이 없어요");
	const up = srv.spec.send!.upload!;
	const withUpload = (u: unknown) => validateSpec({ ...srv.spec, send: { ...srv.spec.send, upload: u } });
	expect(withUpload(up)).toBeUndefined();
	expect(withUpload({ ...up, idPath: "" })).toContain("idPath");
	expect(withUpload({ ...up, chunkBytes: 10 })).toContain("chunkBytes");
	expect(withUpload({ ...up, path: "https://elsewhere.example.test/up" })).toContain("origin");
	expect(withUpload({ ...up, okStatus: "(" })).toContain("okStatus");
	expect(withUpload({ ...up, large: { minBytes: 0 } })).toContain("large");
});
