// Repeated work and failed attempts over the last N days, measured from the session logs and hub.log with no model call. Ported from the
// one-off analysis scripts (sessions.py, wakes.py, ended.py) so a recurring dotz project can run it, wake a model only when a class grew,
// and then work on the biggest one. The gateway's only scheduled user is the nightly doctor (hub/doctor.ts), which keeps the baseline in its own store.
// usage: bun hub/failure-report.ts [--days 7] [--json] [--md <path>] [--check --state <file> [--grow-pct 25] [--min-tokens 1000000] [--min-count 10]]
//   no flag      prints the Korean table
//   --json       prints the full result
//   --md <path>  writes the Korean table to <path>
//   --check      watch mode: compares with the baseline in --state (first run, missing, corrupt or old-format file: baseline only, prints nothing),
//                prints one line per class whose SHARE grew past the threshold, biggest first, then replaces the baseline. Exit code stays 0 either way.
//                A busy day moves every absolute number, so the decision is by share: tokens / all tokens of the window, and for the classes that
//                carry no tokens (hub.log counters, model errors, whose failed turn is charged 0) count / assistant turns of the window. The floors
//                --min-tokens / --min-count apply to what the class cost beyond its old share, so they stay noise floors.
// A class' tokens are what its turns cost: a failed tool call is charged the tokens of the turn that issued it (split over that turn's calls),
// a cut worker its whole session (a worker that reached a normal stop and only failed on a later wake is finished; just the turns after that stop are the
// error class), a no-op wake the one turn it ran. Classes overlap (a cut worker also holds tool errors), so never add them up.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, HOME, writeAtomic } from "./config.ts";
import { collectSessions, type Src } from "./session-sources.ts";

type Json = Record<string, any>; // session lines are external jsonl; fields are read defensively
export type Row = { name: string; count: number; tokens: number; share: number; chars?: number; noop?: number; lost?: number; top?: string; sample?: string };
type Entry = { count: number; tokens: number; chars: number; noop: number; lost: number; sample: string; tools: Map<string, number> };
type Tally = Map<string, Entry>;
export type Report = {
	generatedAt: string; days: number; since: string; files: { total: number; workers: number; skipped: number; emptyWorkers: number };
	tokens: number; turns: number; roles: Row[]; workers: Row[]; toolErrors: Row[]; repeats: Row[]; errorTurns: Row[]; toolOutput: Row[]; wakes: Row[]; hubLog: Row[]; lost: Row[];
	run: { ms: number; peakRssMb: number };
};

const DAY = 86400e3;
const FRESH_WORKER = "끝냄", CAP = "토큰 상한", ERR_CUT = "오류로 끊김", TOOL_CUT = "도구 도중 끊김";

// Tool error causes, first match wins: the anchored phrases of dotz's own guards come before the loose words of the runtimes.
const TOOL_ERR: [string, RegExp][] = [
	["얇은 브리프", /worker brief|done-condition|Acceptance:|Done when|brief rejected/i],
	["런타임 끊김", /token cap|INTERRUPTED|Operation aborted|\babort|cancel|interrupted/i],
	["정책 차단", /Blocked by dotz|orchestrator-guard|budget gate|denied|not allowed|refused|forbidden|EACCES|EPERM|answers only|looks like a codename/i],
	["기한 초과", /timed? ?out|deadline|ETIMEDOUT/i],
	["입력 오류", /^Tool \S+ not found|oldText|exact text|did not match|must match|not unique|no match|multiple matches|overlap|Validation failed|SyntaxError|TypeError|ReferenceError|is not a function|is not defined|EISDIR|identical content|conflicting shapes|must be |required|invalid|malformed|JSON Parse/i],
	["낡은 경로·선택자", /ENOENT|no such file|not found|does not exist|cannot find|unavailable|selector|locator|strict mode|no tab|No terminal session/i],
];
export const classifyToolError = (text: string): string => TOOL_ERR.find(([, re]) => re.test(text.slice(0, 400)))?.[0] ?? "기타";

const MODEL_ERR: [string, RegExp][] = [
	["429·한도", /429|rate.?limit|usage limit|quota/i], ["과부하·5xx", /overload|\b5\d\d\b|internal/i], ["중단", /abort|cancel/i],
	["프로세스·스트림", /exited|stream|socket|ECONN|connection|terminated|closed|EPIPE/i], ["시간 초과", /timeout|timed out/i], ["컨텍스트", /context|too long|prompt is too/i],
];
export const classifyModelError = (msg: string): string => MODEL_ERR.find(([, re]) => re.test(msg))?.[0] ?? "기타";

