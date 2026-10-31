// The approval queue on the real outbound path (outbound.out -> events -> notices): cards the assistant posts in one conversation are
// shown one at a time, the same card again is not a second post, and closing the shown card brings the next one.
import { afterAll, expect, test } from "bun:test";
import { type HubEvent, onEmit } from "./events.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { listNotices, resolveNotices } from "./notices.ts";
import { out } from "./outbound.ts";

const card = (ref: string, body = `${ref} 님 답글이에요`) => `[ask] 댓글 답글 초안이에요\n${draftApprovalBlock({ to: `${ref} 댓글`, toLabel: "대상", body, ref, question: "이 답글 올릴까요?" })}`;
const posted: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && e.target === "web" && typeof e.text === "string" && e.text.includes("이 답글 올릴까요?") && posted.push(e)));
// The next card the queue posts in the web conversation, awaited with a deadline.
const nextCard = (ref: string) =>
	new Promise<HubEvent>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`card ${ref} never came`)), 5000);
		onEmit(e => {
			if (e.kind === "out" && e.target === "web" && String(e.text).includes(`(${ref})`)) {
				clearTimeout(timer);
				resolve(e);
			}
		});
	});
const openCards = () => listNotices(500).items.filter((n: any) => n.decision?.state === "open" && n.decision.draft?.ref?.startsWith("aq-"));

test("three cards at once: one shows, the others wait; the same card again changes nothing; answering it shows the next", async () => {
	await out("web", card("aq-one"));
	await out("web", card("aq-two"));
	await out("web", card("aq-three"));
	await out("web", card("aq-one"));
	expect(posted.map(e => /\((aq-[a-z]+)\)/.exec(String(e.text))?.[1])).toEqual(["aq-one"]);
	expect(openCards().map((n: any) => n.decision.draft.ref)).toEqual(["aq-one"]);
	// The open card counts what waits behind it.
	expect(openCards()[0].text).toContain("남은 2건");

	const next = nextCard("aq-two");
	resolveNotices({ ids: [openCards()[0].id] });
	const second = await next;
	expect(String(second.text)).toContain("남은 1건");
	expect(openCards().map((n: any) => n.decision.draft.ref)).toEqual(["aq-two"]);
});

// The notice store and the queue are shared by every test file in the run: the rest of this test's cards are answered and drained.
afterAll(async () => {
	const last = nextCard("aq-three");
	resolveNotices({ ids: openCards().map((n: any) => n.id) });
	await last;
	resolveNotices({ ids: openCards().map((n: any) => n.id) });
	expect(openCards()).toEqual([]);
});
