import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftAttachRoute } from "../../../hub/draft-attach.ts";
import { asksForFile, claimsAttachment, LIBRARY_MISS, NO_ATTACHMENT_WARNING, parseDraftApproval } from "../../../hub/draft-approval.ts";
import { loadPlugins } from "../../../hub/plugins.ts";
import { reviseDraft } from "../lib/flow.ts";
import { matchLibrary } from "../lib/library.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { canAttach, sendWith } from "../lib/senders.ts";
import { addStagedFile, removeStagedFile, stagedFiles } from "../lib/staged.ts";
import { paths } from "../lib/settings.ts";
import { getDraft, listDrafts, setStatus } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { enable, fakeModel, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "rd-lib-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
for (const f of ["행방불명_공유용.pdf", "하울의 움직이는 성_공유용.pdf", "견적서 양식.xlsx", "악보/기타/캐논.pdf"]) {
	mkdirSync(join(lib, f, ".."), { recursive: true });
	writeFileSync(join(lib, f), `bytes of ${f}`);
}
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), join(env.dir, "custom", "plugins")]) rmSync(p, { force: true, recursive: true });
});

const TEACHER_BODY = "선생님 안녕하세요.\n\n요청주신 센과 치히로의 행방불명 OST 또다시 악보 보내드립니다. 공유용 악보는 1절까지 들어 있어요. 보내드린 악보는 개인 연습용으로만 써 주세요.";
const TEACHER_SUBJECT = "Re: 선생님 센과 치히로의 행방불명 ost 악보 부탁드립니다";
const teacherMail = { ...mailFixture, key: "t-1", subject: "선생님 센과 치히로의 행방불명 ost 악보 부탁드립니다", from: "Student <stu@example.com>", body: "선생님 센과 치히로의 행방불명 ost 악보 부탁드립니다." };
const teacherReply = { action: "draft", reason: "asks for a score", to: "stu@example.com", subject: TEACHER_SUBJECT, body: TEACHER_BODY, questions: [] };
const sink = () => {
	const sent: { target: string; text: string }[] = [];
	return { sent, send: (target: string, text: string) => void sent.push({ target, text }) };
};

describe("the warning heuristic", () => {
	test("the teacher's body (악보 보내드립니다) is a claim", () => {
		expect(claimsAttachment(TEACHER_BODY)).toBe(true);
		expect(claimsAttachment("견적서를 보내드릴게요")).toBe(true);
		expect(claimsAttachment("사진 보냈습니다")).toBe(true);
		expect(claimsAttachment("보내드린 PDF는 확인해 주세요")).toBe(true);
	});
	test.each(["악보를 보내드리지 못했어요", "확인했어요. 내일 회신드릴게요", "수업 일정을 보내드립니다", "사진 보낸 분께 감사드려요", ""])("%s is not a claim", t => {
		expect(claimsAttachment(t)).toBe(false);
	});
	test("the mail being answered asks for a file", () => {
		expect(asksForFile("선생님 센과 치히로의 행방불명 ost 악보 부탁드립니다")).toBe(true);
		expect(asksForFile("견적서 보내주세요.")).toBe(true);
		expect(asksForFile("Could you please send the PDF?")).toBe(true);
		expect(asksForFile("수업 시간 문의드립니다. 감사합니다.")).toBe(false);
		expect(asksForFile("악보 잘 받았습니다")).toBe(false);
	});
	test("the Discord block says 첨부: 없음 with the reason, and the parser raises the warning from it", async () => {
		enable(env);
		const out = sink();
		await offerMailDraft(teacherMail, { send: out.send, call: fakeModel([j(teacherReply)]).call });
		const text = out.sent[0]!.text;
		expect(text).toContain("> 첨부: 없음 (본문에는 보낸다고 썼어요)");
		expect(text).not.toContain("⚠");
		expect(parseDraftApproval(text)).toMatchObject({ warning: NO_ATTACHMENT_WARNING, note: "본문에는 보낸다고 썼어요" });
	});
});

