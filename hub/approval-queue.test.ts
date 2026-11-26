// One send-approval card at a time per conversation: the rest wait behind it ("남은 N건") and come one by one as each closes; the same
// card again updates the open one instead of a second post.
import { describe, expect, test } from "bun:test";
import { type ApprovalQueueDeps, cardPointer, cardRef, cardTitle, CARDS_LEAD, closedCardText, createApprovalQueue, type Held, pendingCardsNote, splitCardLead, splitDraftCards, withLeft , withSendState } from "./approval-queue.ts";
import { draftApprovalBlock, parseDraftApproval } from "./draft-approval.ts";
import { parseTone, stripHandoff } from "./tone.ts";

// Draft refs are 2+ characters (draft-approval.ts REF): "A" stands for the draft "cm-A".
const card = (ref: string, body = `답글 ${ref}`) => `[ask] 댓글 답글 초안이에요\n${draftApprovalBlock({ to: `${ref} 댓글`, toLabel: "대상", body, ref: `cm-${ref}`, question: "이 답글 올릴까요?" })}`;

function setup(load: Held[] = [], more: Partial<ApprovalQueueDeps> = {}) {
	const open = new Map<string, string[]>();
	const posts: { target: string; text: string; extra: Record<string, unknown> }[] = [];
	const rewrites: { conv: string; ref: string; ids?: string[]; text: string }[] = [];
	let disk: Held[] = load;
	const q = createApprovalQueue({
		convOf: t => t,
		openRefs: c => open.get(c) ?? [],
		post: (target, text, extra) => posts.push({ target, text, extra }),
		// What notices.ts rewriteOpenDraft does: the open decision of that ref shows the new text, so its ref becomes the new card's.
		rewrite: (conv, s, text) => {
			rewrites.push({ conv, ref: s.ref, ...(s.ids ? { ids: s.ids } : {}), text });
			const ref = cardRef(text), list = open.get(conv) ?? [];
			if (ref && list.includes(s.ref)) open.set(conv, list.map(r => (r === s.ref ? ref : r)));
		},
		persist: h => void (disk = h),
		log: () => {},
		load: () => load,
		store: async (_conv, text) => text,
		...more,
	});
	// What outbound.out does around route(): a post that goes out becomes an open decision, then posted() records it.
	const show = (target: string, text: string, ids = ["m1"]) => {
		open.set(target, [...(open.get(target) ?? []), cardRef(text)!]);
		q.posted(target, text, ids);
	};
	const close = (target: string, ref: string) => {
		open.set(target, (open.get(target) ?? []).filter(r => r !== ref));
		q.closed(target, ref);
	};
	return { q, open, posts, rewrites, show, close, disk: () => disk };
}

