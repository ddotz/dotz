import { afterEach, expect, spyOn, test } from "bun:test";
import * as discord from "./discord.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { listNotices, markDraftPosted, settleOpenDecision } from "./notices.ts";
import { out } from "./outbound.ts";
import { reportSend } from "./reply-wire.ts";

const CONV = "mail:os-test";
const TARGET = "1400000000000000001";
const ref = "os-send-state";
const card = `[ask] 댓글 답글 초안이에요\n${draftApprovalBlock({ to: "친구 댓글", toLabel: "대상", body: "답글이에요", ref, question: "이 답글 올릴까요?" })}`;
const edit = spyOn(discord, "edit").mockImplementation(async () => ({ delivered: true }));
afterEach(() => edit.mockClear());

const report = (state: "undo" | "queued" | "sending" | "sent" | "failed" | "unsure", text = "") => reportSend({ ref, conv: CONV, title: `이 답글 올릴까요? (${ref})`, state, text, at: Date.now(), ...(state === "undo" ? { until: Date.now() + 10_000 } : {}) });
const lastEdit = () => {
	const c = edit.mock.calls.at(-1)!;
	return { target: c[0], id: c[1], text: String(c[2]), opts: c[3] };
};

test("a Discord card the owner pressed (closed at once) shows the send's state in place: countdown, sending, failed, unsure, sent", async () => {
	await out(CONV, card);
	markDraftPosted(CONV, ref, TARGET, ["1400000000000000002"]);
	settleOpenDecision(listNotices(500).items.find(n => n.decision?.state === "open" && n.decision.draft?.ref === ref)!.id, "1) 보내기");
	expect(lastEdit().opts).toEqual({ clearComponents: true });
	edit.mockClear();

	const shown = (state: Parameters<typeof report>[0], text?: string) => (report(state, text), lastEdit());
	expect(shown("undo")).toMatchObject({ target: TARGET, id: "1400000000000000002", opts: { clearComponents: true } });
	expect(lastEdit().text).toContain("처리됨: 1) 보내기");
	expect(lastEdit().text).toContain("10초 후 보내요");
	expect(shown("sending").text).toContain("-# 보내는 중");
	expect(shown("failed", "서버가 거부했어요").text).toContain("-# 보내지 못했어요 - 서버가 거부했어요");
	expect(shown("unsure", "확인 필요").text).toContain("-# 보냈는지 확인되지 않았어요");
	const sent = shown("sent").text;
	expect(sent).toContain("-# 보냈어요");
	expect(sent).not.toContain("보내는 중");
	expect(sent).not.toContain("보내지 못했어요");
	expect(edit).toHaveBeenCalledTimes(5);
});
