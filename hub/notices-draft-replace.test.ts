// A revise moves every open card of the old draft to the new one in place (design 3.5): same notice id, new text, draft and title, no send state.
// An edit or a revise draws each card anew: it keeps the hash of the version it shows and is edited on Discord (the refresh hook outbound.ts uses).
import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { markDraftSend, type Notice, onDraftCardRefreshed, redrawDraftCards, resetNoticesForTest } from "./notices.ts";
import { flushNotices } from "./notices-store.ts";

const stored = (): Notice[] => (flushNotices(), JSON.parse(readFileSync(paths.notices, "utf8")));
const card = (ref: string, body: string) => `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "kim@example.com", body, ref, question: "이 답장 보낼까요?" })}`;
const refreshed: { id: string; text: string; hash?: string }[] = [];
onDraftCardRefreshed(n => void refreshed.push({ id: n.id, text: n.text, ...(n.decision?.hash ? { hash: n.decision.hash } : {}) }));
beforeEach(() => {
	resetNoticesForTest();
	refreshed.length = 0;
});

test("every open card of the old draft, in each conversation, becomes the new draft and keeps its id", () => {
	for (const target of ["mail:acct-1", "main"]) emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target, text: card("RAAAAAA", "확인해 보고 말씀드릴게요.") });
	const before = stored().filter(n => n.decision?.draft?.ref === "RAAAAAA");
	expect(before).toHaveLength(2);
	markDraftSend("main", "RAAAAAA", "failed", "보내지 못했어요");
	expect(redrawDraftCards("RAAAAAA", card("RBBBBBB", "목요일까지 보내드릴게요."), "hash-b", "RBBBBBB")).toBe(2);
	const after = stored().filter(n => before.some(b => b.id === n.id));
	expect(after.map(n => [n.decision!.draft!.ref, n.title, n.decision!.send, n.decision!.hash])).toEqual([
		["RBBBBBB", "이 답장 보낼까요? (RBBBBBB)", undefined, "hash-b"],
		["RBBBBBB", "이 답장 보낼까요? (RBBBBBB)", undefined, "hash-b"],
	]);
	expect(after.every(n => n.text.includes("목요일까지 보내드릴게요."))).toBe(true);
	expect(refreshed.map(r => [r.id, r.hash])).toEqual(before.map(b => [b.id, "hash-b"]));
	expect(redrawDraftCards("RAAAAAA", card("RCCCCCC", "x"), "hash-c", "RCCCCCC")).toBe(0);
});

test("an edit keeps the ref: the card shows the saved text, stores its hash and is edited on Discord", () => {
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: card("RAAAAAA", "확인해 보고 말씀드릴게요.") });
	expect(redrawDraftCards("RAAAAAA", card("RAAAAAA", "내일 오전에 보내드릴게요."), "hash-e")).toBe(1);
	const [n] = stored().filter(x => x.decision?.draft?.ref === "RAAAAAA");
	expect([n!.decision!.state, n!.decision!.hash, n!.text.includes("내일 오전에 보내드릴게요.")]).toEqual(["open", "hash-e", true]);
	expect(refreshed).toEqual([{ id: n!.id, text: n!.text, hash: "hash-e" }]);
});

test("a revise that drops or adds the send option redraws the card's buttons with its text", () => {
	const noSend = (ref: string) => `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "kim@example.com", body: "초안", ref, question: "이 답장 보낼까요?", noSend: "본문이 비어 있어서 보낼 수 없어요" })}`;
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: noSend("RAAAAAA") });
	const labels = () => stored().find(n => n.decision?.draft?.ref === "RAAAAAA" || n.decision?.draft?.ref === "RBBBBBB")!.decision!.options.map(o => o.label);
	expect(labels()).not.toContain("보내기");
	expect(redrawDraftCards("RAAAAAA", card("RBBBBBB", "목요일까지 보내드릴게요."), "hash-b", "RBBBBBB")).toBe(1);
	expect(labels()).toContain("보내기");
	expect(redrawDraftCards("RBBBBBB", noSend("RBBBBBB"), "hash-c")).toBe(1);
	expect(labels()).not.toContain("보내기");
});

test("a long draft stays whole in the card text after a redraw", () => {
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: card("RAAAAAA", "첫 초안") });
	const body = "목요일까지 보내드릴게요.\n".repeat(200);
	expect(redrawDraftCards("RAAAAAA", card("RAAAAAA", body), "hash-l")).toBe(1);
	const [n] = stored().filter(x => x.decision?.draft?.ref === "RAAAAAA");
	expect(n!.text.length).toBeGreaterThan(1500);
	expect(n!.text).toContain("결정: 이 답장 보낼까요? (RAAAAAA)");
	expect(n!.decision!.draft!.body.length).toBe(body.trim().length);
});
