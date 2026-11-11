// The day note: every night a small model writes one short memory file of the day to <data dir>/memory/days/YYYY-MM-DD.md.
// No prompt loads the file (one index line at most, see day-note-format.ts); the recall index reads its sections, so a search finds it.
// Off by default (config.json day_note.enabled). The model is not pinned: it follows OmO's own `quick` fallback chain (resolveQuick).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionDirs } from "./cleanup.ts";
import { cfg, DATA_DIR, DEFAULTS, log, workerModel, writeAtomic } from "./config.ts";
import { daysDir, headingKey, kstDay, lineSrcs, LESSONS_MAX_LINES, LINE_MAX_CHARS, NOTE_MAX_CHARS, noteFile, type Note, OPEN_MAX_LINES, readNote, SECTION_KEYS, type Section, type SectionKey } from "./day-note-format.ts";
import { lang, msg } from "./i18n.ts";
import { maskSecrets, secretFileValues } from "./public-scrub.ts";
import { extractPairs, type Pair, sessionHeader } from "./recall-extract.ts";
import { readLines } from "./recall-index.ts";
import { renderState } from "./recall-parts.ts";
import { OMO } from "./runtime/omo-hosts.ts";
import { trackTimer } from "./shutdown.ts";

export const WINDOW_MAX_MS = 72 * 3_600_000;
export const PAIRS_MAX_CHARS = 30_000;
export const COMPACTION_MAX_CHARS = 40_000;
export const STATE_MAX_CHARS = 2500;
const PAIR_OWNER_CAP = 500;
const PAIR_ANSWER_CAP = 400;
const CALL_TIMEOUT_MS = 60_000;
const BACKOFF_FIRST_MS = 30_000;
// The run is at 04:36 and the nightly review at 04:40: the retries of a failed call end before the review starts.
export const RETRY_WINDOW_MS = 4 * 60_000;

/** The window a note covers: from the end of the previous note (else 24 h back), at most 72 h; the day is the date of its start in the owner's time zone. */
export function noteWindow(now: number, previousEnd?: number): { start: number; end: number; day: string } {
	const from = previousEnd !== undefined && previousEnd < now ? previousEnd : now - 24 * 3_600_000;
	const start = Math.max(from, now - WINDOW_MAX_MS);
	return { start, end: now, day: kstDay(start) };
}

// ---- input --------------------------------------------------------------------------------------------------------

export type Known = { msgs: Set<string>; sessions: Set<string>; tasks: Set<string>; stamps: Set<string>; srcs: Set<string>; text: string };
export type Collected = { text: string; known: Known; pairs: number; summary: boolean };

const MARK = Buffer.from('{"type":"compaction"');

function compactions(file: string): { at: number; text: string }[] {
	const out: { at: number; text: string }[] = [];
	try {
		const buf = readFileSync(file);
		for (let at = buf.lastIndexOf(MARK); at >= 0; at = at > 0 ? buf.lastIndexOf(MARK, at - 1) : -1) {
			if (at > 0 && buf[at - 1] !== 0x0a) continue;
			const end = buf.indexOf(0x0a, at);
			try {
				const e: { summary?: unknown; timestamp?: unknown } = JSON.parse(buf.toString("utf8", at, end < 0 ? buf.length : end));
				const t = Date.parse(String(e.timestamp ?? ""));
				if (typeof e.summary === "string" && e.summary.trim() && Number.isFinite(t)) out.push({ at: t, text: e.summary.trim() });
			} catch {}
		}
	} catch {}
	return out;
}

function firstLine(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(8192);
		return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0)).split("\n")[0] ?? "";
	} finally {
		closeSync(fd);
	}
}