// What started a turn: a dotz inbox line, a runtime notification or the owner. The first words are enough to tell the sources apart.
const PREFIXES: [string, string][] = [["[keepalive", "keepalive"], ["[watch", "watch"], ["[schedule", "schedule"], ["[owner", "owner"], ["[dotz lane", "lane-brief"], ["[lane", "lane-report"], ["<system-reminder>", "sysreminder"], ["Background task", "bgtask"], ["[peer", "peer"]];
export function wakeOf(text: string): string {
	const m = text.match(/^\[dotz inbox\]\s*([^\s\]\n:]+)/);
	if (m) return /^(lane|lanes|session)$/.test(m[1] ?? "") ? "inbox:lane-report" : `inbox:${m[1]}`;
	return PREFIXES.find(([p]) => text.startsWith(p))?.[1] ?? `other:${text.slice(0, 24).replace(/\n/g, " ")}`;
}
const NOT_A_WAKE = new Set(["cm:senpi-task.usage", "cm:environment-context", "cm:senpi.todo-owed"]);

// Hub log events worth counting; `sum` reads the number out of the line when the line stands for several things.
const HUB_COUNTERS: { name: string; re: RegExp; sum?: RegExp }[] = [
	{ name: "재시도: 막힌 턴", re: /login store changed; retrying the blocked turn/ }, { name: "재시도: 메일·카드 요약", re: /summary failed, retry|keep their original \(retry in/ },
	{ name: "재시도: 답 전에 끊긴 턴", re: /stopped on an error before answering; its request stays open for the retry/ },
	{ name: "재생: 못 받은 프롬프트", re: /replaying \d+ unanswered prompt/, sum: /replaying (\d+) unanswered/ },
	{ name: "답: 워커 결과로 연결", re: /an answer had no prompt; sent to (?!no message)/ }, { name: "답: 메시지 없이 전달", re: /an answer had no prompt; sent to no message/ }, { name: "[later]: 프롬프트 없는 턴", re: /a run without a prompt said \[later\]/ },
	{ name: "재시작: 게이트웨이", re: /gateway restart \(/ }, { name: "재시작: 레인 중단", re: /stopped for a gateway restart/ }, { name: "재시작: 오래 기다림", re: /gateway restart still waiting/ },
];

const entry = (): Entry => ({ count: 0, tokens: 0, chars: 0, noop: 0, lost: 0, sample: "", tools: new Map() });
function bump(t: Tally, key: string, tokens: number, o: { chars?: number; noop?: number; lost?: number; sample?: string; tool?: string; count?: number } = {}) {
	const e = t.get(key) ?? t.set(key, entry()).get(key)!;
	e.count += o.count ?? 1;
	e.tokens += tokens;
	e.chars += o.chars ?? 0;
	e.noop += o.noop ?? 0;
	e.lost += o.lost ?? 0;
	if (!e.sample && o.sample) e.sample = o.sample;
	if (o.tool) e.tools.set(o.tool, (e.tools.get(o.tool) ?? 0) + 1);
}
// Biggest tokens first; a class with no tokens (hub.log counters) sorts by count.
const rows = (t: Tally, total: number): Row[] =>
	[...t].map(([name, e]): Row => {
		const top = [...e.tools].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(", ");
		return {
			name, count: e.count, tokens: Math.round(e.tokens), share: total ? +(e.tokens / total).toFixed(4) : 0,
			...(e.chars ? { chars: e.chars } : {}), ...(e.noop ? { noop: e.noop, lost: Math.round(e.lost) } : {}), ...(top ? { top } : {}), ...(e.sample ? { sample: e.sample } : {}),
		};
	}).sort((a, b) => b.tokens - a.tokens || b.count - a.count);

// One pass over a jsonl file in 1 MB reads: the biggest session files are over 100 MB, so a file is never held whole.
function eachLine(file: string, fn: (line: string) => void) {
	const fd = openSync(file, "r");
	const buf = Buffer.allocUnsafe(1 << 20);
	const dec = new TextDecoder();
	let tail = "";
	try {
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (!n) break;
			const text = tail + dec.decode(buf.subarray(0, n), { stream: true });
			let from = 0;
			for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", from)) {
				fn(text.slice(from, i));
				from = i + 1;
			}
			tail = text.slice(from);
		}
	} finally {
		closeSync(fd);
	}
	if (tail) fn(tail);
}