describe("approval queue", () => {
	test("29 cards at once: one is shown, the rest are held, the shown one counts them", async () => {
		const t = setup();
		expect(await t.q.route("ch:1", card("A"))).toEqual({ action: "post" });
		// The second card comes while the first is still on its way (no notice yet): it waits too.
		expect(await t.q.route("ch:1", card("B"), { session: "s1" })).toEqual({ action: "hold", left: 1 });
		t.show("ch:1", card("A"));
		expect(t.rewrites.at(-1)).toMatchObject({ conv: "ch:1", ref: "cm-A", ids: ["m1"] });
		expect(t.rewrites.at(-1)!.text.split("\n")[1]).toBe("-# 남은 1건 (1/2)");
		for (const r of ["C", "D"]) expect((await t.q.route("ch:1", card(r))).action).toBe("hold");
		expect(t.rewrites.at(-1)!.text.split("\n")[1]).toBe("-# 남은 3건 (1/4)");
		expect(t.posts).toEqual([]);
		expect(t.disk().map(h => h.ref)).toEqual(["cm-B", "cm-C", "cm-D"]);
	});

	test("answering the shown card brings the next one, with how many are left", async () => {
		const t = setup();
		await t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		await t.q.route("ch:1", card("B"), { session: "s1" });
		await t.q.route("ch:1", card("C"));
		t.close("ch:1", "cm-A");
		expect(t.posts).toHaveLength(1);
		expect(t.posts[0]).toMatchObject({ target: "ch:1", extra: { session: "s1" } });
		expect(cardRef(t.posts[0]!.text)).toBe("cm-B");
		expect(t.posts[0]!.text.split("\n")[1]).toBe("-# 남은 1건 (2/3)");
		// Nothing more until B is out and closed.
		t.q.closed("ch:1", "cm-A");
		expect(t.posts).toHaveLength(1);
		t.show("ch:1", t.posts[0]!.text);
		t.close("ch:1", "cm-B");
		expect(t.posts.map(p => cardRef(p.text))).toEqual(["cm-B", "cm-C"]);
		expect(t.posts[1]!.text).not.toContain("남은");
		expect(t.posts[1]!.text.split("\n")[1]).toBe("-# 마지막 카드예요 (3/3)");
		expect(t.disk()).toEqual([]);
	});

	test("the same card again is not posted twice; a changed one replaces the open card", async () => {
		const t = setup();
		await t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		expect(await t.q.route("ch:1", card("A"))).toEqual({ action: "same" });
		expect(t.rewrites).toEqual([]);
		expect(await t.q.route("ch:1", card("A", "고친 답글"))).toEqual({ action: "update" });
		expect(t.rewrites.at(-1)).toMatchObject({ ref: "cm-A", ids: ["m1"] });
		expect(t.rewrites.at(-1)!.text).toContain("고친 답글");
		expect(t.posts).toEqual([]);
	});

	test("a held card posted again replaces its held text; an open card from before a restart is updated, not posted", async () => {
		const t = setup();
		await t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		await t.q.route("ch:1", card("B"));
		expect(await t.q.route("ch:1", card("B", "새 글"))).toEqual({ action: "same" });
		expect(t.q.held().map(h => h.text.includes("새 글"))).toEqual([true]);
		const r = setup();
		r.open.set("ch:2", ["cm-Z"]);
		expect(await r.q.route("ch:2", card("Z", "다시"))).toEqual({ action: "update" });
		expect(r.rewrites[0]).toMatchObject({ conv: "ch:2", ref: "cm-Z" });
		expect((await r.q.route("ch:2", card("Y"))).action).toBe("hold");
	});

	test("conversations do not wait on each other, and posts that are no card pass", async () => {
		const t = setup();
		expect((await t.q.route("ch:1", card("A"))).action).toBe("post");
		expect((await t.q.route("ch:2", card("B"))).action).toBe("post");
		expect((await t.q.route("ch:1", "[done] 올렸어요")).action).toBe("post");
	});

	test("cards held before a restart come back one at a time where nothing is open", () => {
		const t = setup([
			{ ref: "cm-B", target: "ch:1", text: card("B"), extra: {} },
			{ ref: "cm-C", target: "ch:1", text: card("C"), extra: {} },
		]);
		t.q.releaseAll();
		expect(t.posts.map(p => cardRef(p.text))).toEqual(["cm-B"]);
		expect(t.posts[0]!.text.split("\n")[1]).toBe("-# 남은 1건 (1/2)");
	});

	// "cm-X2" is the second card of the item "cm-X" (the bot's mail card and the app's draft of the same mail).
	const sameItem = { itemOf: (_conv: string, ref: string) => ref.replace(/2$/, "") };

	test("a newer card of an item that is held replaces the held one instead of waiting as a second card", async () => {
		const t = setup([], sameItem);
		await t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		expect(await t.q.route("ch:1", card("B"))).toEqual({ action: "hold", left: 1 });
		expect(await t.q.route("ch:1", card("B2"))).toEqual({ action: "same" });
		expect(t.disk().map(h => h.ref)).toEqual(["cm-B2"]);
		expect(t.disk()[0]!.text).toContain("B2");
	});

	test("an older held card dropped for a newer one of its item hands over the lines only it had", async () => {
		const brief = "[ask] 댓글 답글 초안이에요\n할 일: 회의 시간 확인\n";
		const held = [{ ref: "cm-D", target: "ch:1", text: card("D").replace("[ask] 댓글 답글 초안이에요\n", brief), extra: {} }, { ref: "cm-D2", target: "ch:1", text: card("D2"), extra: {} }, { ref: "cm-C", target: "ch:1", text: card("C"), extra: {} }];
		const t = setup(held, sameItem);
		await t.q.releaseAll();
		const kept = [...t.disk(), ...t.posts].find(h => h.text.includes("cm-D2"));
		expect(kept!.text).toContain("할 일: 회의 시간 확인");
	});

	test("a newer card of an item that is open rewrites the open card in place, and the shown card follows its ref", async () => {
		const t = setup([], sameItem);
		await t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		expect((await t.q.route("ch:1", card("A2"))).action).toBe("update");
		// The open notice is still found by the old ref; nothing is held or posted.
		expect(t.rewrites.at(-1)).toMatchObject({ conv: "ch:1", ref: "cm-A", ids: ["m1"] });
		expect(t.rewrites.at(-1)!.text).toContain("(cm-A2)");
		expect(t.disk()).toEqual([]);
		expect(t.q.targetOf("ch:1", "cm-A2")).toBe("ch:1");
		expect(t.posts).toEqual([]);
	});

	test("closing the shown card skips a held card whose item was handled meanwhile", async () => {
		const handled = new Set(["cm-B"]);
		const t = setup([], { handled: ref => handled.has(ref) });
		await t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		await t.q.route("ch:1", card("B"));
		await t.q.route("ch:1", card("C"));
		t.close("ch:1", "cm-A");
		expect(t.posts.map(p => cardRef(p.text))).toEqual(["cm-C"]);
		expect(t.disk()).toEqual([]);
	});

	test("after a restart handled and duplicate held cards are dropped, the rest shows, and a second sweep changes nothing", async () => {
		const handled = new Set(["cm-B"]);
		const held = ["B", "C", "D", "D2"].map(r => ({ ref: `cm-${r}`, target: "ch:1", text: card(r), extra: {} }));
		const t = setup(held, { ...sameItem, handled: async ref => handled.has(ref) });
		await t.q.releaseAll();
		// B is handled, D is replaced by the newer D2, C is shown.
		expect(t.posts.map(p => cardRef(p.text))).toEqual(["cm-C"]);
		expect(t.disk().map(h => h.ref)).toEqual(["cm-D2"]);
		const posts = t.posts.length, disk = JSON.stringify(t.disk());
		await t.q.releaseAll();
		expect(t.posts).toHaveLength(posts);
		expect(JSON.stringify(t.disk())).toBe(disk);
	});

	test("a held newer card of an item whose card is open replaces it on the sweep instead of being dropped", () => {
		const t = setup([{ ref: "cm-B2", target: "ch:1", text: card("B2"), extra: {} }], sameItem);
		t.open.set("ch:1", ["cm-B"]);
		t.q.releaseAll();
		// The open card (found by its old ref) shows the newer card's text, which asks for the newer ref; nothing is held or posted.
		expect(t.rewrites.map(w => w.ref)).toEqual(["cm-B"]);
		expect(t.rewrites[0]!.text).toContain("(cm-B2)");
		expect(t.open.get("ch:1")).toEqual(["cm-B2"]);
		expect(t.disk()).toEqual([]);
		expect(t.posts).toEqual([]);
	});

	test("the sweep run twice changes nothing the second time", () => {
		const t = setup([{ ref: "cm-B2", target: "ch:1", text: card("B2"), extra: {} }], sameItem);
		t.open.set("ch:1", ["cm-B"]);
		t.q.releaseAll();
		const before = [t.rewrites.length, JSON.stringify(t.disk()), t.posts.length];
		t.q.releaseAll();
		expect([t.rewrites.length, JSON.stringify(t.disk()), t.posts.length]).toEqual(before);
	});

	test("a closed card is edited to a closed form: first line kept, how it ended under it", () => {
		const c = card("A");
		const first = c.replace(/^\[ask\]\s*/, "").split("\n", 1)[0];
		expect(closedCardText(c, "answered", "1) 보내기")).toBe(`${first}\n-# 처리됨: 1) 보내기`);
		expect(closedCardText(c, "resolved")).toBe(`${first}\n-# 다른 곳에서 처리됐어요`);
		expect(closedCardText(c, "ignored")).toBe(`${first}\n-# 처리됨: 무시`);
	});

	test("cards the bot numbers and posts one per turn count the rest of its batch, and the last says so", async () => {
		const t = setup();
		const bot = (ref: string, k: number) => card(ref).replace("댓글 답글 초안이에요", `댓글 답글 초안이에요 (${k}/28)`);
		const r = await t.q.route("ch:1", bot("S", 19));
		expect(r.action).toBe("post");
		expect(r.action === "post" && r.text!.split("\n")[1]).toBe("-# 남은 9건 (19/28)");
		t.show("ch:1", (r as { text: string }).text);
		// A card held behind the open one is counted too, and the bot's turn sees where the open one stands.
		expect(await t.q.route("ch:1", card("X"))).toEqual({ action: "hold", left: 1 });
		expect(t.q.openCard("ch:1")).toMatchObject({ ref: "cm-S", progress: "남은 9건 (19/28)", held: 1, ids: ["m1"] });
		t.close("ch:1", "cm-S");
		t.show("ch:1", t.posts.at(-1)!.text);
		t.close("ch:1", "cm-X");
		const last = await t.q.route("ch:1", bot("T", 28));
		expect(last.action === "post" && last.text!.split("\n")[1]).toBe("-# 마지막 카드예요 (28/28)");
	});

	test("the bot's turn note lists the waiting cards with where they are", () => {
		expect(pendingCardsNote([], 0)).toBeUndefined();
		const n = pendingCardsNote([{ ref: "cm-S", title: "댓글 답글 (19/28)", notice: "n1", progress: "남은 9건 (19/28)", link: "https://discord.com/channels/1/2/3" }], 2)!;
		expect(n.startsWith(CARDS_LEAD)).toBe(true);
		expect(n).toContain("cm-S");
		expect(n).toContain("남은 9건 (19/28)");
		expect(n).toContain("https://discord.com/channels/1/2/3");
		expect(n).toContain("2 more held");
	});

	test("each card row says whom it goes to, how it starts and whether it is still the newest post; the note names the three markers", () => {
		const note = (c: Partial<Parameters<typeof pendingCardsNote>[0][number]>) => pendingCardsNote([{ ref: "RSQMWMR", title: "이 메일 보낼까요?", notice: "n1", to: "kim@x.com", head: "선생님 안녕하세요", ...c }], 0)!;
		const row = (c: Parameters<typeof note>[0]) => note(c).split("\n")[1]!;
		const older = row({ newest: false });
		for (const want of ["(RSQMWMR)", "to kim@x.com", '"선생님 안녕하세요"', "not the newest post"]) expect([want, older.includes(want)]).toEqual([want, true]);
		for (const want of ["[send <ref>]", "[drop <ref>]", "[revise <ref>]"]) expect([want, note({}).includes(want)]).toEqual([want, true]);
		expect([row({ newest: true }).includes("the newest post here"), row({ newest: true }).includes("not the newest"), row({ revising: true }).includes("being revised"), older.includes("being revised")]).toEqual([true, false, true, false]);
	});

	test("withLeft keeps one count line under the first line", () => {
		const c = card("A");
		expect(withLeft(withLeft(c, 3), 2).split("\n").filter(l => l.includes("남은"))).toEqual(["-# 남은 2건"]);
		expect(withLeft(withLeft(c, 3), 0)).toBe(c);
		expect(cardRef(withLeft(c, 3))).toBe("cm-A");
	});
});

