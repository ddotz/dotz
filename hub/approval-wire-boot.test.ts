import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { commentSettleSending } from "./comments/gateway.ts";
import { commentsDir, createStore } from "./comments/store.ts";
import { SEND_CLI_MS } from "./approval-send.ts";
import { sender, settleSends } from "./approval-wire.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { ignoreNotice, listNotices, markDraftSend } from "./notices.ts";
import { out } from "./outbound.ts";
import { replies, resetSendsBootForTest } from "./reply-wire.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import { addDraft, claimFile, getDraft, newId, setStatus } from "../features/reply-drafts/lib/store.ts";

const draft = () => {
	const id = newId();
	addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `ab-${id.toLowerCase()}`, to: "friend@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", text: "", from: "" } } as never);
	return id;
};
const job = (ref: string, state: "queued" | "sending") => ({ ref, conv: "mail:ab-test", action: "send", title: `답장 보낼까요? (${ref})`, state });

const CONV = "mail:ab-test";
const heldJob = (ref: string, state: "failed" | "unsure") => ({
	ref,
	conv: CONV,
	action: "send",
	title: `이대로 보낼까요? (${ref})`,
	state,
	attempts: 3,
	...(state === "failed" ? { reason: { code: "rejected", text: "앱에서 이 글을 받지 않았어요" }, safeToAuto: false } : { reason: { code: "net_cut", text: "보내는 중에 연결이 끊겼어요" } }),
});
const notes: string[] = [];
onEmit((e: HubEvent) => void (e.kind === "out" && /^\[(fail|wait)\]/.test(String(e.text)) && notes.push(String(e.text))));
const notesOf = (ref: string) => notes.filter(t => t.includes(`(${ref})`));
const cardOf = (ref: string) => listNotices(500).items.find(n => n.decision?.draft?.ref === ref)!;
const failedRef = draft(), unsureRef = draft(), closedRef = draft();
let shownAt = "";
beforeAll(async () => {
	for (const ref of [failedRef, unsureRef, closedRef]) await out(CONV, `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: getDraft(ref)!.body, ref, question: "이대로 보낼까요?" })}`);
	markDraftSend(CONV, failedRef, "failed", "앱에서 이 글을 받지 않았어요", undefined, "rejected");
	shownAt = cardOf(failedRef).decision!.send!.at;
	await advance(60_000);
	setStatus(closedRef, "dropped");
});
afterAll(() => {
	for (const n of listNotices(500).items.filter(i => i.decision?.to === CONV && i.decision.state === "open")) ignoreNotice(n.id);
	resetSendsBootForTest();
});

test("on boot the file's jobs are taken up: a running one is judged and never re-run, a queued one runs again, a sent draft is marked sent", async () => {
	const lost = draft(), queued = draft(), done = draft();
	setStatus(done, "sent");
	const gone = Bun.spawn([process.execPath, "-e", "0"]);
	await gone.exited;
	mkdirSync(dirname(claimFile(lost)), { recursive: true });
	writeFileSync(claimFile(lost), String(gone.pid));
	writeFileSync(join(DATA_DIR, "approval-sends.json"), JSON.stringify([job(lost, "sending"), job(queued, "queued"), job(done, "sending"), heldJob(failedRef, "failed"), heldJob(unsureRef, "unsure"), heldJob(closedRef, "failed")]));

	settleSends();
	await sender.idle();
	await flush();
	const state = (ref: string) => sender.results().find(r => r.ref === ref);
	// A send cut off with no sender left may have gone out: 확인 필요, never a retryable failure.
	expect(state(lost)).toMatchObject({ state: "unsure", reason: { code: "interrupted" } });
	expect(state(lost)!.text).toContain("나갔을 수");
	expect(state(done)).toMatchObject({ state: "sent" });
	expect(state(queued)).toMatchObject({ state: "failed" });
	expect(state(queued)!.text).not.toContain("나갔을 수");
	// Failed sends stay in the file until they are resolved, so a restart forgets none; the sent one leaves it.
	const kept = (JSON.parse(await Bun.file(join(DATA_DIR, "approval-sends.json")).text()) as { ref: string; state: string }[]).map(k => `${k.ref}:${k.state}`).sort();
	expect(kept).toEqual([`${lost}:unsure`, `${queued}:failed`, `${failedRef}:failed`, `${unsureRef}:unsure`].sort());
});

test("a restart holds the failed and unsure sends its file kept without a note or a new time on the card, settles the one whose draft ended, and a later failure is one note", async () => {
	await flush();
	await out("web", "정리했어요", undefined, { source: "gateway" });
	expect(notesOf(failedRef)).toEqual([]);
	expect(notesOf(unsureRef)).toEqual([]);
	expect(notesOf(closedRef)).toEqual([]);
	expect(cardOf(failedRef).decision!.send!.at).toBe(shownAt);
	expect((await replies.list()).find(i => i.ref === failedRef)?.send).toMatchObject({ state: "failed" });
	expect((await replies.list()).find(i => i.ref === unsureRef)?.send).toMatchObject({ state: "unsure" });
	expect(sender.results().some(r => r.ref === closedRef)).toBe(false);

	expect(sender.enqueue({ ref: failedRef, conv: CONV, action: "send", title: `이대로 보낼까요? (${failedRef})`, retry: true })).toBe(true);
	await sender.idle();
	await out("web", "정리했어요", undefined, { source: "gateway" });
	expect(notesOf(failedRef)).toHaveLength(1);
	expect(notesOf(unsureRef)).toEqual([]);
	expect(notesOf(closedRef)).toEqual([]);
});

test("a comment reply left sending by the run that stopped ends unsure, visible, and is not sent again by itself", () => {
	const store = createStore(commentsDir(DATA_DIR));
	store.putReply({ id: "send:cm:a:1", commentId: "cm:a:1", source: "a", thread: "p", text: "답", state: "sending", at: 1, draft: "D9", via: "owner", collector: "x" });
	expect(commentSettleSending()).toBe(1);
	expect(store.replies().find(r => r.id === "send:cm:a:1")).toMatchObject({ state: "unsure" });
	expect(commentSettleSending()).toBe(0);
});

test("the periodic sweep leaves a comment reply whose sender died unsure and keeps a fresh sending one", () => {
	settleSends();
	const store = createStore(commentsDir(DATA_DIR));
	const put = (id: string, at: number) => store.putReply({ id: `send:cm:a:${id}`, commentId: `cm:a:${id}`, source: "a", thread: "p", text: "답", state: "sending", at, draft: `D${id}`, via: "owner", collector: "x" });
	put("stale", Date.now() - SEND_CLI_MS - 120_000);
	put("fresh", Date.now() - 60_000);
	settleSends();
	const state = (id: string) => store.replies().find(r => r.id === `send:cm:a:${id}`)?.state;
	expect(state("stale")).toBe("unsure");
	expect(state("fresh")).toBe("sending");
});
