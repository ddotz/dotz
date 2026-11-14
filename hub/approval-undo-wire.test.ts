import { beforeEach, expect, test } from "bun:test";
import { dirname } from "node:path";
import { draftVerdict, draftApprovalBlock } from "./draft-approval.ts";
import { listNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { sender, webAnswer } from "./approval-wire.ts";
import { replyRoute } from "./reply-route.ts";
import { replies } from "./reply-wire.ts";
import { cfg, paths } from "./config.ts";
import { addDraft, getDraft, newId } from "../features/reply-drafts/lib/store.ts";

// The cancel window on the real modules: the owner's 보내기 is held, 취소 takes his pick back, and the card waits for approval again.
process.env.DOTZ_DIR = dirname(paths.inbox);
beforeEach(() => void (cfg.web.send_undo_sec = 10));
const CONV = "mail:undo-test";
const id = newId();
const ref = id;
addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `un-${id.toLowerCase()}`, to: "friend@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", text: "안녕" } as never });
const card = `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "대화방", body: "답", ref, question: "이대로 보낼까요?" })}`;
const openCard = () => listNotices(500).items.find((n: any) => n.decision?.state === "open" && n.decision.draft?.ref === ref) as any;
const verdict = () => draftVerdict(paths.inbox, ref, 0, { conv: CONV }).verdict;
const undo = () => replyRoute(new Request("http://local/api/reply/act", { method: "POST", body: JSON.stringify({ ref, action: "undo" }) }), new URL("http://local/api/reply/act"), { replies, login: "owner@example.com" });

test("a cancel inside the window: nothing is sent, the pick is taken back, the card is open again and says so on the card", async () => {
	await out(CONV, card);
	const r = await webAnswer(openCard().id, { n: 1 }, "owner@example.com", async () => undefined);
	expect(r.status).toBe(200);
	expect((r.body as any).send).toMatchObject({ state: "undo" });
	expect(verdict()).toBe("send");
	expect(openCard()).toBeUndefined();

	const res = (await undo())!;
	expect(res.status).toBe(200);
	await sender.idle();
	expect(verdict()).toBe("undo");
	expect(getDraft(ref)?.status).toBe("pending");
	expect(openCard().decision.send).toMatchObject({ state: "back" });
	expect(sender.results(CONV).find(x => x.ref === ref)?.state).toBe("back");
	expect((await undo())!.status).toBe(409);
});
