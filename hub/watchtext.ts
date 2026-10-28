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
	if (r.startsWith("stopped after a password")) return "저장된 비밀번호가 없어 다시 로그인하지 못했어요. 맥 암호에 저장하고 다시 연결을 눌러 주세요";
	if (r.startsWith("stopped after")) return "실패가 이어져 멈췄어요. 승인하면 다시 돌아요";
	if (r.startsWith("needs the owner's approval for a second factor")) return "2차 인증이 필요해요. 다시 연결을 누르면 휴대폰으로 승인 요청을 보내요";
	if (r.startsWith("needs the owner")) return "승인이 필요해요";
	return r;
}

// What the owner reads for a watch: an internal key ("kakao-new") reads as words ("kakao new"); a label written for people stays.
export function humanLabel(label: string, fallback = "모니터링"): string {
	const s = label.trim();
	if (!s) return fallback;
	return /^[a-z0-9][a-z0-9_-]*$/.test(s) ? s.replace(/[-_]+/g, " ") : s;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
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

export type ItemRef = { app: string; id: string; subject?: string; from?: string };
const ITEM_LINE = /^DOTZ_ITEM[ \t]+([a-z][a-z0-9-]{0,19}):(\S+)[ \t]*$/m;
const ITEM_SUBJECT = /^(?:subject|제목)[ \t]*[:=][ \t]*(\S.*)$/im;
const ITEM_FROM = /^(?:from|보낸 ?사람)[ \t]*[:=][ \t]*(\S.*)$/im;

// The app item a check points at: one `DOTZ_ITEM <app>:<id>` line (a mail: `mail:<source>/<id>` or the mail key). A `subject:` and a `from:` line, when the
// check printed them, are what the report shows if the hub cannot find the item itself. undefined = the output names no item.
export function itemRefOf(output: string): ItemRef | undefined {
	const m = ITEM_LINE.exec(output.replace(ANSI, ""));
	if (!m) return undefined;
	const subject = ITEM_SUBJECT.exec(output)?.[1]?.trim().slice(0, 200), from = ITEM_FROM.exec(output)?.[1]?.trim().slice(0, 200);
	return { app: m[1]!, id: m[2]!, ...(subject ? { subject } : {}), ...(from ? { from } : {}) };
}

export const isIssue = (reason: string) => /^(?:fail\b|failed \d+|stopped after|needs the owner)/.test(reason.trim());

const ISO_ALL = new RegExp(ISO.source, "g");
const LONG_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{9,})\b/gi;

// What a `DOTZ_FAIL <kind>` line means to the owner. A kind that is not here reads as the plain failure phrase.
const FAIL_KO: Record<string, string> = {
	login: "로그인이 풀렸어요", session: "로그인이 풀렸어요", auth: "로그인이 풀렸어요", expired: "로그인이 풀렸어요",
	approval: "승인이 필요해요", "token-source": "토큰 원본을 읽지 못했어요",
 fetch: "내용을 가져오지 못했어요", network: "네트워크에 연결하지 못했어요", timeout: "시간이 너무 오래 걸렸어요",
	captcha: "보안 확인(캡차)이 필요해요", off: "연동이 꺼져 있어요", app: "앱이 꺼져 있어요", browser: "브라우저를 열지 못했어요",
	parse: "화면 구조가 바뀌어 읽지 못했어요", rate: "요청이 너무 잦아 잠시 막혔어요", limit: "요청이 너무 잦아 잠시 막혔어요",
};
export const failKindKo = (kind: string): string => FAIL_KO[kind] ?? "점검에 실패했어요";

const tidy = (l: string, now?: number, tz?: string): string =>
	l.replace(ANSI, "").replace(ISO_ALL, m => clockKo(m, now, tz)).replace(LONG_ID, "").replace(/\s+/g, " ").trim();
const linesOf = (s: string, now?: number, tz?: string): string[] =>
	s.replace(ANSI, "").replace(/\r/g, "").split("\n").map(l => tidy(l, now, tz)).filter(Boolean);
// A line a person can read as words: letters make most of it, and it is not key=value or a snake_case token.
const plainLine = (l: string): boolean => {
	if (l.length > 160 || /\S=\S/.test(l) || /\w_\w/.test(l)) return false;
	const letters = (l.match(/[가-힣A-Za-z0-9]/g) ?? []).length;
	return /[가-힣A-Za-z]{2,}/.test(l) && letters >= l.length * 0.6;
};
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const items = (list: string[]) => `${list.slice(0, 3).join(" · ")}${list.length > 3 ? ` 외 ${list.length - 3}건` : ""}`;