describe("the 첨부 파일 폴더", () => {
	test("'행방불명 ost 악보' finds 행방불명_공유용.pdf and nothing else", async () => {
		const found = await matchLibrary(lib, { subject: "행방불명 ost 악보", text: "" });
		expect(found.map(f => f.rel)).toEqual(["행방불명_공유용.pdf"]);
		expect((await matchLibrary(lib, { subject: TEACHER_SUBJECT, text: "" })).map(f => f.rel)).toEqual(["행방불명_공유용.pdf"]);
	});
	test("a mail that names nothing in the folder matches nothing (a generic 악보 alone is not enough)", async () => {
		expect(await matchLibrary(lib, { subject: "악보 부탁드립니다", text: "악보 보내주세요" })).toEqual([]);
		expect(await matchLibrary(join(lib, "none"), { subject: "행방불명", text: "" })).toEqual([]);
	});
	test("more than three files tied: one pick call that sees names only; otherwise no call at all", async () => {
		const tie = mkdtempSync(join(tmpdir(), "rd-tie-"));
		for (const n of ["a", "b", "c", "d", "e"]) writeFileSync(join(tie, `캐논_${n}.pdf`), n);
		const seen: string[][] = [];
		const found = await matchLibrary(tie, { subject: "캐논 악보", text: "" }, async names => (seen.push(names), ["캐논_d.pdf", "캐논_b.pdf"]));
		expect(found.map(f => f.rel)).toEqual(["캐논_b.pdf", "캐논_d.pdf"]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual(["캐논_a.pdf", "캐논_b.pdf", "캐논_c.pdf", "캐논_d.pdf", "캐논_e.pdf"]);
		let calls = 0;
		await matchLibrary(lib, { subject: "행방불명", text: "" }, async () => (calls++, []));
		expect(calls).toBe(0);
		rmSync(tie, { recursive: true, force: true });
	});
});

describe("drafting a reply that promises a file", () => {
	test("the best match is staged and shown, with no warning; the model is called once for the draft and never for the match", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const out = sink();
		const model = fakeModel([j(teacherReply)]);
		expect(await offerMailDraft(teacherMail, { send: out.send, call: model.call })).toBe("offered");
		expect(model.calls).toHaveLength(1);
		const d = parseDraftApproval(out.sent[0]!.text)!;
		expect(d.attachments).toEqual([{ name: "행방불명_공유용.pdf", size: "35B" }]);
		expect(d.warning).toBeUndefined();
		const rec = listDrafts()[0]!;
		expect(stagedFiles(rec.id).map(f => f.name)).toEqual(["행방불명_공유용.pdf"]);
		expect(rec.status).toBe("pending");
	});
	test("no match: the warning plus 첨부 파일 폴더에서 맞는 파일을 찾지 못했어요", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const out = sink();
		await offerMailDraft({ ...teacherMail, subject: "다른 곡 악보 부탁드립니다", body: "다른 곡 악보 부탁드립니다" }, { send: out.send, call: fakeModel([j(teacherReply)]).call });
		const d = parseDraftApproval(out.sent[0]!.text)!;
		expect(d.attachments).toBeUndefined();
		expect(d.warning).toBe(NO_ATTACHMENT_WARNING);
		expect(d.note).toContain(LIBRARY_MISS);
		expect(listDrafts()[0]!.libraryMiss).toBe(true);
	});
	test("no folder set: the warning only, nothing is searched; a plain reply gets neither", async () => {
		enable(env);
		const out = sink();
		await offerMailDraft(teacherMail, { send: out.send, call: fakeModel([j(teacherReply)]).call });
		const d = parseDraftApproval(out.sent[0]!.text)!;
		expect(d.warning).toBe(NO_ATTACHMENT_WARNING);
		expect(d.note).not.toContain(LIBRARY_MISS);
		const plain = sink();
		await offerMailDraft({ ...mailFixture, key: "plain-1" }, { send: plain.send, call: fakeModel([j({ action: "draft", to: "kim@example.com", subject: "Re: x", body: "확인했어요.", questions: [] })]).call });
		expect(parseDraftApproval(plain.sent[0]!.text)!.warning).toBeUndefined();
	});
	test("a webmail account cannot send files: nothing is staged, the warning stays", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const out = sink();
		await offerMailDraft({ ...teacherMail, key: "w-1", source: "webmail:corp" }, { send: out.send, call: fakeModel([j(teacherReply)]).call });
		expect(parseDraftApproval(out.sent[0]!.text)!.attachments).toBeUndefined();
		expect(canAttach("webmail:corp")).toBe(false);
		expect(canAttach("zele")).toBe(true);
	});
	test("a revised draft keeps the files of the one it replaces", async () => {
		enable(env, { attachFolders: { mail: lib } });
		await offerMailDraft(teacherMail, { send: sink().send, call: fakeModel([j(teacherReply)]).call });
		const old = listDrafts()[0]!;
		const step = await reviseDraft(old.id, "더 짧게", { call: fakeModel([j({ ...teacherReply, body: "악보 보내드립니다." })]).call });
		expect(step.ok).toBe(true);
		const fresh = listDrafts().find(d => d.status === "pending")!;
		expect(fresh.id).not.toBe(old.id);
		expect(stagedFiles(fresh.id).map(f => f.name)).toEqual(["행방불명_공유용.pdf"]);
		expect(parseDraftApproval(step.text)!.attachments).toHaveLength(1);
	});
});