describe("a held card replaced by a newer card of the same item", () => {
	const lines = "할 일: 시간 확인\n직접 답할 것: 장소는요?";
	const withLines = (ref: string) => card(ref).replace("\n", `\n${lines}\n`);
	test("keeps the lines only the older card had", async () => {
		const { q, show, disk } = setup([], { itemOf: (_c, r) => (r === "cm-A" ? "open" : "one") });
		show("c", card("A"));
		await q.route("c", withLines("B"));
		await q.route("c", card("C"));
		expect(disk()[0]!.text).toContain(lines);
		expect(cardRef(disk()[0]!.text)).toBe("cm-C");
	});
});

describe("an answer written above a held card", () => {
	const report = "[done] 롱폼 공개됐어.\nhttps://youtu.be/x\n\n숏폼 카드는 아래에 있어.\n- 첫머리를 바꿨어.";
	const open = async () => {
		const s = setup();
		await s.q.route("ch:1", card("A"));
		s.show("ch:1", card("A"));
		return s;
	};

	test("goes out now and only the card waits behind the open one", async () => {
		const s = await open();
		expect(await s.q.route("ch:1", `${report}\n\n${card("B")}`)).toEqual({ action: "post", text: report });
		expect(s.q.held().map(h => h.text)).toEqual([card("B")]);
		s.close("ch:1", "cm-A");
		expect(s.posts.map(p => cardRef(p.text))).toEqual(["cm-B"]);
		expect(s.posts[0]!.text).not.toContain("롱폼 공개됐어");
	});

	test("goes out when the card was already held too, and the held card takes the new text", async () => {
		const s = await open();
		await s.q.route("ch:1", card("B"));
		expect(await s.q.route("ch:1", `${report}\n\n${card("B", "고친 답글")}`)).toEqual({ action: "post", text: report });
		expect(s.q.held().map(h => h.text)).toEqual([card("B", "고친 답글")]);
	});

	test("a card alone still just waits, and a post that is no card passes through", async () => {
		const s = await open();
		expect(await s.q.route("ch:1", card("B"))).toEqual({ action: "hold", left: 1 });
		expect(await s.q.route("ch:1", report)).toEqual({ action: "post" });
	});

	test("a card whose head stands apart from its quote stays whole, its ask moves off the lead", () => {
		const body = draftApprovalBlock({ to: "유튜브", toLabel: "대상", body: "설명", ref: "shorts:1", question: "이대로 올릴까?" });
		expect(splitCardLead(`[done] 끝났어.\n\n[ask] 쇼츠 업로드\n길이 82초\n\n${body}`)).toEqual({ lead: "[done] 끝났어.", card: `[ask] 쇼츠 업로드\n길이 82초\n\n${body}` });
		expect(splitCardLead(`쇼츠 업로드\n\n${body}`)).toBeUndefined();
		expect(splitCardLead(`[ask] 끝났어.\n\n쇼츠 업로드\n${body}`)).toEqual({ lead: "끝났어.", card: `[ask] 쇼츠 업로드\n${body}` });
	});
});

