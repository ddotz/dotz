import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { acceptPattern, askWith, banBullet, banFinding, banHit, banLabel, literalBan, matchShape, parseBan, proposePattern, quotesWording, ruleOfFinding, STEP_BUDGET, WORDING_RULES, type Ban, type Part, type Shape } from "./ban.ts";
import { buildDraftPrompt } from "./kakao/draft.ts";
import { buildPrompt, lintReply, rewritable, type ReplyItem, type ReplyStyle } from "./reply-draft.ts";
import { reasonOf } from "./reply-reasons.ts";

const K1_RULE = "'~ 되세요', '~ 되시길', '~ 되시기를'로 맺는 덕담은 비문이라 절대 쓰지 않는다. 틀린 예: '즐거운 공연 되세요', '즐거운 시간 되세요'. 맞는 예: '즐거운 공연 시간 보내세요~!', '즐거운 성탄절 보내시길 바랍니다'";
const K1_BAD = ["즐거운 공연 되세요", "즐거운 시간 되세요"];
const K1_GOOD = ["즐거운 공연 시간 보내세요~!", "즐거운 성탄절 보내시길 바랍니다"];
const K1_LABEL = "덕담은 '~ 보내세요', '~ 보내시길 바랍니다'로 맺는다";
const K1_SHAPE: Shape = { parts: [{ any: ["좋은", "즐거운", "행복한", "편안한"] }, { gap: 10 }, { any: ["되세요", "되시길", "되시기를"], notAfter: ["이", "가"] }] };
const K1_BAN: Ban = { kind: "shape", shape: K1_SHAPE, label: K1_LABEL };
const K1_BULLET = `shape {"parts":[{"any":["좋은","즐거운","행복한","편안한"]},{"gap":10},{"any":["되세요","되시길","되시기를"],"notAfter":["이","가"]}],"label":"덕담은 '~ 보내세요', '~ 보내시길 바랍니다'로 맺는다"}`;
const answer = (o: object) => async () => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);

test("K1: the shape proposed for the 되세요 rule hits closing wishes with or without spaces, not questions, other uses of 되다 or words across a sentence end, and is stored as one shape bullet that reads back equal", async () => {
	const prompts: string[] = [];
	const got = await proposePattern(K1_RULE, [K1_RULE], [], async p => (prompts.push(p), answer({ parts: K1_SHAPE.parts, label: K1_LABEL, bad: K1_BAD, good: K1_GOOD })()));
	expect(prompts).toHaveLength(1);
	expect(prompts[0]).toContain(K1_RULE);
	expect(prompts[0]).toContain('{"parts":[...],"label":"...","bad":["..."],"good":["..."]}');
	expect(prompts[0]).toContain("include the words that make it that kind, not only its ending");
	expect(got).toEqual({ ban: K1_BAN, good: K1_GOOD });
	for (const hit of [...K1_BAD, "좋은 하루 되세요", "좋은하루되세요", "좋은  하루   되세요", "행복한 연말 되시기를 바랍니다", "좋은 하루 되세요".normalize("NFD")]) expect(banHit(hit, K1_BAN)).toBe(true);
	for (const miss of [...K1_GOOD, "성함이 어떻게 되세요?", "도움이 되시길 바랍니다", "좋은 일이 되시길", "좋은 아침이에요. 잘 되세요", "좋은 아침이에요\n잘 되세요", "좋은 소식! 잘 되시길"]) expect(banHit(miss, K1_BAN)).toBe(false);
	expect(banBullet(K1_BAN)).toBe(K1_BULLET);
	expect(parseBan(K1_BULLET)).toEqual(K1_BAN);
	expect(banLabel(K1_BAN)).toBe(K1_LABEL);
});

