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
		dated.push({ line, tokens: tokens(m[4]) });
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

// Lessons that today's corrections hit again while nothing enforces them: at least half of the lesson's words (3 or more) appear in one
// correction. Each is a repeat the nightly turn must fix at the highest level that works (structure, type, guard, test, check), not reword.
export function repeatedLessons(text: string, corrections: readonly string[]): string[] {
	const said = corrections.map(tokens);
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const m = LESSON_LINE.exec(line);
		if (!m || ENFORCED.test(line)) continue;
		const own = tokens(m[4]);
		if (own.size < 3) continue;
		if (said.some(s => { let hit = 0; for (const w of own) if (s.has(w)) hit++; return hit / own.size >= 0.5; })) out.push(line);
	}
	return out;
}

function candidateBlock(now: number, corrections: readonly string[] = []): string {
	const stale = existsSync(paths.observations) ? lessonCandidates(readFileSync(paths.observations, "utf8"), now).stale : [];
	const repeats = existsSync(paths.lessons) && corrections.length ? repeatedLessons(readFileSync(paths.lessons, "utf8"), corrections) : [];
	return lessonBlock(now) + (repeats.length ? msg().lessonRepeats(repeats) : "") + (stale.length ? msg().staleObservations(stale) : "");
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
