// Nightly self-review. The gateway pre-digests the last 24h (owner corrections, failures, alerts, token use) so the
// model reviews a few hundred tokens of facts instead of reading logs, and skips the turn entirely on a quiet day.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushBackup, unstageSecrets } from "./backup.ts";
import { cfg, DATA_DIR, DEFAULTS, log, paths } from "./config.ts";
import { msg, withReplyLine } from "./i18n.ts";
import { LESSONS_MAX_BYTES } from "./prompt-budget.ts";
import { trackTimer } from "./shutdown.ts";
import { auditSummaryLine } from "./token-audit.ts";

const CORRECTION = /(아니|말고|하지\s*마|하지마|왜\s|다시|틀렸|잘못|그게 아니|no,|don't|stop)/i;
const DAY = 24 * 3600_000;

function jsonl(file: string, since: number): Record<string, any>[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").flatMap(l => {
		try {
			const e = JSON.parse(l);
			return Date.parse(e.ts) >= since ? [e] : [];
		} catch {
			return [];
		}
	});
}

function usage(sessionFile: string, since: number): string {
	if (!sessionFile || !existsSync(sessionFile)) return "n/a";
	let requests = 0;
	let read = 0;
	let write = 0;
	let busts = 0;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.includes('"usage"')) continue;
		try {
			const j = JSON.parse(line);
			const u = j.message?.usage;
			if (!u || Date.parse(j.timestamp) < since) continue;
			requests++;
			read += u.cacheRead ?? 0;
			write += u.cacheWrite ?? 0;
			if ((u.cacheWrite ?? 0) > 30_000 && (u.cacheRead ?? 0) < (u.cacheWrite ?? 0)) busts++;
		} catch {
			continue;
		}
	}
	return `${requests} requests, cache read ${Math.round(read / 1000)}K, cache write ${Math.round(write / 1000)}K, full rewrites >30K: ${busts}`;
}

// The owner's messages of the last 24h that read like a correction or a repeat (the digest lists them; repeatedLessons matches lessons against them).
export function ownerCorrections(now = Date.now()): string[] {
	return jsonl(paths.inbox, now - DAY).filter(e => (e.kind === "message" || e.kind === "lane_message") && CORRECTION.test(String(e.text))).map(e => String(e.text));
}

export function digest(sessionFile: string, now = Date.now()): string | undefined {
	const since = now - DAY;
	const inbox = jsonl(paths.inbox, since);
	const outbox = jsonl(paths.outbox, since);
	const owner = inbox.filter(e => e.kind === "message" || e.kind === "lane_message");
	const laneTrouble = inbox.filter(e => e.kind === "lane_report" && /^\[lane (error|exited|paused)\]/.test(String(e.text)));
	if (!owner.length && !laneTrouble.length) return undefined;
	const logLines = existsSync(paths.log) ? readFileSync(paths.log, "utf8").split("\n").filter(l => Date.parse(l.slice(0, 24)) >= since) : [];
	const count = (re: RegExp) => logLines.filter(l => re.test(l)).length;
	const short = (t: unknown, n = 160) => String(t ?? "").replace(/\s+/g, " ").slice(0, n);
	const corrections = owner.filter(e => CORRECTION.test(String(e.text)));
	const audit = auditSummaryLine(now);
	return [
		`owner messages: ${owner.length} (${[...new Set(owner.map(e => e.channel ?? e.source))].join(", ")})`,
		`possible corrections or repeats (${corrections.length}):`,
		// The message id is the source the reflection cites in memory/observations.md.
		...corrections.slice(-10).map(e => `- ${short(e.text)}${e.message_id ? ` (src: discord ${e.message_id})` : ` (src: ${e.channel ?? e.source} ${String(e.ts).slice(0, 16)})`}`),
		`lane trouble (${laneTrouble.length}):`,
		...laneTrouble.slice(-8).map(e => `- ${e.lane}: ${short(e.text)}`),
		`alerts sent (${outbox.filter(e => e.target === "alert").length}):`,
		...outbox.filter(e => e.target === "alert").slice(-6).map(e => `- ${short(e.text)}`),
		`gateway: watchdog restarts ${count(/did not start a turn/)}, memory restarts ${count(/memory guard: .*restarting it/)}, orchestrator exits ${count(/orchestrator exited/)}, rotations ${count(/rotating to a fresh/)}, keepalives ${count(/keepalive \d/)}, send failures ${count(/send failed/)}, watch failures ${count(/^\S+ watch \S+ failed/)}`,
		// With the nightly token audit on, one summary line replaces the raw usage counters so each fact is counted once.
		...(audit ? [audit] : [`orchestrator tokens: ${usage(sessionFile, since)}`, ...laneUsage(since)]),
	].join("\n");
}