type Acc = { tokens: number; turns: number; roles: Tally; workers: Tally; toolErrors: Tally; repeats: Tally; errorTurns: Tally; toolOutput: Tally; wakes: Tally; skipped: number; emptyWorkers: number };
const text = (blocks: unknown): string => (Array.isArray(blocks) ? blocks : []).map(b => (b && typeof b === "object" && typeof (b as Json).text === "string" ? (b as Json).text : "")).join("");
const roleOf = (src: Src): string => (src.child ? "워커" : src.file.includes(".dotz-projects") ? "프로젝트" : src.label.startsWith("orchestrator") ? "오케스트레이터" : src.label.startsWith("lane") ? "레인" : "기타");

function scanFile(src: Src, since: number, acc: Acc) {
	const role = roleOf(src);
	const calls = new Map<string, { name: string; share: number }>();
	let lastSig = "", lastStop: string | null = null, cap = false, fileTokens = 0, turns = 0, stopTokens = 0, stopped = false;
	let wake = "start", groupTokens = 0, groupTurns = 0, lastText = "";
	const endGroup = () => {
		if (!groupTurns) return;
		const noop = groupTurns === 1 && lastText.length < 8;
		bump(acc.wakes, wake, groupTokens, { noop: noop ? 1 : 0, lost: noop ? groupTokens : 0 });
		groupTokens = groupTurns = 0;
	};
	const trigger = (next: string) => {
		if (NOT_A_WAKE.has(next)) return;
		endGroup();
		wake = next;
	};
	eachLine(src.file, line => {
		if (line.length < 20) return;
		const head = line.slice(0, 300);
		const isMsg = head.startsWith('{"type":"message"');
		if (head.startsWith('{"type":"custom_message"')) return trigger(`cm:${head.match(/"customType":"([^"]+)"/)?.[1] ?? "?"}`);
		if (!isMsg) return;
		if (!cap) {
			const h = line.slice(0, 1500);
			if (h.includes("dotz task token cap") && h.includes("[fail]")) cap = true;
		}
		if (head.includes('"role":"custom"')) return trigger(`cm:${head.match(/"customType":"([^"]+)"/)?.[1] ?? "?"}`);
		if (head.includes('"role":"user"')) {
			const raw = line.slice(0, 900).match(/"(?:content|text)":"((?:[^"\\]|\\.){0,60})/)?.[1] ?? "";
			let prefix = raw;
			try {
				prefix = JSON.parse(`"${raw}"`);
			} catch {
				// the 60-char cut can land inside an escape; the raw prefix still tells the source apart
			}
			return trigger(wakeOf(prefix));
		}
		const isAssistant = head.includes('"role":"assistant"');
		if (!isAssistant && !head.includes('"role":"toolResult"')) return;
		const ts = Date.parse(head.match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
		if (!(ts >= since)) return;
		let m: Json;
		try {
			m = JSON.parse(line).message ?? {};
		} catch {
			return; // the line being appended right now is cut short; the next run sees it whole
		}
		if (isAssistant) {
			const tok = Number(m.usage?.totalTokens) || 0;
			const toolCalls = (Array.isArray(m.content) ? m.content : []).filter((b: Json) => b?.type === "toolCall");
			lastStop = m.stopReason ?? null;
			if (m.stopReason === "error") bump(acc.errorTurns, classifyModelError(String(m.errorMessage ?? "")), tok, { sample: String(m.errorMessage ?? "").slice(0, 120) });
			if (tok) {
				acc.tokens += tok;
				fileTokens += tok;
				turns++;
				acc.turns++;
				bump(acc.roles, role, tok);
				groupTokens += tok;
				groupTurns++;
				lastText = text(m.content).trim();
			}
			if (m.stopReason === "stop") {
				stopped = true;
				stopTokens = fileTokens;
			}
			const share = tok / Math.max(1, toolCalls.length);
			for (const c of toolCalls) {
				calls.set(String(c.id), { name: String(c.name), share });
				const sig = `${c.name}${JSON.stringify(c.arguments ?? {})}`;
				if (sig === lastSig) bump(acc.repeats, String(c.name), share, { sample: sig.slice(0, 120) });
				else lastSig = sig;
			}
			return;
		}
		const call = calls.get(String(m.toolCallId));
		const name = String(m.toolName ?? call?.name ?? "?");
		const body = text(m.content);
		bump(acc.toolOutput, name, Math.round(body.length / 4), { chars: body.length });
		if (m.isError) bump(acc.toolErrors, classifyToolError(body), call?.share ?? 0, { tool: name, sample: body.slice(0, 120).replace(/\s+/g, " ") });
	});
	endGroup();
	if (!src.child) return;
	if (!turns) acc.emptyWorkers++;
	else if (!cap && stopped && lastStop === "error") {
		// It answered and stopped normally; only a later wake died (the follow-up or notification found its launch gone). That is a finished worker,
		// and the error class holds just the turns after the last stop (count = the cut wakes that cost tokens; the failed turn itself is charged 0).
		bump(acc.workers, FRESH_WORKER, stopTokens);
		if (fileTokens > stopTokens) bump(acc.workers, ERR_CUT, fileTokens - stopTokens);
	} else bump(acc.workers, cap ? CAP : lastStop === "stop" ? FRESH_WORKER : lastStop === "error" ? ERR_CUT : TOOL_CUT, fileTokens);
}