function openTasks(stateFile: string): { text: string; ids: string[] } {
	try {
		const raw = readFileSync(stateFile, "utf8");
		const tasks = (JSON.parse(raw) as { open_tasks?: unknown }).open_tasks;
		const ids = Array.isArray(tasks) ? tasks.map(t => (t as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string") : [];
		return { text: renderState(raw, stateFile, STATE_MAX_CHARS), ids };
	} catch {
		return { text: "", ids: [] };
	}
}

const block = (p: Pair): string => {
	const refs = [...p.msgIds.map(id => `${p.room} ${id}`), `session ${p.session.slice(0, 8)}#L${p.line}`];
	return `[${refs.join(" ; ")}] ${p.ts.slice(0, 16)}\nOWNER: ${p.owner}\nANSWER: ${p.answer}`;
};

/** Everything the writer may use, as one text, and the ids a line may cite. Only the main session's files are read. */
export function collectInput(o: { files: readonly string[]; start: number; end: number; stateFile: string; previous?: Note; secrets: readonly string[] }): Collected {
	const pairs: Pair[] = [];
	let summary: { at: number; text: string } | undefined;
	for (const file of o.files) {
		for (const c of compactions(file)) if (c.at >= o.start && c.at < o.end && (!summary || c.at > summary.at)) summary = c;
		const header = sessionHeader(firstLine(file));
		if (!header) continue;
		const ctx = { file, cwd: header.cwd, session: header.session, title: "", convKey: "", afterBrief: false, ownerCap: PAIR_OWNER_CAP, answerCap: PAIR_ANSWER_CAP };
		for (const p of extractPairs(readLines(file, 0, 1, { end: 0, line: 1 }), ctx)) {
			const t = Date.parse(p.ts);
			if (t >= o.start && t < o.end) pairs.push(p);
		}
	}
	pairs.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
	// The newest exchanges fill the budget: the compaction summary holds the older part of the day.
	const kept: Pair[] = [];
	let used = 0;
	for (const p of pairs.toReversed()) {
		used += block(p).length + 2;
		if (used > PAIRS_MAX_CHARS) break;
		kept.unshift(p);
	}
	const state = openTasks(o.stateFile);
	const openLines = o.previous?.sections.find(s => s.key === "open")?.lines.slice(0, OPEN_MAX_LINES) ?? [];
	const parts: string[] = [];
	if (openLines.length) parts.push(`Open items of the previous note:\n${openLines.join("\n")}`);
	if (state.text) parts.push(`Open tasks (state.json):\n${state.text}`);
	if (summary) parts.push(`Newest compaction summary (${new Date(summary.at).toISOString()}):\n${summary.text.slice(0, COMPACTION_MAX_CHARS)}`);
	if (kept.length) parts.push(`Exchanges of the day, oldest first:\n${kept.map(block).join("\n\n")}`);
	const text = maskSecrets(parts.join("\n\n"), o.secrets).text;
	const known: Known = { msgs: new Set(), sessions: new Set(), tasks: new Set(state.ids), stamps: new Set(), srcs: new Set(openLines.flatMap(lineSrcs)), text };
	for (const p of kept) {
		for (const id of p.msgIds) known.msgs.add(id);
		known.sessions.add(`${p.session.slice(0, 8)}#L${p.line}`);
		known.stamps.add(p.ts.slice(0, 16));
	}
	return { text, known, pairs: kept.length, summary: summary !== undefined };
}

// ---- output -------------------------------------------------------------------------------------------------------

type SrcKind = "msg" | "session" | "task" | "commit" | "stamp";

function srcKind(src: string, k: Known): SrcKind | undefined {
	if (k.srcs.has(src)) return /^session /.test(src) ? "session" : /^task /.test(src) ? "task" : /^commit /.test(src) ? "commit" : "msg";
	const [word, rest = "", extra] = src.split(/\s+/);
	if (!word || !rest || extra !== undefined) return undefined;
	if (word === "session") return k.sessions.has(rest) ? "session" : undefined;
	if (word === "task") return k.tasks.has(rest) || k.text.includes(`task ${rest}`) ? "task" : undefined;
	if (word === "commit") return /^[0-9a-f]{7,40}$/.test(rest) && k.text.toLowerCase().includes(rest) ? "commit" : undefined;
	if (k.msgs.has(rest) || (rest.length >= 6 && k.text.includes(rest))) return "msg";
	return /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(rest) && k.stamps.has(rest) ? "stamp" : undefined;
}

const QUOTE = /["“「]([^"”」]*)["”」]/g;

function lineOk(line: string, key: SectionKey, k: Known): boolean {
	const m = /^- (.+?) \(src: ([^)]+)\)$/.exec(line);
	if (!m || m[1]!.length > LINE_MAX_CHARS) return false;
	const kinds = lineSrcs(line).map(s => srcKind(s, k));
	if (!kinds.length || kinds.some(x => x === undefined)) return false;
	if (key !== "decided") return true;
	// The owner's words come with their message id and stay short.
	return kinds.includes("msg") && [...m[1]!.matchAll(QUOTE)].every(q => q[1]!.length <= 80);
}

/** The model's reply cut down to the lines that may stay: a section is found by its heading or, for a heading the writer made up, by its place. */
export function validate(reply: string, known: Known): { sections: Section[]; dropped: number; description: string } {
	const by = new Map<SectionKey, string[]>();
	let current: SectionKey | undefined;
	let said: string | undefined;
	let seen = 0;
	let dropped = 0;
	for (const raw of reply.split("\n")) {
		const line = raw.trim();
		if (said === undefined && /^description:/i.test(line)) {
			said = line.replace(/^description:\s*/i, "");
		} else if (line.startsWith("#")) {
			current = headingKey(line) ?? SECTION_KEYS[seen];
			seen++;
		} else if (line.startsWith("- ")) {
			const lines = current ? (by.get(current) ?? by.set(current, []).get(current)!) : undefined;
			if (current && lines && lineOk(line, current, known) && !lines.includes(line)) lines.push(line);
			else dropped++;
		}
	}
	const sections = SECTION_KEYS.flatMap(key => {
		const cap = key === "open" ? OPEN_MAX_LINES : key === "lessons" ? LESSONS_MAX_LINES : Infinity;
		const lines = (by.get(key) ?? []).slice(0, cap);
		return lines.length ? [{ key, lines }] : [];
	});
	return { sections, dropped, description: dayDescription(said, sections) };
}

const plain = (s: string): string => s.replace(/\s+/g, " ").trim();
const bare = (line: string): string => line.replace(/^- /, "").replace(/\s*\(src: [^)]*\)$/, "");