// Lanes are the expensive sessions (오모냥 token-audit scans every tab, not just the secretary).
function laneUsage(since: number): string[] {
	if (!existsSync(paths.lanes)) return [];
	return readdirSync(paths.lanes).flatMap(name => {
		const file = join(paths.lanes, name, "lane.json");
		if (!existsSync(file)) return [];
		const u = usage(JSON.parse(readFileSync(file, "utf8")).sessionFile ?? "", since);
		return u === "n/a" || u.startsWith("0 requests") ? [] : [`lane ${name} tokens: ${u}`];
	});
}

// Local history of the files the bot edits itself (rules, lessons, identity, schedules), so a bad edit can be undone.
const SNAPSHOT = ["RULES.md", "LESSONS.md", "memory", "identity", "features", "schedules.json", "watches.json", "channel-setups.json", "config.json", "channels.json"];
export async function snapshot(): Promise<string | undefined> {
	const git = (...a: string[]) => Bun.$`git -C ${DATA_DIR} ${a}`.nothrow().quiet();
	if (!existsSync(join(DATA_DIR, ".git"))) {
		writeFileSync(join(DATA_DIR, ".gitignore"), ["*", ...SNAPSHOT.flatMap(f => [`!${f}`, `!${f}/**`]), "!.gitignore", ""].join("\n"));
		await git("init", "-q");
	}
	await git("add", "-A");
	// Off-machine copy is opt-in (`backup.remote` in config.json). Files that look like secrets stay out of the commit then.
	const remote = String((cfg as { backup?: { remote?: string } }).backup?.remote ?? "").trim();
	const flagged = remote ? await unstageSecrets(DATA_DIR) : [];
	const r = await git("-c", "user.name=dotz", "-c", "user.email=dotz@localhost", "commit", "-q", "-m", `snapshot ${new Date().toISOString().slice(0, 10)}`);
	log(`snapshot: ${r.exitCode === 0 ? "committed" : "no changes"}`);
	return remote ? pushBackup(DATA_DIR, remote, flagged) : undefined;
}

// Code picks removal/merge candidates in LESSONS.md, the model decides (stale >90 days, near-duplicates by token overlap).
const STALE_DAYS = 90;
const DUPLICATE_SIMILARITY = 0.6;
// A lesson line is dated [YYYY-MM-DD] or, as the nightly turn writes it, [MM-DD]: a year-less date is this year's, or last year's when that
// would lie in the future.
const LESSON_LINE = /^- \[(?:(\d{4})-)?(\d{2})-(\d{2})\]\s*(.*)$/;
const lessonYear = (y: string | undefined, mo: number, d: number, now: number): number => {
	if (y) return Number(y);
	const year = new Date(now).getUTCFullYear();
	return Date.UTC(year, mo - 1, d) > now + DAY ? year - 1 : year;
};
// A lesson carried by structure names its enforcer: "(enforced: <guard, test, lint or check>)". pstack's correct / encode-lessons-in-structure:
// a rule that keeps recurring is fixed where it cannot happen again, and the line says where.
const ENFORCED = /\(enforced:\s*[^)]+\)/i;
// Same tokens as OMH's duplicate check (lowercase alphanumeric/hangul runs of 2+); the date prefix is dropped so shared dates never count as overlap.
const tokens = (text: string): Set<string> => new Set(text.toLowerCase().match(/[0-9a-z가-힣]{2,}/g) ?? []);

