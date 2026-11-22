import { afterAll, describe, expect, test } from "bun:test";
import { parseDecisions } from "../../../hub/choices.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { runDraft } from "../bin/draft.ts";
import { commentAsk } from "../../../hub/comments/ask.ts";
import type { Comment, SourceConfig } from "../../../hub/comments/contract.ts";
import type { Draft } from "../../../hub/comments/store.ts";
import { fakeModel, goodReply, j, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);

const mail = ["new", "--mail", "m-r1", "--from", "kim@example.com", "--subject", "회의 일정 문의"];
const MSG = "다음 주 회의를 언제 할지 정해서 알려 주실 수 있을까요? 장소는 지난번 그 회의실이면 좋겠어요.";
const draft = (questions: string[], body = "확인해 보고 말씀드릴게요.") => j({ ...goodReply, body, questions });

// Owner 2026-10-26: "자동답장 컨펌은 초안 다 잡아놓고 물어보기". The draft settles what it can first, then the owner is asked once, with the
// complete draft; a fact only he knows is a line inside that one approval card, never a separate note above it.
describe("a reply draft is resolved before the owner is asked", () => {
	test("the one draft call settles what it can; what it cannot is asked inside the approval card, an address question never", async () => {
		const m = fakeModel([draft(["회의 날짜", "받는 사람 메일 주소"], "장소는 지난번 회의실로 할게요. 날짜는 확인해서 말씀드릴게요.")]);
		const out = await runDraft(mail, MSG, { call: m.call });
		expect(out.code).toBe(0);
		expect(m.calls).toHaveLength(1);
		expect(m.calls[0]!.system).toContain("settle it yourself");
		const text = out.lines.join("\n");
		expect(text).not.toContain("-# ");
		expect(text).not.toContain("정해 주세요");
		const card = parseDraftApproval(text);
		expect(card?.body).toContain("지난번 회의실");
		const block = parseDecisions(text).blocks;
		expect(block).toHaveLength(1);
		expect(card?.decide?.join(" ")).toContain("회의 날짜");
		expect(card?.decide?.join(" ")).not.toContain("주소");
		expect(block[0]!.title).toEndWith(`(${card!.ref})`);
	});

	test("a draft without open points is asked after one model call, its card question unchanged", async () => {
		const m = fakeModel([draft([])]);
		const out = await runDraft([...mail.slice(0, 2), "m-r2", ...mail.slice(3)], MSG, { call: m.call });
		expect(m.calls).toHaveLength(1);
		const block = parseDecisions(out.lines.join("\n")).blocks;
		expect(block[0]!.title).toMatch(/^이 답장 보낼까요\? \(R[A-Z2-7]{6}\)$/);
	});

	test("a lint warning stays a check note; a comment reply's open question sits in its card too", () => {
		const text = commentAsk({ kind: "youtube" } as SourceConfig, { id: "c1", author: "kim", text: "다음 공연 언제예요?", at: 0, postTitle: "" } as unknown as Comment, { code: "J1", text: "곧 알려 드릴게요", notes: ["확인: 길이", "정해 주세요: 공연 날짜"] } as unknown as Draft);
		expect(text).toContain("-# 확인: 길이");
		expect(text).not.toContain("정해 주세요");
		expect(parseDecisions(text).blocks[0]!.title).toBe("이 답글 올릴까요? (J1)");
		expect(parseDraftApproval(text)?.decide).toEqual(["공연 날짜"]);
	});
});
