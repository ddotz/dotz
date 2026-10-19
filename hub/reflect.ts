// Nightly self-review. The gateway pre-digests the last 24h (owner corrections, failures, alerts, token use) so the
// model reviews a few hundred tokens of facts instead of reading logs, and skips the turn entirely on a quiet day.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushBackup, unstageSecrets } from "./backup.ts";
import { cfg, DATA_DIR, log, paths } from "./config.ts";
import { msg, withReplyLine } from "./i18n.ts";
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
		...corrections.slice(-10).map(e => `- ${short(e.text)}`),
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
const SNAPSHOT = ["RULES.md", "LESSONS.md", "identity", "features", "schedules.json", "watches.json", "channel-setups.json", "config.json", "channels.json"];
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

export const reflectPrompt = (d: string): string => withReplyLine(msg().reflect(d, paths.lessons));

export function startReflection(deliver: (text: string) => void, sessionFile: () => string): void {
	const at = String((cfg as { reflect_at?: string }).reflect_at ?? "04:40");
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
			deliver(reflectPrompt(d));
		} else log("reflection: quiet day, skipped");
		trackTimer("reflection", setTimeout(run, next()));
	};
	trackTimer("reflection", setTimeout(run, next()));
}
