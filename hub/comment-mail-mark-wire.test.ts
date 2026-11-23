import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runWatch } from "../features/comments/bin/watch.ts";
import { paths } from "../features/reply-drafts/lib/settings.ts";
import { addDraft, newId, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { DATA_DIR, paths as hubPaths } from "./config.ts";
import { broadcast, onBroadcast } from "./events.ts";
import { resetOwnAddresses, setOwnAddresses } from "./mail-state.ts";
import { deleteMail, mailByKey, mailCard, mailTarget, postMail, setMailReply, type MailDeps } from "./mail.ts";
import { commentReply, commentsRoute } from "./comments/gateway.ts";
import { type Comment, commentId, type CommentAdapter, type RawComment, type ReplyOutcome, type SourceConfig } from "./comments/contract.ts";
import { createEngine } from "./comments/engine.ts";
import { commentsDir, createStore, type Draft } from "./comments/store.ts";
import { reportSend } from "./reply-wire.ts";
import type { ReplyItem } from "./reply-types.ts";
import { flush } from "./runtime/test-clock.ts";

const deps: MailDeps = { createThread: async () => ({ id: "1" }), send: async () => {}, mailChannel: async () => undefined, discordOn: false, emit: () => {}, wake: () => {} };
const store = createStore(commentsDir(DATA_DIR));
store.saveConfig({ enabled: true, sources: { youtube: { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: [], autoDraft: false } } });
const POSTED_AT = Date.parse("2026-11-19T03:04:05.000Z");
let seq = 0;
const uid = () => `18c2f${Date.now().toString(16)}${++seq}`;
const items: { ref: string; item: ReplyItem }[] = [];
onBroadcast(e => void (e.kind === "reply" && e.item && items.push({ ref: String(e.ref), item: e.item as ReplyItem })));

beforeEach(() => {
	setOwnAddresses("zele", ["me@example.com"]);
	items.length = 0;
});
afterEach(() => resetOwnAddresses());
const mailKeys: string[] = [];
const logSizes = [hubPaths.inbox, hubPaths.outbox].map(file => [file, existsSync(file) ? statSync(file).size : 0] as const);
afterAll(() => {
	for (const key of mailKeys) deleteMail(key);
	for (const [file, size] of logSizes) if (existsSync(file)) truncateSync(file, size);
});

async function owedMail() {
	const id = uid();
	const { key } = await postMail({ source: "zele", id, messageId: `m-${id}`, from: "Fan <fan@example.com>", to: "Me <me@example.com>", subject: "자료 요청", body: "자료를 보내 주실 수 있나요?" }, deps);
	setMailReply(key, "need");
	mailKeys.push(key);
	return { id, key };
}
const comment = (native: string): Comment => ({ id: commentId("youtube", native), source: "youtube", native, thread: "p1", author: "팬", text: "자료 부탁드려요", postTitle: "영상", at: 1_000, mine: false, collector: "t" });
function commentDraft(thread: string, o: { status?: Draft["status"]; state?: "sent" | "failed" } = {}): string {
	const native = uid(), code = `D${native.slice(-6).toUpperCase()}`;
	store.addComments([comment(native)]);
	store.putDraft({ code, commentId: commentId("youtube", native), source: "youtube", thread: "p1", text: "자료는 메일로 드렸어요", status: o.status ?? "sent", created: POSTED_AT - 60_000, changes: [], clean: false, notes: [], mailThread: { id: thread, answered: false } });
	if (o.state) store.putReply({ id: `rp-${code}`, commentId: commentId("youtube", native), source: "youtube", thread: "p1", text: "자료는 메일로 드렸어요", state: o.state, at: POSTED_AT, draft: code, via: "owner", collector: "t" });
	return code;
}
const ended = (ref: string, state: "sent" | "failed") => reportSend({ ref, conv: "comment:youtube", title: `이 답글 올릴까요? (${ref})`, state, text: state === "failed" ? "앱에서 이 글을 받지 않았어요" : "", at: Date.now() });
const changed = (body: Record<string, unknown>) => commentsRoute(new Request("http://local/api/comments/changed", { method: "POST", body: JSON.stringify(body) }), new URL("http://local/api/comments/changed"), ["api", "comments", "changed"]);

test("CM-13 an approved comment reply the send CLI posted marks the matched mail once the gateway hears the send ended sent; the mail's reply state stays", async () => {
	const { id, key } = await owedMail();
	const code = commentDraft(id, { state: "sent" });
	expect(mailByKey(key)!.commentReplyAt).toBeUndefined();
	ended(code, "sent");
	expect(mailByKey(key)!.commentReplyAt).toBe(new Date(POSTED_AT).toISOString());
	expect(mailCard(mailByKey(key)!).reply).toBe("needs");
});

test("CM-13 a comment reply whose send failed marks no mail", async () => {
	const { id, key } = await owedMail();
	const code = commentDraft(id, { status: "pending", state: "failed" });
	ended(code, "failed");
	expect(mailByKey(key)!.commentReplyAt).toBeUndefined();
});

test("CM-13 a reply that went up while the mail riding on it failed still marks the matched mail", async () => {
	const { id, key } = await owedMail();
	const code = commentDraft(id, { state: "sent" });
	ended(code, "failed");
	expect(mailByKey(key)!.commentReplyAt).toBe(new Date(POSTED_AT).toISOString());
});

test("CM-13 a reply the watch's rule posted reaches the gateway by its draft code", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cm13-watch-"));
	try {
		const src: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: true, autoSince: 0, autoSend: { on: true, match: ["질문"], max_per_day: 5 } };
		writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: src } }));
		const raw: RawComment = { native: "w1", thread: "p1", author: "팬", text: "질문 있어요?", postTitle: "영상", at: Date.now() - 1000 };
		let pages: RawComment[][] = [[raw]];
		const adapter: CommentAdapter = { kind: "youtube", list: async () => ({ comments: pages.shift() ?? [] }), reply: async (): Promise<ReplyOutcome> => ({ ok: true, ref: "r1" }) };
		const reply = `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body: "네 있어요", questions: [] })}\n\`\`\``;
		const engine = createEngine({ dir, now: Date.now, collector: "t", adapters: { youtube: adapter }, model: async () => ({ text: reply }) });
		const told: unknown[][] = [];
		await runWatch(dir, engine, async (...args) => void told.push(args), Date.now() + 240_000);
		pages = [];
		const sent = engine.store.drafts().filter(d => d.status === "sent").map(d => d.code);
		expect(sent).toHaveLength(1);
		expect(told.map(a => a[2])).toEqual([sent]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CM-13 the watch naming a posted reply marks that reply's matched mail in the gateway", async () => {
	const { id, key } = await owedMail();
	const code = commentDraft(id, { state: "sent" });
	expect((await changed({ threads: [], mails: [], sent: [code] }))?.status).toBe(200);
	expect(mailByKey(key)!.commentReplyAt).toBe(new Date(POSTED_AT).toISOString());
	expect(mailCard(mailByKey(key)!).reply).toBe("needs");
});