// OmO keeps task workers in <home>/.omo/agent/projects/<project>/senpi-task/children/**, and the collector only knows the stores listed in task-stores.json,
// which misses every project folder created after that list stopped being updated. Walk the folders themselves and add what the collector lacks.
function workerFiles(home: string, since: number): Src[] {
	const out: Src[] = [];
	const walk = (dir: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // a worker folder removed while walking
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) {
				try {
					if (statSync(p).mtimeMs >= since) out.push({ file: p, label: `worker ${e.name}`, child: true, runtime: "omo" });
				} catch {
					// file removed between listing and stat
				}
			}
		}
	};
	const root = join(home, ".omo", "agent", "projects");
	let projects: string[] = [];
	try {
		projects = readdirSync(root);
	} catch {
		return out; // no worker store on this machine
	}
	for (const p of projects) walk(join(root, p, "senpi-task", "children"));
	return out;
}

function hubLogRows(file: string, since: number): Row[] {
	const t: Tally = new Map(HUB_COUNTERS.map(c => [c.name, entry()]));
	let lines: string[] = [];
	try {
		lines = readFileSync(file, "utf8").split("\n");
	} catch {
		return rows(t, 0); // no hub.log yet: every counter is 0
	}
	for (const line of lines) {
		if (!(Date.parse(line.slice(0, 24)) >= since)) continue;
		for (const c of HUB_COUNTERS) if (c.re.test(line)) bump(t, c.name, 0, { count: c.sum ? Number(line.match(c.sum)?.[1] ?? 1) : 1 });
	}
	return rows(t, 0);
}