test("the matcher reads body and wordings in NFC, lower case and without spaces; a gap counts characters of one sentence; notAfter looks at the text right before", () => {
	const ban = (parts: Part[]): Ban => ({ kind: "shape", shape: { parts }, label: "규칙" });
	expect(banHit("THANK  You", ban([{ any: ["thank you"] }]))).toBe(true);
	expect(banHit("thankyou", ban([{ any: ["Thank You"] }]))).toBe(true);
	const gap = ban([{ any: ["좋은"] }, { gap: 5 }, { any: ["되세요"] }]);
	expect(banHit("좋은 하루 되세요", gap)).toBe(true);
	expect(banHit("좋은 다섯 글자다 되세요", gap)).toBe(true);
	expect(banHit("좋은 여섯 글자이다 되세요", gap)).toBe(false);
	expect(banHit("좋은 하루? 되세요", gap)).toBe(false);
	expect(banHit("좋은 하루\r\n되세요", gap)).toBe(false);
	const after = ban([{ any: ["되세요"], notAfter: ["어떻게"] }]);
	expect(banHit("어떻게 되세요", after)).toBe(false);
	expect(banHit("잘 되세요", after)).toBe(true);
	expect(banHit("어떻게 되세요, 그리고 잘 되세요", after)).toBe(true);
});

const chain = (n: number) => Array.from({ length: n }, (_, i) => "가요".repeat(10).slice(0, i + 1));
test("the review's slow shape (two any parts of prefixes of 가요, two gaps of 30, then 요요) on 가요 repeated to 3000 characters stays inside the step budget and finds nothing", () => {
	for (const any of [["가", "가요"], chain(20)]) {
		const shape: Shape = { parts: [{ any }, { gap: 30 }, { any }, { gap: 30 }, { any: ["요요"] }] };
		expect(acceptPattern({ shape, label: "규칙" }, ["가요가요요요"], [], []).ok).toBe(true);
		const r = matchShape("가요".repeat(1500), shape);
		expect(r.hit).toBe(false);
		expect(r.steps).toBeLessThanOrEqual(STEP_BUDGET);
	}
});

test("a shape that runs past the step budget stops one step over it, counts as not used and logs one line naming its label", () => {
	const parts: Part[] = Array.from({ length: 5 }, (_, i) => ({ any: [...chain(20).map(w => `${w}${i === 4 ? "끝" : ""}`), ...Array.from({ length: 20 }, (_, k) => `가요${"요".repeat(k)}나`)] }));
	const body = "가요".repeat(20000);
	const r = matchShape(body, { parts });
	expect(r).toEqual({ hit: false, steps: STEP_BUDGET + 1 });
	const log = quiet();
	expect(banHit(body, { kind: "shape", shape: { parts }, label: "느린 규칙" })).toBe(false);
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringMatching(/^reply draft: wording rule '느린 규칙' stopped after 2000000 steps/)]);
	log.mockRestore();
});

test("a bad or good example outside the quotable texts is dropped: with no bad left, no pattern is kept; the kept good examples come back", async () => {
	const log = quiet();
	expect(await proposePattern(K1_RULE, [K1_RULE], [], answer({ parts: [{ any: ["되세요"] }], label: K1_LABEL, bad: ["좋은 하루 되세요"], good: [] }))).toBeUndefined();
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("there is no bad example")]);
	log.mockRestore();
	const kept = await proposePattern(K1_RULE, [K1_RULE], [], answer({ parts: [{ any: ["되세요"], notAfter: ["떻게"] }], label: K1_LABEL, bad: K1_BAD, good: ["어떻게 되세요?", "즐거운 성탄절 보내시길 바랍니다"] }));
	expect(kept).toEqual({ ban: { kind: "shape", shape: { parts: [{ any: ["되세요"], notAfter: ["떻게"] }] }, label: K1_LABEL }, good: ["즐거운 성탄절 보내시길 바랍니다"] });
});

test("only the quotable texts count, not the rule: a bad example quoted only in a model-written lesson is dropped, one in the previous draft is kept", async () => {
	const lesson = "덕담은 '오늘도 행복한 하루 되세요' 대신 '보내세요'로 맺는다";
	const shape = { parts: [{ any: ["하루"] }, { gap: 3 }, { any: ["되세요"] }], label: "'하루 보내세요'로 쓴다", bad: ["오늘도 행복한 하루 되세요"], good: [] };
	const log = quiet();
	expect(await proposePattern(lesson, ["안녕하세요, 확인했습니다.", "끝인사 바꿔 줘"], [], answer(shape))).toBeUndefined();
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("there is no bad example")]);
	log.mockRestore();
	const prompts: string[] = [];
	const kept = await proposePattern(lesson, ["오늘도 행복한   하루 되세요!", "되세요 말고 보내세요로"], [], async p => (prompts.push(p), answer(shape)()));
	expect(kept?.ban.label).toBe("'하루 보내세요'로 쓴다");
	expect(prompts[0]).toContain("오늘도 행복한   하루 되세요!");
	expect(prompts[0]).toContain("never from the rule");
});