/** The description of the day: the writer's sentence, unless it is empty or repeats a note line word for word; then the counts per section, built from the note. */
export function dayDescription(said: string | undefined, sections: readonly Section[]): string {
	const own = plain(said ?? "");
	const copy = sections.some(s => s.lines.some(l => plain(bare(l)).toLowerCase() === own.toLowerCase() || plain(l).toLowerCase() === own.toLowerCase()));
	if (own && !copy) return own;
	return sections.filter(s => s.lines.length).map(s => `${msg().dayNote.headings[s.key]} ${s.lines.length}`).join(", ");
}

export type NoteMeta = { day: string; start: number; end: number; writer: string; description?: string };

/** The file text: front matter and the sections in design order. Over NOTE_MAX_CHARS whole lines go, from the last section upward. "" when no line is left. */
export function buildNote(meta: NoteMeta, sections: readonly Section[]): string {
	const keep = sections.map(s => ({ key: s.key, lines: [...s.lines] }));
	const render = (): string => {
		const head = ["---", `description: ${msg().dayNote.description(meta.day, meta.description?.trim() || dayDescription(undefined, keep)).replace(/\s+/g, " ").slice(0, 160)}`, `day: ${meta.day}`, `window: ${new Date(meta.start).toISOString()}/${new Date(meta.end).toISOString()}`, `writer: ${meta.writer}`, "---"];
		const body = keep.filter(s => s.lines.length).map(s => `\n## ${msg().dayNote.headings[s.key]}\n${s.lines.join("\n")}`);
		return `${head.join("\n")}\n${body.join("\n")}\n`;
	};
	let text = render();
	while (text.length > NOTE_MAX_CHARS) {
		const last = keep.findLast(s => s.lines.length);
		if (!last) return "";
		last.lines.pop();
		text = render();
	}
	return keep.some(s => s.lines.length) ? text : "";
}

