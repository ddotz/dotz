/** One part of a wording shape: one of the `any` wordings (not right after a `notAfter` wording), or up to `gap` other characters of the same sentence. */
export type Part = { any: string[]; notAfter?: string[] } | { gap: number };
/** A wording a model describes and code matches (`matchShape`); the model never writes a regex. */
export type Shape = { parts: Part[] };

/** A banned wording: `literal` matches as a substring (NFC, whitespace runs as one space, case aside); `regex` is a pattern the owner wrote by hand; `shape` is a wording rule the product wrote, shown by its label (what to write instead); `content` is something the draft must not say (`내용: 용도를 묻지 않기`), which no wording finds: only the style judge reads it (hub/style-judge.ts). */
export type Ban = { kind: "literal"; text: string } | { kind: "regex"; source: string; flags: string } | { kind: "shape"; shape: Shape; label: string } | { kind: "content"; text: string };
/** A ban that is a wording rule the product wrote. */
export type ShapeBan = Extract<Ban, { kind: "shape" }>;

/** The prompt heading of the wording rules, apart from the forbidden list. */
export const WORDING_RULES = "Wording rules the owner set (a draft that breaks one is rejected):";

const REGEX_ENTRY = /^\/(.+)\/([a-z]*)$/;
const SHAPE_PREFIX = "shape ";
/** The marker of a content ban bullet in `## 금지`: `내용: <what not to write>`. */
export const CONTENT_PREFIX = "내용:";
const MULTILINE = /[\n\r\u2028\u2029]/;
const oneLine = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim();
const banText = (s: string): string => oneLine(s).toLowerCase();
const chars = (s: string): number => [...s].length;
const inRange = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max;
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x): x is string => typeof x === "string") ? v : undefined);
const fieldsOf = (v: unknown, keys: string[]): Map<string, unknown> | undefined => {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
	const fields = new Map(Object.entries(v));
	return [...fields.keys()].every(k => keys.includes(k)) ? fields : undefined;
};

const LIMITS = { parts: 5, gaps: 2, gap: 30, any: 40, anyChars: 20, notAfter: 10, notAfterChars: 6, labelChars: 80 };

function shapeProblem(shape: Shape, label: string): string | undefined {
	const parts = shape.parts;
	if (!inRange(parts.length, 1, LIMITS.parts)) return `the shape needs 1 to ${LIMITS.parts} parts`;
	if (!("any" in parts[0]!) || !("any" in parts[parts.length - 1]!)) return "the shape must start and end with an any part";
	if (parts.filter(p => "gap" in p).length > LIMITS.gaps) return `the shape has more than ${LIMITS.gaps} gaps`;
	let gapBefore = false;
	for (const p of parts) {
		if ("gap" in p) {
			if (gapBefore) return "the shape has two gaps in a row";
			if (!inRange(p.gap, 1, LIMITS.gap)) return `a gap must be a whole number from 1 to ${LIMITS.gap}`;
			gapBefore = true;
			continue;
		}
		gapBefore = false;
		if (!inRange(p.any.length, 1, LIMITS.any)) return `an any part needs 1 to ${LIMITS.any} wordings`;
		const badAny = p.any.find(a => !inRange(chars(a.trim()), 1, LIMITS.anyChars) || MULTILINE.test(a));
		if (badAny !== undefined) return `the wording '${badAny}' is not 1 to ${LIMITS.anyChars} characters on one line`;
		const after = p.notAfter ?? [];
		if (after.length > LIMITS.notAfter) return `notAfter holds at most ${LIMITS.notAfter} wordings`;
		const badAfter = after.find(a => !inRange(chars(a.trim()), 1, LIMITS.notAfterChars) || MULTILINE.test(a));
		if (badAfter !== undefined) return `the notAfter wording '${badAfter}' is not 1 to ${LIMITS.notAfterChars} characters on one line`;
	}
	if (!label.trim() || !inRange(chars(label), 1, LIMITS.labelChars) || MULTILINE.test(label)) return `the label is not 1 to ${LIMITS.labelChars} characters on one line`;
	return undefined;
}

