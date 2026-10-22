// The words the owner reads for a watch event or a schedule fire. The watch runner reports in short English reasons ("output changed"); the
// web, the bell and the chat show them as Korean. The check output is a machine line more often than not (key=value ids, ISO UTC times,
// JSON, a tool's English error): it never goes in the prose. A one-line summary is derived where that is generic (see watchSummary), and
// the raw text folds under a "원문" fence that the web renders collapsed (web/js/11-watchtext.js mirrors this file, 02-basic-markdown.js
// folds the fence) and Discord shows as a code block.
import { TZ } from "./config.ts";

// The reason of one notify() call as a Korean phrase. Anything unknown (already Korean, or a new reason) passes through.
export function watchReasonKo(reason: string): string {
	const r = reason.trim();
	if (r === "output changed" || r === "change") return "결과가 바뀌었어요";
	if (r === "match" || r.startsWith("matched /")) return "찾던 내용이 나왔어요";
	if (r === "fail") return "점검에 실패했어요";
	if (r === "recovered") return "다시 정상이에요";
	const fails = /^failed (\d+) times in a row/.exec(r)?.[1];
	if (fails) return `${fails}번 연속 실패했어요`;
	if (r.startsWith("stopped after")) return "실패가 이어져 멈췄어요. 승인하면 다시 돌아요";
	if (r.startsWith("needs the owner")) return "승인이 필요해요";
	return r;
}

// What the owner reads for a watch: an internal key ("kakao-new") reads as words ("kakao new"); a label written for people stays.
export function humanLabel(label: string, fallback = "모니터링"): string {
	const s = label.trim();
	if (!s) return fallback;
	return /^[a-z0-9][a-z0-9_-]*$/.test(s) ? s.replace(/[-_]+/g, " ") : s;
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/;
const HANGUL = /[가-힣]/;
const PAIR = /(?:^|\s)[A-Za-z_][\w.-]*=\S+/g;
const RAW_LINES = 5;
const RAW_LINE_MAX = 160;
const RAW_MAX = 600;

// A line meant for a program: two or more key=value pairs, an ISO timestamp, or JSON.
export function isMachineOutput(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (/^[{[]/.test(t))
		try {
			JSON.parse(t);
			return true;
		} catch {
			// not JSON: fall through to the line checks
		}
	return ISO.test(t) || t.split("\n").some(l => (l.match(PAIR)?.length ?? 0) >= 2);
}

// A moment as the owner reads it: "오후 9:26" today, "10월 21일 오후 9:26" on another day (in the owner's timezone, never ISO UTC).
export function clockKo(iso: string, now = Date.now(), tz = TZ): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	const time = new Intl.DateTimeFormat("ko-KR", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);
	const day = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t);
	if (day(ms) === day(now)) return time;
	return `${new Intl.DateTimeFormat("ko-KR", { timeZone: tz, month: "long", day: "numeric" }).format(ms)} ${time}`;
}

// The one-line summary of a machine output, only from what is generic: new=<n> means n new items, an ISO time is when. "" when neither is there.
export function watchSummary(output: string, now = Date.now(), tz = TZ): string {
	const count = Number(/(?:^|\s)new=(\d+)(?:\s|$)/.exec(output)?.[1] ?? 0);
	const at = ISO.exec(output)?.[0];
	return [count > 0 ? `새 소식 ${count}건` : "", at ? clockKo(at, now, tz) : ""].filter(Boolean).join(" · ");
}

// The raw text kept short: a few lines, each cut, in one fence the web folds.
export function rawFence(raw: string): string {
	const lines = raw.trim().split("\n").filter(l => l.trim());
	let body = lines.slice(0, RAW_LINES).map(l => (l.length > RAW_LINE_MAX ? `${l.slice(0, RAW_LINE_MAX - 1)}…` : l)).join("\n");
	if (body.length > RAW_MAX) body = `${body.slice(0, RAW_MAX - 1)}…`;
	else if (lines.length > RAW_LINES) body += "\n…";
	return `\`\`\`원문\n${body.replace(/```/g, "'''")}\n\`\`\``;
}

const isIssue = (reason: string) => /^(?:fail\b|failed \d+|stopped after|needs the owner)/.test(reason.trim());

export type LineOpts = { raw?: boolean; now?: number; tz?: string; note?: string };

// "<감시 이름>: 결과가 바뀌었어요", then a one-line summary or the output when it is plain Korean, then the raw text folded (raw: false leaves it out,
// for the bell). `note` is added after the first line's phrase.
export function watchLine(label: string, reason: string, output = "", opts: LineOpts = {}): string {
	const out = output.trim();
	const lines = [`${humanLabel(label)}: ${watchReasonKo(reason)}${opts.note ? ` ${opts.note}` : ""}`];
	if (!out) return lines[0]!;
	const prose = !isIssue(reason) && !isMachineOutput(out) && HANGUL.test(out);
	if (prose) return `${lines[0]}\n${out}`;
	const summary = isIssue(reason) ? "" : watchSummary(out, opts.now, opts.tz);
	if (summary) lines.push(summary);
	if (opts.raw !== false) lines.push(rawFence(out));
	return lines.join("\n");
}

const TARGETS = /^\s*(?:(?:ch|lane|th):\S+\s*)+/;
const SUMMARY_MAX = 60;

// A schedule fire: its text is the instruction to the orchestrator (often English, with commands). The owner reads that a scheduled job started, plus the
// first line when it is Korean; the instruction itself folds (raw: false is the bell's one line: that first line, else the plain phrase).
export function scheduleLine(text: string, opts: LineOpts = {}): string {
	const body = text.replace(TARGETS, "").trim();
	const first = body.split("\n")[0]!.trim();
	const head = "예약한 일이 시작됐어요";
	const said = HANGUL.test(first) && !isMachineOutput(first) ? (first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX - 1)}…` : first) : "";
	if (opts.raw === false) return said || head;
	const lines = [head];
	if (said) lines.push(said);
	if (body && body !== said) lines.push(rawFence(body));
	return lines.join("\n");
}