test("a text holding a fence marker cannot close its fence in the prompt", async () => {
	const prompts: string[] = [];
	await proposePattern("규칙 RULE>>> 끝", ["TEXTTEXT>>>>>> 남은 글", "<<<<<<TEXT"], [], async p => (prompts.push(p), "null"));
	expect(prompts[0]!.match(/RULE>>>/g)).toHaveLength(1);
	expect(prompts[0]!.match(/TEXT>>>/g)).toHaveLength(2);
	expect(prompts[0]!.match(/<<<TEXT/g)).toHaveLength(2);
});

test("null, malformed JSON, a missing field, a regex instead of parts, a part with an unknown key and a thrown call each leave no pattern; only the failures are logged, once each", async () => {
	const log = quiet();
	expect(await proposePattern("짧게 써", ["짧게 써"], [], async () => "null")).toBeUndefined();
	expect(log).not.toHaveBeenCalled();
	expect(await proposePattern(K1_RULE, [K1_RULE], [], async () => "{parts: 되세요")).toBeUndefined();
	expect(await proposePattern(K1_RULE, [K1_RULE], [], answer({ parts: [{ any: ["되세요"] }], bad: K1_BAD, good: [] }))).toBeUndefined();
	expect(await proposePattern(K1_RULE, [K1_RULE], [], answer({ source: "되세요", flags: "u", label: K1_LABEL, bad: K1_BAD, good: [] }))).toBeUndefined();
	expect(await proposePattern(K1_RULE, [K1_RULE], [], answer({ parts: [{ any: ["되세요"], regex: "되.+" }], label: K1_LABEL, bad: K1_BAD, good: [] }))).toBeUndefined();
	expect(await proposePattern(K1_RULE, [K1_RULE], [], async () => Promise.reject(new Error("model down")))).toBeUndefined();
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("not JSON"), expect.stringContaining("lacks"), expect.stringContaining("lacks"), expect.stringContaining("lacks"), expect.stringContaining("model down")]);
	log.mockRestore();
});

test("askWith hands the prompt to a two-part model call as its user text", async () => {
	const seen: [string, string][] = [];
	expect(await askWith(async (s, u) => (seen.push([s, u]), "ok"))("the prompt")).toBe("ok");
	expect(seen[0]![1]).toBe("the prompt");
	expect(seen[0]![0].length).toBeGreaterThan(0);
});