export function failureReport(opts: { home?: string; dataDir?: string; days?: number; now?: number; hubLog?: string } = {}): Report {
	const t0 = Date.now();
	const home = opts.home ?? HOME, dataDir = opts.dataDir ?? DATA_DIR, days = opts.days ?? 7;
	const since = (opts.now ?? t0) - days * DAY;
	const words = { orchestrator: "orchestrator", lane: "lane", worker: "worker" };
	const files = new Map<string, Src>();
	for (const s of [...collectSessions(since, { home, dataDir, words }), ...workerFiles(home, since)]) if (!files.has(s.file)) files.set(s.file, s);
	const acc: Acc = { tokens: 0, turns: 0, roles: new Map(), workers: new Map(), toolErrors: new Map(), repeats: new Map(), errorTurns: new Map(), toolOutput: new Map(), wakes: new Map(), skipped: 0, emptyWorkers: 0 };
	for (const src of files.values()) {
		try {
			scanFile(src, since, acc);
			Bun.gc(true); // the parsed lines of a big file are garbage once it is done; without this the peak grows past 300 MB
		} catch {
			acc.skipped++; // a session file that vanished or is unreadable right now does not stop the report
		}
	}
	const sum = (t: Tally) => [...t.values()].reduce((n, e) => n + e.tokens, 0);
	const workers = rows(acc.workers, sum(acc.workers));
	const toolErrors = rows(acc.toolErrors, sum(acc.toolErrors));
	const repeats = rows(acc.repeats, sum(acc.repeats));
	const errorTurns = rows(acc.errorTurns, sum(acc.errorTurns));
	const wakes = rows(acc.wakes, sum(acc.wakes));
	const hubLog = hubLogRows(opts.hubLog ?? join(dataDir, "hub.log"), since);
	const total = acc.tokens;
	const share = (n: number) => (total ? +(n / total).toFixed(4) : 0);
	const lost: Row[] = [
		...workers.filter(r => r.name !== FRESH_WORKER).map(r => ({ ...r, name: `워커 ${r.name}`, share: share(r.tokens) })),
		...toolErrors.map(r => ({ ...r, name: `도구 오류 ${r.name}`, share: share(r.tokens) })),
		{ name: "같은 호출 반복", count: repeats.reduce((n, r) => n + r.count, 0), tokens: repeats.reduce((n, r) => n + r.tokens, 0), share: share(repeats.reduce((n, r) => n + r.tokens, 0)) },
		...errorTurns.map(r => ({ ...r, name: `모델 오류 ${r.name}`, share: share(r.tokens) })),
		...wakes.filter(r => r.noop).map(r => ({ name: `빈 깨움 ${r.name}`, count: r.noop ?? 0, tokens: r.lost ?? 0, share: share(r.lost ?? 0) })),
		...hubLog.map(r => ({ name: `허브 로그 ${r.name}`, count: r.count, tokens: 0, share: 0 })),
	].sort((a, b) => b.tokens - a.tokens || b.count - a.count);
	return {
		generatedAt: new Date(t0).toISOString(), days, since: new Date(since).toISOString(),
		files: { total: files.size, workers: [...files.values()].filter(s => s.child).length, skipped: acc.skipped, emptyWorkers: acc.emptyWorkers },
		tokens: total, turns: acc.turns, roles: rows(acc.roles, total), workers, toolErrors, repeats, errorTurns,
		toolOutput: rows(acc.toolOutput, sum(acc.toolOutput)).slice(0, 12), wakes: wakes.slice(0, 14), hubLog, lost,
		run: { ms: Date.now() - t0, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) },
	};
}

// version 2 adds the totals the share is taken against; a version 1 file (volume only) is replaced silently like a missing one.
export type Baseline = { version: 2; at: string; tokens: number; turns: number; classes: Record<string, { count: number; tokens: number }> };
const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const P = (s: number) => `${(s * 100).toFixed(2)}%`;
export const isBaseline = (b: unknown): b is Baseline => {
	const o = b as Json | null, c = o?.classes;
	return o?.version === 2 && Number.isFinite(o.tokens) && Number.isFinite(o.turns) && !!c && typeof c === "object" && Object.values(c).every((v: any) => Number.isFinite(v?.count) && Number.isFinite(v?.tokens));
};
function loadBaseline(file: string): Baseline | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const b = JSON.parse(readFileSync(file, "utf8"));
		return isBaseline(b) ? b : undefined;
	} catch {
		return undefined; // a half-written or foreign file is a first run, not an error
	}
}
export type Thresholds = { pct: number; minTokens: number; minCount: number };
// A class grew when its share grew by at least pct percent and it cost at least the floor beyond what its old share predicts for this window
// (tokens, or count for classes that carry no tokens). Share = tokens / all tokens, or count / assistant turns for a count-only class: counts have
// no token total, and turns are what a model error or a hub.log retry happens per, so a longer or busier window dilutes them like it dilutes tokens.
export function grownClasses(r: Report, base: Baseline | undefined, th: Thresholds): { name: string; line: string; weight: number }[] {
	if (!base) return [];
	const out: { name: string; line: string; weight: number }[] = [];
	for (const c of r.lost) {
		const b = base.classes[c.name] ?? { count: 0, tokens: 0 };
		const byTokens = c.tokens > 0 || b.tokens > 0;
		const was = byTokens ? b.tokens : b.count, now = byTokens ? c.tokens : c.count;
		const wasTotal = byTokens ? base.tokens : base.turns, nowTotal = byTokens ? r.tokens : r.turns;
		if (!wasTotal || !nowTotal) continue;
		const before = was / wasTotal, after = now / nowTotal;
		const excess = now - before * nowTotal;
		if (excess < (byTokens ? th.minTokens : th.minCount) || after < before * (1 + th.pct / 100)) continue;
		const pct = before ? `+${Math.round((after / before - 1) * 100)}%` : "새로 생김";
		const share = byTokens ? `비중 ${P(before)} → ${P(after)}` : `1천 턴당 ${(before * 1e3).toFixed(2)} → ${(after * 1e3).toFixed(2)}`;
		out.push({ name: c.name, weight: byTokens ? excess : excess * 1e3, line: `${c.name}: ${byTokens ? `토큰 ${M(b.tokens)} → ${M(c.tokens)}, ` : ""}건수 ${b.count} → ${c.count}, ${share} (${pct})` });
	}
	return out.sort((a, b) => b.weight - a.weight);
}
// What the next comparison starts from; the doctor (hub/doctor.ts) keeps it in its own store instead of a state file.
export const baselineOf = (r: Report): Baseline => ({ version: 2, at: r.generatedAt, tokens: r.tokens, turns: r.turns, classes: Object.fromEntries(r.lost.map(c => [c.name, { count: c.count, tokens: c.tokens }])) });
export function check(r: Report, stateFile: string, th: Thresholds): string[] {
	const lines = grownClasses(r, loadBaseline(stateFile), th).map(g => g.line);
	const next = baselineOf(r);
	mkdirSync(dirname(stateFile), { recursive: true });
	writeAtomic(stateFile, `${JSON.stringify(next)}\n`);
	return lines;
}