test("CM-13 a mark lands even when the reply drafts file cannot be read", async () => {
	const { id, key } = await owedMail();
	const code = commentDraft(id, { state: "sent" });
	addDraft({ id: newId(), kind: "mail", app: "mail", source: "zele", mailId: `m-${id}`, ref: `other-${id}`, to: "a@example.com", body: "답", status: "pending", created: "2026-11-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "a@example.com", text: "안녕" } } as DraftRec);
	chmodSync(paths.drafts(), 0o000);
	try {
		expect(() => ended(code, "sent")).not.toThrow();
	} finally {
		chmodSync(paths.drafts(), 0o600);
	}
	expect(mailByKey(key)!.commentReplyAt).toBe(new Date(POSTED_AT).toISOString());
});

test("CM-13 an open comment draft card says 메일로 이미 답했어요 once its writer's mail is answered after the draft was made", async () => {
	const { id, key } = await owedMail();
	const code = commentDraft(id, { status: "pending" });
	expect((await commentReply.get(code))!.answeredElsewhere).toBeUndefined();
	setMailReply(key, "sent");
	expect((await commentReply.get(code))!.answeredElsewhere).toEqual({ via: "mail" });
	broadcast({ kind: "mail_unreplied", target: mailTarget(key) });
	await flush();
	expect(items.filter(x => x.ref === code).map(x => x.item.answeredElsewhere)).toEqual([{ via: "mail" }]);
});