describe("several drafts in one post (audit S1)", () => {
	const block = (ref: string) => draftApprovalBlock({ to: "friend@example.com", toLabel: "받는이", subject: `Re: ${ref}`, body: `보내 ${ref}`, ref, question: "이 답장 보낼까요?" });
	test("each card ends at its options: the prose between is the next card's lead, the prose after the last is the tail", () => {
		const split = splitDraftCards(`[ask] 답장 초안이에요\n${block("r1")}\n\n두 번째예요\n${block("r2")}\n\n나머지는 끝냈어요`)!;
		expect(split.cards.map(cardRef)).toEqual(["r1", "r2"]);
		expect(split.cards[0]).not.toContain("두 번째");
		expect(split.cards[0]!.endsWith("**3) 보내지 않기**")).toBe(true);
		expect(split.cards[1]!.startsWith("두 번째예요\n>")).toBe(true);
		expect(split.cards[1]).not.toContain("나머지");
		expect(split.tail).toBe("나머지는 끝냈어요");
		expect(splitDraftCards(`[ask] 답장 초안이에요\n${block("r1")}\n${block("r2")}`)).toEqual({ cards: [`[ask] 답장 초안이에요\n${block("r1")}`, `[ask] 답장 초안이에요\n${block("r2")}`] });
	});
});

