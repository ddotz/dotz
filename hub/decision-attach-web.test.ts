import { beforeAll, describe, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { answerDecision, listNotices, markNoticesRead, type Notice, resolveNotices } from "./notices.ts";

// A send-approval answer that carries files (POST /api/notices/<id>/answer, hub/routes.ts -> hub/notices.ts answerDecision -> sendWeb): a draft's
// 고치기 hands them on, any other answer drops them. The web's own file picker of the old dock 직접 수정 is gone; the queue card's 직접 수정 replaced it.
const find = (ref: string) => listNotices(300).items.find(n => n.kind === "decision" && n.decision?.state === "open" && n.decision.draft?.ref === ref)! as Notice;
const ask = (ref: string, extra: object) =>
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${draftApprovalBlock({ subject: "견적서 회신", body: "안녕하세요.\n견적서를 보내 드립니다.", ref, ...extra })}` });

beforeAll(() => {
	resolveNotices({ ids: listNotices(300).items.filter(n => n.decision?.state === "open").map(n => n.id) });
	markNoticesRead({ all: true });
});

describe("the hub's answer path", () => {
	test("a draft 고치기 hands the validated files to the send; a decision that is not a draft edit drops them", async () => {
		ask("RHUB0001", { to: "kim@example.com" });
		const n = find("RHUB0001");
		const files = [{ path: "/tmp/uploads/a.pdf", name: "a.pdf", type: "application/pdf", size: 3 }];
		const sent: { text: string; files?: unknown }[] = [];
		const r = await answerDecision(n.id, { n: 2, note: "이 내용으로 고쳐 주세요: x", files }, async a => { sent.push(a); });
		expect(r.status).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.files).toEqual(files);
		ask("RHUB0002", { to: "kim@example.com" });
		const m = find("RHUB0002");
		const other: { files?: unknown }[] = [];
		await answerDecision(m.id, { n: 3, files }, async a => { other.push(a); });
		expect(other[0]!.files).toBeUndefined();
	});
});
