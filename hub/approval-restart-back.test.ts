import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { sender, settleSends } from "./approval-wire.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { answerDecision, listNotices, onDecision } from "./notices.ts";
import { out } from "./outbound.ts";
import { replies, resetSendsBootForTest } from "./reply-wire.ts";
import { flush } from "./runtime/test-clock.ts";
import { addDraft, getDraft, newId } from "../features/reply-drafts/lib/store.ts";

const CONV = "mail:restart-back-test";
const JOBS = join(DATA_DIR, "approval-sends.json");
afterAll(resetSendsBootForTest);
const id = newId();
addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `rb-${id.toLowerCase()}`, to: "friend@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", text: "", from: "" } } as never);
const cardOf = () => {
	const n = listNotices(500).items.find(i => i.decision?.draft?.ref === id);
	if (!n?.decision) throw new Error("no card");
	return { id: n.id, decision: n.decision };
};
const notes: string[] = [];
onEmit((e: HubEvent) => void (e.kind === "out" && String(e.text).includes(`(${id})`) && /^\[(fail|wait)\]/.test(String(e.text)) && notes.push(String(e.text))));
const pushed: string[] = [];
onDecision(n => void (n.decision?.draft?.ref === id && pushed.push(n.id)));

test("a send cancelled by a restart inside its window tells the owner once, reopens its card with one push, shows why on the queue row, and a later restart says nothing more", async () => {
	await out(CONV, `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: getDraft(id)!.body, ref: id, question: "이 답장 보낼까요?" })}`);
	await answerDecision(cardOf().id, { n: 1 }, async () => {});
	expect(cardOf().decision.state).toBe("answered");
	const pushedBefore = pushed.length;
	writeFileSync(JOBS, JSON.stringify([{ ref: id, conv: CONV, action: "send", title: `이 답장 보낼까요? (${id})`, state: "undo", approvedAt: Date.now() - 1000, wait: 10_000 }]));

	settleSends();
	await sender.idle();
	await flush();

	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain("보내지 않았어요");
	expect(notes[0]).toContain("다시 시작");
	expect(notes[0]).not.toContain("\n");
	expect(cardOf().decision.state).toBe("open");
	expect(pushed.length - pushedBefore).toBe(1);
	const item = (await replies.list()).find(i => i.ref === id);
	expect(item?.send).toBeUndefined();
	expect(item?.back).toMatchObject({ cause: "restart" });

	settleSends();
	await sender.idle();
	await flush();
	expect(notes).toHaveLength(1);
	expect(pushed.length - pushedBefore).toBe(1);
	expect((JSON.parse(await Bun.file(JOBS).text()) as { ref: string }[]).filter(j => j.ref === id)).toEqual([]);
});