describe("sending", () => {
	const runner = () => {
		const argv: string[][] = [];
		const run: Runner = async a => (argv.push(a), { code: 0, stdout: "", stderr: "" });
		return { argv, run };
	};
	test("zele reply carries every staged file as --attach, after the read zele demands", async () => {
		enable(env, { attachFolders: { mail: lib } });
		await offerMailDraft(teacherMail, { send: sink().send, call: fakeModel([j(teacherReply)]).call });
		const rec = getDraft(listDrafts()[0]!.id)!;
		addStagedFile(rec.id, join(lib, "견적서 양식.xlsx"));
		const { argv, run } = runner();
		expect(await sendWith(rec, run)).toMatchObject({ ok: true });
		expect(argv[0]).toEqual(["zele", "mail", "read", "msg-1"]);
		const reply = argv[1]!;
		expect(reply.slice(0, 8)).toEqual(["zele", "mail", "reply", "msg-1", "--to", "stu@example.com", "--body", TEACHER_BODY]);
		const files = reply.slice(8);
		expect(files.filter(a => a === "--attach")).toHaveLength(2);
		expect(files.filter(a => a !== "--attach").map(p => p.split("/").pop())).toEqual(["행방불명_공유용.pdf", "견적서 양식.xlsx"]);
		for (const p of files.filter(a => a !== "--attach")) expect(existsSync(p)).toBe(true);
	});
	test("a draft without files sends no --attach", async () => {
		enable(env);
		await offerMailDraft({ ...mailFixture, key: "p-2" }, { send: sink().send, call: fakeModel([j({ action: "draft", to: "kim@example.com", subject: "Re: x", body: "확인했어요.", questions: [] })]).call });
		const { argv, run } = runner();
		await sendWith(listDrafts()[0]!, run);
		expect(argv[1]).not.toContain("--attach");
	});
	test("a source that cannot send files refuses a draft that holds files instead of dropping them", async () => {
		enable(env);
		await offerMailDraft({ ...teacherMail, key: "w-2", source: "webmail:corp" }, { send: sink().send, call: fakeModel([j(teacherReply)]).call });
		const rec = listDrafts()[0]!;
		addStagedFile(rec.id, join(lib, "행방불명_공유용.pdf"));
		const { argv, run } = runner();
		const out = await sendWith(rec, run);
		expect(out.ok).toBe(false);
		expect(out.message).toContain("첨부파일을 보낼 수 없");
		expect(argv).toEqual([]);
	});
	test("a custom plugin gets the files in its reply hook; its repliesWithFiles decides canAttach", async () => {
		const plugins = join(env.dir, "custom", "plugins");
		mkdirSync(plugins, { recursive: true });
		const got = join(env.dir, "plugin-got.json");
		writeFileSync(join(plugins, "work.ts"), `import { writeFileSync } from "node:fs";
export default { name: "work", reply: (d: any) => { if (d.source !== "work") return undefined; writeFileSync(${JSON.stringify(got)}, JSON.stringify(d)); return { ok: true, message: "plugin sent" }; }, repliesWithFiles: (s: string) => s === "work" };`);
		await loadPlugins(env.dir);
		try {
			enable(env);
			await offerMailDraft({ ...teacherMail, key: "c-1", source: "work" }, { send: sink().send, call: fakeModel([j(teacherReply)]).call });
			const rec = listDrafts()[0]!;
			addStagedFile(rec.id, join(lib, "행방불명_공유용.pdf"));
			expect(canAttach("work")).toBe(true);
			expect(await sendWith(rec, async () => ({ code: 1, stdout: "", stderr: "" }))).toEqual({ ok: true, message: "plugin sent" });
			const draft = JSON.parse(await Bun.file(got).text());
			expect(draft).toMatchObject({ source: "work", id: "msg-1", to: "stu@example.com", body: TEACHER_BODY });
			expect(draft.attachments).toHaveLength(1);
			expect(draft.attachments[0]).toMatchObject({ name: "행방불명_공유용.pdf", size: 35 });
			expect(existsSync(draft.attachments[0].path)).toBe(true);
		} finally {
			await loadPlugins(join(env.dir, "none"));
		}
		expect(canAttach("work")).toBe(false);
	});
});

