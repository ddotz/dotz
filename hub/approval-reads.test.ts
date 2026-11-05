import { afterAll, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { cardGroups, waitingCards } from "./approval-wire.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { resetNoticesForTest } from "./notices.ts";
import { addDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { paths } from "../features/reply-drafts/lib/settings.ts";

const CARDS = 40;
const draft = (n: number) =>
	({
		id: `R${String(n).padStart(6, "A")}`, kind: "mail", app: "mail", source: "zele", mailId: `m${n}`, ref: `ar-${n}`, to: "owner@example.test", subject: `s${n}`, body: `본문 ${n}`, status: "pending",
		created: new Date(Date.UTC(2026, 10, 2, 1, 0, n)).toISOString(), changes: [], questions: [],
		item: { kind: "mail", subject: `s${n}`, text: "t", from: "sender@example.test" },
	}) as unknown as DraftRec;

for (let n = 0; n < CARDS; n++) {
	const d = draft(n);
	addDraft(d);
	const block = draftApprovalBlock({ to: d.to, body: d.body, ref: d.id, question: "이 답장 보낼까요?" });
	emit("outbox", { ts: new Date(Date.UTC(2026, 10, 2, 1, 0, n)).toISOString(), kind: "out", source: "orchestrator", target: "mail:ar-test", text: `[ask] 메일 답장 초안이에요\n${block}` });
}
afterAll(() => {
	resetNoticesForTest();
	rmSync(paths.drafts(), { force: true });
});

const parses = (run: () => void): number => {
	const spy = spyOn(JSON, "parse");
	run();
	const n = spy.mock.calls.length;
	spy.mockRestore();
	return n;
};

test("the waiting cards are read without parsing a store once per card", () => {
	expect(waitingCards()).toHaveLength(CARDS);
	expect(parses(() => void waitingCards())).toBeLessThan(CARDS / 2);
});

test("grouping the cards reads no store per card either", () => {
	expect(cardGroups().reduce((n, g) => n + g.count, 0)).toBe(CARDS);
	expect(parses(() => void cardGroups())).toBeLessThan(CARDS / 2);
});
