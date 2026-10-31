// One send-approval card at a time per conversation: the rest wait behind it ("남은 N건") and come one by one as each closes; the same
// card again updates the open one instead of a second post.
import { describe, expect, test } from "bun:test";
import { cardRef, createApprovalQueue, type Held, withLeft } from "./approval-queue.ts";
import { draftApprovalBlock } from "./draft-approval.ts";

// Draft refs are 2+ characters (draft-approval.ts REF): "A" stands for the draft "cm-A".
const card = (ref: string, body = `답글 ${ref}`) => `[ask] 댓글 답글 초안이에요\n${draftApprovalBlock({ to: `${ref} 댓글`, toLabel: "대상", body, ref: `cm-${ref}`, question: "이 답글 올릴까요?" })}`;

function setup(load: Held[] = []) {
	const open = new Map<string, string[]>();
	const posts: { target: string; text: string; extra: Record<string, unknown> }[] = [];
	const rewrites: { conv: string; ref: string; ids?: string[]; text: string }[] = [];
	let disk: Held[] = load;
	const q = createApprovalQueue({
		convOf: t => t,
		openRefs: c => open.get(c) ?? [],
		post: (target, text, extra) => posts.push({ target, text, extra }),
		rewrite: (conv, s, text) => rewrites.push({ conv, ref: s.ref, ...(s.ids ? { ids: s.ids } : {}), text }),
		persist: h => void (disk = h),
		log: () => {},
		load: () => load,
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
	test("29 cards at once: one is shown, the rest are held, the shown one counts them", () => {
		const t = setup();
		expect(t.q.route("ch:1", card("A"))).toEqual({ action: "post" });
		// The second card comes while the first is still on its way (no notice yet): it waits too.
		expect(t.q.route("ch:1", card("B"), { session: "s1" })).toEqual({ action: "hold", left: 1 });
		t.show("ch:1", card("A"));
		expect(t.rewrites.at(-1)).toMatchObject({ conv: "ch:1", ref: "cm-A", ids: ["m1"] });
		expect(t.rewrites.at(-1)!.text.split("\n")[1]).toBe("-# 남은 1건");
		for (const r of ["C", "D"]) expect(t.q.route("ch:1", card(r)).action).toBe("hold");
		expect(t.rewrites.at(-1)!.text.split("\n")[1]).toBe("-# 남은 3건");
		expect(t.posts).toEqual([]);
		expect(t.disk().map(h => h.ref)).toEqual(["cm-B", "cm-C", "cm-D"]);
	});

	test("answering the shown card brings the next one, with how many are left", () => {
		const t = setup();
		t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		t.q.route("ch:1", card("B"), { session: "s1" });
		t.q.route("ch:1", card("C"));
		t.close("ch:1", "cm-A");
		expect(t.posts).toHaveLength(1);
		expect(t.posts[0]).toMatchObject({ target: "ch:1", extra: { session: "s1" } });
		expect(cardRef(t.posts[0]!.text)).toBe("cm-B");
		expect(t.posts[0]!.text.split("\n")[1]).toBe("-# 남은 1건");
		// Nothing more until B is out and closed.
		t.q.closed("ch:1", "cm-A");
		expect(t.posts).toHaveLength(1);
		t.show("ch:1", t.posts[0]!.text);
		t.close("ch:1", "cm-B");
		expect(t.posts.map(p => cardRef(p.text))).toEqual(["cm-B", "cm-C"]);
		expect(t.posts[1]!.text).not.toContain("남은");
		expect(t.disk()).toEqual([]);
	});

	test("the same card again is not posted twice; a changed one replaces the open card", () => {
		const t = setup();
		t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		expect(t.q.route("ch:1", card("A"))).toEqual({ action: "same" });
		expect(t.rewrites).toEqual([]);
		expect(t.q.route("ch:1", card("A", "고친 답글"))).toEqual({ action: "update" });
		expect(t.rewrites.at(-1)).toMatchObject({ ref: "cm-A", ids: ["m1"] });
		expect(t.rewrites.at(-1)!.text).toContain("고친 답글");
		expect(t.posts).toEqual([]);
	});

	test("a held card posted again replaces its held text; an open card from before a restart is updated, not posted", () => {
		const t = setup();
		t.q.route("ch:1", card("A"));
		t.show("ch:1", card("A"));
		t.q.route("ch:1", card("B"));
		expect(t.q.route("ch:1", card("B", "새 글"))).toEqual({ action: "same" });
		expect(t.q.held().map(h => h.text.includes("새 글"))).toEqual([true]);
		const r = setup();
		r.open.set("ch:2", ["cm-Z"]);
		expect(r.q.route("ch:2", card("Z", "다시"))).toEqual({ action: "update" });
		expect(r.rewrites[0]).toMatchObject({ conv: "ch:2", ref: "cm-Z" });
		expect(r.q.route("ch:2", card("Y")).action).toBe("hold");
	});

	test("conversations do not wait on each other, and posts that are no card pass", () => {
		const t = setup();
		expect(t.q.route("ch:1", card("A")).action).toBe("post");
		expect(t.q.route("ch:2", card("B")).action).toBe("post");
		expect(t.q.route("ch:1", "[done] 올렸어요").action).toBe("post");
	});

	test("cards held before a restart come back one at a time where nothing is open", () => {
		const t = setup([
			{ ref: "cm-B", target: "ch:1", text: card("B"), extra: {} },
			{ ref: "cm-C", target: "ch:1", text: card("C"), extra: {} },
		]);
		t.q.releaseAll();
		expect(t.posts.map(p => cardRef(p.text))).toEqual(["cm-B"]);
		expect(t.posts[0]!.text.split("\n")[1]).toBe("-# 남은 1건");
	});

	test("withLeft keeps one count line under the first line", () => {
		const c = card("A");
		expect(withLeft(withLeft(c, 3), 2).split("\n").filter(l => l.includes("남은"))).toEqual(["-# 남은 2건"]);
		expect(withLeft(withLeft(c, 3), 0)).toBe(c);
		expect(cardRef(withLeft(c, 3))).toBe("cm-A");
	});
});