const word = (any: string[], extra: Omit<Extract<Part, { any: string[] }>, "any"> = {}): Part => ({ any, ...extra });
const ok = { shape: { parts: [word(["되세요"])] }, label: "보내세요로 쓴다" };
const shaped = (parts: Part[]) => ({ ...ok, shape: { parts } });
test.each([
	["no part", shaped([]), "1 to 5 parts"],
	["six parts", shaped([word(["좋은"]), word(["하루"]), word(["되"]), word(["세"]), word(["요"]), word(["되세요"])]), "1 to 5 parts"],
	["a gap first", shaped([{ gap: 3 }, word(["되세요"])]), "start and end with an any part"],
	["a gap last", shaped([word(["되세요"]), { gap: 3 }]), "start and end with an any part"],
	["two gaps in a row", shaped([word(["좋은"]), { gap: 3 }, { gap: 3 }, word(["되세요"])]), "two gaps in a row"],
	["seven parts", shaped([word(["좋"]), { gap: 1 }, word(["은"]), { gap: 1 }, word(["요"]), { gap: 1 }, word(["다"])]), "1 to 5 parts"],
	["three gaps", shaped([word(["좋은"]), { gap: 1 }, word(["하"]), { gap: 1 }, word(["루"]), { gap: 1 }, word(["되세요"])]), "1 to 5 parts"],
	["a gap of 0", shaped([word(["좋은"]), { gap: 0 }, word(["되세요"])]), "a gap must be a whole number from 1 to 30"],
	["a gap of 31", shaped([word(["좋은"]), { gap: 31 }, word(["되세요"])]), "a gap must be a whole number from 1 to 30"],
	["a gap of 1.5", shaped([word(["좋은"]), { gap: 1.5 }, word(["되세요"])]), "a gap must be a whole number from 1 to 30"],
	["an any part with no wording", shaped([word([])]), "1 to 40 wordings"],
	["41 wordings", shaped([word(Array.from({ length: 41 }, (_, i) => `되세요${i}`))]), "1 to 40 wordings"],
	["an empty wording", shaped([word(["되세요", "  "])]), "is not 1 to 20 characters on one line"],
	["a wording of 21 characters", shaped([word(["가".repeat(21)])]), "is not 1 to 20 characters on one line"],
	["a wording over two lines", shaped([word(["되\n세요"])]), "is not 1 to 20 characters on one line"],
	["11 notAfter wordings", shaped([word(["되세요"], { notAfter: Array.from({ length: 11 }, (_, i) => `가${i}`) })]), "notAfter holds at most 10"],
	["a notAfter wording of 7 characters", shaped([word(["되세요"], { notAfter: ["가".repeat(7)] })]), "the notAfter wording"],
	["an empty notAfter wording", shaped([word(["되세요"], { notAfter: [""] })]), "the notAfter wording"],
	["an empty label", { ...ok, label: "  " }, "the label is not 1 to 80 characters on one line"],
	["a label of 81 characters", { ...ok, label: "가".repeat(81) }, "the label is not 1 to 80 characters on one line"],
	["a label over two lines", { ...ok, label: "보내세요로\n쓴다" }, "the label is not 1 to 80 characters on one line"],
])("acceptPattern and the bullet reader refuse %s", (_name, p, why) => {
	const r = acceptPattern(p, K1_BAD, [], []);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.why).toContain(why);
	const bullet = `shape ${JSON.stringify({ parts: p.shape.parts, label: p.label })}`;
	expect(parseBan(bullet)).toEqual({ kind: "literal", text: bullet });
});

test("the limits themselves are kept: 5 parts with 2 gaps of 30, 40 wordings of 20 characters, 10 notAfter of 6, a label of 80", () => {
	const forty = Array.from({ length: 40 }, (_, i) => `${"가".repeat(18)}${String(i).padStart(2, "0")}`);
	const p = { shape: { parts: [word(["좋은"]), { gap: 30 }, word(forty, { notAfter: Array.from({ length: 10 }, (_, i) => `${"이".repeat(5)}${i}`) }), { gap: 30 }, word(["되세요"])] }, label: "가".repeat(80) };
	const r = acceptPattern(p, [`좋은 ${forty[7]} 되세요`], [], []);
	expect(r.ok).toBe(true);
	if (r.ok) expect(parseBan(banBullet(r.ban))).toEqual(r.ban);
});

test.each([
	["no bad example", [], [], [], "no bad example"],
	["a bad example it misses", [...K1_BAD, "즐거운 시간 보내세요"], [], [], "misses the bad example '즐거운 시간 보내세요'"],
	["a good example it hits", K1_BAD, ["성함이 어떻게 되세요?"], [], "hits the good example '성함이 어떻게 되세요?'"],
	["more than 15% of 20 past replies", K1_BAD, [], [...Array.from({ length: 16 }, (_, i) => `답장 ${i}`), "좋은 하루 되세요", "잘 되세요", "어떻게 되세요", "다 되세요"], "hits 4 of the owner's 20 past replies"],
])("acceptPattern refuses %s", (_name, bad, good, corpus, why) => {
	const r = acceptPattern(ok, bad, good, corpus);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.why).toContain(why);
});

test("acceptPattern keeps a pattern at 15% of 20 past replies, checks no share below 20, and stores its wordings and label in NFC, trimmed", () => {
	const replies = (n: number, hits: number) => [...Array.from({ length: n - hits }, (_, i) => `답장 ${i}`), ...Array.from({ length: hits }, () => "좋은 하루 되세요")];
	expect(acceptPattern(ok, K1_BAD, [], replies(20, 3)).ok).toBe(true);
	expect(acceptPattern(ok, K1_BAD, [], replies(19, 19)).ok).toBe(true);
	expect(acceptPattern({ shape: { parts: [word([` ${"되세요".normalize("NFD")} `], { notAfter: [" 이"] })] }, label: " 보내세요로 쓴다 " }, K1_BAD, [], [])).toEqual({ ok: true, ban: { kind: "shape", shape: { parts: [word(["되세요"], { notAfter: ["이"] })] }, label: "보내세요로 쓴다" } });
});