function partsOf(v: unknown): Part[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const parts: Part[] = [];
	for (const p of v) {
		const gap = fieldsOf(p, ["gap"]);
		if (gap) {
			const n = gap.get("gap");
			if (typeof n !== "number") return undefined;
			parts.push({ gap: n });
			continue;
		}
		const word = fieldsOf(p, ["any", "notAfter"]);
		const any = strings(word?.get("any"));
		const after = word?.get("notAfter");
		const notAfter = after === undefined ? undefined : strings(after);
		if (!any || (after !== undefined && !notAfter)) return undefined;
		parts.push({ any, ...(notAfter ? { notAfter } : {}) });
	}
	return parts;
}

function storedShape(json: string): ShapeBan | undefined {
	let v: unknown;
	try {
		v = JSON.parse(json);
	} catch (e) {
		if (e instanceof SyntaxError) return undefined;
		throw e;
	}
	const fields = fieldsOf(v, ["parts", "label"]);
	const label = fields?.get("label");
	const parts = partsOf(fields?.get("parts"));
	if (typeof label !== "string" || !parts || shapeProblem({ parts }, label) !== undefined) return undefined;
	return { kind: "shape", shape: { parts }, label };
}

/** One `## 금지` bullet as a ban: `/re/flags` a hand-written regex, `shape <JSON>` a wording rule the product stored (one that does not read back strictly is a literal), `내용: <text>` a content ban, anything else a literal. */
export function parseBan(bullet: string): Ban {
	const text = bullet.trim();
	const re = REGEX_ENTRY.exec(text);
	if (re) return { kind: "regex", source: re[1]!, flags: re[2]! };
	if (text.startsWith(SHAPE_PREFIX)) return storedShape(text.slice(SHAPE_PREFIX.length)) ?? { kind: "literal", text };
	const content = text.startsWith(CONTENT_PREFIX) ? oneLine(text.slice(CONTENT_PREFIX.length)) : "";
	return content ? { kind: "content", text: content } : { kind: "literal", text };
}

/** The bullet a ban is stored as; `parseBan` reads it back. */
export const banBullet = (ban: Ban): string => (ban.kind === "literal" ? ban.text : ban.kind === "content" ? `${CONTENT_PREFIX} ${ban.text}` : ban.kind === "regex" ? `/${ban.source}/${ban.flags}` : `${SHAPE_PREFIX}${JSON.stringify({ parts: ban.shape.parts, label: ban.label })}`);

/** What tells two bans apart: a literal by its normalised text, a regex by its source and flags, a shape by its parts (label aside). */
export const banKey = (ban: Ban): string => (ban.kind === "literal" ? banText(ban.text) : ban.kind === "content" ? `${CONTENT_PREFIX}${banText(ban.text)}` : ban.kind === "regex" ? `/${ban.source}/${ban.flags}` : `${SHAPE_PREFIX}${JSON.stringify(ban.shape.parts)}`);

/** What the model and the owner see for a ban: the literal text, a regex as the owner wrote it, a shape's label or a content ban's text. */
export const banLabel = (ban: Ban): string => (ban.kind === "shape" ? ban.label : ban.kind === "content" ? ban.text : banBullet(ban));

/** The text of a content ban; undefined for any other ban. */
export const contentBan = (ban: Ban): string | undefined => (ban.kind === "content" ? ban.text : undefined);

/** The label of a wording rule (a shape); undefined for a literal or a regex, which stay forbidden expressions. */
export const wordingRule = (ban: Ban): string | undefined => (ban.kind === "shape" ? ban.label : undefined);