describe("the version the owner reads (audit S6, S7)", () => {
	test("a card whose item was handled already is not posted, and nothing waits behind it", async () => {
		const t = setup([], { handled: async ref => ref === "cm-A" });
		expect(await t.q.route("ch:1", card("A"))).toEqual({ action: "same" });
		expect(t.q.openCard("ch:1")).toBeUndefined();
		expect(await t.q.route("ch:1", card("B"))).toEqual({ action: "post" });
		expect(t.posts).toEqual([]);
		expect(t.disk()).toEqual([]);
	});

	test("a held card is shown with the text its store holds when it is released", async () => {
		const t = setup([{ ref: "cm-B", target: "ch:1", text: card("B", "old 답글"), extra: {} }], { fresh: async ref => (ref === "cm-B" ? card("B", "new 답글") : undefined) });
		await t.q.releaseAll();
		expect(t.posts.map(p => cardRef(p.text))).toEqual(["cm-B"]);
		expect(t.posts[0]!.text).toContain("new 답글");
		expect(t.posts[0]!.text).not.toContain("old 답글");
	});

	test("a held card whose ref is open in another conversation is dropped, never posted", async () => {
		const open = new Set(["cm-B"]);
		const t = setup([{ ref: "cm-B", target: "ch:1", text: card("B"), extra: {} }], { handled: (ref, conv) => open.has(ref) && conv !== "mail:x" });
		await t.q.releaseAll();
		expect(t.posts).toEqual([]);
		expect(t.disk()).toEqual([]);
	});

	test("one ref waits in one conversation: the newest card of it wins, on the route and after a restart", async () => {
		const t = setup();
		for (const c of ["ch:1", "ch:2"]) {
			await t.q.route(c, card("A"));
			t.show(c, card("A"));
			await t.q.route(c, card("B", `in ${c}`));
		}
		expect(t.disk().map(h => [h.target, h.ref])).toEqual([["ch:2", "cm-B"]]);
		const r = setup([{ ref: "cm-B", target: "ch:1", text: card("B"), extra: {} }, { ref: "cm-B", target: "ch:2", text: card("B", "newer"), extra: {} }]);
		await r.q.releaseAll();
		expect(r.posts.map(p => [p.target, cardRef(p.text)])).toEqual([["ch:2", "cm-B"]]);
		expect(r.disk()).toEqual([]);
	});
});