export function lessonCandidates(text: string, now: number): { stale: string[]; duplicates: { a: string; b: string; score: number }[] } {
	const stale: string[] = [];
	const dated: { line: string; tokens: Set<string> }[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const m = LESSON_LINE.exec(line);
		if (!m) continue;
		const [mo, d] = [Number(m[2]), Number(m[3])], y = lessonYear(m[1], mo, d, now);
		const at = Date.UTC(y, mo - 1, d);
		const back = new Date(at);
		if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) continue;
		if (now - at > STALE_DAYS * DAY) stale.push(line);
		dated.push({ line, tokens: tokens(m[4].replace(BROKEN, "").replace(ENFORCED, "")) });   // the trailers' dates and names are not the lesson
	}
	const duplicates: { a: string; b: string; score: number }[] = [];
	for (let i = 0; i < dated.length; i++) {
		for (let j = i + 1; j < dated.length; j++) {
			const [x, y] = [dated[i].tokens, dated[j].tokens];
			let shared = 0;
			for (const t of x) if (y.has(t)) shared++;
			const union = x.size + y.size - shared;
			const score = union ? shared / union : 0;
			if (score >= DUPLICATE_SIMILARITY) duplicates.push({ a: dated[i].line, b: dated[j].line, score: Math.round(score * 100) / 100 });
		}
	}
	return { stale, duplicates };
}

// Matching a lesson to today's corrections (pstack's correct: a rule broken again gets a structural fix). Words alone miss the same mistake said
// another way and catch a correction that only shares common words, so code does the cheap part and the nightly turn judges by meaning:
// - words are compared without Korean particles/endings and without common words, and a Hangul word also matches one sharing most of its
//   letter pairs ("체크아웃을" ~ "체크아웃했어"), so a lesson scores how much of it a correction repeats (likely = 0.4 or more, 2+ words);
// - every lesson with no enforcer is handed over when there were corrections, the likely ones first with their score, for the turn to decide;
// - a lesson the turn finds broken gets the date in "(broken: MM-DD, ...)", so a repeat across nights is counted, not re-guessed.
const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "is", "are", "be", "it", "its", "this", "that", "with", "for", "on", "in", "at", "as", "by", "from", "before", "after", "never", "not", "no", "do", "does", "did", "when", "once", "only", "each", "every", "his", "him", "he", "you", "your", "그", "이", "저", "것", "수", "좀", "또", "다시", "그냥", "이거", "그거", "저거", "왜", "뭐", "지금", "이번", "있는", "없는", "하는", "한", "할", "해", "하고", "했어", "했어요", "해요", "합니다", "하세요", "말고"]);
const PARTICLE = /(?:에서는|에게서|으로는|으로|에서|에게|까지|부터|처럼|보다|하고|이랑|랑|은|는|이|가|을|를|에|의|와|과|도|만|로|요|죠|네)$/;
const ENDING = /(?:했었어요|했었어|했어요|했어|했다|했음|하세요|하지마|하지|해서|해요|해야|하는|하고|하면|되면|됐어|된|하기|함|해|한|할)$/;
const HANGUL = /^[가-힣]+$/;
function stem(w: string): string {
	if (!HANGUL.test(w)) return w;
	for (let i = 0; i < 3; i++) {
		const next = w.replace(ENDING, "").replace(PARTICLE, "");
		if (next === w || next.length < 2) break;
		w = next;
	}
	return w;
}
/** The words of a text that carry meaning: lowercased, particles and endings stripped, common words dropped. */
export const meaningWords = (text: string): string[] => [...new Set((text.toLowerCase().match(/[0-9a-z가-힣]{2,}/g) ?? []).map(stem).filter(w => w.length >= 2 && !STOP.has(w)))];
const pairs = (w: string): Set<string> => new Set([...w].slice(1).map((c, i) => w[i] + c));
// Two words are the same word: equal, or both Hangul and one keeps at least two thirds of the other's letter pairs.
function sameWord(a: string, b: string): boolean {
	if (a === b) return true;
	if (!HANGUL.test(a) || !HANGUL.test(b) || a.length < 2 || b.length < 2) return false;
	const [x, y] = [pairs(a), pairs(b)], small = x.size <= y.size ? x : y, big = small === x ? y : x;
	let hit = 0;
	for (const p of small) if (big.has(p)) hit++;
	return small.size > 0 && hit / small.size >= 2 / 3;
}
const LIKELY = 0.4;
/** How much of a lesson one correction repeats: the share of its meaning words found there (0 when fewer than two match). */
export function lessonScore(lesson: string, correction: string): number {
	const own = meaningWords(lesson), said = meaningWords(correction);
	if (!own.length) return 0;
	const hit = own.filter(w => said.some(s => sameWord(w, s))).length;
	return hit >= 2 ? Math.round((hit / own.length) * 100) / 100 : 0;
}
const BROKEN = /\(broken:\s*([^)]*)\)/i;
export type LessonCheck = { line: string; score: number; broken: number };
/** Every lesson with no enforcer, with its best score against today's corrections and how many nights it was found broken; repeats first,
 *  then the likely ones by score. */
