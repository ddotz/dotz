import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { loadPlugins } from "../../../hub/plugins.ts";
import { askText, reviseDraft } from "../lib/flow.ts";
import { sendWith } from "../lib/senders.ts";
import { addStagedFile, removeStagedFile, stagedFiles } from "../lib/staged.ts";
import { paths } from "../lib/settings.ts";
import { addDraft, getDraft, type DraftRec } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { enable, fakeModel, j, setupEnv } from "./helpers.ts";

// A draft's files never go missing: they are carried through 고치기 (a new draft id), they are what the approval card lists, they are
// removed only when the owner removes them, and both mailers (zele's --attach argv and a plugin's attachments) carry their exact bytes.
const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), join(env.dir, "custom", "plugins")]) rmSync(p, { force: true, recursive: true });
});

const PDF = Buffer.from("%PDF-1.7\n2 0 obj\n<< /점검 결과 >>\nstream\n보고서 본문\nendstream\n", "utf8");
const SHEET = Buffer.from("이름,점수\n김,90\n", "utf8");
const lib = mkdtempSync(join(tmpdir(), "rd-attach-"));
mkdirSync(join(lib), { recursive: true });
writeFileSync(join(lib, "점검보고서.pdf"), PDF);
writeFileSync(join(lib, "점수표.csv"), SHEET);
afterAll(() => rmSync(lib, { recursive: true, force: true }));

let seq = 0;
const rec = (patch: Partial<DraftRec> = {}): DraftRec => ({
	id: `RATTACH${++seq}`,
	kind: "mail",
	app: "mail",
	source: "zele",
	mailId: "T77",
	ref: "zele-t77",
	to: "kim@example.com",
	subject: "Re: 점검 결과",
	body: "보내드립니다.",
	status: "pending",
	created: new Date().toISOString(),
	changes: [],
	questions: [],
	item: { kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "점검 결과", text: "점검 결과 보내 주세요" },
	...patch,
});
const twoFiles = (id: string) => [addStagedFile(id, join(lib, "점검보고서.pdf")), addStagedFile(id, join(lib, "점수표.csv"))];
const revision = (body: string) => fakeModel([j({ action: "draft", reason: "shorter", to: "kim@example.com", subject: "Re: 점검 결과", body, questions: [] })]);

// What zele's own message looks like, built from the argv it was handed: one part per --attach with the file's bytes in base64, the body
// as the text part. A file that never reached the argv, or a path to something else, is missing from this text.
function mimeOf(argv: readonly string[]): string {
	const files = argv.flatMap((a, i) => (a === "--attach" ? [argv[i + 1]!] : []));
	const body = argv[argv.indexOf("--body") + 1] ?? "";
	const parts = files.map(p => `--BND\nContent-Type: application/octet-stream\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename="${basename(p)}"\n\n${readFileSync(p).toString("base64")}`);
	return [`Content-Type: multipart/mixed; boundary=BND`, "", `--BND\nContent-Type: text/plain; charset=utf-8\n\n${body}`, ...parts, "--BND--", ""].join("\n");
}
const base64Of = (b: Buffer) => b.toString("base64");

describe("the files of a draft stay on it", () => {
	test("고치기 rewrites the words and carries both files, and the new card lists both", async () => {
		const first = rec();
		addDraft(first);
		twoFiles(first.id);
		expect(stagedFiles(first.id).map(f => f.name)).toEqual(["점검보고서.pdf", "점수표.csv"]);
		const step = await reviseDraft(first.id, "더 짧게", { call: revision("보고서와 점수표 보내드립니다.").call });
		expect(step.ok).toBe(true);
		const next = getDraft(step.id!)!;
		expect(stagedFiles(next.id).map(f => f.name)).toEqual(["점검보고서.pdf", "점수표.csv"]);
		expect(readFileSync(stagedFiles(next.id)[0]!.path)).toEqual(PDF);
		const card = parseDraftApproval(askText(next, []))!;
		expect(card.attachments?.map(a => a.name)).toEqual(["점검보고서.pdf", "점수표.csv"]);
	});

	test("a file is gone only when the owner takes it off, and the card follows", () => {
		const d = rec();
		addDraft(d);
		twoFiles(d.id);
		expect(removeStagedFile(d.id, 0)).toBe(true);
		const left = stagedFiles(d.id);
		expect(left.map(f => f.name)).toEqual(["점수표.csv"]);
		expect(readFileSync(left[0]!.path)).toEqual(SHEET);
		expect(parseDraftApproval(askText(getDraft(d.id)!, []))!.attachments?.map(a => a.name)).toEqual(["점수표.csv"]);
		removeStagedFile(d.id, 0);
		expect(stagedFiles(d.id)).toEqual([]);
		expect(parseDraftApproval(askText(getDraft(d.id)!, []))!.attachments).toBeUndefined();
	});
});