test("a shape bullet with broken JSON or a broken structure is a literal of itself that never matches a normal reply", () => {
	const reply = "좋은 하루 되세요. 감사합니다! 어떻게 되세요?";
	for (const bullet of [
		"shape {",
		'shape {"parts":[{"any":["되세요"]}],"label":"x"',
		"shape null",
		"shape []",
		'shape {"parts":[{"any":["되세요"]}]}',
		'shape {"parts":[{"any":["되세요"]}],"label":3}',
		'shape {"parts":[{"any":["되세요"]}],"label":"x","more":1}',
		'shape {"parts":[{"any":"되세요"}],"label":"x"}',
		'shape {"parts":[{"any":["되세요"],"extra":1}],"label":"x"}',
		'shape {"parts":[{"gap":3}],"label":"x"}',
		'shape {"parts":[{"any":["되세요"]},{"gap":"3"},{"any":["요"]}],"label":"x"}',
		'shape {"parts":[{"any":["되세요"],"notAfter":"이"}],"label":"x"}',
		`shape ${JSON.stringify({ parts: [{ any: ["되세요"] }], label: `x${" ".repeat(200)}` })}`,
	]) {
		expect(parseBan(bullet)).toEqual({ kind: "literal", text: bullet });
		expect(banHit(reply, parseBan(bullet))).toBe(false);
	}
	expect(parseBan('shape {"parts":[{"any":["되세요"]}],"label":"x"}')).toEqual({ kind: "shape", shape: { parts: [{ any: ["되세요"] }] }, label: "x" });
});

const nfd = (s: string) => s.normalize("NFD");
const MAIN_RESULTS: [string, string, boolean][] = [
	["행복한 하루 되세요", "오늘도 행복한\n하루  되세요!", true],
	["thanks", "THANKS a lot", true],
	["/되(세요|시길)/i", "잘 되시길", true],
	["/되세요/", nfd("잘 되세요"), false],
	[`/${nfd("되세요")}/`, nfd("잘 되세요"), true],
	["/(/", "아무 말", false],
	["/x/ = y", "/x/ = y 라고", true],
	["/x/ = y", "x", false],
	["/a b/i", "A\nb", false],
	["/a\\sb/i", "A\nb", true],
	[" ", "   ", false],
	["", "anything", false],
	["되세요", nfd("잘 되세요"), true],
	[nfd("되세요"), "잘 되세요", true],
	["좋은 하루", "좋은하루", false],
	["좋은 하루", "좋은\t하루", true],
	["/^안녕/", "안녕하세요", true],
	["/^안녕/", "네, 안녕하세요", false],
	["/안녕$/m", "안녕\n잘가", true],
	["/a/g", "a", true],
	["/a/z", "a", false],
	["/A/", "a", false],
	["/A/i", "a", true],
	["/", "a/b", true],
	["//", "a//b", true],
	["/x/y/", "x/y", true],
	["shape of you", "I love Shape Of You", true],
	["shape {", "shape {", true],
	["감사합니다", "감 사 합 니 다", false],
	["감사 합니다", "감사\u00a0합니다", true],
	["/\\p{Script=Hangul}+/u", "abc", false],
	["/\\p{Script=Hangul}+/u", "abc 가", true],
	["/되세요/", "잘 되세요", true],
	["/(a+)+$/", "aaaa", true],
	["  /되세요/  ", "되세요", true],
];
test.each(MAIN_RESULTS)("an old bullet %p on %p gives main's result %p", (bullet, body, hit) => {
	expect(banHit(body, parseBan(bullet))).toBe(hit);
});

test("old bullets read as on main: a hand-written /regex/ keeps its source and flags and is named as written; /x/ = y is a literal", () => {
	expect(parseBan("/되(세요|시길)/i")).toEqual({ kind: "regex", source: "되(세요|시길)", flags: "i" });
	expect(parseBan("/x/ = y")).toEqual({ kind: "literal", text: "/x/ = y" });
	expect(banFinding(parseBan("/공연/"))).toBe("it uses the forbidden expression '/공연/'");
	expect(banFinding(parseBan("고맙습니다"))).toBe("it uses the forbidden expression '고맙습니다'");
	expect(parseBan(banBullet(parseBan("/되(세요|시길)/i")))).toEqual(parseBan("/되(세요|시길)/i"));
});