const RULE_FINDING = "it breaks the owner's wording rule ";
/** The lint finding of a ban the body uses: a wording rule the body breaks, or a forbidden expression it uses. */
export const banFinding = (ban: Ban): string => {
	const rule = wordingRule(ban);
	return rule ? `${RULE_FINDING}'${rule}'` : `it uses the forbidden expression '${banLabel(ban)}'`;
};
/** The label of a lint finding about a broken wording rule; undefined for any other finding. */
export const ruleOfFinding = (finding: string): string | undefined => (finding.startsWith(`${RULE_FINDING}'`) && finding.endsWith("'") ? finding.slice(RULE_FINDING.length + 1, -1) : undefined);

/** The most steps (one per `startsWith` and per gap position) one shape check may take; past it the check stops and counts as not used. */
export const STEP_BUDGET = 2_000_000;
const SENTENCE_END = ".!?\n";
const flat = (s: string): string =>
	s
		.normalize("NFC")
		.toLowerCase()
		.replace(/\r\n?|[\u2028\u2029]/g, "\n")
		.replace(/[^\S\n]+/g, "");

type Compiled = { any: string[]; notAfter: string[] } | { gap: number };

/** Whether `body` holds the shape, and the `startsWith` steps it took: body and wordings in NFC, lower case, whitespace removed (a newline stays a sentence break); from every start, an any part takes one of its wordings unless the text before ends with one of its `notAfter` wordings, a gap 0..n characters that are not `.`, `!`, `?` or a newline. Past `STEP_BUDGET` steps it stops with `hit: false` and `steps` one over the budget. */
export function matchShape(body: string, shape: Shape): { hit: boolean; steps: number } {
	const text = flat(body);
	const parts: Compiled[] = shape.parts.map(p => ("gap" in p ? { gap: p.gap } : { any: [...new Set(p.any.map(flat))].filter(Boolean), notAfter: (p.notAfter ?? []).map(flat).filter(Boolean) }));
	const failed = parts.map(() => new Uint8Array(text.length + 1));
	let steps = 0;
	const stopped = () => steps > STEP_BUDGET;
	const from = (i: number, pos: number): boolean => {
		if (i === parts.length) return true;
		if (failed[i]![pos]) return false;
		const p = parts[i]!;
		if ("gap" in p) {
			let at = pos;
			for (let k = 0; k <= p.gap; k++) {
				if (++steps > STEP_BUDGET) return false;
				if (from(i + 1, at)) return true;
				if (stopped() || at >= text.length || SENTENCE_END.includes(text[at]!)) break;
				at += text.codePointAt(at)! > 0xffff ? 2 : 1;
			}
		} else if (!p.notAfter.some(a => text.endsWith(a, pos))) {
			for (const w of p.any) {
				if (++steps > STEP_BUDGET) return false;
				if (text.startsWith(w, pos) && from(i + 1, pos + w.length)) return true;
				if (stopped()) return false;
			}
		}
		if (!stopped()) failed[i]![pos] = 1;
		return false;
	};
	for (let start = 0; start < text.length; start++) {
		if (from(0, start)) return { hit: true, steps };
		if (stopped()) return { hit: false, steps };
	}
	return { hit: false, steps };
}

function compiled(source: string, flags: string): RegExp | undefined {
	try {
		return new RegExp(source, flags);
	} catch (e) {
		if (e instanceof SyntaxError) return undefined;
		throw e;
	}
}

/** Whether `body` uses the ban (a content ban never: no wording finds it, only the style judge): a literal as a substring (NFC, whitespace runs as one space, case aside; an empty one never hits), a regex tested once on the body as written (an invalid one never hits), a shape by `matchShape` (one that runs past its step budget counts as not used, logged once). */
export function banHit(body: string, ban: Ban): boolean {
	if (ban.kind === "content") return false;
	if (ban.kind === "regex") return compiled(ban.source, ban.flags)?.test(body) ?? false;
	if (ban.kind === "shape") {
		const r = matchShape(body, ban.shape);
		if (r.steps > STEP_BUDGET) console.error(`reply draft: wording rule '${ban.label}' stopped after ${STEP_BUDGET} steps on a ${chars(body)}-character text and counts as not used`);
		return r.hit;
	}
	const word = banText(ban.text);
	return !!word && banText(body).includes(word);
}

