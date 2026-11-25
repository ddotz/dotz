import { basename } from "node:path";

const MAX_NESTING = 24;
const MAX_HEREDOC_CODE_DEPTH = 6;
const MAX_EXPANDED = 1_000_000;
const ARITH_BUDGET_FACTOR = 4;
const ARITH_BUDGET_FLOOR = 65_536;
const NO_SUBS: string[] = [];
const REDIRECT_OPERATORS = ["&>>", "<<<", "<<-", "&>", "<<", "<>", "<&", ">&", ">>", ">|", "<", ">"];
const COMMAND_PREFIXES: Record<string, true> = { then: true, do: true, else: true, elif: true, if: true, while: true, until: true, "!": true, "{": true, time: true, coproc: true };
const READERS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, ksh: true, ssh: true, eval: true };
const DATA_HEADS = /^(?:cat|tee|head|tail|wc|sort|uniq|tr|cut|sed|awk|grep|egrep|fgrep|rg|jq|diff|git|python[\d.]*|node|perl|ruby|curl|base64)$/;
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_]*)=/y;
const BODY_SPECIAL = /[\\$`]/g;
const BRACE_FORM = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([\s\S]*))?$/;
const BACKTICK_ESCAPE = /\\([`\\$])/g;
const ANSI_ESCAPE = /\\(?:([abeEfnrtv\\'"?])|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|c([\s\S]))/g;
const ANSI_SIMPLE: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
const ESCAPED: Record<Context, RegExp> = { dq: /[\\"$`]/g, body: /[\\$`]/g, word: /[\\'"$`;&|<>()#]/g, value: /[\\'"$`;&|<>()# \t]/g };

type Context = "dq" | "word" | "value" | "body";

/** One word of a simple command: its value after quote removal, whether an unquoted expansion occurs in it, whether the shell can put text into it that the guard did not see (`live`: an unresolved `$` expansion or command substitution outside single quotes, or an unquoted brace or glob character), and the inner command of each live `$(...)` or backtick substitution in its source. A redirection target also carries its operator (`>`, `>>`, `<`, `&>`, ...). */
export interface ShellWord {
	text: string;
	expands: boolean;
	live: boolean;
	subs: string[];
	operator?: string;
}

/** A simple command: its words, and the targets of its redirections. */
export interface Segment {
	words: ShellWord[];
	redirects: ShellWord[];
}

interface Expander {
	vars: Map<string, string>;
	left: number;
	done: boolean;
}

interface ListOptions {
	nested: boolean;
	depth: number;
	build?: boolean;
	codeDepth?: number;
	expander?: Expander;
	bodies?: string[];
}

interface ListResult {
	end: number;
	closed: boolean;
	segments: Segment[];
	text: string;
}

interface WordOptions {
	collect: boolean;
	expander: Expander | undefined;
	depth: number;
	valueFrom: number;
	literal: boolean;
}

interface WordRead {
	end: number;
	text: string;
	expands: boolean;
	live: boolean;
	plain: boolean;
	dynamic: boolean;
	subs: string[];
	raw: string;
	replaced: boolean;
}

interface Dollar {
	end: number;
	kind: "paren" | "arith" | "brace";
	innerStart: number;
	innerEnd: number;
	closed: boolean;
}

interface CaseState {
	phase: "subject" | "pattern" | "body";
	parens: number;
	fresh: boolean;
}

interface PendingDoc {
	delimiter: string;
	stripTabs: boolean;
	quoted: boolean;
	pipe: number;
	from: number;
}

interface LineSegment {
	pipe: number;
	words: ShellWord[];
}

const isWordEnd = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">";
const isNameStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isNameChar = (c: string): boolean => isNameStart(c) || (c >= "0" && c <= "9");
const assignmentAt = (s: string, at: number): RegExpExecArray | null => {
	ASSIGNMENT.lastIndex = at;
	return ASSIGNMENT.exec(s);
};

function decodeAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE, (_match: string, simple?: string, hex?: string, short?: string, long?: string, octal?: string, control?: string) => {
		if (simple !== undefined) return ANSI_SIMPLE[simple];
		if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
		if (short !== undefined) return String.fromCharCode(parseInt(short, 16));
		if (long !== undefined) {
			const point = parseInt(long, 16);
			return point > 0x10ffff ? "" : String.fromCodePoint(point);
		}
		if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8) & 0xff);
		return String.fromCharCode((control ?? "").charCodeAt(0) & 0x1f);
	});
}

function scanBacktick(s: string, open: number): { end: number; closed: boolean } {
	const n = s.length;
	for (let i = open + 1; i < n; i++) {
		if (s[i] === "\\") i++;
		else if (s[i] === "`") return { end: i + 1, closed: true };
	}
	return { end: n, closed: false };
}

const backtickInner = (s: string, open: number, found: { end: number; closed: boolean }): string => s.slice(open + 1, found.closed ? found.end - 1 : found.end).replace(BACKTICK_ESCAPE, "$1");

function scanDouble(s: string, from: number, subs: string[] | undefined, depth: number): number {
	const n = s.length;
	if (depth > MAX_NESTING) return n;
	let i = from;
	while (i < n) {
		const c = s[i];
		if (c === '"') return i + 1;
		if (c === "\\") i += 2;
		else if (c === "$") i = skipDollar(s, i, subs, depth, true);
		else if (c === "`") {
			const found = scanBacktick(s, i);
			subs?.push(backtickInner(s, i, found));
			i = found.end;
		} else i++;
	}
	return n;
}

function scanBrace(s: string, from: number, subs: string[] | undefined, depth: number, inDouble: boolean): { end: number; closed: boolean } {
	const n = s.length;
	if (depth > MAX_NESTING) return { end: n, closed: false };
	let i = from;
	while (i < n) {
		const c = s[i];
		if (c === "}") return { end: i + 1, closed: true };
		if (c === "\\") i += 2;
		else if (c === "'" && !inDouble) {
			const close = s.indexOf("'", i + 1);
			i = close < 0 ? n : close + 1;
		} else if (c === '"') i = scanDouble(s, i + 1, subs, depth + 1);
		else if (c === "$") i = skipDollar(s, i, subs, depth, inDouble);
		else if (c === "`") {
			const found = scanBacktick(s, i);
			subs?.push(backtickInner(s, i, found));
			i = found.end;
		} else i++;
	}
	return { end: n, closed: false };
}

let arithBudget = 0;

const startBudget = (length: number): void => {
	arithBudget = ARITH_BUDGET_FACTOR * length + ARITH_BUDGET_FLOOR;
};

function scanArith(s: string, from: number, subs: string[] | undefined, depth: number): number {
	if (arithBudget < 0) return -1;
	const result = scanArithRaw(s, from, subs, depth);
	if (result >= 0) return result;
	arithBudget -= ~result - from;
	return -1;
}

function scanArithRaw(s: string, from: number, subs: string[] | undefined, depth: number): number {
	const n = s.length;
	if (depth > MAX_NESTING) return ~from;
	let level = 2;
	let i = from;
	while (i < n) {
		const c = s[i];
		if (c === "\\") i += 2;
		else if (c === "'") {
			const close = s.indexOf("'", i + 1);
			i = close < 0 ? n : close + 1;
		} else if (c === '"') i = scanDouble(s, i + 1, subs, depth + 1);
		else if (c === "`") {
			const found = scanBacktick(s, i);
			subs?.push(backtickInner(s, i, found));
			i = found.end;
		} else if (c === "$") i = skipDollar(s, i, subs, depth, false);
		else if (c === "(") {
			level++;
			i++;
		} else if (c === ")") {
			level--;
			if (level === 1) return s[i + 1] === ")" ? i + 2 : ~i;
			i++;
		} else i++;
	}
	return ~n;
}

function scanDollar(s: string, i: number, subs: string[] | undefined, depth: number, inDouble: boolean): Dollar | undefined {
	const next = s[i + 1];
	if (next === "(") {
		if (s[i + 2] === "(") {
			const mark = subs?.length ?? 0;
			const end = scanArith(s, i + 3, subs, depth + 1);
			if (end >= 0) return { end, kind: "arith", innerStart: i + 3, innerEnd: end - 2, closed: true };
			if (subs !== undefined) subs.length = mark;
		}
		const sub = scanList(s, i + 2, { nested: true, depth: depth + 1 });
		const innerEnd = sub.closed ? sub.end - 1 : sub.end;
		subs?.push(s.slice(i + 2, innerEnd));
		return { end: sub.end, kind: "paren", innerStart: i + 2, innerEnd, closed: sub.closed };
	}
	if (next === "{") {
		const brace = scanBrace(s, i + 2, subs, depth + 1, inDouble);
		return { end: brace.end, kind: "brace", innerStart: i + 2, innerEnd: brace.closed ? brace.end - 1 : brace.end, closed: brace.closed };
	}
	return undefined;
}

function skipDollar(s: string, i: number, subs: string[] | undefined, depth: number, inDouble: boolean): number {
	return scanDollar(s, i, subs, depth, inDouble)?.end ?? i + 1;
}

function escapeValue(value: string, context: Context): string {
	if (context === "dq" || context === "body") return value.replace(ESCAPED[context], "\\$&");
	return value.replace(/[\r\n]+/g, " ").replace(ESCAPED[context], "\\$&");
}

function insertValue(expander: Expander, value: string, context: Context): string | undefined {
	if (expander.done) return undefined;
	const text = escapeValue(value, context);
	if (text.length > expander.left) {
		expander.done = true;
		return undefined;
	}
	expander.left -= text.length;
	return text;
}

function expandBrace(inner: string, expander: Expander, depth: number): string | undefined {
	const found = BRACE_FORM.exec(inner);
	if (found === null || expander.done) return undefined;
	const [, name, operator, fallback] = found;
	const assigned = expander.vars.get(name);
	if (operator === undefined) return assigned;
	if (assigned !== undefined && !(operator === ":-" && assigned === "")) return assigned;
	const read = readWord(fallback, 0, { collect: false, expander, depth: depth + 1, valueFrom: Infinity, literal: true });
	return read.dynamic ? undefined : read.text;
}

function expandList(text: string, expander: Expander, depth: number): string {
	if (depth > MAX_NESTING || expander.done) return text;
	return scanList(text, 0, { nested: false, depth, expander }).text;
}

function expandBody(body: string, expander: Expander, depth: number): string {
	const n = body.length;
	let out = "";
	let copied = 0;
	let i = 0;
	while (i < n) {
		BODY_SPECIAL.lastIndex = i;
		const found = BODY_SPECIAL.exec(body);
		if (found === null) break;
		const at = found.index;
		const c = body[at];
		if (c === "\\") {
			i = at + 2;
		} else if (c === "`") {
			i = scanBacktick(body, at).end;
		} else if (body[at + 1] === "(" || body[at + 1] === "{") {
			const dollar = scanDollar(body, at, undefined, depth, false);
			i = dollar?.end ?? at + 1;
			if (dollar?.kind === "paren") {
				const inner = body.slice(dollar.innerStart, dollar.innerEnd);
				const rewritten = expandList(inner, expander, depth + 1);
				if (rewritten !== inner) {
					out += `${body.slice(copied, at)}$(${rewritten}${dollar.closed ? ")" : ""}`;
					copied = dollar.end;
				}
			} else if (dollar?.kind === "brace" && dollar.closed) {
				const value = expandBrace(body.slice(dollar.innerStart, dollar.innerEnd), expander, depth + 1);
				const insertion = value === undefined ? undefined : insertValue(expander, value, "body");
				if (insertion !== undefined) {
					out += body.slice(copied, at) + insertion;
					copied = dollar.end;
				}
			}
		} else if (isNameStart(body[at + 1] ?? "")) {
			let end = at + 2;
			while (end < n && isNameChar(body[end])) end++;
			const value = expander.done ? undefined : expander.vars.get(body.slice(at + 1, end));
			const insertion = value === undefined ? undefined : insertValue(expander, value, "body");
			if (insertion !== undefined) {
				out += body.slice(copied, at) + insertion;
				copied = end;
			}
			i = end;
		} else i = at + 1;
	}
	return out + body.slice(copied);
}

function readWord(s: string, from: number, o: WordOptions): WordRead {
	const n = s.length;
	const subs: string[] = o.collect ? [] : NO_SUBS;
	const collecting = o.collect ? subs : undefined;
	const expander = o.expander;
	let text = "";
	let expands = false;
	let live = false;
	let plain = true;
	let dynamic = false;
	let raw = "";
	let copied = from;
	let replaced = false;
	let quoted = false;
	let i = from;
	while (i < n) {
		const c = s[i];
		if (quoted) {
			if (c === '"') {
				quoted = false;
				i++;
				continue;
			}
			if (c === "\\") {
				const next = s[i + 1];
				if (next === "\n") i += 2;
				else if (next === "$" || next === "`" || next === '"' || next === "\\") {
					text += next;
					i += 2;
				} else {
					text += c;
					i++;
				}
				continue;
			}
			if (c !== "$" && c !== "`") {
				text += c;
				i++;
				continue;
			}
		} else {
			if (!o.literal && isWordEnd(c)) break;
			if (c === "\\") {
				if (s[i + 1] !== "\n") {
					text += s[i + 1] ?? "";
					plain = false;
				}
				i += 2;
				continue;
			}
			if (c === "'") {
				const close = s.indexOf("'", i + 1);
				const stop = close < 0 ? n : close;
				text += s.slice(i + 1, stop);
				plain = false;
				i = stop + 1;
				continue;
			}
			if (c === '"') {
				quoted = true;
				plain = false;
				i++;
				continue;
			}
		}
		if (c === "$") {
			const next = s[i + 1];
			const context: Context = quoted ? "dq" : i >= o.valueFrom ? "value" : "word";
			if (next === "(" || next === "{") {
				const found = scanDollar(s, i, collecting, o.depth, quoted);
				const end = found?.end ?? i + 1;
				if (found === undefined) {
					text += c;
					i++;
					continue;
				}
				if (!quoted) {
					expands = true;
					plain = false;
				}
				let resolved = false;
				if (expander !== undefined && found.closed && found.kind === "paren") {
					const inner = s.slice(found.innerStart, found.innerEnd);
					const rewritten = expandList(inner, expander, o.depth + 1);
					if (rewritten !== inner) {
						const piece = `$(${rewritten})`;
						raw += s.slice(copied, i) + piece;
						copied = end;
						replaced = true;
						text += piece;
						i = end;
						dynamic = true;
						live = true;
						continue;
					}
				} else if (expander !== undefined && found.closed && found.kind === "brace") {
					const value = expandBrace(s.slice(found.innerStart, found.innerEnd), expander, o.depth + 1);
					const insertion = value === undefined ? undefined : insertValue(expander, value, context);
					if (value !== undefined && insertion !== undefined) {
						raw += s.slice(copied, i) + insertion;
						copied = end;
						replaced = true;
						text += value;
						resolved = true;
					}
				}
				if (!resolved) {
					text += s.slice(i, end);
					dynamic = true;
					live = true;
				}
				i = end;
				continue;
			}
			if (next !== undefined && isNameStart(next)) {
				let end = i + 2;
				while (end < n && isNameChar(s[end])) end++;
				if (!quoted) {
					expands = true;
					plain = false;
				}
				if (expander !== undefined) {
					const value = expander.done ? undefined : expander.vars.get(s.slice(i + 1, end));
					const insertion = value === undefined ? undefined : insertValue(expander, value, context);
					if (value !== undefined && insertion !== undefined) {
						raw += s.slice(copied, i) + insertion;
						copied = end;
						replaced = true;
						text += value;
						i = end;
						continue;
					}
					dynamic = true;
				}
				text += s.slice(i, end);
				live = true;
				i = end;
				continue;
			}
			if (next === "'" && !quoted) {
				let stop = i + 2;
				while (stop < n && s[stop] !== "'") stop += s[stop] === "\\" ? 2 : 1;
				text += decodeAnsi(s.slice(i + 2, Math.min(stop, n)));
				plain = false;
				i = stop + 1;
				continue;
			}
			if (next === '"' && !quoted) {
				i++;
				continue;
			}
			text += c;
			i++;
			continue;
		}
		if (c === "`") {
			const found = scanBacktick(s, i);
			collecting?.push(backtickInner(s, i, found));
			text += s.slice(i, found.end);
			if (!quoted) {
				expands = true;
				plain = false;
			}
			dynamic = true;
			live = true;
			i = found.end;
			continue;
		}
		if (!quoted && (c === "{" || c === "*" || c === "?" || c === "[")) live = true;
		text += c;
		i++;
	}
	const end = Math.min(i, n);
	return { end, text, expands, live, plain, dynamic, subs, raw: replaced ? raw + s.slice(copied, end) : "", replaced };
}

function heredocBody(s: string, from: number, doc: PendingDoc): { end: number; next: number } {
	const n = s.length;
	const { delimiter, stripTabs } = doc;
	let lineStart = from;
	while (lineStart < n) {
		let lineEnd = s.indexOf("\n", lineStart);
		if (lineEnd < 0) lineEnd = n;
		let at = lineStart;
		if (stripTabs) while (at < lineEnd && s.charCodeAt(at) === 9) at++;
		if (lineEnd - at === delimiter.length && s.startsWith(delimiter, at)) return { end: lineStart, next: Math.min(lineEnd + 1, n) };
		lineStart = lineEnd + 1;
	}
	return { end: n, next: n };
}

function bodySubstitutions(body: string, depth: number): string[] {
	const subs: string[] = [];
	const n = body.length;
	let i = 0;
	while (i < n) {
		BODY_SPECIAL.lastIndex = i;
		const found = BODY_SPECIAL.exec(body);
		if (found === null) break;
		const at = found.index;
		if (body[at] === "\\") i = at + 2;
		else if (body[at] === "`") {
			const tick = scanBacktick(body, at);
			subs.push(backtickInner(body, at, tick));
			i = tick.end;
		} else i = skipDollar(body, at, subs, depth, false);
	}
	return subs;
}

function readsCode(words: ShellWord[]): boolean {
	const found = commandHead(words);
	if (found === undefined) return false;
	if (found.name === "." || found.name === "source" || READERS[found.name] === true) return true;
	if (DATA_HEADS.test(found.name)) return false;
	return words.some(word => READERS[basename(word.text)] === true);
}

function scanList(s: string, from: number, o: ListOptions): ListResult {
	const n = s.length;
	const segments: Segment[] = [];
	if (o.depth > MAX_NESTING) return { end: n, closed: false, segments, text: s };
	const { nested, expander } = o;
	const build = o.build === true;
	const codeDepth = o.codeDepth ?? 0;
	const flat = codeDepth > MAX_HEREDOC_CODE_DEPTH;
	const wordOptions: WordOptions = { collect: build, expander, depth: o.depth, valueFrom: Infinity, literal: false };
	const delimiterOptions: WordOptions = { collect: false, expander: undefined, depth: o.depth, valueFrom: Infinity, literal: false };
	const out: string[] = [];
	const cases: CaseState[] = [];
	let words: ShellWord[] = [];
	let redirects: ShellWord[] = [];
	let docs: PendingDoc[] = [];
	let lineSegments: LineSegment[] = [];
	let pipeId = 0;
	let pipeJoin = false;
	let parens = 0;
	let cmdStart = true;
	let prevWord = "";
	let copied = from;
	let i = from;

	const replace = (start: number, stop: number, value: string): void => {
		out.push(s.slice(copied, start), value);
		copied = stop;
	};

	const addReaderBodies = (): void => {
		if (!readsCode(words)) return;
		for (const word of [...words, ...redirects]) {
			const bodies: string[] = [];
			for (const sub of word.subs.slice()) scanList(sub, 0, { nested: false, depth: o.depth + 1, bodies });
			for (const body of bodies) word.subs.push(body);
		}
	};

	const endSegment = (operator: "pipe" | "separator" | "newline"): void => {
		if (words.length > 0 || redirects.length > 0) {
			if (!pipeJoin) pipeId++;
			segments.push({ words, redirects });
			if (docs.length > 0) lineSegments.push({ pipe: pipeId, words });
			if (words.some(word => word.subs.length > 0) || redirects.some(word => word.subs.length > 0)) addReaderBodies();
			pipeJoin = operator === "pipe";
			words = [];
			redirects = [];
		} else if (operator !== "newline") pipeJoin = operator === "pipe";
	};

	const resolveDocs = (at: number): number => {
		let position = at;
		const pending = docs;
		docs = [];
		for (const doc of pending) {
			const bodyFrom = position;
			const { end, next } = heredocBody(s, bodyFrom, doc);
			position = next;
			let reader = false;
			if (build) for (let k = doc.from; k < lineSegments.length && !reader; k++) reader = lineSegments[k].pipe === doc.pipe && readsCode(lineSegments[k].words);
			if (!reader && o.bodies === undefined && (doc.quoted || (!build && expander === undefined))) continue;
			const body = s.slice(bodyFrom, end);
			o.bodies?.push(body);
			if (reader) {
				for (const segment of scanList(body, 0, { nested: false, depth: o.depth, build: true, codeDepth: codeDepth + 1 }).segments) segments.push(segment);
			} else if (build && !doc.quoted) {
				const subs = bodySubstitutions(body, o.depth);
				if (subs.length > 0) segments.push({ words: [], redirects: [{ text: "", expands: false, live: true, subs }] });
			}
			if (expander !== undefined && !doc.quoted) replace(bodyFrom, end, expandBody(body, expander, o.depth + 1));
		}
		return position;
	};

	while (i < n) {
		const c = s[i];
		if (c === " " || c === "\t") {
			i++;
			continue;
		}
		if (c === "\\" && s[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (c === "\n") {
			endSegment("newline");
			cmdStart = true;
			prevWord = "";
			i++;
			if (docs.length > 0) i = resolveDocs(i);
			lineSegments = [];
			continue;
		}
		if (c === "#") {
			while (i < n && s[i] !== "\n") i++;
			continue;
		}
		const top = cases.length > 0 ? cases[cases.length - 1] : undefined;
		if (top !== undefined && top.phase === "pattern") {
			if (c === "(") {
				if (!top.fresh) top.parens++;
				i++;
			} else if (c === ")") {
				if (top.parens > 0) top.parens--;
				else {
					top.phase = "body";
					cmdStart = true;
				}
				i++;
			} else if (c === "|") {
				top.fresh = true;
				i++;
			} else {
				const pattern = readWord(s, i, wordOptions);
				if (top.fresh && pattern.plain && pattern.text === "esac" && pattern.end > i) cases.pop();
				else top.fresh = false;
				i = pattern.end > i ? pattern.end : i + 1;
			}
			continue;
		}
		if (c === ";") {
			const length = s.startsWith(";;&", i) ? 3 : s[i + 1] === ";" || s[i + 1] === "&" ? 2 : 1;
			endSegment("separator");
			if (length > 1 && top !== undefined && top.phase === "body") {
				top.phase = "pattern";
				top.fresh = true;
				top.parens = 0;
			}
			i += length;
			cmdStart = length === 1;
			prevWord = "";
			continue;
		}
		if (c === "&" && s[i + 1] !== ">") {
			endSegment("separator");
			i += s[i + 1] === "&" ? 2 : 1;
			cmdStart = true;
			prevWord = "";
			continue;
		}
		if (c === "|") {
			const either = s[i + 1] === "|";
			endSegment(either ? "separator" : "pipe");
			i += either || s[i + 1] === "&" ? 2 : 1;
			cmdStart = true;
			prevWord = "";
			continue;
		}
		if (c === "(") {
			if (s[i + 1] === "(" && (cmdStart || prevWord === "for")) {
				const found: string[] | undefined = build ? [] : undefined;
				const end = scanArith(s, i + 2, found, o.depth + 1);
				if (end >= 0) {
					if (found !== undefined && found.length > 0) segments.push({ words: [], redirects: [{ text: "", expands: false, live: true, subs: found }] });
					i = end;
					cmdStart = false;
					prevWord = "";
					continue;
				}
			}
			endSegment("separator");
			if (nested) parens++;
			cmdStart = true;
			prevWord = "";
			i++;
			continue;
		}
		if (c === ")") {
			endSegment("separator");
			i++;
			prevWord = "";
			cmdStart = false;
			if (nested) {
				if (parens > 0) {
					parens--;
					continue;
				}
				return { end: i, closed: true, segments, text: "" };
			}
			continue;
		}
		if (c === "<" || c === ">" || c === "&") {
			if (c !== "&" && s[i + 1] === "(") {
				i++;
				continue;
			}
			const operator = REDIRECT_OPERATORS.find(candidate => s.startsWith(candidate, i)) ?? c;
			i += operator.length;
			if ((operator === ">&" || operator === "<&") && s[i] === "-") {
				i++;
				continue;
			}
			while (i < n && (s[i] === " " || s[i] === "\t")) i++;
			if (i >= n || isWordEnd(s[i])) continue;
			const heredoc = (operator === "<<" || operator === "<<-") && !flat;
			wordOptions.valueFrom = Infinity;
			const target = readWord(s, i, heredoc ? delimiterOptions : wordOptions);
			if (heredoc) docs.push({ delimiter: target.text, stripTabs: operator === "<<-", quoted: !target.plain, pipe: pipeJoin ? pipeId : pipeId + 1, from: lineSegments.length });
			else if (build) redirects.push({ text: target.text, expands: target.expands, live: target.live, subs: target.subs, operator });
			if (expander !== undefined && !heredoc && target.replaced) replace(i, target.end, target.raw);
			i = target.end > i ? target.end : i + 1;
			continue;
		}
		const assignment = expander === undefined ? null : assignmentAt(s, i);
		wordOptions.valueFrom = assignment === null ? Infinity : i + assignment[0].length;
		const word = readWord(s, i, wordOptions);
		const end = word.end > i ? word.end : i + 1;
		if (word.plain && /^\d+$/.test(word.text) && (s[end] === "<" || s[end] === ">")) {
			i = end;
			continue;
		}
		if (build) words.push({ text: word.text, expands: word.expands, live: word.live, subs: word.subs });
		if (expander !== undefined) {
			if (word.replaced) replace(i, end, word.raw);
			if (assignment !== null) {
				const name = assignment[1];
				if (word.dynamic || s[end] === "(") expander.vars.delete(name);
				else expander.vars.set(name, word.text.slice(name.length + 1));
			}
		}
		const keyword = word.plain ? word.text : "";
		const current = nested && cases.length > 0 ? cases[cases.length - 1] : undefined;
		if (nested && cmdStart && keyword === "case") {
			cases.push({ phase: "subject", parens: 0, fresh: true });
			cmdStart = false;
		} else if (current?.phase === "subject" && keyword === "in") {
			current.phase = "pattern";
			current.parens = 0;
			current.fresh = true;
		} else if (cmdStart && current?.phase === "body" && keyword === "esac") {
			cases.pop();
			cmdStart = false;
		} else if (cmdStart) cmdStart = COMMAND_PREFIXES[keyword] === true || assignmentAt(s, i) !== null;
		prevWord = keyword;
		i = end;
	}
	endSegment("separator");
	if (expander !== undefined) out.push(s.slice(copied));
	return { end: n, closed: false, segments, text: out.join("") };
}

/** Rewrites `$VAR`, `${VAR}`, `${VAR:-default}` and `${VAR-default}` with the value assigned before each use, in command order; comments, single quotes and quoted heredoc bodies expand nothing, and past 1 MB of inserted text the rest stays as written. */
export function expandShellVars(command: string): string {
	if (!command.includes("$")) return command;
	startBudget(command.length);
	return scanList(command, 0, { nested: false, depth: 0, expander: { vars: new Map(), left: MAX_EXPANDED, done: false } }).text;
}

/** The inner command of every live `$(...)` and backtick substitution in a command text, decided on the raw text with quote state. */
export function substitutions(text: string): string[] {
	return shellSegments(text).flatMap(segment => [...segment.words, ...segment.redirects].flatMap(word => word.subs));
}

/** The index after the `)` that closes the substitution whose `(` is at `open`, or the end of the text when it is never closed. */
export function skipParen(s: string, open: number): number {
	startBudget(s.length - open);
	return scanList(s, open + 1, { nested: true, depth: 0 }).end;
}

/** The index after the backtick that closes the substitution opened at `open`, or the end of the text when it is never closed. */
export function skipBacktick(s: string, open: number): number {
	return scanBacktick(s, open).end;
}

/** Splits a command into simple-command segments of words. A heredoc body is read as commands only when a shell reads it, and its substitutions are live only when its delimiter is unquoted. */
export function shellSegments(s: string): Segment[] {
	startBudget(s.length);
	return scanList(s, 0, { nested: false, depth: 0, build: true }).segments;
}

const WRAPPER_COMMANDS: Record<string, true> = { sudo: true, env: true, time: true, nice: true, nohup: true, command: true, exec: true, builtin: true, xargs: true, timeout: true, if: true, then: true, else: true, elif: true, do: true, while: true, until: true, "{": true, "!": true };

/** The command word of a simple command after env assignments and wrappers (sudo, env, timeout 60, ...) and the shell keywords that precede it (`if git push; then`, `{ npm i; }`, `! cmd`). */
export function commandHead(words: ShellWord[]): { head: string; name: string; args: ShellWord[] } | undefined {
	let i = 0;
	while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text) || WRAPPER_COMMANDS[basename(words[i].text)] === true || (i > 0 && /^(-|\d+$)/.test(words[i].text)))) i++;
	const head = words[i];
	return head && { head: head.text, name: basename(head.text), args: words.slice(i + 1) };
}

/** The agents whose workers write files: the default `task` agent and `sonic`. Every other agent reads. */
export const WRITING_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);