describe("what the mailer gets", () => {
	const fake = () => {
		const calls: string[][] = [];
		const run: Runner = async argv => (calls.push(argv), { code: 0, stdout: "ok", stderr: "" });
		return { calls, run };
	};

	test("a zele reply carries every file: both parts of the message have their exact bytes", async () => {
		const d = rec();
		addDraft(d);
		twoFiles(d.id);
		const f = fake();
		expect((await sendWith(getDraft(d.id)!, f.run)).ok).toBe(true);
		const reply = f.calls.find(c => c[1] === "mail" && c[2] === "reply")!;
		const mime = mimeOf(reply);
		for (const [name, bytes] of [["점검보고서.pdf", PDF], ["점수표.csv", SHEET]] as const) {
			expect(mime).toContain(`filename="${name}"`);
			expect(mime).toContain(base64Of(bytes));
		}
		expect(mime).toContain("보내드립니다.");
	});

	test("a new mail carries them too, after the draft was saved and edited twice", async () => {
		const first = rec({ compose: true, mailId: "compose-x", ref: "compose-x" });
		addDraft(first);
		twoFiles(first.id);
		const a = await reviseDraft(first.id, "더 짧게", { call: revision("짧게 보냅니다.").call });
		const b = await reviseDraft(a.id!, "인사 추가", { call: revision("안녕하세요. 짧게 보냅니다.").call });
		const f = fake();
		expect((await sendWith(getDraft(b.id!)!, f.run)).ok).toBe(true);
		const sent = f.calls.find(c => c[1] === "mail" && c[2] === "send")!;
		const mime = mimeOf(sent);
		expect(mime).toContain(base64Of(PDF));
		expect(mime).toContain(base64Of(SHEET));
		expect(mime).toContain("안녕하세요. 짧게 보냅니다.");
	});

	test("a plugin mailer receives every file with its bytes and size", async () => {
		mkdirSync(join(env.dir, "custom", "plugins"), { recursive: true });
		writeFileSync(join(env.dir, "custom", "plugins", "kdb.ts"), [
			`export default {`,
			`\trepliesWithFiles: () => true,`,
			`\treply: async d => {`,
			`\t\tglobalThis.__pluginGot = d;`,
			`\t\treturn { ok: true, message: "보냈어요" };`,
			`\t},`,
			`};`,
		].join("\n"));
		await loadPlugins(env.dir);
		const d = rec({ source: "kdb", mailId: "kdb-1", ref: "kdb-1" });
		addDraft(d);
		twoFiles(d.id);
		const out = await sendWith(getDraft(d.id)!, fake().run);
		expect(out).toEqual({ ok: true, message: "보냈어요" });
		const got = (globalThis as { __pluginGot?: { attachments: { name: string; path: string; size: number }[] } }).__pluginGot!;
		expect(got.attachments.map(a => a.name)).toEqual(["점검보고서.pdf", "점수표.csv"]);
		expect(readFileSync(got.attachments[0]!.path)).toEqual(PDF);
		expect(got.attachments[0]!.size).toBe(PDF.length);
		delete (globalThis as { __pluginGot?: unknown }).__pluginGot;
	});
});

describe("a source that cannot carry files says so instead of sending the text alone", () => {
	test("a webmail site with a file on the draft is refused, and the card says why", async () => {
		enable(env);
		const d = rec({ source: "webmail:school" });
		addDraft(d);
		twoFiles(d.id);
		const r = await sendWith(getDraft(d.id)!, async () => ({ code: 0, stdout: "", stderr: "" }));
		expect(r.ok).toBe(false);
		expect(r.message).toContain("첨부파일");
		expect(askText(getDraft(d.id)!, [])).toContain("빠진 파일: 점검보고서.pdf, 점수표.csv");
	});
});
