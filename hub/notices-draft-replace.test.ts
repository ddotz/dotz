// A revise moves every open card of the old draft to the new one in place (design 3.5): same notice id, new text, draft and title, no send state.
import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { markDraftSend, type Notice, replaceDraftCards, resetNoticesForTest } from "./notices.ts";

const stored = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));
const card = (ref: string, body: string) => `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "kim@example.com", body, ref, question: "이 답장 보낼까요?" })}`;
beforeEach(resetNoticesForTest);

test("every open card of the old draft, in each conversation, becomes the new draft and keeps its id", () => {
	for (const target of ["mail:acct-1", "main"]) emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target, text: card("RAAAAAA", "확인해 보고 말씀드릴게요.") });
	const before = stored().filter(n => n.decision?.draft?.ref === "RAAAAAA");
	expect(before).toHaveLength(2);
	markDraftSend("main", "RAAAAAA", "failed", "보내지 못했어요");
	expect(replaceDraftCards("RAAAAAA", "RBBBBBB", card("RBBBBBB", "목요일까지 보내드릴게요."))).toBe(2);
	const after = stored().filter(n => before.some(b => b.id === n.id));
	expect(after.map(n => [n.decision!.draft!.ref, n.title, n.decision!.send])).toEqual([
		["RBBBBBB", "이 답장 보낼까요? (RBBBBBB)", undefined],
		["RBBBBBB", "이 답장 보낼까요? (RBBBBBB)", undefined],
	]);
	expect(after.every(n => n.text.includes("목요일까지 보내드릴게요."))).toBe(true);
	expect(replaceDraftCards("RAAAAAA", "RCCCCCC", card("RCCCCCC", "x"))).toBe(0);
});
