import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { msg } from "./i18n.ts";
import { onDraftRepost, repostNote, resetNoticesForTest, setStoredDraft, type Notice } from "./notices.ts";
import { reconcileStored } from "./notices-store.ts";
import { storedDraftOf } from "./notices-wiring.ts";

// Issue #7: a send-approval card the bot re-words (or posts next to another card in one answer) is read as no draft. Its 보내기 would send the
// draft by its "(<ref>)" while the owner saw other words, so it closes at once with a reason, and its session is told to post it again as printed.
const ts = () => new Date().toISOString();
const stored = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));
const cards = () => stored().filter(n => n.kind === "decision");
const card = (ref: string) => draftApprovalBlock({ to: "A <a@example.com>", subject: "Re: hello", body: "Hello there.\nSee you soon.", ref, question: "이 답장 보낼까요?" });
// The re-worded card of the issue: a shorter question, the body cut to a pointer, the recipient line edited.
const reworded = (ref: string) => card(ref).replace("이 답장 보낼까요?", "보낼까?").replace("> Hello there.\n> See you soon.", "> (위와 같아)").replace("> 받는이: A", "> 받는 사람: A");
const post = (text: string, at = ts()) => emit("outbox", { ts: at, kind: "out", source: "orchestrator", target: "web", text: `[ask] ${text}` });
// The stored draft behind every card here, for each test only: the resolver is one for the whole run, and the files after this one read the real drafts.
const DRAFT = { to: "A <a@example.com>", body: "Hello there.\nSee you soon." };
let real = DRAFT;
let kept = storedDraftOf;
const told: { ref: string; note: string }[] = [];
onDraftRepost((n, note) => told.push({ ref: n.title.match(/\(([^()]+)\)$/)?.[1] ?? n.title, note }));
const view = () => cards().map(n => ({ ref: n.title.match(/\(([^()]+)\)$/)?.[1], state: n.decision!.state, answer: n.decision!.answer, draft: n.decision!.draft?.ref }));

beforeEach(() => {
	kept = storedDraftOf;
	real = DRAFT;
	setStoredDraft(() => real);
	resetNoticesForTest();
	told.length = 0;
});
afterEach(() => setStoredDraft(kept));

test("a re-worded card closes at once with the reason and no draft, and its session is told to post it again", () => {
	post(reworded("m-a1"));
	expect(view()).toEqual([{ ref: "m-a1", state: "answered", answer: msg().draftCardRedo, draft: undefined }]);
	expect(told.map(t => t.ref)).toEqual(["m-a1"]);
	expect(told[0]!.note).toBe(repostNote(cards()[0]!)!);
});

test("a card with the draft's words but another address is closed the same way", () => {
	post(card("m-a1").replace("a@example.com", "b@example.com"));
	expect(view().map(v => [v.state, v.draft])).toEqual([["answered", undefined]]);
	expect(told.map(t => t.ref)).toEqual(["m-a1"]);
});

test("every card of one answer with two cards is its own notice, and each is sent back", () => {
	post(`${reworded("m-a1")}\n\n${card("m-b2")}`);
	expect(view().map(v => [v.ref, v.state])).toEqual([
		["m-a1", "answered"],
		["m-b2", "answered"],
	]);
	expect(told.map(t => t.ref)).toEqual(["m-a1", "m-b2"]);
});

test("a session's report with two cards goes back to that session the same way", () => {
	emit("inbox", { ts: ts(), kind: "lane_report", source: "lane:w1", lane: "w1", text: `[ask] ${reworded("m-a1")}\n\n${reworded("m-b2")}` });
	expect(cards().map(n => [n.by, n.decision!.state])).toEqual([
		["lane:w1", "answered"],
		["lane:w1", "answered"],
	]);
	expect(told.map(t => t.ref)).toEqual(["m-a1", "m-b2"]);
});

test("the card posted again as the draft printed it stays open with its draft", () => {
	post(reworded("m-a1"));
	post(card("m-a1"));
	expect(view().map(v => [v.state, v.draft])).toEqual([
		["answered", undefined],
		["open", "m-a1"],
	]);
	expect(told.length).toBe(1);
});

test("the re-post note names the card's draft id; a card read as its draft gets none", () => {
	post(card("m-b2"));
	expect(repostNote(cards()[0]!)).toBeUndefined();
	expect(told).toEqual([]);
	post(reworded("m-a1"));
	expect(repostNote(cards()[1]!)).toContain("(m-a1)");
});

test("a card read as its draft keeps it when the gateway redraws it on start after the stored draft changed (the owner's own edit)", () => {
	// Its own time: the redraw finds the card's post in the outbox by it.
	post(card("m-a1"), "2026-01-02T03:04:05.678Z");
	real = { ...DRAFT, body: "Hello there.\nSee you at noon." };
	reconcileStored();
	expect(view().map(v => [v.state, v.draft])).toEqual([["open", "m-a1"]]);
});