const LITERAL_CHARS = { min: 2, max: 40 };
/** A wording the owner or a revise may ban as a literal (2 to 40 characters once whitespace runs are one space, reading back as a literal: not a `/re/` nor a valid `shape` bullet), stored in NFC on one line; undefined otherwise. */
export function literalBan(word: string): Extract<Ban, { kind: "literal" }> | undefined {
	const text = oneLine(word);
	return inRange(chars(text), LITERAL_CHARS.min, LITERAL_CHARS.max) && parseBan(text).kind === "literal" ? { kind: "literal", text } : undefined;
}

const CORPUS_MIN = 20;
const CORPUS_SHARE = 0.15;
const tidy = (s: string): string => s.normalize("NFC").trim();

/** A proposed wording shape checked by code: its wordings and label in NFC and trimmed, it keeps the shape limits, hits every `bad` (at least one) and no `good`, and hits at most 15% of `corpus` (the owner's own past replies in the profile's scope) when it holds 20 or more. */
export function acceptPattern(p: { shape: Shape; label: string }, bad: string[], good: string[], corpus: string[]): { ok: true; ban: ShapeBan } | { ok: false; why: string } {
	const no = (why: string) => ({ ok: false as const, why });
	const parts = p.shape.parts.map((x): Part => ("gap" in x ? { gap: x.gap } : { any: x.any.map(tidy), ...(x.notAfter?.length ? { notAfter: x.notAfter.map(tidy) } : {}) }));
	const label = tidy(p.label);
	const problem = shapeProblem({ parts }, label);
	if (problem !== undefined) return no(problem);
	const ban: ShapeBan = { kind: "shape", shape: { parts }, label };
	if (banBullet(parseBan(banBullet(ban))) !== banBullet(ban)) return no("the pattern does not read back from its bullet");
	if (!bad.length) return no("there is no bad example");
	const missed = bad.find(b => !banHit(b, ban));
	if (missed !== undefined) return no(`the pattern misses the bad example '${missed}'`);
	const caught = good.find(g => banHit(g, ban));
	if (caught !== undefined) return no(`the pattern hits the good example '${caught}'`);
	if (corpus.length >= CORPUS_MIN) {
		const hits = corpus.filter(t => banHit(t, ban)).length;
		if (hits > corpus.length * CORPUS_SHARE) return no(`the pattern hits ${hits} of the owner's ${corpus.length} past replies`);
	}
	return { ok: true, ban };
}