function flatJson(v: unknown, key: string, out: string[], now?: number, tz?: string): void {
	if (out.length >= 8) return;
	if (v && typeof v === "object" && !Array.isArray(v)) {
		for (const [k, x] of Object.entries(v)) if (!/(?:^|_)(?:id|uuid|token)$/i.test(k)) flatJson(x, key ? `${key}.${k}` : k, out, now, tz);
		return;
	}
	const val = Array.isArray(v) ? v.map(x => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : String(v);
	const shown = tidy(val, now, tz);
	if (shown) out.push(`${key || "값"}: ${cut(shown, 80)}`);
}

export type Described = { text: string; readable: boolean };
export type DescribeOpts = { prev?: string; issue?: boolean; now?: number; tz?: string };

// The output of a check as a person reads it, by rules alone: a DOTZ_FAIL kind as a phrase, JSON as key: value lines, the lines that were added or
// removed against the last output (or marked +/-), key=value counts and times, plain Korean as it is. `readable: false` = none of these fit.
// Ids, ANSI colours and ISO times never reach the text.
export function describeOutput(output: string, opts: DescribeOpts = {}): Described {
	const out = output.replace(ANSI, "").trim();
	if (!out) return { text: "", readable: true };
	const fail = /^DOTZ_FAIL[ =:]([a-z0-9-]{1,20})\b/m.exec(out);
	if (fail) {
		const said = linesOf(out, opts.now, opts.tz).filter(l => !l.startsWith("DOTZ_") && HANGUL.test(l) && !isMachineOutput(l)).slice(0, 2);
		return { text: [failKindKo(fail[1]!), ...said.map(l => cut(l, 120))].join("\n"), readable: true };
	}
	if (/^[{[]/.test(out)) {
		try {
			const rows: string[] = [];
			flatJson(JSON.parse(out), "", rows, opts.now, opts.tz);
			if (rows.length) return { text: rows.join("\n"), readable: true };
		} catch {
			// not JSON: the line rules below
		}
	}
	if (opts.issue) return { text: "", readable: true };
	if (isMachineOutput(out)) {
		const s = watchSummary(out, opts.now, opts.tz);
		return { text: s, readable: Boolean(s) };
	}
	const cur = linesOf(out, opts.now, opts.tz);
	const marked = cur.filter(l => /^[+-](?![+-]{2})\s?\S/.test(l));
	let added: string[] | undefined;
	let removed: string[] = [];
	if (opts.prev !== undefined && opts.prev.trim()) {
		const old = linesOf(opts.prev, opts.now, opts.tz), had = new Set(old), has = new Set(cur);
		added = cur.filter(l => !had.has(l));
		removed = old.filter(l => !has.has(l));
	} else if (marked.length && marked.length >= cur.length / 2) {
		added = marked.filter(l => l.startsWith("+")).map(l => l.slice(1).trim());
		removed = marked.filter(l => l.startsWith("-")).map(l => l.slice(1).trim());
	}
	if (added) {
		if (![...added, ...removed].every(plainLine)) return { text: "", readable: false };
		const said = [added.length ? `새로 생겼어요: ${items(added)}` : "", removed.length ? `사라졌어요: ${items(removed)}` : ""].filter(Boolean);
		return { text: said.join("\n") || "내용은 그대로이고 시각 같은 값만 바뀌었어요", readable: true };
	}
	if (HANGUL.test(out)) return { text: out, readable: true };
	if (cur.length <= 3 && cur.every(plainLine)) return { text: cur.join("\n"), readable: true };
	return { text: "", readable: false };
}

export type LineOpts = { raw?: boolean; now?: number; tz?: string; note?: string; prev?: string; summary?: string };

// "<감시 이름>: 결과가 바뀌었어요", then the output in words (describeOutput; `summary` is a cached model sentence for output the rules could not read),
// then the raw text folded (raw: false leaves it out, for the bell). A plain Korean output is its own words and is not folded again.
// `note` is added after the first line's phrase.
export function watchLine(label: string, reason: string, output = "", opts: LineOpts = {}): string {
	const out = output.trim();
	const lines = [`${humanLabel(label)}: ${watchReasonKo(reason)}${opts.note ? ` ${opts.note}` : ""}`];
	if (!out) return lines[0]!;
	const d = describeOutput(out, { prev: opts.prev, issue: isIssue(reason), now: opts.now, tz: opts.tz });
	const text = d.readable ? d.text : opts.summary ?? "";
	if (text && text === out) return `${lines[0]}\n${out}`;
	if (text) lines.push(text);
	if (opts.raw !== false) lines.push(rawFence(out));
	return lines.join("\n");
}

// The key of a watch ("kdb-login", "ch-1234-2") as words the owner reads: known English words become Korean, other words (a site, a product)
// stay. A key that carries no name of its own (a channel's numbered monitor) has no words: "".
const WORDS: Record<string, string> = {
	login: "로그인", logout: "로그아웃", new: "새 소식", stock: "재고", build: "빌드", update: "업데이트", updates: "업데이트", upgrade: "업그레이드",
	security: "보안", check: "확인", price: "가격", mail: "메일", patch: "패치", version: "버전", release: "릴리스", status: "상태", deploy: "배포",
	error: "오류", session: "세션", keepalive: "유지",
};
export function nameKo(name: string): string {
	const parts = name.replace(/^ch[-_ ](?:ch|\d+)[-_ ]\d+$/i, "").split(/[-_\s]+/).filter(Boolean);
	return parts.map(p => WORDS[p.toLowerCase()] ?? p).join(" ");
}

export type LabelInput = { name: string; project?: string; index?: number; header?: string; site?: string };
const KEYISH = /^[a-z0-9][a-z0-9_-]*$/;

// The Korean name a watch gets once, when it has none: the site of a login watch, else the first Korean line of its script header, else the words of
// its key, each led by the project (channel) it belongs to; a numbered channel monitor is "<project> 감시 <n>". Always readable, never the key.
export function deriveLabel(i: LabelInput): string {
	const lead = i.project?.trim() ?? "";
	const withLead = (s: string) => (lead && !s.includes(lead) ? `${lead} ${s}` : s);
	if (i.site) return `${i.site} 로그인 유지`;
	const header = (i.header ?? "").replace(/^[#/*\s]+/, "").trim();
	if (HANGUL.test(header)) return withLead(cut(header.split(/[.。\n]/)[0]!.trim(), 24));
	const words = nameKo(i.name);
	if (words) return withLead(words);
	const n = i.index ?? (Number(/(\d+)$/.exec(i.name)?.[1]) || 0);
	return `${lead || "프로젝트"} 감시${n ? ` ${n}` : ""}`;
}

// A label that is still a key ("kdb-login", "ch ch 2") and not words written for people.
export const isKeyLabel = (label: string): boolean => KEYISH.test(label.trim().replace(/\s+/g, "-")) && !/[A-Z가-힣]/.test(label);

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
