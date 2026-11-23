import { afterAll, afterEach, expect, test } from "bun:test";
import { DATA_DIR } from "./config.ts";
import { ignoreNotice, listNotices, resetNoticesForTest } from "./notices.ts";
import { out } from "./outbound.ts";
import { commentsRoute } from "./comments/gateway.ts";
import { type Comment, commentId } from "./comments/contract.ts";
import { commentsDir, createStore, type Draft } from "./comments/store.ts";
import { resetSendsBootForTest, settleSends } from "./reply-wire.ts";
import { addDraft, getDraft, newId } from "../features/reply-drafts/lib/store.ts";

const store = createStore(commentsDir(DATA_DIR));
store.saveConfig({ enabled: true, sources: { youtube: { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: [], autoDraft: false } } });

const mailDraft = (body: string) => {
	const id = newId();
	addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `km-${id.toLowerCase()}`, to: "fan@example.com", body, status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "fan@example.com", text: "자료 부탁드려요" } as never });
	return id;
};
const comment = (native: string, o: Partial<Comment> = {}): Comment => ({ id: commentId("youtube", native), source: "youtube", native, thread: "p1", author: "팬", text: "자료 부탁드려요 fan@example.com", postTitle: "영상", at: 1_000, mine: false, collector: "t", ...o });
const pendingDraft = (code: string, native: string, mail: string): Draft => ({ code, commentId: commentId("youtube", native), source: "youtube", thread: "p1", text: "메일로 보내드릴게요", status: "pending", created: 2_000, changes: [], clean: false, notes: [], mail, mailAt: 2_000 });
const mailCards = (mail: string) => listNotices(500).items.filter(n => n.decision?.state === "open" && n.decision.draft?.ref === mail);
const flush = () => out("web", "정리했어요", undefined, { source: "gateway" });
const reconcile = () => commentsRoute(new Request("http://local/api/comments/reconcile", { method: "POST" }), new URL("http://local/api/comments/reconcile"), ["api", "comments", "reconcile"]);

afterEach(() => {
	for (const n of listNotices(500).items.filter(x => x.decision?.state === "open")) ignoreNotice(n.id);
});
afterAll(resetSendsBootForTest);

test("boot: a comment closed answered on the platform raises one card for its still-pending mail; a 답장 안 함 close and a sent mail raise none", async () => {
	const kept = mailDraft("부팅 때 남은 메일"), dismissed = mailDraft("답장 안 함 메일"), sent = mailDraft("이미 보낸 메일");
	const closed = (code: string, native: string, mail: string, reason: Draft["closedReason"]): Draft => {
		const { mail: _m, mailAt: _a, ...rest } = pendingDraft(code, native, mail);
		return { ...rest, status: "answered", closedReason: reason, mailKept: mail };
	};
	store.putDraft(closed("DKEPTBOOT1", "b1", kept, "answered-on-platform"));
	store.putDraft(closed("DKEPTBOOT2", "b2", dismissed, "dismissed"));
	addDraft({ ...getDraft(sent)!, status: "sent" });
	store.putDraft(closed("DKEPTBOOT3", "b3", sent, "answered-on-platform"));
	settleSends();
	await flush();
	expect(mailCards(kept)).toHaveLength(1);
	expect(mailCards(dismissed)).toEqual([]);
	expect(mailCards(sent)).toEqual([]);
});

test("a pending reply + mail whose comment is answered on the platform ends with a card for that mail; 답장 안 함 ends with none", async () => {
	const answered = mailDraft("답한 댓글의 메일"), quiet = mailDraft("답장 안 함 댓글의 메일");
	store.addComments([comment("a1"), comment("a1.r", { author: "나", text: "보내 드렸어요", mine: true, parent: "a1", at: 3_000 }), comment("a2")]);
	store.putDraft(pendingDraft("DKEPTLIVE1", "a1", answered));
	store.putDraft(pendingDraft("DKEPTLIVE2", "a2", quiet));
	store.dismiss(commentId("youtube", "a2"), 3_000);
	expect((await reconcile())?.status).toBe(200);
	await flush();
	expect(store.drafts().find(d => d.code === "DKEPTLIVE1")).toMatchObject({ status: "answered", closedReason: "answered-on-platform", mailKept: answered });
	expect(mailCards(answered)).toHaveLength(1);
	expect(store.drafts().find(d => d.code === "DKEPTLIVE2")).toMatchObject({ status: "answered", closedReason: "dismissed" });
	expect(mailCards(quiet)).toEqual([]);
	expect(getDraft(quiet)?.status).toBe("pending");
});

test("the watch's closes reach the gateway as mails owed: each still-pending one gets one card", async () => {
	const owed = mailDraft("워치가 닫은 댓글의 메일");
	const { mail: _m, mailAt: _a, ...rest } = pendingDraft("DKEPTWATCH", "w1", owed);
	store.putDraft({ ...rest, status: "answered", closedReason: "answered-on-platform", mailKept: owed });
	const changed = () => commentsRoute(new Request("http://local/api/comments/changed", { method: "POST", body: JSON.stringify({ threads: [], mails: [owed] }) }), new URL("http://local/api/comments/changed"), ["api", "comments", "changed"]);
	expect((await changed())?.status).toBe(200);
	expect((await changed())?.status).toBe(200);
	await flush();
	expect(mailCards(owed)).toHaveLength(1);
});

test("a kept mail gets its card once: after the owner ignores it and the card leaves the notices list, the watch naming it again raises none", async () => {
	const owed = mailDraft("한 번만 묻는 메일");
	const { mail: _m, mailAt: _a, ...rest } = pendingDraft("DKEPTONCE1", "o1", owed);
	store.putDraft({ ...rest, status: "answered", closedReason: "answered-on-platform", mailKept: owed });
	const changed = () => commentsRoute(new Request("http://local/api/comments/changed", { method: "POST", body: JSON.stringify({ threads: [], mails: [owed] }) }), new URL("http://local/api/comments/changed"), ["api", "comments", "changed"]);
	await changed();
	await flush();
	const [card] = mailCards(owed);
	expect(card).toBeDefined();
	ignoreNotice(card!.id);
	resetNoticesForTest();
	await changed();
	await flush();
	expect(mailCards(owed)).toEqual([]);
});
