import { afterAll, expect, test } from "bun:test";
import { parseDecisions } from "../../../hub/choices.ts";
import { blockDraftRef, draftApprovalBlock, parseDraftApproval } from "../../../hub/draft-approval.ts";
import { askText } from "../lib/flow.ts";
import { addDraft, getDraft, type DraftRec } from "../lib/store.ts";
import { setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);

const rec = (over: Partial<DraftRec> = {}): DraftRec => ({ id: "REMPTY1", kind: "mail", app: "mail", source: "acme", mailId: "9", ref: "acme-9", to: "kim@example.com", subject: "Re: 문의", body: "", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", from: "kim@example.com", self: ["me@corp.example"], subject: "문의", text: "문의드립니다" }, ...over });

test("a draft with an empty body is posted without the 보내기 option and says why", () => {
	addDraft(rec());
	const card = askText(getDraft("REMPTY1")!, ["the body is empty"]);
	const labels = parseDecisions(card).blocks[0]!.options.map(o => o.label);
	expect(labels).toEqual(["고치기", "보내지 않기"]);
	expect(card).toContain("-# 보내기 없음: 본문이 비어 있어서 보낼 수 없어요");
});

test("a draft with a body keeps its 보내기 option", () => {
	addDraft(rec({ id: "RFULL001", ref: "acme-10", body: "확인했습니다." }));
	const labels = parseDecisions(askText(getDraft("RFULL001")!, [])).blocks[0]!.options.map(o => o.label);
	expect(labels).toEqual(["보내기", "고치기", "보내지 않기"]);
});

test("a two-option block is a draft approval only with the no-send reason line", () => {
	const card = draftApprovalBlock({ to: "kim@example.com", body: "내용", ref: "RTWO0001", noSend: "보낼 수 없어요" });
	expect(parseDraftApproval(card)?.ref).toBe("RTWO0001");
	const bare = card.split("\n").filter(l => !l.startsWith("-# 보내기 없음")).join("\n");
	expect(parseDecisions(bare).blocks[0]!.options.map(o => o.label)).toEqual(["고치기", "보내지 않기"]);
	expect(parseDraftApproval(bare)).toBeUndefined();
});

test("the empty-body card is still found by its draft ref, so the card closes when the draft ends", () => {
	const card = askText({ ...rec(), id: "REMPTY2" }, []);
	const block = parseDecisions(card).blocks[0]!;
	expect(blockDraftRef(block.title, block.options.map(o => o.label))).toBe("REMPTY2");
	expect(blockDraftRef(block.title, ["보내지 않기", "고치기"])).toBeUndefined();
});
