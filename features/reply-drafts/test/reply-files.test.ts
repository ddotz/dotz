// Files the mail's poster already chose for the reply (hub/mail.ts reply_files): staged on the draft as they are, named to the model as
// attached, and no 첨부 파일 폴더 pick runs.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerMailDraft } from "../lib/offer.ts";
import { stagedFiles } from "../lib/staged.ts";
import { paths } from "../lib/settings.ts";
import { listDrafts } from "../lib/store.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
const src = mkdtempSync(join(tmpdir(), "rd-reply-files-"));
afterAll(() => {
	env.cleanup();
	rmSync(src, { recursive: true, force: true });
});
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
});
const quote = join(src, "견적서 양식.xlsx");
writeFileSync(quote, "quote bytes");
const sent: string[] = [];
const send = (_t: string, text: string) => void sent.push(text);

test("reply files are on the draft, its card lists them, and the model is told they are attached", async () => {
	enable(env);
	const model = fakeModel([j({ ...goodReply, body: "요청하신 견적서 양식 보내드립니다." })]);
	expect(await offerMailDraft({ ...mailFixture, key: "rf-1", subject: "견적서 양식 부탁드려요", body: "견적서 양식 부탁드려요", replyFiles: [{ path: quote }] }, { send, call: model.call })).toBe("offered");
	const draft = listDrafts().at(-1)!;
	expect(stagedFiles(draft.id).map(f => f.name)).toEqual(["견적서 양식.xlsx"]);
	expect(sent.at(-1)).toContain("견적서 양식.xlsx");
	expect(sent.at(-1)).not.toContain("첨부파일이 없어요");
	expect(model.calls.map(c => c.system + c.user).join("\n")).toContain('"견적서 양식.xlsx"');
});

test("without reply files nothing is staged and the model hears of no attached file", async () => {
	enable(env);
	const model = fakeModel([j(goodReply)]);
	expect(await offerMailDraft({ ...mailFixture, key: "rf-2" }, { send, call: model.call })).toBe("offered");
	expect(stagedFiles(listDrafts().at(-1)!.id)).toEqual([]);
	expect(model.calls.map(c => c.system + c.user).join("\n")).not.toContain("Files already attached");
});