export const systemPrompt = (language: string): string =>
	[
		"You write one day note: a short memory file of one day of work between an owner and an AI assistant. A reader finds it later by search, so every line must stand alone, with the names and ids needed to understand it.",
		"Use only the input and do not guess. Output a first line `description: <ONE sentence about the day as a whole, in your own words; never a copy of a line below>`, then only sections, each starting with a line `## <key>`; the keys are: open, done, decided, know, lessons.",
		"open: requests and tasks still unfinished, at most 8; keep the open items of the previous note that are still open. done: what was finished. decided: what the owner decided or corrected; quote the owner's own words in at most 80 characters. know: facts the next day needs. lessons: at most 3 candidates for a rule to learn.",
		`Every line is \`- \`, then ONE sentence of at most ${LINE_MAX_CHARS} characters, then \` (src: <ref>)\`. A ref is copied from a bracket in the input: \`<room> <message id>\`, \`session <id8>#L<line>\`, \`task <id>\` or \`commit <sha>\`. A line without a ref copied from the input is dropped. Leave out a section that has no line. No other text.`,
		`Write the sentences in ${language}.`,
	].join("\n");

// ---- the model ----------------------------------------------------------------------------------------------------

export interface ResolveDeps {
	exec(argv: string[]): Promise<{ code: number; out: string }>;
	bundle(): string | undefined;
}
export type Resolution = { selector: string } | { reason: string };

const familyId = (bundle: string, key: string): string | undefined => new RegExp(`[{,]${key}:"([^"]+)"`).exec(bundle)?.[1];

/** The effort OmO's built-in `quick` chain gives to a model id; undefined when the chain cannot be read or does not list the id. */
export function chainVariant(bundle: string, id: string): { variant?: string } | undefined {
	const start = bundle.indexOf("quick:[{providers");
	if (start < 0) return undefined;
	const entry = /\{providers:\[[^\]]*\],model:("[^"]+"|[\w$]+\.\w+)(?:,variant:"([^"]*)")?\}/y;
	let pos = bundle.indexOf("[", start) + 1;
	for (;;) {
		entry.lastIndex = pos;
		const m = entry.exec(bundle);
		if (!m) return undefined;
		const model = m[1]!.startsWith('"') ? m[1]!.slice(1, -1) : familyId(bundle, m[1]!.split(".")[1]!);
		if (model === id) return m[2] === undefined ? {} : { variant: m[2] };
		pos = entry.lastIndex;
		if (bundle[pos] !== ",") return undefined;
		pos++;
	}
}

/**
 * OmO's own `quick` model as OmO resolves it here: `omo doctor --models --json` (no model call) lists the chain with each rung's login state; the
 * rungs from omo.json are the owner's override and are skipped, so the first built-in rung with a login wins. The effort the doctor does not print is
 * read from the chain in OmO's shipped bundle. Anything unreadable gives a reason, never a guess.
 */
export async function resolveQuick(d: ResolveDeps): Promise<Resolution> {
	let doc: { categories?: { name?: string; rungs?: { model?: unknown; source?: unknown; state?: unknown; providers?: unknown }[] }[] };
	try {
		const r = await d.exec([OMO, "doctor", "--models", "--json"]);
		if (r.code !== 0) return { reason: `omo doctor exited ${r.code}` };
		doc = JSON.parse(r.out);
	} catch (e) {
		return { reason: `omo doctor failed: ${(e as Error).message}` };
	}
	const rung = doc.categories?.find(c => c?.name === "quick")?.rungs?.find(r => r?.source === "built-in" && r.state !== "no-login" && r.state !== "excluded" && typeof r.model === "string");
	if (!rung) return { reason: "no usable built-in rung in the quick chain" };
	const model = rung.model as string;
	const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : Array.isArray(rung.providers) ? String(rung.providers[0] ?? "") : "";
	const id = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
	if (!provider) return { reason: `no provider for ${id}` };
	const bundle = d.bundle();
	const chain = bundle === undefined ? undefined : chainVariant(bundle, id);
	if (!chain) return { reason: `the effort of ${id} is not readable in OmO's chain` };
	return { selector: `${provider}/${id}${chain.variant ? `:${chain.variant}` : ""}` };
}

