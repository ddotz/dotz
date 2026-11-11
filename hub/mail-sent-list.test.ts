import { afterAll, describe, expect, test } from "bun:test";
import { addDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { addStagedBytes } from "../features/reply-drafts/lib/staged.ts";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { mailByKey, postMail, type MailDeps } from "./mail.ts";
import { makeRoute } from "./routes.ts";

// A mail the owner sent shows in the mail list (GET /api/conversations) as 내가 보냄: one the mailbox's sent folder reports, one dotz sent as an approved
// reply (listed at once, with its text and files, in the thread of the mail it answered) and a new mail composed in dotz.
const env = setupEnv();
afterAll(env.cleanup);
const call = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => deps });
const rows = async () => ((await (await call("GET", "/api/conversations?all=1")).json()) as { items: Array<{ target: string; mail?: Record<string, any> }> }).items;
const rowOf = async (key: string) => (await rows()).find(i => i.target === `mail:${key}`)?.mail;

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;
const deps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: () => undefined, wake: () => undefined };
const draft = (id: string, ref: string, extra: Partial<DraftRec> = {}): DraftRec => ({ id, kind: "mail", app: "mail", source: "fx", mailId: "1", ref, to: "kim@example.com", subject: "Re: 견적 문의", body: "견적 보내 드려요.\n금요일에 뵐게요.", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", app: "mail", from: "kim@example.com", text: "견적 부탁해요" }, ...extra });

describe("보낸 메일 목록", () => {
	test("a mail the sent folder reports is listed as dir out with its recipient, time and a body preview", async () => {
		const r = await postMail({ source: "zele", id: uid("snt"), subject: "회의 자료", from: "Me <me@example.com>", to: "kim@example.com", body: "자료 첨부해요.\n확인 부탁해요.", folder: "SENT", at: "2030-05-01T09:00:00+09:00" }, deps);
		expect(r.direction).toBe("out");
		expect(await rowOf(r.key)).toMatchObject({ dir: "out", to: "kim@example.com", at: "2030-05-01T00:00:00.000Z", preview: "자료 첨부해요.\n확인 부탁해요.", html: true });
		const label = await postMail({ source: "zele", id: uid("snl"), subject: "라벨로 보냄", from: "Me <me@example.com>", to: "lee@example.com", labels: ["SENT"], summary: "한 줄 요약" }, deps);
		expect(await rowOf(label.key)).toMatchObject({ dir: "out", to: "lee@example.com", summary: "한 줄 요약" });
	});

	test("a reply dotz sent is listed at once with its text and files, in the thread of the mail it answered", async () => {
		const incoming = await postMail({ source: "fx", id: uid("inc"), subject: "견적 문의", from: "Kim <kim@example.com>", to: "me@example.com", body: "견적 부탁해요", needsReply: true }, deps);
		const id = `R${uid("S").toUpperCase().replace(/[^A-Z0-9]/g, "")}`.slice(0, 12);
		addDraft(draft(id, incoming.key));
		addStagedBytes(id, "견적서.pdf", new Uint8Array([1, 2, 3, 4]));
		expect((await call("POST", "/api/followup", { app: "mail", kind: "mail", key: id, ids: { draft: id, mail: incoming.key } })).status).toBe(200);
		const list = await rows();
		const sent = list.find(i => i.mail?.dir === "out" && i.mail?.to === "kim@example.com" && i.mail?.subject === "Re: 견적 문의");
		expect(sent?.mail).toMatchObject({ dir: "out", preview: "견적 보내 드려요.\n금요일에 뵐게요.", html: true, attachments: [{ name: "견적서.pdf", size: 4 }] });
		expect(sent?.mail?.base).toBe((await rowOf(incoming.key))!.base);
		expect((await rowOf(incoming.key))!.reply).toBe("replied");
		expect(mailByKey(sent!.target.slice(5))!.attachments![0]!.file).toContain("견적서.pdf");
	});

	test("a new mail composed in dotz becomes the sent mail once it went out", async () => {
		const ref = uid("cmp");
		const id = `R${ref.toUpperCase().replace(/[^A-Z0-9]/g, "")}`.slice(0, 12);
		const key = ((await (await call("POST", "/api/mail/compose", { ref: id, source: "zele", app: "mail", to: "park@example.com", subject: "새 제안" })).json()) as { key: string }).key;
		expect(await rowOf(key)).toMatchObject({ dir: "out", suggest: { state: "draft" } });
		addDraft(draft(id, `compose-${id.toLowerCase()}`, { compose: true, source: "zele", to: "park@example.com", subject: "새 제안", body: "제안드립니다." }));
		expect((await call("POST", "/api/mail/compose", { ref: id, source: "zele", state: "sent" })).status).toBe(200);
		expect(await rowOf(key)).toMatchObject({ dir: "out", to: "park@example.com", preview: "제안드립니다.", suggest: { state: "sent" } });
	});
});
