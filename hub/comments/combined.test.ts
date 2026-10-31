// One card for a comment reply and the mail that follows it: the block shows both, one 보내기 posts the reply and then sends the mail,
// 고치기 changes either part, 보내지 않기 drops both. Everything is injected (adapter, model, mail link): nothing is posted or sent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runComments } from "../../features/comments/bin/comments.ts";
import { parseDecisions } from "../choices.ts";
import { parseDraftApproval } from "../draft-approval.ts";
import { commentAsk } from "./ask.ts";
import { type Comment, type CommentAdapter, commentId, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine, type MailLink, type MailView } from "./engine.ts";
import { createCommentsWeb } from "./web.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const raw = (native: string): RawComment => ({ native, thread: "p1", author: "팬", text: "악보 받을 수 있나요? fan@example.com", postTitle: "Post one", at: NOW - 1000 });
const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const MAIL = { app: "mail", to: "fan@example.com", subject: "악보 보내드립니다", body: "안녕하세요.\n요청하신 악보를 보내드립니다.", attach: ["/files/score.pdf"] };
const reply = (body: string) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [] })}\n\`\`\``;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "combined-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A mail link that only records: `log` is shared with the adapter so the order reply -> mail is visible.
function fakeMail(log: string[], o: { failSend?: string } = {}) {
	const drafts = new Map<string, MailView>();
	let n = 0;
	const link: MailLink = {
		compose: async spec => {
			const id = `M${++n}`;
			drafts.set(id, { id, to: spec.to, subject: spec.subject, body: spec.body, attachments: (spec.attach ?? []).map(p => ({ name: p.split("/").pop()!, size: 2048 })) });
			log.push(`compose ${id}`);
			return { ok: true, id };
		},
		send: async id => (log.push(`send ${id}`), o.failSend ? { ok: false, text: o.failSend } : { ok: true, text: "메일을 보냈어요" }),
		drop: id => void log.push(`drop ${id}`),
		revise: async (id, change) => {
			const v = drafts.get(id)!;
			const next = `M${++n}`;
			drafts.set(next, { ...v, id: next, body: `${v.body}\n(${change})` });
			log.push(`revise ${id} -> ${next}`);
			return { ok: true, id: next };
		},
		view: id => drafts.get(id),
	};
	return link;
}

function setup(o: { failSend?: string; noMail?: boolean; failReply?: string; sub?: string } = {}) {
	const root = o.sub ? join(dir, o.sub) : dir;
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const log: string[] = [];
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [raw("c1")], cursor: "1" }),
		reply: async (_s, _c, text) => (log.push("reply"), o.failReply ? { ok: false, reason: o.failReply } : (void text, { ok: true, ref: "r1" })),
		posts: async () => [],
	};
	const events: Record<string, unknown>[] = [];
	const woke: string[] = [];
	const engine = createEngine({
		dir: root,
		now: () => NOW,
		collector: "mac-a",
		adapters: { youtube: adapter },
		model: async () => ({ text: reply("고쳐 쓴 답글이에요.") }),
		broadcast: e => events.push(e),
		sent: (app, r) => woke.push(`${app}:${r.id}`),
		...(o.noMail ? {} : { mail: fakeMail(log, o) }),
	});
	const id = commentId("youtube", "c1");
	return { engine, log, events, woke, id, inbox: join(root, "inbox.jsonl") };
}
type T = ReturnType<typeof setup>;

async function withMail(t: T) {
	await t.engine.collect({ force: true });
	const s = await t.engine.addDraft(t.id, "악보는 메일로 보내 드렸어요", undefined, MAIL);
	if (!s.ok) throw new Error(s.reason);
	return s.draft;
}
const pick = (t: T, code: string, n: 1 | 2 | 3, ts = NOW + 5000, source = "web") => {
	const label = ["보내기", "고치기", "보내지 않기"][n - 1]!;
	appendFileSync(t.inbox, `${JSON.stringify({ ts: new Date(ts).toISOString(), kind: "message", source, text: `${n}) ${label}`, picks: [{ q: `이 답글을 올리고 메일도 보낼까요? (${code})`, n, label }] })}\n`);
};