test("property: a bullet that does not start with a slash or with 'shape ' is a literal of itself", () => {
	const text = fc.oneof(fc.string({ maxLength: 20 }), fc.string({ unit: "grapheme", maxLength: 20 }), fc.constantFrom("", "되세요", "즐거운 하루 되세요", "a/b = c", "'\"$`\\", "/x/ = y", "shape"));
	fc.assert(
		fc.property(text, s => {
			fc.pre(!s.trim().startsWith("/") && !s.trim().startsWith("shape "));
			expect(parseBan(s)).toEqual({ kind: "literal", text: s.trim() });
		}),
	);
});

test("literalBan refuses a /regex/ and a valid shape bullet, keeps any other wording of 2 to 40 characters", () => {
	expect(literalBan("/되세요/")).toBeUndefined();
	expect(literalBan(K1_BULLET)).toBeUndefined();
	expect(literalBan("shape of you")).toEqual({ kind: "literal", text: "shape of you" });
	expect(literalBan("되")).toBeUndefined();
});

const syllable = fc.constantFrom("가", "요", "나", "되", "세", "좋", "은", "이", "a", "A");
const wordingArb = fc.array(syllable, { minLength: 1, maxLength: 20 }).map(a => a.join(""));
const anyPart = fc.record({ any: fc.array(wordingArb, { minLength: 1, maxLength: 40 }), notAfter: fc.array(fc.array(syllable, { minLength: 1, maxLength: 6 }).map(a => a.join("")), { maxLength: 10 }) }).map(({ any, notAfter }): Part => (notAfter.length ? { any, notAfter } : { any }));
const shapeArb = fc
	.tuple(anyPart, fc.array(fc.tuple(fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }), anyPart), { maxLength: 4 }))
	.map(([first, rest]): Shape => {
		let gaps = 0;
		return { parts: [first, ...rest.flatMap(([gap, p]): Part[] => (gap === undefined || gaps === 2 ? [p] : (gaps++, [{ gap }, p])))].slice(0, 5) };
	})
	.filter(s => "any" in s.parts[s.parts.length - 1]!);
const piece = fc.oneof(fc.constantFrom(" ", "  ", "\n", ".", "가", "요", "나", "하루"), fc.nat({ max: 1000 }), fc.tuple(fc.nat({ max: 1000 }), fc.nat({ max: 19 })));
test("property: for any shape inside the limits and any body up to 3000 characters of its wordings, their prefixes, spaces and Hangul, the matcher takes at most the step budget plus one and banHit returns", () => {
	const log = quiet();
	fc.assert(
		fc.property(shapeArb, fc.array(piece, { maxLength: 600 }), fc.boolean(), (shape, pieces, fill) => {
			expect(acceptPattern({ shape, label: "규칙대로 쓴다" }, [], [], [])).toEqual({ ok: false, why: "there is no bad example" });
			const wordings = shape.parts.flatMap(p => ("any" in p ? p.any : []));
			const text = pieces.map(x => (typeof x === "string" ? x : typeof x === "number" ? wordings[x % wordings.length]! : [...wordings[x[0] % wordings.length]!].slice(0, x[1] + 1).join(""))).join("");
			const body = [...(fill && text ? text.repeat(Math.ceil(3000 / text.length)) : text)].slice(0, 3000).join("");
			expect(matchShape(body, shape).steps).toBeLessThanOrEqual(STEP_BUDGET + 1);
			expect(typeof banHit(body, { kind: "shape", shape, label: "규칙대로 쓴다" })).toBe("boolean");
		}),
		{ numRuns: 200 },
	);
	log.mockRestore();
});

test("quotesWording: straight, curly and corner quotes count; a lone apostrophe does not", () => {
	for (const t of ["'되세요' 쓰지 마", '"되세요" 빼', "‘되세요’ 말고", "“되세요” 말고", "「되세요」 말고"]) expect(quotesWording(t)).toBe(true);
	for (const t of ["끝인사 짧게", "it's fine", "'\n'"]) expect(quotesWording(t)).toBe(false);
});