describe("a hand-written card (no store knows its ref)", () => {
	const hand = (ref: string, o: Partial<Parameters<typeof draftApprovalBlock>[0]> = {}) =>
		`[ask] [file] /tmp/fileA.xlsx\n\n${draftApprovalBlock({ to: "Kim <kim@example.com>", toLabel: "받는이", subject: "RE: 제목A", body: `본문 ${ref}`, ref, question: "이 메일 보낼까요?", ...o })}`;
	const asDraft = (text: string) => parseDraftApproval(parseTone(stripHandoff(text)).text.trim());
	const mailItems = () => {
		const texts = new Map<string, string>();
		const calls: { ref: string; text?: string }[] = [];
		const itemOf = (conv: string, ref: string, text?: string) => {
			calls.push({ ref, text });
			const d = asDraft(text ?? texts.get(ref) ?? "");
			return d?.subject ? `${conv}|${d.to}|${d.subject}` : ref;
		};
		const open = (text: string) => (texts.set(cardRef(text)!, text), text);
		return { itemOf, open, calls };
	};

	test("a card with no prose head line is named by its question, without the ref tag", () => {
		const q = "이 메일 보낼까요?";
		expect(cardTitle(hand("hand-3"))).toBe(q);
		expect(cardTitle(withLeft(hand("hand-3"), 0, { k: 2, total: 2 }))).toBe(q);
		expect(cardTitle(hand("hand-3").replace("[ask] [file] /tmp/fileA.xlsx\n\n", ""))).toBe(q);
		expect(cardTitle(`[ask] 첨부를 확인해 주세요\n\n${hand("hand-3")}`)).toBe("첨부를 확인해 주세요");
		expect(cardTitle(card("A"))).toBe("댓글 답글 초안이에요");
	});

	test("a card held and then released is named by its question where it is pointed to, listed and closed", async () => {
		const q = "이 메일 보낼까요?";
		const t = setup();
		await t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		expect((await t.q.route("ch:1", hand("hand-3"))).action).toBe("hold");
		t.close("ch:1", "cm-A");
		const released = t.posts[0]!.text;
		t.show("ch:1", released);
		const open = t.q.openCard("ch:1")!;
		expect(open.title).toBe(q);
		expect(cardPointer(open)).toBe(`-# ↑ 답을 기다리는 카드: ${q} · ${open.progress}`.replace(/ · $/, ""));
		const noticeText = hand("hand-3").split("\n\n").slice(1).join("\n\n");
		const note = pendingCardsNote([{ ref: "hand-3", title: cardTitle(noticeText) || "x", notice: "n1" }], 0)!;
		expect(note.split("\n")[1]!.startsWith(`- ${q} (hand-3)`)).toBe(true);
		expect(closedCardText(released, "answered").split("\n")[0]).toBe(q);
	});

	test("a card of the same mail under a new ref is one item with the open card; another subject or recipient waits", async () => {
		const m = mailItems();
		const t = setup([], { itemOf: m.itemOf });
		await t.q.route("ch:1", hand("hand-3"));
		t.show("ch:1", m.open(hand("hand-3")));
		m.calls.length = 0;
		expect((await t.q.route("ch:1", hand("hand-4"))).action).toBe("update");
		expect(m.calls.some(c => c.ref === "hand-4" && c.text?.includes("(hand-4)"))).toBe(true);
		expect(m.calls.some(c => c.ref === "hand-3" && c.text?.includes("(hand-3)"))).toBe(true);
		expect(t.disk()).toEqual([]);
		m.open(hand("hand-4"));
		expect((await t.q.route("ch:1", hand("hand-5", { subject: "RE: 제목B" }))).action).toBe("hold");
		expect((await t.q.route("ch:1", hand("hand-6", { to: "Lee <lee@example.com>" }))).action).toBe("hold");
		expect(t.disk().map(h => h.ref)).toEqual(["hand-5", "hand-6"]);
	});

	test("a revision held behind another mail's open card replaces the held card: only the newest is released", async () => {
		const m = mailItems();
		const t = setup([], { itemOf: m.itemOf });
		await t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		expect(await t.q.route("ch:1", hand("hand-3"))).toEqual({ action: "hold", left: 1 });
		const lead = "표를 고쳤어요.";
		expect(await t.q.route("ch:1", `${lead}\n\n${hand("hand-4")}`)).toEqual({ action: "post", text: lead });
		expect(t.disk().map(h => h.ref)).toEqual(["hand-4"]);
		t.close("ch:1", "cm-A");
		expect(t.posts.map(p => cardRef(p.text))).toEqual(["hand-4"]);
		expect(t.disk()).toEqual([]);
	});

	test("a store-backed card (the reply store knows its ref) is replaced in place as before", async () => {
		const m = mailItems();
		const reposts: string[] = [];
		const t = setup([], { itemOf: m.itemOf, handWritten: () => false, repost: (_c, ref) => (reposts.push(ref), undefined) });
		await t.q.route("ch:1", hand("hand-3"));
		t.show("ch:1", m.open(hand("hand-3")));
		expect((await t.q.route("ch:1", hand("hand-4"))).action).toBe("update");
		expect(reposts).toEqual([]);
		expect(t.rewrites.at(-1)).toMatchObject({ conv: "ch:1", ref: "hand-3" });
		expect(t.posts).toEqual([]);
	});

	test("a hand-written revision of the open card is posted again: the notice is handed over, the shown card follows the new ref", async () => {
		const m = mailItems();
		const taken: { ref: string; text: string }[] = [];
		const was = hand("hand-3");
		const t = setup([], {
			itemOf: m.itemOf,
			handWritten: ref => ref.startsWith("hand-"),
			openText: (_c, ref) => (ref === "hand-3" ? was : undefined),
			repost: (_c, ref, text) => (taken.push({ ref, text }), { id: "n1", was, card: { target: "ch:1", ids: ["m1"] } }),
		});
		await t.q.route("ch:1", was);
		t.show("ch:1", m.open(was));
		const lead = "표를 고쳤어요.";
		const next = `${lead}\n\n${hand("hand-4", { body: "고친 본문" })}`;
		expect(t.q.replaces("ch:1", next)).toBe("hand-3");
		const r = await t.q.route("ch:1", next);
		expect(r).toEqual({ action: "post", repost: { id: "n1", ref: "hand-3", was, card: { target: "ch:1", ids: ["m1"] } } });
		expect(taken).toEqual([{ ref: "hand-3", text: next }]);
		expect(t.rewrites).toEqual([]);
		expect(t.disk()).toEqual([]);
		t.open.set("ch:1", [cardRef(m.open(next))!]);
		t.q.posted("ch:1", next, ["m2"]);
		expect(t.q.openCard("ch:1")).toMatchObject({ ref: "hand-4", ids: ["m2"], held: 0 });
		expect(t.q.replaces("ch:1", hand("hand-4", { body: "또 고친 본문" }))).toBe("hand-4");
		expect(t.q.replaces("ch:1", hand("hand-4", { body: "고친 본문" }))).toBeUndefined();
		expect((await t.q.route("ch:1", hand("hand-4", { body: "고친 본문" }))).action).toBe("update");
	});
});

test("withSendState puts the send state on the card's last line and replaces the previous one", () => {
	const card = "[ask] 이 답장 보낼까요? (RAAAAAA)\n안녕하세요";
	const undo = withSendState(card, "undo", "", 9200);
	expect(undo).toBe(`${card}\n-# 10초 후 보내요. 되돌리려면 웹앱 답장 대기에서 되돌리기`);
	expect(withSendState(undo, "failed", "인터넷에 연결되지 않았어요\n자세히")).toBe(`${card}\n-# 보내지 못했어요 - 인터넷에 연결되지 않았어요`);
	expect(withSendState(undo, "back")).toBe(card);
});
