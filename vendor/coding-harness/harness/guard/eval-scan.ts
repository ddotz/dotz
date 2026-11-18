import { basename } from "node:path";
import { scanCommand } from "./external.ts";

const HOLE = "\uFFFC";
const MAX_DEPTH = 10_000;
const MAX_NEST = 16;
const MAX_ITEMS = 256;
const MAX_ARGS = 1024;
const MAX_ARG_TOKENS = 4096;
const MAX_COMMANDS = 5000;
const MAX_COMMAND = 262_144;
const MAX_TOTAL = 8_000_000;
const MAX_NAMES = 20_000;
const MAX_VALUES = 32;
const MAX_EXTRA_PASSES = 20_000;
const MAX_SNIFF = 20_000;

type Item = string | null;
type Bound = string | Item[];
type FrameKind = "top" | "call" | "paren" | "list" | "sub" | "obj" | "emb" | "params";

interface Tok {
	k: "str" | "word" | "op" | "group";
	text: string;
	tag?: string;
	frame?: Frame;
	nl?: true;
}

interface Frame {
	kind: FrameKind;
	callee: string;
	args: Tok[][];
	cur: Tok[];
}

interface Pending {
	name: string;
	eq: Tok;
	frame: Frame;
	depth: number;
}

const table = (words: string): Record<string, true> => Object.fromEntries(words.split(" ").map(word => [word, true as const]));
const RESERVED = table("if elif else while for with assert return yield await not and or in is lambda from import as except raise del switch catch typeof void delete throw of instanceof do case default async new let const var def function class try finally");
const REGEX_AFTER = table("return typeof case in of delete void throw new else do yield await");
const NOT_VALUE = table("in not is lambda for while of instanceof typeof function class def yield");
const ALT_WORDS = table("if else or and");
const ALT_OPS = table("? : || && ??");
const PLAIN_OPS = table(". ?. %");
const PARAMS_AFTER = table("def function class");
const BLOCK_HEAD = table("if elif else while for with try except finally case default");
const DECL = table("const let var export");
const NAME = /^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*$/;
const COMMAND_KEY = /^(?:args|cmd|command|commands|argv|script|cmdline|command_line)$/;
const PREFIX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const OP_CHARS = "+-*%<>=!&|^~?:@.\\";
const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"' };

const DATA_FAMILY = /^(?:console|logging|logger|log|warnings|re|json|JSON)\./;
const DATA_NAMES = table(
	"print pprint echo input log debug info warn warning error exception critical fail skip exit phase agent completion judge judge_batch recall reflect retain write writelines writeFile writeFileSync appendFile appendFileSync write_text write_bytes startswith endswith startsWith endsWith includes indexOf lastIndexOf find rfind count index replace replaceAll split join format get has contains append push add extend insert remove pop setdefault update dumps dump loads stringify parse match search test findall fullmatch sub compile escape quote expect it describe list tuple set frozenset dict sorted len max min sum any all str repr bytes bool int float Counter defaultdict deque Series DataFrame Array Set Map choice",
);
const DATA_HEADS = table("rg grep echo cat jq");
const DATA_GIT_VERBS = table("commit log show grep diff");

