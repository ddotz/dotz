import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { cardBlock } from "./choices.ts";
import { paths } from "./config.ts";
import { compose, type DoctorStore, doctorPost } from "./doctor.ts";
import type { Finding } from "./doctor-types.ts";
import { emit, type HubEvent } from "./events.ts";
import { cardAsked, listNotices, resetNoticesForTest } from "./notices.ts";
import { decisionsOf } from "./notices-decisions.ts";
import { items, reconcileStored, settleDecision } from "./notices-store.ts";
import type { Notice } from "./notices-types.ts";

const MIN = 60e3, H = 60 * MIN, D = 24 * H, T0 = Date.parse("2026-11-24T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const cards = () => listNotices(300).items.filter(n => n.kind === "decision");
const post = (text: string, at: number, ids?: string[], source = "gateway") =>
	emit("outbox", { ts: iso(at), kind: "out", source, target: "alert", wk: "doctor", text, ...(ids ? { card_ids: ids } : {}) });
const OPTIONS = [{ name: "Apply", result: "PROPOSAL" }, { name: "Leave", result: "Nothing changes." }];
const review = (key: string, why: string, subject = "Contract 'Session…'"): Finding => ({ key, area: "prompt", what: "REVIEW", evidence: [`MODE.md line of ${key}`, why], since: T0, level: 1, decide: { subject, question: "Change it?", options: OPTIONS } });
const store = (...f: Finding[]): DoctorStore => ({ version: 1, lastRun: T0, memo: {}, findings: Object.fromEntries(f.map(x => [x.key, x])), told: {} });
const morning = (at: number, ...f: Finding[]) => {
	const n = compose(store(...f), at)!;
	post(n.text, at, n.ids);
};
const own = (id: string): Notice => {
	const found = cards().filter(c => c.decision!.card_id === id);
	expect(found).toHaveLength(1);
	return found[0]!;
};

beforeEach(resetNoticesForTest);

for (const gap of [60, 10])
	test(`a finding of another id with the same title ${gap} min after the first one's answer is a new open card; the answered card keeps its answer and lines`, () => {
		const start = Date.now() - 3 * H;
		morning(start, review("prompt:review:aaaa", "WHY-A"));
		const [a] = cards();
		settleDecision(a!, "2) Leave", iso(start + 2 * H - gap * MIN));
		morning(start + 2 * H, review("prompt:review:bbbb", "WHY-B"));
		expect(cards().find(c => c.id === a!.id)).toMatchObject({ title: a!.title, decision: { state: "answered", answer: "2) Leave", evidence: ["MODE.md line of prompt:review:aaaa", "WHY-A"] } });
		const b = cards().filter(c => c.id !== a!.id);
		expect(b.map(c => [c.title, c.decision!.state, c.decision!.asked, c.decision!.evidence])).toEqual([[a!.title, "open", undefined, ["MODE.md line of prompt:review:bbbb", "WHY-B"]]]);
		expect(b[0]!.text).not.toContain("번째 알려요");
		expect([own("prompt:review:aaaa").id, own("prompt:review:bbbb").id]).toEqual([a!.id, b[0]!.id]);
	});

test("of X and X (2) on day 1 with X answered, the second finding alone a week later (now titled X, first in its message) is its own card asked again", () => {
	const day1 = Date.now() - 8 * D;
	morning(day1, review("prompt:review:1111", "WHY-ONE"), review("prompt:review:2222", "WHY-TWO"));
	const [first, second] = ["WHY-ONE", "WHY-TWO"].map(w => cards().find(c => c.decision!.evidence?.includes(w))!);
	expect(second!.title).not.toBe(first!.title);
	settleDecision(first!, "2) Leave", iso(day1 + 30 * MIN));
	morning(day1 + 7 * D, review("prompt:review:2222", "WHY-TWO"));
	expect(cards()).toHaveLength(2);
	expect(cards().find(c => c.id === first!.id)).toMatchObject({ title: first!.title, decision: { state: "answered", answer: "2) Leave", evidence: ["MODE.md line of prompt:review:1111", "WHY-ONE"] } });
	const again = cards().find(c => c.id === second!.id)!;
	expect(again).toMatchObject({ title: first!.title, decision: { state: "open", asked: { n: 2 }, evidence: ["MODE.md line of prompt:review:2222", "WHY-TWO"] } });
	expect(again.text).toContain("2번째 알려요");
	expect(own("prompt:review:2222").id).toBe(second!.id);
});

test("the same id posted again a day after its answer, under a reworded title, is its own card asked a second time", () => {
	const day1 = Date.now() - 2 * D;
	morning(day1, review("disk:low", "Free 9 GB", "Disk nearly full"));
	const [card] = cards();
	settleDecision(card!, "2) Leave", iso(day1 + H));
	morning(day1 + D, review("disk:low", "Free 4 GB", "Disk almost full"));
	expect(cards().map(c => c.id)).toEqual([card!.id]);
	const again = cards()[0]!;
	expect(again).toMatchObject({ title: "Disk almost full · Change it?", decision: { card_id: "disk:low", state: "open", asked: { n: 2, first: iso(day1) } } });
	expect(again.text.split("\n").at(-1)!.startsWith("2번째 알려요")).toBe(true);
});

test("the redraw on start keeps each card's id and its key", () => {
	const at = Date.now() - H;
	morning(at, review("prompt:enforced:r1", "WHY-1"), review("prompt:enforced:r2", "WHY-2"));
	const before = items.filter(n => n.kind === "decision").map(n => [n.id, n.key, n.decision!.card_id, n.title]);
	expect(before.map(b => b[2])).toEqual(["prompt:enforced:r1", "prompt:enforced:r2"]);
	for (const n of items.filter(i => i.kind === "decision")) n.title = "stale title";
	reconcileStored();
	expect(items.filter(n => n.kind === "decision").map(n => [n.id, n.key, n.decision!.card_id, n.title])).toEqual(before);
});

test("ids from a session or the orchestrator are ignored, and a gateway list that does not name each card once is dropped with one log line", () => {
	const text = [cardBlock({ subject: "S", question: "One?", options: OPTIONS }), cardBlock({ subject: "S", question: "Two?", options: OPTIONS })].join("\n\n");
	const at = Date.now() - H;
	emit("outbox", { ts: iso(at), kind: "out", source: "lane:sample-2", target: "lane:sample-2", text: `[ask]\n${text}`, card_ids: ["x1", "x2"] });
	emit("outbox", { ts: iso(at + 1), kind: "out", source: "orchestrator", target: "main", text: `[ask]\n${text}`, card_ids: ["y1", "y2"] });
	post(text, at + 2, ["z1"]);
	post(text, at + 3, ["d1", "d1"]);
	expect(cards().filter(c => c.decision!.card_id !== undefined || c.key!.includes(":id:"))).toEqual([]);
	const logged = existsSync(paths.log) ? readFileSync(paths.log, "utf8").split("\n") : [];
	expect(logged.filter(l => l.includes(`card ids of ${iso(at + 2)} dropped`))).toHaveLength(1);
	expect(logged.filter(l => l.includes(`card ids of ${iso(at + 3)} dropped`))).toHaveLength(1);
	post(text, at + 4, ["g1", "g2"]);
	expect(["g1", "g2"].map(id => own(id).decision!.state)).toEqual(["open", "open"]);
});

test("a card without an id with the title of an answered card that has one is a card of its own", () => {
	const at = Date.now() - 3 * H, text = cardBlock({ subject: "Same subject", question: "Change it?", options: OPTIONS });
	post(text, at, ["prompt:review:cccc"]);
	const [named] = cards();
	settleDecision(named!, "1) Apply", iso(at + H));
	post(text, at + 2 * H);
	expect(cards().find(c => c.id === named!.id)!.decision).toMatchObject({ card_id: "prompt:review:cccc", state: "answered", answer: "1) Apply" });
	expect(cards().filter(c => c.id !== named!.id).map(c => [c.title, c.decision!.state, c.decision!.card_id])).toEqual([[named!.title, "open", undefined]]);
});

type Step = { kind: "post"; gap: number; cards: { id: string; title: number; opts: number }[] } | { kind: "answer"; gap: number; pick: number; n: 1 | 2 };
const IDS = ["i0", "i1", "i2", "i3"], GAPS = [1, 10, 29, 31, 60, 1440];
const step: fc.Arbitrary<Step> = fc.oneof(
	fc.record({
		kind: fc.constant("post" as const),
		gap: fc.constantFrom(...GAPS),
		cards: fc.uniqueArray(fc.record({ id: fc.constantFrom(...IDS), title: fc.integer({ min: 0, max: 1 }), opts: fc.integer({ min: 0, max: 1 }) }), { minLength: 1, maxLength: 3, selector: c => c.id }),
	}),
	fc.record({ kind: fc.constant("answer" as const), gap: fc.constantFrom(...GAPS), pick: fc.nat(), n: fc.constantFrom(1 as const, 2 as const) }),
);
const shape = (n: Notice) => [n.decision!.card_id, n.decision!.state, n.decision!.answer, n.decision!.asked?.n ?? 1];

test("over any run of gateway posts with clashing titles and answers between them: one card per id, each in the state its own posts and answers give it, and an answer lands on the tapped card", () => {
	fc.assert(
		fc.property(fc.array(step, { minLength: 1, maxLength: 14 }), steps => {
			resetNoticesForTest();
			const model = new Map<string, { state: "open" | "answered"; since: number; n: number; answer?: string }>();
			let t = Date.now() - 40 * D;
			for (const s of steps) {
				t += s.gap * MIN;
				if (s.kind === "post") {
					const text = s.cards.map(c => cardBlock({ subject: `Same subject ${c.title}`, question: "Change it?", options: c.opts ? [...OPTIONS].reverse() : OPTIONS })).join("\n\n");
					post(`Morning check.\n\n${text}`, t, s.cards.map(c => c.id));
					for (const c of s.cards) {
						const m = model.get(c.id);
						if (!m) model.set(c.id, { state: "open", since: t, n: 1 });
						else if (t - m.since >= 30 * MIN) model.set(c.id, { state: "open", since: t, n: m.n + 1 });
					}
				} else {
					const open = cards().filter(c => c.decision!.state === "open");
					if (!open.length) continue;
					const tapped = open[s.pick % open.length]!, others = cards().filter(c => c.id !== tapped.id).map(shape);
					settleDecision(tapped, `${s.n}) pick`, iso(t));
					expect(cards().find(c => c.id === tapped.id)!.decision).toMatchObject({ state: "answered", answer: `${s.n}) pick` });
					expect(cards().filter(c => c.id !== tapped.id).map(shape)).toEqual(others);
					const m = model.get(tapped.decision!.card_id!)!;
					model.set(tapped.decision!.card_id!, { ...m, state: "answered", since: t, answer: `${s.n}) pick` });
				}
				const all = cards();
				expect(all.every(c => c.decision!.card_id !== undefined)).toBe(true);
				for (const [id, m] of model) {
					const mine = all.filter(c => c.decision!.card_id === id);
					expect(mine).toHaveLength(1);
					expect(shape(mine[0]!)).toEqual([id, m.state, m.state === "answered" ? m.answer : undefined, m.n]);
				}
				expect(all).toHaveLength(model.size);
			}
		}),
		{ numRuns: 150 },
	);
});

for (const answered of [false, true])
	test(`a gateway card with an id that meets ${answered ? "an answered" : "an open"} card stored without one under its title is a card of its own, and the stored card stays as it is`, () => {
		const at = Date.now() - 3 * H, text = cardBlock({ subject: "Same subject", question: "Change it?", options: OPTIONS });
		const kept = (c: Notice) => [c.title, c.key, c.decision!.state, c.decision!.answer, c.decision!.asked, c.decision!.card_id];
		post(text, at);
		const [stored] = cards();
		if (answered) settleDecision(stored!, "2) Leave", iso(at + H));
		const before = kept(cards().find(c => c.id === stored!.id)!);
		post(text, at + 2 * H, ["prompt:review:dddd"]);
		expect(kept(cards().find(c => c.id === stored!.id)!)).toEqual(before);
		expect(before.slice(2)).toEqual([answered ? "answered" : "open", answered ? "2) Leave" : undefined, undefined, undefined]);
		expect(cards().filter(c => c.id !== stored!.id).map(c => kept(c).slice(2))).toEqual([["open", undefined, undefined, "prompt:review:dddd"]]);
	});

test("reading a post's decisions writes no log line: a dropped list, here one with an empty id, is logged once, when the store takes the post", () => {
	const text = [cardBlock({ subject: "S", question: "One?", options: OPTIONS }), cardBlock({ subject: "S", question: "Two?", options: OPTIONS })].join("\n\n");
	const ts = iso(Date.now() - H), e: HubEvent = { ts, kind: "out", source: "gateway", target: "alert", wk: "doctor", text, card_ids: ["a", ""] };
	expect(decisionsOf(e).map(d => d.card_id)).toEqual([undefined, undefined]);
	emit("outbox", e);
	decisionsOf(e);
	const logged = existsSync(paths.log) ? readFileSync(paths.log, "utf8").split("\n") : [];
	expect(logged.filter(l => l.includes(`card ids of ${ts} dropped`))).toHaveLength(1);
	expect(cards().map(c => c.decision!.card_id)).toEqual([undefined, undefined]);
});

test("of two open cards with one title, a Discord button stands for the card whose own lines its message shows", () => {
	const at = Date.now() - 3 * H;
	const a = compose(store(review("prompt:review:aaaa", "WHY-A")), at)!, b = compose(store(review("prompt:review:bbbb", "WHY-B")), at + H)!;
	post(a.text, at, a.ids);
	post(b.text, at + H, b.ids);
	const first = own("prompt:review:aaaa"), second = own("prompt:review:bbbb");
	expect([first.decision!.state, second.decision!.state, second.title]).toEqual(["open", "open", first.title]);
	expect([cardAsked(first.decision!.to, first.title, a.text), cardAsked(first.decision!.to, first.title, b.text)]).toEqual([first.id, second.id]);
	expect(cardAsked(first.decision!.to, first.title)).toBe(first.id);
});

test("the gateway's morning post puts each card in the store under its finding's key, and a message without a card carries no ids", async () => {
	const posts: [string, boolean][] = [], at = Date.now() - H;
	const out = async (target: string, text: string, _replyTo?: string, extra: Record<string, unknown> = {}) => {
		posts.push([target, "card_ids" in extra]);
		emit("outbox", { ts: iso(at + posts.length), kind: "out", target, text, ...extra, source: String(extra.source) });
		return { delivered: true };
	};
	const n = compose(store(review("prompt:review:aaaa", "WHY-A"), review("disk:low", "Free 4 GB", "Disk almost full")), at)!;
	await doctorPost(out)(n.text, n.decision, n.open, n.ids);
	expect([own("prompt:review:aaaa").decision!.state, own("disk:low").decision!.state]).toEqual(["open", "open"]);
	await doctorPost(out)("All fixed.", false, false, []);
	expect(posts).toEqual([["alert", true], ["worklog", false]]);
});