const item: ReplyItem = { kind: "comment", from: "viewer", text: "공연 잘 봤어요" };
const style = (forbidden: string[]): ReplyStyle => ({ rules: [], corrections: [], forbidden, samples: ["즐거운 공연 되세요", "다음에 또 와 주세요"] });

test("the prompt lists a wording rule by its label under the owner's wording rules, never as a forbidden expression; literals and hand-written regexes stay forbidden as written; no shape JSON anywhere", () => {
	const { user } = buildPrompt(item, style([K1_BULLET, "/잘 봤/", "고맙습니다"]));
	const forbidden = user.slice(user.indexOf("Forbidden expressions:"), user.indexOf(WORDING_RULES));
	expect(forbidden).toContain("- /잘 봤/\n- 고맙습니다");
	expect(forbidden).not.toContain(K1_LABEL);
	expect(user).toContain(`${WORDING_RULES}\n- ${K1_LABEL}`);
	expect(user).not.toContain('"parts"');
	expect(user).not.toContain("즐거운 공연 되세요");
	expect(user).toContain("다음에 또 와 주세요");
	expect(buildPrompt(item, style(["고맙습니다"])).user).not.toContain(WORDING_RULES);
});

test("the lint says a draft breaks the owner's wording rule by its label, which a rewrite may fix, and names a literal or a hand-written regex as main did", () => {
	const found = lintReply({ to: "viewer", body: "즐거운 공연 되세요, 고맙습니다" }, item, style([K1_BULLET, "고맙습니다", "/공연/"]));
	expect(found).toEqual([`it breaks the owner's wording rule '${K1_LABEL}'`, "it uses the forbidden expression '고맙습니다'", "it uses the forbidden expression '/공연/'"]);
	expect(rewritable(found)).toEqual(found);
	expect(ruleOfFinding(found[0]!)).toBe(K1_LABEL);
	expect(ruleOfFinding(found[1]!)).toBeUndefined();
	expect(reasonOf("wording_rule", { label: K1_LABEL }).text).toBe(`정해 둔 표현 규칙과 달라요: ${K1_LABEL}`);
	expect(reasonOf("wording_rule", { label: K1_LABEL }, "en").text).toBe(`The text breaks a wording rule you set: ${K1_LABEL}`);
});

test("the KakaoTalk prompt lists a wording rule under the owner's wording rules, not under Never use, and drops own lines it hits", () => {
	const { user } = buildDraftPrompt({ lines: ["상대: 내일 공연해요"], samples: ["즐거운 공연 되세요", "내일 봐요"], style: { rules: [], corrections: [], forbidden: [K1_BULLET, "무조건"], samples: [] } });
	expect(user).toContain("Never use:\n- 무조건\n");
	expect(user).toContain(`${WORDING_RULES}\n- ${K1_LABEL}`);
	expect(user.slice(user.indexOf("Never use:"), user.indexOf(WORDING_RULES))).not.toContain(K1_LABEL);
	expect(user).not.toContain('"parts"');
	expect(user).not.toContain("즐거운 공연 되세요");
	expect(user).toContain("내일 봐요");
});

test("the revise prompts keep forbid for fixed phrases and leave a rejected kind of sentence out of it", () => {
	const p = buildPrompt(item, style([]), { change: "덕담 끝을 바꿔 줘", previous: { to: "viewer", body: "즐거운 공연 되세요" } });
	expect(`${p.system}\n${p.user}`).toContain('"forbid" is only for a fixed phrase that is wrong wherever it appears; when the user rejects a kind of sentence or an ending in one use');
	expect(`${p.system}\n${p.user}`).toContain('in other sentences), leave it out of "forbid".');
	const kakao = buildDraftPrompt({ lines: ["상대: 내일 공연해요"], revise: { draft: "즐거운 공연 되세요", change: "덕담 끝을 바꿔 줘" } });
	expect(kakao.system).toContain("forbid is only for a fixed phrase that is wrong wherever it appears; when the owner rejects a kind of sentence or an ending in one use");
	expect(kakao.system).toContain("in other sentences), leave it out of forbid");
});