const JS_MARKS =
	/^[ \t]*(?:\/\/|\/\*|(?:export[ \t]+)?(?:const|let|var)[ \t]+[\w${[]|(?:async[ \t]+)?function\b|import\b[^\n]*\bfrom[ \t]*["']|export[ \t])|=>|[!=]==|\b(?:console\.(?:log|info|warn|error)|Bun\.|require\(|child_process|execSync|execFileSync|spawnSync)|\$`|;[ \t]*$/gm;
const PY_MARKS =
	/^[ \t]*(?:#(?!!)|(?:async[ \t]+)?def\b|class\b|elif\b|except\b|(?:from[ \t]+[\w.]+[ \t]+)?import[ \t]+[\w., ]+(?:#.*)?$|(?:if|for|while|with|try|else|finally)\b[^\n]*:[ \t]*(?:#.*)?$|%%?\w|!\S)|\b(?:None|True|False|lambda)\b|\bprint\(|"""|'''|\bf["']|\bsubprocess\.|\bos\.(?:system|popen|environ|path)\b|\bshlex\.|\basyncio\./gm;

function looksLikeJs(code: string): boolean {
	const head = code.length > MAX_SNIFF ? code.slice(0, MAX_SNIFF) : code;
	return (head.match(JS_MARKS)?.length ?? 0) > (head.match(PY_MARKS)?.length ?? 0);
}

function isDataCallee(callee: string): boolean {
	if (callee === "") return false;
	if (DATA_FAMILY.test(callee)) return true;
	const name = callee.slice(callee.lastIndexOf(".") + 1);
	return (DATA_NAMES[name] === true && callee !== "shlex.split") || /^to[A-Z]|(?:Error|Exception|Warning|Exit)$/.test(name) || name.startsWith("assert");
}

function hex(src: string, from: number, length: number): number {
	const digits = src.slice(from, from + length);
	return digits.length === length && /^[0-9a-fA-F]+$/.test(digits) ? Number.parseInt(digits, 16) : -1;
}

const codePoint = (value: number): string => (value > 0x10ffff ? "\uFFFD" : String.fromCodePoint(value));

// why(spec): an unrecognised escape keeps its backslash in a Python string and loses it in a JS one (https://docs.python.org/3/reference/lexical_analysis.html#escape-sequences, ECMA-262 NonEscapeCharacter).
function unescape(src: string, at: number, js: boolean): [string, number] {
	const c = src[at];
	if (c === undefined) return ["\\", at];
	if (c === "\n") return ["", at + 1];
	if (c === "\r") return ["", src[at + 1] === "\n" ? at + 2 : at + 1];
	const simple = SIMPLE_ESCAPES[c];
	if (simple !== undefined) return [simple, at + 1];
	if (c >= "0" && c <= "7") {
		let end = at + 1;
		while (end < at + 3 && src[end] >= "0" && src[end] <= "7") end++;
		return [codePoint(Number.parseInt(src.slice(at, end), 8)), end];
	}
	if (c === "x" && hex(src, at + 1, 2) >= 0) return [codePoint(hex(src, at + 1, 2)), at + 3];
	if (c === "u") {
		if (src[at + 1] === "{") {
			const close = src.indexOf("}", at + 2);
			const value = close > at + 2 && close - at <= 10 ? hex(src, at + 2, close - at - 2) : -1;
			if (value >= 0) return [codePoint(value), close + 1];
		}
		if (hex(src, at + 1, 4) >= 0) return [codePoint(hex(src, at + 1, 4)), at + 5];
	}
	if (!js && c === "U" && hex(src, at + 1, 8) >= 0) return [codePoint(hex(src, at + 1, 8)), at + 9];
	if (!js && c === "N" && src[at + 1] === "{") {
		const close = src.indexOf("}", at + 2);
		return ["?", close < 0 ? at + 1 : close + 1];
	}
	if (!js && c === "a") return ["\x07", at + 1];
	return [js ? c : `\\${c}`, at + 1];
}

function chain(cur: Tok[]): string {
	let at = cur.length - 1;
	let name = cur[at].text;
	for (let steps = 0; steps < 8 && at >= 2; steps++) {
		const dot = cur[at - 1];
		const owner = cur[at - 2];
		if (dot.k !== "op" || (dot.text !== "." && dot.text !== "?.") || owner.k !== "word") break;
		name = `${owner.text}.${name}`;
		at -= 2;
	}
	return name;
}

function strs(tokens: Tok[]): string | undefined {
	if (tokens.length === 0) return undefined;
	let text = "";
	for (const tok of tokens) {
		if (tok.k !== "str" || tok.tag !== undefined) return undefined;
		text += tok.text;
	}
	return text;
}

function elements(frame: Frame): Item[] {
	const items: Item[] = [];
	for (const arg of frame.args) {
		if (items.length >= MAX_ITEMS) break;
		if (arg.length > 0) items.push(strs(arg) ?? null);
	}
	return items;
}

const joinedCall = (t: Tok[], at: number): Frame | undefined => (t[at]?.k === "op" && (t[at].text === "." || t[at].text === "?.") && t[at + 1]?.text === "join" && t[at + 2]?.frame?.kind === "call" ? t[at + 2].frame : undefined);

function operand(tokens: Tok[], level = 0): Item | Item[] {
	let t = tokens;
	for (let inner = t[0]?.frame; inner?.kind === "paren" && inner.args.length === 1 && t.length === 1; inner = t[0]?.frame) t = inner.args[0];
	const [head] = t;
	if (head === undefined || level > 4) return null;
	if (head.k === "str" && head.tag === undefined) {
		let at = 0;
		let text = "";
		while (t[at]?.k === "str" && t[at].tag === undefined) text += t[at++].text;
		const call = joinedCall(t, at);
		const list = call === undefined ? null : operand(call.args[0] ?? [], level + 1);
		return Array.isArray(list) ? list.map(item => item ?? HOLE).join(text) : text;
	}
	const frame = head.frame;
	if (frame === undefined || (frame.kind !== "list" && !(frame.kind === "paren" && frame.args.length !== 1))) return null;
	const items = elements(frame);
	const call = joinedCall(t, 1);
	if (call === undefined) return items;
	const sep = strs(call.args[0] ?? []);
	return sep === undefined ? null : items.map(item => item ?? HOLE).join(sep);
}

function shWord(text: string): string {
	if (text === "") return "''";
	return text
		.split(HOLE)
		.map(part => (part === "" || SAFE_WORD.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
		.join("$_");
}

function dataHead(argv: Item[]): boolean {
	const [head, verb] = argv;
	if (head === null || head === undefined) return false;
	const name = basename(head);
	return DATA_HEADS[name] === true || (name === "git" && typeof verb === "string" && DATA_GIT_VERBS[verb] === true);
}

function constant(tokens: Tok[]): Bound | undefined {
	const text = strs(tokens);
	if (text !== undefined) return text;
	if (tokens.length !== 1 || tokens[0].frame === undefined) return undefined;
	const value = operand(tokens);
	if (typeof value === "string") return value;
	return Array.isArray(value) && value.some(item => item !== null) ? value : undefined;
}

function words(text: string): string[] {
	const out: string[] = [];
	let word: string | undefined;
	let quote = "";
	for (let at = 0; at < text.length && out.length < MAX_ITEMS; at++) {
		const c = text[at];
		if (quote !== "") {
			if (c === quote) quote = "";
			else if (c === "\\" && quote === '"' && at + 1 < text.length) word = (word ?? "") + text[++at];
			else word = (word ?? "") + c;
		} else if (c === '"' || c === "'") {
			quote = c;
			word ??= "";
		} else if (c === "\\" && at + 1 < text.length) word = (word ?? "") + text[++at];
		else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
			if (word !== undefined) out.push(word);
			word = undefined;
		} else word = (word ?? "") + c;
	}
	if (word !== undefined && out.length < MAX_ITEMS) out.push(word);
	return out;
}

class Cell {
	readonly out = new Set<string>();
	private readonly src: string;
	private readonly js: boolean;
	private readonly stack: Frame[] = [{ kind: "top", callee: "", args: [], cur: [] }];
	private i = 0;
	private nl = false;
	private lineStart = true;
	private overflow = 0;
	private total = 0;
	private readonly bound = new Map<string, Bound[]>();
	private pending: Pending | undefined;
	private trimmed = false;
	private pick = 0;
	private passes = 1;
	private extra = 0;

	constructor(src: string, js: boolean) {
		this.src = src;
		this.js = js;
	}

	run(): Set<string> {
		// why(vendor): omp's Python runner runs `!cmd`, `x = !cmd` and a `%%bash` cell body through a shell (https://github.com/can1357/oh-my-pi, docs python-repl.md, section Magics).
		const magic = /^\s*%%(?:ba)?sh\b[^\n]*(?:\n|$)/.exec(this.src);
		if (magic) {
			this.command(this.src.slice(magic[0].length));
			return this.out;
		}
		this.code(0);
		while (this.stack.length > 1) this.closeTop();
		return this.out;
	}

	private command(text: string): void {
		if (this.out.size >= MAX_COMMANDS || this.total >= MAX_TOTAL) return;
		const line = text.replaceAll(HOLE, "$_");
		const bounded = line.length > MAX_COMMAND ? line.slice(0, MAX_COMMAND) : line;
		if (this.out.has(bounded)) return;
		this.out.add(bounded);
		this.total += bounded.length;
	}

	private top(): Frame {
		return this.stack[this.stack.length - 1];
	}

	private last(): Tok | undefined {
		const cur = this.top().cur;
		return cur[cur.length - 1];
	}

	private push(tok: Tok): void {
		this.lineStart = false;
		if (this.overflow > 0) return;
		if (this.nl) tok.nl = true;
		if (this.pending !== undefined) this.settle(tok);
		const top = this.top();
		if (top.kind === "top" && top.cur.length >= 512) {
			top.cur.splice(0, 256);
			this.trimmed = true;
		}
		if (top.cur.length < MAX_ARG_TOKENS) top.cur.push(tok);
		if (tok.k === "op" && tok.text === "=" && this.pending === undefined) this.arm(top, tok);
	}

	private startsStatement(frame: Frame, at: number): boolean {
		const cur = frame.cur;
		if (cur[at].nl === true) return true;
		if (at === 0) return frame.kind !== "top" || !this.trimmed;
		const prev = cur[at - 1];
		const head = cur[0].k === "word" && BLOCK_HEAD[cur[0].text] === true;
		if (prev.k === "op") return prev.text === ";" || (prev.text === ":" && head);
		if (prev.k === "word") return DECL[prev.text] === true || prev.text === "else" || prev.text === "do";
		return prev.k === "group" && (prev.frame?.kind === "obj" || (prev.frame?.kind === "paren" && head));
	}

	private arm(top: Frame, eq: Tok): void {
		const cur = top.cur;
		const q = cur.length - 2;
		if ((top.kind !== "top" && top.kind !== "obj") || cur[q + 1] !== eq || q < 0) return;
		let at = cur[q].k === "word" && this.startsStatement(top, q) ? q : -1;
		for (let k = q - 1; at < 0 && k >= 1 && k >= q - 8; k--) {
			const tok = cur[k];
			if (tok.k !== "op") continue;
			if (tok.text === "=" || tok.text === ";") break;
			if (tok.text === ":" && cur[k - 1].k === "word" && this.startsStatement(top, k - 1)) at = k - 1;
		}
		if (at < 0 || !NAME.test(cur[at].text) || RESERVED[cur[at].text] === true) return;
		this.pending = { name: cur[at].text, eq, frame: top, depth: this.stack.length - 1 };
	}

	private settle(tok: Tok): void {
		const pending = this.pending;
		if (pending === undefined) return;
		const open = this.stack[pending.depth] === pending.frame;
		if (open && this.top() !== pending.frame) return;
		const cur = pending.frame.cur;
		const at = cur.lastIndexOf(pending.eq);
		const value = at < 0 ? [] : cur.slice(at + 1);
		if (open) {
			if (at >= 0 && value.length === 0 && this.js) return;
			if (at >= 0 && value.length === 0 && tok.nl !== true) return;
			if (at >= 0 && value.length > 0 && tok.k === "str" && tok.tag === undefined && value.every(part => part.k === "str")) return;
			const ends = tok.k === "op" ? tok.text === ";" || (tok.nl === true && !this.js) : tok.nl === true && tok.k !== "group";
			this.pending = undefined;
			if (at < 0 || !ends) return;
		} else this.pending = undefined;
		if (value.length > 0) this.bind(pending.name, constant(value));
	}

	private bind(name: string, value: Bound | undefined): void {
		if (value === undefined) return;
		let values = this.bound.get(name);
		if (values === undefined) {
			if (this.bound.size >= MAX_NAMES) return;
			values = [];
			this.bound.set(name, values);
		}
		const seen = values.findIndex(old => (typeof old === "string" || typeof value === "string" ? old === value : old.length === value.length && old.every((item, at) => item === value[at])));
		if (seen >= 0) values.splice(seen, 1);
		else if (values.length >= MAX_VALUES) values.shift();
		values.push(value);
	}

	private named(t: Tok[]): Bound | undefined {
		const spread = t[0]?.k === "op" && (t[0].text === "*" || t[0].text === "...");
		const at = spread ? 1 : 0;
		const word = t[at];
		if (word === undefined || word.k !== "word") return undefined;
		const values = this.bound.get(word.text);
		if (values === undefined) return undefined;
		const dot = t[at + 1];
		const split = !spread && t.length === 4 && dot.k === "op" && (dot.text === "." || dot.text === "?.") && t[2].text === "split" && t[3].frame?.kind === "call";
		if (t.length !== at + 1 && !split) return undefined;
		this.passes = Math.max(this.passes, values.length);
		const value = values[Math.max(0, values.length - 1 - this.pick)];
		if (!split) return value;
		return typeof value === "string" ? words(value) : undefined;
	}

	private add(k: "word" | "op", text: string): void {
		this.push({ k, text });
		this.nl = false;
	}

	private addStr(text: string, tag?: string): void {
		if (tag !== undefined && !isDataCallee(tag)) this.command(text);
		this.push({ k: "str", text, tag });
		this.nl = false;
	}

	private open(ch: string, emb: boolean): void {
		const nl = this.nl;
		this.nl = false;
		this.lineStart = false;
		if (this.overflow > 0 || this.stack.length >= MAX_DEPTH) {
			this.overflow++;
			return;
		}
		this.stack.push(this.frameFor(ch, nl, emb));
	}

	private frameFor(ch: string, nl: boolean, emb: boolean): Frame {
		const frame = (kind: FrameKind, callee = ""): Frame => ({ kind, callee, args: [], cur: [] });
		if (emb) return frame("emb");
		if (ch === "{") return frame("obj");
		const top = this.top();
		const cur = top.cur;
		const prev = !this.js && nl && top.kind === "top" ? undefined : cur[cur.length - 1];
		const named = prev?.k === "word" && RESERVED[prev.text] !== true;
		if (ch === "[") return frame(named || prev?.k === "str" || prev?.k === "group" ? "sub" : "list");
		const before = cur[cur.length - 2];
		if (named) return before?.k === "word" && PARAMS_AFTER[before.text] === true ? frame("params") : frame("call", chain(cur));
		const kind = prev?.k === "group" ? prev.frame?.kind : undefined;
		return kind === "call" || kind === "sub" || kind === "paren" ? frame("call") : frame("paren");
	}

	private comma(): void {
		this.nl = false;
		this.lineStart = false;
		if (this.overflow > 0) return;
		const top = this.top();
		if (top.kind !== "top" && top.args.length < MAX_ARGS) top.args.push(top.cur);
		top.cur = [];
	}

	private close(): void {
		this.lineStart = false;
		this.nl = false;
		if (this.overflow > 0) this.overflow--;
		else if (this.stack.length > 1) this.closeTop();
	}

	private closeTop(): void {
		const frame = this.stack.pop();
		if (frame === undefined) return;
		if (frame.cur.length > 0 || frame.args.length > 0) frame.args.push(frame.cur);
		if (frame.kind === "call") this.judge(frame);
		if (frame.kind === "emb") return;
		const parent = this.top();
		if (parent.kind === "top" && parent.cur.length >= 512) {
			parent.cur.splice(0, 256);
			this.trimmed = true;
		}
		const group: Tok = { k: "group", text: frame.kind, frame };
		if (this.pending !== undefined) this.settle(group);
		if (parent.cur.length < MAX_ARG_TOKENS) parent.cur.push(group);
	}

	private argItems(tokens: Tok[], items: Item[], level = 0): void {
		let t = tokens;
		if (t.length === 0 || level > 4) return;
		if (t.length > 2 && t[0].k === "word" && t[1].k === "op" && t[1].text === "=") {
			if (!COMMAND_KEY.test(t[0].text)) return;
			t = t.slice(2);
		}
		const named = this.named(t);
		if (named !== undefined) {
			if (typeof named === "string") items.push(named);
			else items.push(...named);
			return;
		}
		const only = t.length === 1 ? t[0].frame : undefined;
		if (only?.kind === "obj") {
			for (const entry of only.args) {
				const [key, colon] = entry;
				if (colon?.k === "op" && colon.text === ":" && (key.k === "word" || key.k === "str") && COMMAND_KEY.test(key.text)) this.argItems(entry.slice(2), items, level + 1);
			}
			return;
		}
		const alts: Tok[][][] = [[[]]];
		for (const tok of t) {
			if (tok.k === "op" && tok.text === "+") alts[alts.length - 1].push([]);
			else if ((tok.k === "op" && ALT_OPS[tok.text] === true) || (tok.k === "word" && ALT_WORDS[tok.text] === true)) alts.push([[]]);
			else if ((tok.k === "op" && PLAIN_OPS[tok.text] !== true) || (tok.k === "word" && NOT_VALUE[tok.text] === true)) return;
			else {
				const alt = alts[alts.length - 1];
				alt[alt.length - 1].push(tok);
			}
		}
		const texts: string[] = [];
		let spread = false;
		for (const operands of alts) {
			const values = operands.map(parts => operand(parts));
			if (values.some(Array.isArray)) {
				spread = true;
				for (const value of values) {
					if (Array.isArray(value)) items.push(...value);
					else items.push(value);
				}
			} else if (values.some(value => value !== null)) texts.push(values.map(value => value ?? HOLE).join(""));
		}
		if (texts.length === 1 && alts.length === 1) items.push(texts[0]);
		else {
			for (const text of texts) this.command(text);
			if (texts.length > 0 || (alts.length === 1 && !spread)) items.push(null);
		}
	}

	private judge(frame: Frame): void {
		if (isDataCallee(frame.callee)) return;
		this.passes = 1;
		for (this.pick = 0; this.pick < this.passes; this.pick++) {
			if (this.pick > 0 && ++this.extra > MAX_EXTRA_PASSES) break;
			this.judgeOnce(frame);
		}
	}

	private judgeOnce(frame: Frame): void {
		const items: Item[] = [];
		for (const arg of frame.args) {
			if (items.length >= MAX_ITEMS) break;
			this.argItems(arg, items);
		}
		const at = items.findIndex(item => item !== null);
		const first = items[at];
		if (first === null || first === undefined) return;
		if (/\s/.test(first)) {
			for (const item of items.slice(at)) if (item !== null) this.command(item);
			return;
		}
		const argv = items.slice(at, at + MAX_ITEMS);
		if (argv.length === 1) this.command(first);
		else if (!dataHead(argv)) this.command(argv.map(word => (word === null ? "$_" : shWord(word))).join(" "));
	}

	private code(nest: number, field?: "py" | "js"): void {
		const src = this.src;
		let depth = 0;
		while (this.i < src.length) {
			const c = src[this.i];
			if (c === "\n") {
				this.nl = true;
				this.lineStart = true;
				this.i++;
			} else if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") this.i++;
			else if (c === "\\" && (src[this.i + 1] === "\n" || (src[this.i + 1] === "\r" && src[this.i + 2] === "\n"))) this.i += src[this.i + 1] === "\n" ? 2 : 3;
			else if (!field && c === "#" && (!this.js || this.lineStart || (src[this.i + 1] ?? " ") <= " ")) this.skipLine();
			else if (!field && c === "/" && src[this.i + 1] === "/" && (this.js || this.lineStart)) this.skipLine();
			else if (c === "/" && src[this.i + 1] === "*") {
				const end = src.indexOf("*/", this.i + 2);
				this.i = end < 0 ? src.length : end + 2;
			} else if (c === "!" && !field && !this.js && src[this.i + 1] !== "=" && (this.lineStart || this.assigned())) this.shellLine();
			else if (c === '"' || c === "'") this.string(this.i, "", nest);
			else if (c === "`") this.template(nest);
			else if (c === "$" || c === "_" || /[A-Za-z0-9]/.test(c) || c > "\u007f") this.word(nest);
			else if (c === "(" || c === "[" || c === "{") {
				depth++;
				this.i++;
				this.open(c, false);
			} else if (c === ")" || c === "]" || c === "}") {
				this.i++;
				if (depth > 0) {
					depth--;
					this.close();
				} else if (field) {
					if (c === "}") return;
				} else this.close();
			} else if (c === ",") {
				this.i++;
				this.comma();
			} else if (c === ":" && field === "py" && depth === 0) {
				this.i++;
				this.spec(nest);
				return;
			} else if (c === "/" && this.js && this.regexAllowed() && this.regex()) continue;
			else if (c === ";") {
				this.i++;
				this.add("op", ";");
			} else {
				let end = this.i + 1;
				while (OP_CHARS.includes(src[end] ?? "\0")) end++;
				this.add("op", src.slice(this.i, end));
				this.i = end;
			}
		}
	}

	private skipLine(): void {
		const end = this.src.indexOf("\n", this.i);
		this.i = end < 0 ? this.src.length : end;
	}

	private assigned(): boolean {
		const cur = this.top().cur;
		const prev = cur[cur.length - 1];
		return this.stack.length === 1 && prev?.k === "op" && prev.text === "=" && cur[cur.length - 2]?.k === "word";
	}

	private shellLine(): void {
		const src = this.src;
		let end = src.indexOf("\n", this.i);
		while (end > 0 && src[end - 1] === "\\") end = src.indexOf("\n", end + 1);
		const stop = end < 0 ? src.length : end;
		this.command(src.slice(this.i + 1, stop));
		this.i = stop;
		this.lineStart = false;
	}

	private word(nest: number): void {
		const src = this.src;
		let end = this.i + 1;
		while (end < src.length && (/[A-Za-z0-9_$]/.test(src[end]) || src[end] > "\u007f" || (src[end] === "." && /[0-9]/.test(src[this.i])))) end++;
		const word = src.slice(this.i, end);
		const quote = src[end];
		this.i = end;
		if ((quote === '"' || quote === "'") && PREFIX.test(word)) this.string(end, word, nest);
		else this.add("word", word);
	}

	private regexAllowed(): boolean {
		const prev = this.last();
		return prev === undefined || prev.k === "op" || (prev.k === "word" && REGEX_AFTER[prev.text] === true);
	}

	private regex(): boolean {
		const src = this.src;
		let inClass = false;
		for (let j = this.i + 1; j < src.length; j++) {
			const c = src[j];
			if (c === "\n") return false;
			if (c === "\\") j++;
			else if (c === "[") inClass = true;
			else if (c === "]") inClass = false;
			else if (c === "/" && !inClass) {
				let end = j + 1;
				while (end < src.length && /[a-z]/i.test(src[end])) end++;
				this.i = end;
				this.add("word", "/re/");
				return true;
			}
		}
		return false;
	}

	private string(start: number, prefix: string, nest: number): void {
		const src = this.src;
		const q = src[start];
		const triple = src.startsWith(q + q + q, start);
		const lower = prefix.toLowerCase();
		this.lineStart = false;
		this.i = start + (triple ? 3 : 1);
		this.addStr(this.body(triple ? q + q + q : q, lower.includes("r"), lower.includes("f") ? "py" : undefined, triple, nest));
	}

	private template(nest: number): void {
		const prev = this.last();
		const tag = prev?.k === "word" && RESERVED[prev.text] !== true ? chain(this.top().cur) : undefined;
		this.lineStart = false;
		this.i++;
		this.addStr(this.body("`", tag !== undefined && /(?:^|\.)raw$/.test(tag), "js", true, nest), tag);
	}

	// why(spec): since Python 3.12 an f-string replacement field may reuse the string's own quote character (https://peps.python.org/pep-0701/).
	private body(close: string, raw: boolean, field: "py" | "js" | undefined, multiline: boolean, nest: number): string {
		const src = this.src;
		let text = "";
		let from = this.i;
		while (this.i < src.length) {
			const c = src[this.i];
			if (c === "\\") {
				text += src.slice(from, this.i);
				if (raw) {
					text += c + (src[this.i + 1] ?? "");
					this.i += 2;
				} else {
					const [piece, next] = unescape(src, this.i + 1, this.js);
					text += piece;
					this.i = next;
				}
				from = this.i;
			} else if (src.startsWith(close, this.i)) {
				text += src.slice(from, this.i);
				this.i += close.length;
				return text;
			} else if (c === "\n" && !multiline) break;
			else if (field === "py" && (c === "{" || c === "}") && src[this.i + 1] === c) {
				text += src.slice(from, this.i + 1);
				this.i += 2;
				from = this.i;
			} else if (nest < MAX_NEST && ((field === "py" && c === "{") || (field === "js" && c === "$" && src[this.i + 1] === "{"))) {
				text += src.slice(from, this.i) + HOLE;
				this.i += field === "py" ? 1 : 2;
				this.field(nest + 1, field);
				from = this.i;
			} else this.i++;
		}
		return text + src.slice(from, this.i);
	}

	private field(nest: number, mode: "py" | "js"): void {
		const depth = this.stack.length + this.overflow;
		this.open("{", true);
		this.code(nest, mode);
		while (this.stack.length + this.overflow > depth) this.close();
	}

	private spec(nest: number): void {
		const src = this.src;
		while (this.i < src.length) {
			const c = src[this.i++];
			if (c === "}") return;
			if (c === "{" && nest < MAX_NEST) this.field(nest + 1, "py");
		}
	}
}

/** The external action a worker's eval cell would perform, or undefined. A string counts as a command only as a call argument (any callee but a known output or data function) or as the body of a tagged template; adjacent literal arguments and list or tuple literals among them are an argv; IPython `!` lines and `%%bash` bodies are commands. Each is judged by `externalAction`, the same check the bash tool runs, after decoding escapes, implicit concatenation and f-string fields; comments, docstrings and literals outside calls are never read. */
export function evalExternalAction(code: string, depth = 0, js = looksLikeJs(code), seen = new Map<string, string | undefined>()): string | undefined {
	for (const command of new Cell(code, js).run()) {
		const kind = externalAction(command, depth, seen);
		if (kind) return kind;
	}
	return undefined;
}

/** The external action a shell command would perform, or undefined: `scanCommand` in loose mode, with the code of interpreter one-liners read by `evalExternalAction`. Within one call each code text is read once per depth, so repeated nested one-liners cost linear time. */
export function externalAction(command: string, depth = 0, seen = new Map<string, string | undefined>()): string | undefined {
	return scanCommand(command, depth, true, (code, inner, js) => {
		const key = `${inner}\u0000${js}\u0000${code}`;
		if (!seen.has(key)) seen.set(key, evalExternalAction(code, inner, js, seen));
		return seen.get(key);
	});
}