const pct = (s: number) => `${(s * 100).toFixed(1)}%`;
const table = (title: string, head: string[], body: (string | number)[][]) =>
	body.length ? `\n## ${title}\n\n| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n${body.map(r => `| ${r.join(" | ")} |`).join("\n")}\n` : "";
const plain = (r: Row[]) => r.map(x => [x.name, x.count, M(x.tokens), pct(x.share)]);
export function toMarkdown(r: Report): string {
	const H = ["분류", "건수", "토큰", "비중"];
	return [
		`# 반복 작업·실패 시도 보고 (최근 ${r.days}일)\n\n기준 ${r.generatedAt} · 세션 파일 ${r.files.total}개(워커 ${r.files.workers}개) · 전체 ${M(r.tokens)} 토큰 · 실행 ${(r.run.ms / 1000).toFixed(1)}초, 최대 메모리 ${r.run.peakRssMb}MB\n\n분류는 서로 겹쳐요(끊긴 워커 안에 도구 오류가 있음): 더하지 말고 위에서부터 보세요. 비중은 위쪽 표만 전체 토큰 기준이고, 나머지는 그 표 안의 비중이에요.\n`,
		table("잃은 토큰 순위", H, plain(r.lost)),
		table("워커 결과", H, plain(r.workers)),
		table("도구 오류 원인", [...H, "자주 나온 도구"], r.toolErrors.map(x => [...plain([x])[0]!, x.top ?? ""])),
		table("같은 호출 반복(도구별)", H, plain(r.repeats)),
		table("모델 오류 종류", H, plain(r.errorTurns)),
		table("도구 출력량(글자 수, 토큰은 글자/4 추정)", ["도구", "호출", "글자(M)", "추정 토큰"], r.toolOutput.map(x => [x.name, x.count, ((x.chars ?? 0) / 1e6).toFixed(1), M(x.tokens)])),
		table("깨움 원인", ["원인", "묶음", "토큰", "빈 깨움", "빈 깨움 토큰"], r.wakes.map(x => [x.name, x.count, M(x.tokens), x.noop ?? 0, M(x.lost ?? 0)])),
		table("hub.log 횟수", ["항목", "횟수"], r.hubLog.map(x => [x.name, x.count])),
		table("역할별 토큰", H, plain(r.roles)),
	].join("") + "\n";
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const val = (flag: string, fallback?: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : fallback;
	};
	const days = Number(val("--days", "7"));
	if (!(days > 0)) throw new Error("--days must be a positive number");
	const r = failureReport({ days });
	if (argv.includes("--check")) {
		const state = val("--state");
		if (!state) throw new Error("--check needs --state <file>");
		const th = { pct: Number(val("--grow-pct", "25")), minTokens: Number(val("--min-tokens", "1000000")), minCount: Number(val("--min-count", "10")) };
		for (const line of check(r, state, th)) console.log(line);
	} else {
		const md = val("--md");
		if (md) writeAtomic(md, toMarkdown(r));
		if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
		else if (!md) console.log(toMarkdown(r));
	}
}
