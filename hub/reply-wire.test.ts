// The live reply flow on the real modules (design lane C1): POST /api/reply/act sends a mail draft through the one queue, writes the owner's
// sealed pick before it, holds the undo window, refuses a second send while the first waits, and the undo takes the pick back.
import { beforeEach, expect, test } from "bun:test";
import { dirname } from "node:path";
import { cfg, paths } from "./config.ts";
import { draftApprovalBlock, draftVerdict } from "./draft-approval.ts";
import { listNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { replyRoute } from "./reply-route.ts";
import { replies, sender } from "./reply-wire.ts";
import { addDraft, getDraft, newId } from "../features/reply-drafts/lib/store.ts";

process.env.DOTZ_DIR = dirname(paths.inbox);
beforeEach(() => void (cfg.web.send_undo_sec = 10));
const CONV = "mail:wire-test";
const ref = newId();
addDraft({ id: ref, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${ref}`, ref: `wt-${ref.toLowerCase()}`, to: "friend@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", text: "안녕" } as never });
const act = (b: object, agent = false) => replyRoute(new Request("http://local/api/reply/act", { method: "POST", body: JSON.stringify(b) }), new URL("http://local/api/reply/act"), { replies, login: "owner@example.com", agent });
const openCard = () => listNotices(500).items.find((n: any) => n.decision?.state === "open" && n.decision.draft?.ref === ref) as any;
const verdict = () => draftVerdict(paths.inbox, ref, 0, { conv: CONV }).verdict;

test("send through /api/reply/act: the pick is sealed where the card was asked, the window holds, a second send is refused, undo takes it back", async () => {
	await out(CONV, `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "친구", toLabel: "받는이", body: "답", ref, question: "이 답장 보낼까요?" })}`);
	expect(openCard()).toBeDefined();
	expect((await act({ ref, action: "drop" }, true))!.status).toBe(403);

	const sent = (await act({ ref, action: "send" }))!;
	expect(sent.status).toBe(200);
	expect(verdict()).toBe("send");
	expect(openCard()).toBeUndefined();
	expect(sender.results(CONV).find(r => r.ref === ref)?.state).toBe("undo");

	const again = (await act({ ref, action: "send" }))!;
	expect(again.status).toBe(409);
	expect((await again.json()).code).toBe("already_sending");

	expect((await act({ ref, action: "undo" }))!.status).toBe(200);
	expect(verdict()).toBe("undo");
	expect(getDraft(ref)?.status).toBe("pending");
	expect(openCard().decision.send).toMatchObject({ state: "back" });
});