describe("the combined card", () => {
	test("shows the reply, then the mail with 받는이, 제목, 첨부 and body, in one approval block", async () => {
		const t = setup();
		const d = await withMail(t);
		expect(d).toMatchObject({ status: "pending", mail: "M1", clean: false });
		const c = t.engine.store.comments()[0]! as Comment;
		const text = commentAsk(source, c, d, "댓글 답글과 이어서 보낼 메일 초안을 만들었어요", t.engine.mailView(d));
		const block = text.slice(text.indexOf("> 대상:"));
		expect(block.indexOf("> 대상: 팬 댓글")).toBeLessThan(block.indexOf("> 함께 보낼 메일"));
		expect(block.indexOf("> 함께 보낼 메일")).toBeLessThan(block.indexOf("> 받는이: fan@example.com"));
		const card = parseDraftApproval(text);
		expect(card).toMatchObject({ toLabel: "대상", to: "팬 댓글", body: "악보는 메일로 보내 드렸어요", ref: d.code });
		expect(card?.mail).toMatchObject({ toLabel: "받는이", to: "fan@example.com", subject: "악보 보내드립니다", body: "안녕하세요.\n요청하신 악보를 보내드립니다.", attachments: [{ name: "score.pdf", size: "2KB" }] });
		expect(card?.mail?.warning).toBeUndefined();
		expect(card?.mail?.ref).toBe("M1");   // the mail draft id its files are staged under: the card opens them at /api/drafts/M1/files/<n>
		// The split send of `comments.ts send --only` is on the card itself: 4) 답글만 보내기, 5) 메일만 보내기, 6) 직접 입력 after the three.
		expect(parseDecisions(text).blocks[0]!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기", "답글만 보내기", "메일만 보내기", "어떻게 보낼지 직접 입력"]);
	});

	test("a reply without a mail keeps the single-part block", async () => {
		const t = setup();
		await t.engine.collect({ force: true });
		const s = await t.engine.addDraft(t.id, "답글만");
		if (!s.ok) throw new Error(s.reason);
		const text = commentAsk(source, t.engine.store.comments()[0]!, s.draft);
		expect(parseDraftApproval(text)?.mail).toBeUndefined();
		expect(parseDecisions(text).blocks[0]!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
	});

	test("보내기 posts the reply and then sends the mail, once", async () => {
		const t = setup();
		const d = await withMail(t);
		pick(t, d.code, 1);
		const out = await runComments(["send", d.code], t.engine, t.inbox);
		expect(out.code).toBe(0);
		expect(t.log).toEqual(["compose M1", "reply", "send M1"]);
		expect(t.engine.store.replies()[0]).toMatchObject({ state: "sent", mail: { state: "sent" } });
		expect((await runComments(["send", d.code], t.engine, t.inbox)).code).toBe(1);
		expect(t.log.filter(l => l === "send M1")).toHaveLength(1);
	});

	test("the send is refused without the owner's pick for this card: nothing is posted, nothing is sent", async () => {
		const t = setup();
		const d = await withMail(t);
		expect((await runComments(["send", d.code], t.engine, t.inbox)).code).toBe(1);
		pick(t, "Dother00", 1);
		pick(t, d.code, 1, NOW + 5000, "lane_message");
		pick(t, d.code, 3);
		expect((await runComments(["send", d.code], t.engine, t.inbox)).code).toBe(1);
		// a 보내기 given on a card that did not show the mail yet does not approve it
		pick(t, d.code, 1, NOW - 1000);
		expect((await runComments(["send", d.code], t.engine, t.inbox)).code).toBe(1);
		expect(t.log).toEqual(["compose M1"]);
	});

	test("a failed mail says so and leaves the reply posted; a failed reply sends no mail", async () => {
		const t = setup({ failSend: "SMTP 거부" });
		const d = await withMail(t);
		pick(t, d.code, 1);
		const out = await runComments(["send", d.code], t.engine, t.inbox);
		expect(out.code).toBe(1);
		expect(out.lines[0]).toContain("SMTP 거부");
		expect(t.log).toEqual(["compose M1", "reply", "send M1"]);
		expect(t.engine.store.replies()[0]).toMatchObject({ state: "sent", mail: { state: "failed", text: "SMTP 거부" } });
		expect(t.engine.store.drafts()[0]!.status).toBe("sent");
		expect(t.events.at(-1)).toMatchObject({ kind: "comment_send", state: "sent", mail: "failed", mailReason: "SMTP 거부" });

		const f = setup({ failReply: "quota", sub: "b" });
		const d2 = await withMail(f);
		pick(f, d2.code, 1);
		const out2 = await runComments(["send", d2.code], f.engine, f.inbox);
		expect(out2.code).toBe(1);
		expect(f.log).toEqual(["compose M1", "reply"]);
	});

	test("고치기 changes the mail alone (same card code) or the reply alone (mail stays attached)", async () => {
		const t = setup();
		const d = await withMail(t);
		const m = await t.engine.revise(d.code, "제목에 곡 이름을 넣어 줘", "mail");
		if (!m.ok) throw new Error(m.reason);
		expect(m.draft).toMatchObject({ code: d.code, text: d.text, mail: "M2", status: "pending" });
		expect(t.log).toContain("revise M1 -> M2");
		expect(t.engine.mailView(m.draft)?.body).toContain("(제목에 곡 이름을 넣어 줘)");

		const r = await t.engine.revise(d.code, "더 짧게", "reply");
		if (!r.ok) throw new Error(r.reason);
		expect(r.draft.code).not.toBe(d.code);
		expect(r.draft).toMatchObject({ text: "고쳐 쓴 답글이에요.", mail: "M2", clean: false });
		expect(t.engine.store.drafts().find(x => x.code === d.code)!.status).toBe("stale");

		const plain = setup({ sub: "b" });
		await plain.engine.collect({ force: true });
		const only = await plain.engine.addDraft(plain.id, "답글만");
		if (!only.ok) throw new Error(only.reason);
		expect(await plain.engine.revise(only.draft.code, "메일 고쳐", "mail")).toMatchObject({ ok: false });
	});

	test("the CLI revise takes --part and prints the combined card again", async () => {
		const t = setup();
		const d = await withMail(t);
		const out = await runComments(["revise", d.code, "--change", "인사말을 줄여 줘", "--part", "mail"], t.engine, t.inbox);
		expect(out.code).toBe(0);
		expect(parseDraftApproval(out.lines[0]!)?.mail?.body).toContain("(인사말을 줄여 줘)");
		expect((await runComments(["revise", d.code, "--change", "x", "--part", "both"], t.engine, t.inbox)).code).toBe(1);
	});

	test("보내지 않기 drops the reply and the mail, and neither can be sent afterwards", async () => {
		const t = setup();
		const d = await withMail(t);
		expect((await runComments(["drop", d.code], t.engine, t.inbox)).code).toBe(0);
		expect(t.log).toContain("drop M1");
		expect(t.engine.store.drafts()[0]!.status).toBe("dropped");
		expect(t.engine.send(d.code, { by: "owner" })).toMatchObject({ ok: false });
		expect(t.log.filter(l => l.startsWith("send"))).toEqual([]);
	});
});

describe("the draft API", () => {
	const call = async (t: T, path: string, body: object) => {
		const web = createCommentsWeb({ engine: t.engine, broadcast: () => {} });
		const url = new URL(`http://x${path}`);
		const res = await web.route(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), url, url.pathname.split("/").filter(Boolean));
		return { status: res!.status, json: (await res!.json()) as any, web };
	};
	const path = (t: T, tail = "draft") => `/api/comments/comment/${encodeURIComponent(t.id)}/${tail}`;

	test("extra.mail becomes a mail draft on the same card and the thread view shows it", async () => {
		const t = setup();
		await t.engine.collect({ force: true });
		const ok = await call(t, path(t), { text: "악보는 메일로 보내 드렸어요", extra: { note: "악보 메일", mail: MAIL } });
		expect(ok.status).toBe(200);
		expect(t.engine.store.drafts()[0]).toMatchObject({ code: ok.json.code, mail: "M1", clean: false, notes: [expect.stringContaining("악보 메일")] });
		const view = t.engine.threadView("youtube", "p1")!;
		expect(view.drafts[0]!.mail).toEqual({ id: "M1", to: "fan@example.com", subject: "악보 보내드립니다", body: MAIL.body, attachments: [{ name: "score.pdf", size: "2KB" }] });
	});

	test("a string extra stays a note; a bad mail or a missing mail link is refused", async () => {
		const t = setup();
		await t.engine.collect({ force: true });
		expect((await call(t, path(t), { text: "글", extra: "메일로 악보" })).status).toBe(200);
		expect(t.engine.store.drafts()[0]).toMatchObject({ notes: [expect.stringContaining("메일로 악보")] });
		expect(t.engine.store.drafts()[0]!.mail).toBeUndefined();
		expect((await call(t, path(t), { text: "글", extra: { mail: { ...MAIL, subject: "" } } })).status).toBe(400);
		expect((await call(t, path(t), { text: "글", extra: { mail: { ...MAIL, attach: "x" } } })).status).toBe(400);
		expect((await call(t, path(t), { text: "글", extra: { note: "메일 없음" } })).status).toBe(400);
		const none = setup({ noMail: true, sub: "b" });
		await none.engine.collect({ force: true });
		expect(await call(none, path(none), { text: "글", extra: { mail: MAIL } }).then(r => r.status)).toBe(409);
		expect(none.engine.store.drafts()).toHaveLength(0);
	});

	test("the web 보내기 posts the reply, then sends the mail, and the revise route takes a part", async () => {
		const t = setup();
		await t.engine.collect({ force: true });
		const made = await call(t, path(t), { text: "악보는 메일로 보내 드렸어요", extra: { mail: MAIL } });
		const code = made.json.code as string;
		expect((await call(t, `/api/comments/drafts/${code}/revise`, { change: "x", part: "both" })).status).toBe(400);
		expect((await call(t, `/api/comments/drafts/${code}/revise`, { change: "제목을 바꿔", part: "mail" })).status).toBe(200);
		const sent = await call(t, `/api/comments/drafts/${code}/send`, {});
		expect(sent.status).toBe(202);
		await sent.web.idle();
		await t.engine.idle();
		expect(t.log).toEqual(["compose M1", "revise M1 -> M2", "reply", "send M2"]);
		// the mail it carries is part of this card: no 이어서 할 일 rule wakes for a reply that brought its mail
		expect(t.woke).toEqual([]);
	});

	test("a reply without a mail still wakes the 이어서 할 일 rule", async () => {
		const t = setup();
		await t.engine.collect({ force: true });
		const s = await t.engine.addDraft(t.id, "답글만");
		if (!s.ok) throw new Error(s.reason);
		const r = t.engine.send(s.draft.code, { by: "owner" });
		expect(r.ok && (await r.done).state).toBe("sent");
		expect(t.woke).toHaveLength(1);
	});
});

describe("sending one part of the card (send --only)", () => {
	test("--only reply posts the reply and leaves the mail draft on its own, unsent", async () => {
		const t = setup();
		const d = await withMail(t);
		pick(t, d.code, 1);
		const r = await runComments(["send", d.code, "--only", "reply"], t.engine, t.inbox);
		expect(r.code).toBe(0);
		expect(r.lines.join("\n")).toContain("mail-cli.ts ask --draft M1");
		expect(t.log).toEqual(["compose M1", "reply"]);
		expect(t.engine.store.drafts().find(x => x.code === d.code)!.status).toBe("sent");
	});

	test("--only mail sends the mail; the reply waits alone and its card no longer carries the mail", async () => {
		const t = setup();
		const d = await withMail(t);
		pick(t, d.code, 1);
		const r = await runComments(["send", d.code, "--only", "mail"], t.engine, t.inbox);
		expect(r.code).toBe(0);
		expect(t.log).toEqual(["compose M1", "send M1"]);
		const after = t.engine.store.drafts().find(x => x.code === d.code)!;
		expect(after.status).toBe("pending");
		expect(after.mail).toBeUndefined();
		expect(r.lines.join("\n")).toContain("이 답글 올릴까요?");
	});

	test("without the owner's pick nothing goes out, and --only takes reply or mail only", async () => {
		const t = setup();
		const d = await withMail(t);
		expect((await runComments(["send", d.code, "--only", "mail"], t.engine, t.inbox)).code).toBe(1);
		pick(t, d.code, 3);
		expect((await runComments(["send", d.code, "--only", "reply"], t.engine, t.inbox)).code).toBe(1);
		expect((await runComments(["send", d.code, "--only", "both"], t.engine, t.inbox)).lines[0]).toBe("--only는 reply 또는 mail이에요");
		expect(t.log).toEqual(["compose M1"]);
	});
});