const unfenced = (tag: string, s: string): string => {
	let out = s;
	for (let before = ""; before !== out; ) {
		before = out;
		out = out.replaceAll(`${tag}>>>`, tag).replaceAll(`<<<${tag}`, tag);
	}
	return out;
};
const fence = (tag: string, s: string): string => `<<<${tag}\n${unfenced(tag, s)}\n${tag}>>>`;
const PROPOSE = (rule: string, quotable: string[]) => {
	const fromRule = quotable.some(q => oneLine(q) === oneLine(rule));
	const texts = quotable.filter(q => oneLine(q) !== oneLine(rule));
	const where = fromRule && texts.length ? "the rule or the texts above" : fromRule ? "the rule" : "the texts above (never from the rule)";
	return [
		"The owner of a reply assistant set this rule for how his replies are written (data):",
		fence("RULE", rule),
		...(texts.length ? ["", "What the rule came from (the draft he corrected and what he said, data):", ...texts.map(t => fence("TEXT", t))] : []),
		"",
		"If the rule says a wording must not be used, describe that wording as a shape of parts that code turns into a matcher.",
		'Answer with one JSON object only: {"parts":[...],"label":"...","bad":["..."],"good":["..."]}',
		"- parts: 1 to 5 parts in order; the first and the last are any parts; at most 2 gap parts, never two in a row. A part is:",
		'  {"any":["...","..."]}: one of these exact wordings (1 to 40, each 1 to 20 characters on one line; spaces never matter, so "좋은 하루" also finds "좋은하루").',
		'  {"gap":n}: up to n other characters of the same sentence (n a whole number from 1 to 30).',
		'  "notAfter":["..."] inside an any part: that part does not count right after one of these wordings (at most 10, each 1 to 6 characters).',
		"- The shape is as narrow as the rule. When the rule is about a kind of sentence (a closing wish, a greeting), include the words that make it that kind, not only its ending.",
		"- label: one Korean line of at most 80 characters that says what to write instead (the wording to use), never the banned wording alone.",
		`- bad: texts the shape must find, copied verbatim from ${where}; at least one.`,
		`- good: texts it must not find (the allowed wording, or the same words used another way), copied verbatim from ${where}; [] when there are none.`,
		"Answer null when the rule is not about a wording (tone, length, order, content or anything a shape of words cannot find).",
	].join("\n");
};

const PROPOSE_SYSTEM = "You turn a rule about wording into a shape of words with examples. You output one JSON value and nothing else.";
/** The `ask` of `proposePattern` on a two-part model call (system, user). */
export const askWith = (call: (system: string, user: string) => Promise<string>) => (prompt: string): Promise<string> => call(PROPOSE_SYSTEM, prompt);

function jsonOf(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
	const raw = (fenced ?? text).trim();
	const from = raw.indexOf("{");
	const body = raw === "null" || from < 0 ? raw : raw.slice(from, raw.lastIndexOf("}") + 1);
	return JSON.parse(body);
}

/** For a rule about a wording to avoid, one model call proposes a labelled shape; code keeps only `bad`/`good` texts that occur verbatim (whitespace aside) in `quotable` (the owner's own words, chosen by the caller), then `acceptPattern` decides. The kept ban with the kept `good` texts; undefined when the rule is not about a wording or anything fails (logged once). */
export async function proposePattern(rule: string, quotable: string[], corpus: string[], ask: (prompt: string) => Promise<string>): Promise<{ ban: ShapeBan; good: string[] } | undefined> {
	const fail = (why: string) => (console.error(`reply draft: no wording pattern for "${oneLine(rule).slice(0, 80)}": ${why}`), undefined);
	let v: unknown;
	try {
		v = jsonOf(await ask(PROPOSE(rule, quotable)));
	} catch (e) {
		return fail(e instanceof SyntaxError ? "the answer is not JSON" : (e as Error).message);
	}
	if (v === null) return undefined;
	if (typeof v !== "object" || Array.isArray(v)) return fail("the answer is not a JSON object");
	const o = new Map(Object.entries(v));
	const parts = partsOf(o.get("parts"));
	const label = o.get("label");
	const bad = strings(o.get("bad")), good = strings(o.get("good") ?? []);
	if (!parts || typeof label !== "string" || !bad || !good) return fail("the answer lacks parts, label, bad or good");
	const said = quotable.map(oneLine);
	const quoted = (x: string) => !!oneLine(x) && said.some(s => s.includes(oneLine(x)));
	const kept = good.filter(quoted).map(oneLine);
	const r = acceptPattern({ shape: { parts }, label }, bad.filter(quoted).map(oneLine), kept, corpus);
	return r.ok ? { ban: r.ban, good: kept } : fail(r.why);
}

const QUOTED = /'[^'\n]+'|"[^"\n]+"|‘[^’\n]+’|“[^”\n]+”|「[^」\n]+」/;
/** Whether the owner's text quotes a wording (straight or curly quotes, or 「」). */
export const quotesWording = (text: string): boolean => QUOTED.test(text);
