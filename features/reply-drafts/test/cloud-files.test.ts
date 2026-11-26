// A file that iCloud keeps only in the cloud (a `.<name>.icloud` placeholder beside where the file belongs) is a file to download on every path
// a draft gets files by: the library search, the candidates, `draft.ts attach`, and the send gate. Nothing here calls brctl: the download is injected.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSealed } from "../../../hub/approval-seal.ts";
import { runDraft } from "../bin/draft.ts";
import { candidatesFor, sendDraft } from "../lib/flow.ts";
import { listLibrary } from "../lib/library.ts";
import { paths } from "../lib/settings.ts";
import { brctlArgv, EVICTED_LATER, stagedFiles, stageFiles, type Want } from "../lib/staged.ts";
import { composeMail } from "../../../hub/mail-cli.ts";
import { addDraft, type DraftRec, getDraft } from "../lib/store.ts";
import { mailHash } from "../lib/view.ts";
import { enable, setupEnv } from "./helpers.ts";

const env = setupEnv();
const lib = realpathSync(mkdtempSync(join(tmpdir(), "rd-cloud-lib-")));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
const real = join(lib, "fileA.mp3"), placeholder = join(lib, ".fileA.mp3.icloud");
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), join(env.dir, "custom", "reply-drafts", "sending"), real]) rmSync(p, { force: true, recursive: true });
	writeFileSync(placeholder, "placeholder plist");
	writeFileSync(join(lib, "fileB.pdf"), "pdf bytes");
	enable(env, { attachFolders: { mail: lib } });
});

let n = 0;
function draft(extra: Partial<DraftRec> = {}): DraftRec {
	const id = `C${++n}`;
	const rec: DraftRec = { id, kind: "mail", app: "mail", source: "zele", mailId: `m-${id}`, ref: `ref-${id}`, to: "kim@example.com", subject: "Re: 곡A 음원", body: "곡A 음원 보내드립니다.", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: "kim@example.com", text: "곡A fileA 음원 부탁드립니다" } as never, ...extra };
	addDraft(rec);
	return rec;
}
const downloads = () => {
	const asked: string[] = [];
	return { asked, stage: { download: (src: string) => void asked.push(src), tries: 0, retry: false as const } };
};

describe("the library sees a cloud-only file under its real name", () => {
	test("listLibrary lists the placeholder as fileA.mp3 at the path the file will have", () => {
		expect(listLibrary(lib).map(f => [f.rel, f.path])).toEqual([["fileA.mp3", real], ["fileB.pdf", join(lib, "fileB.pdf")]]);
	});
	test("a downloaded file is listed once, never again for a leftover placeholder", () => {
		writeFileSync(real, "mp3 bytes");
		expect(listLibrary(lib).map(f => f.rel)).toEqual(["fileA.mp3", "fileB.pdf"]);
	});
	test("the candidates of a mail that names it include it", async () => {
		const rec = draft();
		const c = await candidatesFor(rec.item, { source: rec.source, ref: rec.ref });
		expect(c?.files.map(f => f.rel)).toContain("fileA.mp3");
	});
});

describe("staging a cloud-only file", () => {
	test("stageFiles asks for its download and keeps it in want", async () => {
		const d = downloads(), want: Want[] = [];
		const why = await stageFiles("C-stage", [real], want, d.stage);
		expect(why).toHaveLength(1);
		expect(want).toEqual([{ name: "fileA.mp3", path: real }]);
		expect(d.asked).toEqual([real]);
	});
	test("brctl is asked for the placeholder while only the placeholder is there", () => {
		expect(brctlArgv(real)).toEqual(["/usr/bin/brctl", "download", placeholder]);
	});
});

describe("draft.ts attach with a cloud-only file", () => {
	test.each([["a library name", "fileA.mp3"], ["an absolute path", real], ["the placeholder's path", placeholder]])("by %s: the download starts and the draft waits for it (wantFiles)", async (_how, what) => {
		const rec = draft();
		const d = downloads();
		const out = await runDraft(["attach", rec.id, what], "", { stage: d.stage });
		expect(out.code).toBe(0);
		expect(getDraft(rec.id)!.wantFiles).toEqual([{ name: "fileA.mp3", path: real }]);
		expect(stagedFiles(rec.id)).toEqual([]);
		expect(d.asked).toEqual([real]);
	});
});

describe("a new mail (mail-cli compose) with a cloud-only file", () => {
	const compose = (o: { fromLibrary?: string; attach?: string[] }, stage: ReturnType<typeof downloads>["stage"]) =>
		composeMail({ app: "mail", to: ["kim@example.com"], subject: "곡A 음원", body: "안녕하세요. 음원 보내드립니다.", ...o, notify: false }, { stage });
	test.each([["the library pick", { fromLibrary: "fileA" }], ["--attach with the placeholder's path", { attach: [placeholder] }], ["--attach with the path it will have", { attach: [real] }]])("by %s: the draft is made and waits for the file (wantFiles)", async (_how, o) => {
		const d = downloads();
		const made = await compose(o, d.stage);
		if (!made.ok) throw new Error(made.error);
		expect(getDraft(made.rec.id)!.wantFiles).toEqual([{ name: "fileA.mp3", path: real }]);
		expect(stagedFiles(made.rec.id)).toEqual([]);
		expect(made.notes).toContain(EVICTED_LATER("fileA.mp3"));
		expect(d.asked).toEqual([real]);
	});
});

describe("the send gate with a file that was cloud-only", () => {
	const choose = (id: string) => appendSealed(join(env.dir, "inbox.jsonl"), { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: "1) 보내기", picks: [{ q: `이 답장 보낼까요? (${id})`, n: 1, label: "보내기", hash: mailHash(getDraft(id)!) }] });
	const fakeSend = () => {
		const sent: string[][] = [];
		return { sent, send: async (r: DraftRec) => (sent.push(stagedFiles(r.id).map(f => f.name)), { ok: true, message: "보냈어요" }) };
	};

	test("still cloud-only: the send waits (file_pending) and the download is asked again", async () => {
		const rec = draft({ body: "확인했습니다.", wantFiles: [{ name: "fileA.mp3", path: real }] });
		choose(rec.id);
		const d = downloads(), s = fakeSend();
		const r = await sendDraft(rec.id, { send: s.send, stage: d.stage });
		expect([r.ok, r.code, s.sent]).toEqual([false, "file_pending", []]);
		expect(d.asked).toEqual([real]);
	});
	test("downloaded by now: the send attaches it and goes out with it", async () => {
		const rec = draft({ wantFiles: [{ name: "fileA.mp3", path: real }] });
		choose(rec.id);
		rmSync(placeholder);
		writeFileSync(real, "mp3 bytes");
		const s = fakeSend();
		const r = await sendDraft(rec.id, { send: s.send, stage: downloads().stage });
		expect(r.ok).toBe(true);
		expect(s.sent).toEqual([["fileA.mp3"]]);
		expect(getDraft(rec.id)!.wantFiles).toBeUndefined();
	});
});