export function lessonChecks(text: string, corrections: readonly string[]): LessonCheck[] {
	const out: LessonCheck[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const m = LESSON_LINE.exec(line);
		if (!m || ENFORCED.test(line)) continue;
		const words = m[4].replace(BROKEN, "");
		const score = Math.max(0, ...corrections.map(c => lessonScore(words, c)));
		const broken = (BROKEN.exec(line)?.[1] ?? "").split(",").map(s => s.trim()).filter(Boolean).length;
		out.push({ line, score, broken });
	}
	return out.sort((a, b) => b.broken - a.broken || b.score - a.score);
}
/** The lessons today's corrections most likely broke again (score 0.4 or more). */
export const repeatedLessons = (text: string, corrections: readonly string[]): string[] => lessonChecks(text, corrections).filter(c => c.score >= LIKELY).map(c => c.line);

const localMd = (now: number): string => { const d = new Date(now); return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function candidateBlock(now: number, corrections: readonly string[] = []): string {
	const stale = existsSync(paths.observations) ? lessonCandidates(readFileSync(paths.observations, "utf8"), now).stale : [];
	// With corrections today, every unenforced lesson goes to the turn (LESSONS.md is capped, so this stays small); a lesson already broken on
	// two nights is listed even on a quiet day of matches, since it is a repeat by count, not by words.
	const checks = existsSync(paths.lessons) ? lessonChecks(readFileSync(paths.lessons, "utf8"), corrections) : [];
	const shown = corrections.length ? checks : checks.filter(c => c.broken >= 2);
	return lessonBlock(now) + (shown.length ? msg().lessonRepeats(shown.map(c => ({ ...c, likely: c.score >= LIKELY })), localMd(now)) : "") + (stale.length ? msg().staleObservations(stale) : "");
}

function lessonBlock(now: number): string {
	if (!existsSync(paths.lessons)) return "";
	const text = readFileSync(paths.lessons, "utf8");
	const { stale, duplicates } = lessonCandidates(text, now);
	const bytes = Buffer.byteLength(text);
	const over = bytes > LESSONS_MAX_BYTES ? `${bytes} bytes > cap ${LESSONS_MAX_BYTES} (hub/prompt-budget.ts)` : "";
	if (!stale.length && !duplicates.length && !over) return "";
	return msg().lessonCandidates(stale, duplicates.map(d => `${d.a}\n  ~ ${d.b} (${d.score})`), over);
}

export const reflectPrompt = (d: string, now = Date.now(), corrections: readonly string[] = []): string => withReplyLine(msg().reflect(d, paths.lessons) + candidateBlock(now, corrections));

if (import.meta.main && process.argv[2] === "--candidates" && process.argv[3]) {
	console.log(JSON.stringify(lessonCandidates(readFileSync(process.argv[3], "utf8"), Date.now()), null, 2));
}

export function startReflection(deliver: (text: string) => void, sessionFile: () => string): void {
	const at = String((cfg as { reflect_at?: string }).reflect_at ?? DEFAULTS.reflect_at);
	if (at === "off") return;
	const [h, m] = at.split(":").map(Number);
	const next = () => {
		const d = new Date();
		d.setHours(h, m, 0, 0);
		if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
		return d.getTime() - Date.now();
	};
	const run = async () => {
		const alert = await snapshot().catch(e => (log(`snapshot failed: ${e}`), undefined));
		if (alert) deliver(`${alert}\n(위 내용을 오너에게 짧게 알려줘.)`);
		const d = digest(sessionFile());
		if (d) {
			log("reflection: delivering nightly self-review");
			deliver(reflectPrompt(d, Date.now(), ownerCorrections()));
		} else log("reflection: quiet day, skipped");
		trackTimer("reflection", setTimeout(run, next()));
	};
	trackTimer("reflection", setTimeout(run, next()));
}