function omoBundle(): string | undefined {
	try {
		const bin = Bun.which(OMO);
		if (!bin) return undefined;
		let dir = dirname(realpathSync(bin));
		for (let i = 0; i < 5; i++, dir = dirname(dir)) {
			const file = join(dir, "plugin", "runtime", "category-coverage", "index.js");
			if (existsSync(file)) return readFileSync(file, "utf8");
		}
	} catch {}
	return undefined;
}

async function execOmo(argv: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(argv, { cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 20_000 });
	const out = await new Response(proc.stdout as ReadableStream).text();
	return { code: await proc.exited, out };
}

// ---- one run ------------------------------------------------------------------------------------------------------

export interface RunDeps {
	now(): number;
	on(): boolean;
	/** day_note.model: a selector, or "" to follow OmO's quick chain. */
	pinned(): string;
	fallback(): string;
	dir: string;
	stateFile: string;
	files(since: number): string[];
	secrets(): string[];
	resolve(): Promise<Resolution>;
	call(system: string, text: string, o: { model: string; timeoutMs: number }): Promise<{ text: string; inputTokens: number; outputTokens: number; ms: number }>;
	language(): string;
	log(line: string): void;
}
export type Attempt =
	| { kind: "written"; day: string; chars: number; inTokens: number; outTokens: number; ms: number; model: string }
	| { kind: "skipped"; reason: string }
	| { kind: "retry"; reason: string };

export function latestNote(dir: string): Note | undefined {
	if (!existsSync(dir)) return undefined;
	for (const f of readdirSync(dir).filter(n => /^\d{4}-\d\d-\d\d\.md$/.test(n)).sort().reverse()) {
		const n = readNote(join(dir, f));
		if (n) return n;
	}
	return undefined;
}

type Chosen = { model: string; label: string };

async function choose(d: RunDeps): Promise<Chosen> {
	const pinned = d.pinned().trim();
	if (pinned) return { model: pinned, label: `${pinned} (day_note.model)` };
	const r = await d.resolve();
	if ("selector" in r) return { model: r.selector, label: `${r.selector} (OmO quick)` };
	return { model: d.fallback(), label: `${d.fallback()} (OmO quick not resolved: ${r.reason}; worker model)` };
}

export async function attempt(d: RunDeps, model: () => Promise<Chosen>): Promise<Attempt> {
	if (!d.on()) return { kind: "skipped", reason: "off" };
	const now = d.now();
	const previous = latestNote(d.dir);
	const w = noteWindow(now, previous?.windowEnd);
	const file = noteFile(w.day, d.dir);
	if (existsSync(file)) return { kind: "skipped", reason: `${w.day}: note exists` };
	const input = collectInput({ files: d.files(w.start), start: w.start, end: w.end, stateFile: d.stateFile, previous, secrets: d.secrets() });
	if (!input.pairs && !input.summary) return { kind: "skipped", reason: `${w.day}: no input` };
	const chosen = await model();
	let reply: Awaited<ReturnType<RunDeps["call"]>>;
	try {
		reply = await d.call(systemPrompt(d.language()), input.text, { model: chosen.model, timeoutMs: CALL_TIMEOUT_MS });
	} catch (e) {
		return { kind: "retry", reason: (e as Error).message };
	}
	const { sections, description } = validate(reply.text, input.known);
	const secrets = d.secrets();
	const masked = sections.map(s => ({ key: s.key, lines: s.lines.map(l => maskSecrets(l, secrets).text) }));
	const text = buildNote({ day: w.day, start: w.start, end: w.end, writer: chosen.label, description: maskSecrets(description, secrets).text }, masked);
	if (!text) return { kind: "skipped", reason: `${w.day}: no valid line in the reply` };
	if (existsSync(file)) return { kind: "skipped", reason: `${w.day}: note exists` };
	mkdirSync(d.dir, { recursive: true });
	writeAtomic(file, text);
	return { kind: "written", day: w.day, chars: text.length, inTokens: reply.inputTokens, outTokens: reply.outputTokens, ms: reply.ms, model: chosen.label };
}