describe("adding and removing files of a draft (the send sheet's routes)", () => {
	const call = async (method: string, ref: string, tail: string, body?: object, query = "") => {
		const url = new URL(`http://x/api/drafts/${ref}/${tail}${query}`);
		const res = await draftAttachRoute(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), url, ref, tail);
		return { status: res.status, body: (await res.json()) as any };
	};
	async function draft() {
		enable(env, { attachFolders: { mail: lib } });
		await offerMailDraft({ ...teacherMail, subject: "다른 곡 악보 부탁드립니다", body: "다른 곡 악보 부탁드립니다" }, { send: sink().send, call: fakeModel([j(teacherReply)]).call });
		return listDrafts()[0]!.id;
	}
	test("the library lists its files; picking one stages it, bytes stage a file, x takes one off", async () => {
		const ref = await draft();
		expect((await call("GET", ref, "files")).body).toEqual({ files: [], canAttach: true, library: true, editable: true, tracked: true });
		const listed = (await call("GET", ref, "library")).body.items as { rel: string }[];
		expect(listed.map(i => i.rel)).toContain("악보/기타/캐논.pdf");
		expect((await call("GET", ref, "library", undefined, "?q=캐논")).body.items.map((i: { rel: string }) => i.rel)).toEqual(["악보/기타/캐논.pdf"]);
		const added = await call("POST", ref, "files", { library: "악보/기타/캐논.pdf" });
		expect(added.body.files).toEqual([{ name: "캐논.pdf", size: "33B" }]);
		const bytes = await call("POST", ref, "files", { name: "../../메모.txt", data: Buffer.from("hello").toString("base64") });
		expect(bytes.body.files.map((f: { name: string }) => f.name)).toEqual(["캐논.pdf", "메모.txt"]);
		const removed = await call("POST", ref, "files", { remove: 0 });
		expect(removed.body.files).toEqual([{ name: "메모.txt", size: "5B" }]);
		expect(stagedFiles(ref).map(f => f.name)).toEqual(["메모.txt"]);
		expect((await call("POST", ref, "files", { remove: 5 })).status).toBe(404);
	});
	test("a path outside the folder, an unknown draft and a sent draft change nothing", async () => {
		const ref = await draft();
		expect((await call("POST", ref, "files", { library: "../secret.txt" })).status).toBe(404);
		expect((await call("POST", ref, "files", { library: "/etc/hosts" })).status).toBe(404);
		expect((await call("POST", "RNOSUCH0001", "files", { library: "행방불명_공유용.pdf" })).status).toBe(404);
		expect((await call("GET", "RNOSUCH0001", "files")).body.editable).toBe(false);
		expect((await call("POST", ref, "files", {})).status).toBe(400);
		expect(stagedFiles(ref)).toEqual([]);
		setStatus(ref, "sent");
		expect((await call("POST", ref, "files", { library: "행방불명_공유용.pdf" })).status).toBe(409);
		expect(removeStagedFile(ref, 0)).toBe(false);
	});
	test("a webmail draft reports canAttach false", async () => {
		enable(env, { attachFolders: { mail: lib } });
		await offerMailDraft({ ...teacherMail, key: "w-3", source: "webmail:corp" }, { send: sink().send, call: fakeModel([j(teacherReply)]).call });
		const ref = listDrafts()[0]!.id;
		expect((await call("GET", ref, "files")).body).toMatchObject({ canAttach: false, editable: true });
	});
});
