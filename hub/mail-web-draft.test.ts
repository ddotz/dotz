import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { mailByKey, postMail, type MailDeps } from "./mail.ts";
import { saveUpload, UPLOADS } from "./files.ts";
import { listDrafts } from "../features/reply-drafts/lib/store.ts";
import { stagedFiles } from "../features/reply-drafts/lib/staged.ts";
import { makeRoute } from "./routes.ts";
import { emit } from "./events.ts";

// 메일 쓰기 and the reply box of the mail app (web/js/30-mail-box.js): POST /api/mail/compose without a ref is a draft the owner wrote himself.
// It is recorded like any other draft (pending), its uploads are staged under its own id, and the gateway posts the send-approval card;
// a send still waits for his 보내기. Nothing here sends: the fake mail deps only record.
const env = setupEnv();
afterAll(env.cleanup);

const mailDeps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: e => emit("inbox", e as Parameters<typeof emit>[1]), wake: () => undefined };
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => mailDeps });
const call = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));

let seq = 0;
const upload = (name: string, text: string) => {
	const dir = join(UPLOADS, "day");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${Date.now()}-${++seq}-${name}`);
	writeFileSync(path, text);
	return { name, path, type: "text/plain", size: Buffer.byteLength(text) };
};

const incoming = async () => (await postMail({ source: "zele", id: `wd${++seq}`, subject: "점검 결과 부탁드립니다", from: "Kim <kim@example.com>", to: "me@example.com", body: "점검 결과 보내 주세요" }, mailDeps)).key;

describe("the owner writes a mail in the app", () => {
	test("an uploaded file reaches the draft under the name it came with, in the new mail and in a file added to its card", async () => {
		const up = () => saveUpload(new File(["pdf"], "(마크추가)파일.pdf"));
		const res = await call("POST", "/api/mail/compose", { to: "lee@example.com", subject: "자료", body: "자료입니다.", attachments: [await up()] });
		expect(res.status).toBe(200);
		const rec = listDrafts().find(d => d.subject === "자료")!;
		expect(stagedFiles(rec.id).map(f => f.name)).toEqual(["(마크추가)파일.pdf"]);
		const more = await call("POST", `/api/drafts/${rec.id}/files`, { upload: await up() });
		expect(more.status).toBe(200);
		expect(stagedFiles(rec.id).map(f => f.name)).toEqual(["(마크추가)파일.pdf", "(마크추가)파일 (2).pdf"]);
		expect(readFileSync(stagedFiles(rec.id)[1]!.path, "utf8")).toBe("pdf");
	});

	test("새 메일: his text and two files become a pending draft, both files staged with their bytes", async () => {
		const a = upload("견적서.txt", "견적 금액은 3,000,000원입니다."), b = upload("일정.csv", "1주,설계\n2주,개발\n");
		const res = await call("POST", "/api/mail/compose", { to: "lee@example.com", cc: "park@example.com", subject: "견적 문의", body: "견적을 부탁드립니다.", attachments: [a, b] });
		expect(res.status).toBe(200);
		const made = (await res.json()) as { ok: boolean; ref: string; key: string; files: { name: string; size: number }[] };
		expect(made.ok).toBe(true);
		expect(made.files.map(f => f.name)).toEqual(["견적서.txt", "일정.csv"]);
		const rec = listDrafts().find(d => d.id === made.ref)!;
		expect(rec).toMatchObject({ compose: true, status: "pending", to: "lee@example.com", subject: "견적 문의", body: "견적을 부탁드립니다." });
		const files = stagedFiles(rec.id);
		expect(files.map(f => f.name)).toEqual(["견적서.txt", "일정.csv"]);
		expect(readFileSync(files[0]!.path, "utf8")).toBe("견적 금액은 3,000,000원입니다.");
		expect(mailByKey(made.key)!.dir).toBe("out");
	});

	test("답장: it rides on the mail it answers, with that mail's sender and subject", async () => {
		const key = await incoming();
		const mail = mailByKey(key)!;
		const res = await call("POST", "/api/mail/compose", { reply_to: key, to: "kim@example.com", subject: "Re: 점검 결과 부탁드립니다", body: "확인해서 보내드리겠습니다.", attachments: [upload("보고서.txt", "보고서 본문")] });
		const made = (await res.json()) as { ok: boolean; ref: string; files: unknown[] };
		expect(made.ok).toBe(true);
		const rec = listDrafts().find(d => d.id === made.ref)!;
		expect(rec).toMatchObject({ ref: key, mailId: mail.id, source: "zele", status: "pending" });
		expect(rec.compose).toBeUndefined();
		expect(readFileSync(stagedFiles(rec.id)[0]!.path, "utf8")).toBe("보고서 본문");
		expect(mailByKey(key)!.suggest).toMatchObject({ kind: "reply-draft", ref: rec.id });
	});

	test("an upload that is gone is refused whole, and no draft is left behind", async () => {
		const before = listDrafts().length;
		const res = await call("POST", "/api/mail/compose", { to: "lee@example.com", subject: "제목", body: "본문", attachments: [{ name: "없는 파일.txt", path: join(UPLOADS, "nope.txt"), size: 1 }] });
		expect(res.status).toBe(400);
		expect(listDrafts().length).toBe(before);
	});

	test("a draft with no body, no recipient, or an unknown mail is refused with a plain reason", async () => {
		expect(((await (await call("POST", "/api/mail/compose", { to: "lee@example.com", subject: "제목" })).json()) as { error: string }).error).toBe("내용을 적어 주세요");
		expect(((await (await call("POST", "/api/mail/compose", { body: "본문", subject: "제목" })).json()) as { error: string }).error).toBe("받는 사람을 적어 주세요");
		const gone = await call("POST", "/api/mail/compose", { reply_to: "zele-nosuch", to: "kim@example.com", body: "본문" });
		expect(gone.status).toBe(404);
	});

	test("the card it posts carries both files, so 보내기 goes with them", async () => {
		const res = await call("POST", "/api/mail/compose", { to: "lee@example.com", subject: "자료 보내드립니다", body: "자료 보내드립니다.", attachments: [upload("자료.txt", "자료 본문")] });
		const made = (await res.json()) as { ref: string; key: string };
		const rec = listDrafts().find(d => d.id === made.ref)!;
		const { askText } = await import("../features/reply-drafts/lib/flow.ts");
		const card = askText(rec, []);
		expect(card).toContain("[ask]");
		expect(card).toContain(`> 첨부: 자료.txt`);
		expect(card).toContain(`(${rec.id})`);
	});
});