/** One run: the model is chosen once, a failed call is retried with a doubling wait while the wait and the next call (at most CALL_TIMEOUT_MS) still end before `deadline`, and one log line says what came of it. */
export async function runDayNote(d: RunDeps, sleep: (ms: number) => Promise<void>, deadline: number): Promise<Attempt> {
	let chosen: Promise<Chosen> | undefined;
	const model = () => (chosen ??= choose(d));
	for (let n = 0; ; n++) {
		const a = await attempt(d, model);
		if (a.kind === "retry") {
			const wait = BACKOFF_FIRST_MS * 2 ** n;
			if (d.now() + wait + CALL_TIMEOUT_MS < deadline) {
				await sleep(wait);
				continue;
			}
			const failed: Attempt = { kind: "skipped", reason: `model call failed after ${n + 1} tries: ${a.reason}` };
			d.log(`day note: skipped (${failed.reason})`);
			return failed;
		}
		if (a.kind === "written") d.log(`day note ${a.day}: written ${a.chars} chars, ${a.inTokens} in/${a.outTokens} out tokens, ${a.ms}ms, model ${a.model}`);
		else if (a.reason !== "off") d.log(`day note: skipped (${a.reason})`);
		return a;
	}
}

/** The main session's files that were written since `since`: the 04:30 rotation puts the day in the old file, so every file in the window is read. */
export function mainSessionFiles(since: number, roots: readonly string[] = sessionDirs(), dataDir = DATA_DIR): string[] {
	const folder = `--${dataDir.replace(/^\/+/, "").replace(/[\\/:]/g, "-")}--`;
	return roots.flatMap(root => {
		const dir = join(root, folder);
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => join(dir, f)).filter(f => statSync(f).mtimeMs >= since);
	});
}

const conf = () => (cfg as { day_note?: { enabled?: boolean; at?: string; model?: string } }).day_note ?? {};

const realDeps = (): RunDeps => ({
	now: () => Date.now(),
	on: () => conf().enabled === true,
	pinned: () => conf().model ?? "",
	fallback: workerModel,
	dir: daysDir(),
	stateFile: join(DATA_DIR, "state.json"),
	files: mainSessionFiles,
	secrets: () => secretFileValues(DATA_DIR),
	resolve: () => resolveQuick({ exec: execOmo, bundle: omoBundle }),
	call: async (system, text, o) => (await import("./outlang.ts")).callModel(system, text, o),
	language: lang,
	log,
});

/** Arms the nightly timer (day_note.at, default 04:36, "off" = none). Whether it writes is read at each run, so the switch needs no restart. */
export function startDayNote(): void {
	const at = String(conf().at ?? DEFAULTS.day_note_at);
	if (at === "off") return;
	const [h, m] = at.split(":").map(Number);
	const next = () => {
		const t = new Date();
		t.setHours(h!, m!, 0, 0);
		if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
		return t.getTime() - Date.now();
	};
	const sleep = (ms: number) => new Promise<void>(r => trackTimer("day-note-retry", setTimeout(r, ms)));
	const run = async () => {
		try {
			await runDayNote(realDeps(), sleep, Date.now() + RETRY_WINDOW_MS);
		} catch (e) {
			log(`day note: skipped (${(e as Error).message})`);
		}
		trackTimer("day-note", setTimeout(run, next()));
	};
	trackTimer("day-note", setTimeout(run, next()));
}
