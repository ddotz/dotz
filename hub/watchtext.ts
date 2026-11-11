// The words the owner reads for a watch event or a schedule fire. The watch runner reports in short English reasons ("output changed"); the
// web, the bell and the chat show them as Korean. The check output is a machine line more often than not (key=value ids, ISO UTC times,
// JSON, a tool's English error): it never goes in the prose. A one-line summary is derived where that is generic (see watchSummary), and
// the raw text folds under a "원문" fence that the web renders collapsed (web/js/11-watchtext.js mirrors this file, 02-basic-markdown.js
// folds the fence) and Discord shows as a code block.
import { homedir } from "node:os";
import { TZ } from "./config.ts";
import { msg } from "./i18n.ts";
import type { NotifyInfo } from "./watch-heal.ts";
import { SLOT_SKIPPED_EXIT } from "./release-exit.ts";

// The words the gateway writes for a lost login, its recovery and a check that found nothing new. hub/notice-class.ts reads them back
// (loginLost, watchUnchanged) and hub/limit-alert.ts writes the provider ones, so both sides share one spelling.
export const LOGIN_LOST_KO = "로그인이 풀렸어요";
export const LOGIN_NO_PASSWORD_KO = "저장된 비밀번호가 없어 다시 로그인하지 못했어요";
export const LOGIN_SECOND_FACTOR_KO = "2차 인증이 필요해요";
export const LOGIN_BLOCKED_KO = "모델 제공자 로그인이 풀려서 멈췄어요";
export const PROVIDER_BACK_KO = "모델 제공자가 다시 연결됐어요";
export const WATCH_UNCHANGED_KO = "내용은 그대로이고 시각 같은 값만 바뀌었어요";

// The reason of one notify() call as a Korean phrase. Anything unknown (already Korean, or a new reason) passes through.
export function watchReasonKo(reason: string): string {
	const r = reason.trim();
	if (r === "output changed" || r === "change") return "결과가 바뀌었어요";
	if (r === "match" || r.startsWith("matched /")) return "조건에 맞는 결과가 나왔어요";
	if (r === "fail") return "점검에 실패했어요";
	if (r === "recovered") return "다시 정상이에요";
	// The release-slot watch fails every minute of a skipped slot: that is one skipped slot, not that many failed checks.
	if (r.endsWith(`(exit ${SLOT_SKIPPED_EXIT})`) && /^failed \d+ times in a row/.test(r)) return "이 시간대의 릴리스를 건너뛰었어요";
	const fails = /^failed (\d+) times in a row/.exec(r)?.[1];
	if (fails) return `${fails}번 연속 실패했어요`;
	if (r.startsWith("stopped after a password")) return `${LOGIN_NO_PASSWORD_KO}. 맥 암호에 저장하고 다시 연결을 눌러 주세요`;
	if (r.startsWith("stopped after")) return "실패가 이어져 멈췄어요. 승인하면 다시 확인해요";
	if (r.startsWith("needs the owner's approval for a second factor")) return `${LOGIN_SECOND_FACTOR_KO}. 다시 연결을 누르면 휴대폰으로 승인 요청을 보내요`;
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
// One token a check prints for its own filter ("repo-gone", "READY"): a program's word, not a line to read.
const SENTINEL = /^(?:[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+|[A-Z][A-Z0-9_-]{3,})$/;

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

// The one-line summary of a machine output, only from what is generic: new=<n> means n new items, an ISO time is when. A log of three lines or more
// says how many and when its last line was. "" when none of it is there.
export function watchSummary(output: string, now = Date.now(), tz = TZ): string {
	const count = Number(/(?:^|\s)new=(\d+)(?:\s|$)/.exec(output)?.[1] ?? 0);
	const lines = output.split("\n").filter(l => l.trim()).length, log = !count && lines > 2;
	const at = (log ? output.match(ISO_ALL)?.at(-1) : undefined) ?? ISO.exec(output)?.[0];
	return [count > 0 ? `새 소식 ${count}건` : "", log ? `기록 ${lines}줄` : "", at ? `${log ? "마지막 " : ""}${clockKo(at, now, tz)}` : ""].filter(Boolean).join(" · ");
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

// A match whose whole output is that token: the reason says all there is, so no line, no 원문 and no model summary.
export const sentinelMatch = (reason: string, output: string): boolean => reason.trim().startsWith("match") && SENTINEL.test(output.replace(ANSI, "").trim());

export const isIssue = (reason: string) => /^(?:fail\b|failed \d+|stopped after|needs the owner)/.test(reason.trim());

// A notice text that says a login was lost, from the words above and nothing broader: the reason line of a stopped check (password, second factor),
// the provider's own stop, or a failing check whose output named a login kind (the line after the reason is exactly LOGIN_LOST_KO).
const LEAD = /^[^:\n]{1,60}:\s+/;
const ISSUE_HEAD = /^(?:\d+번 연속 실패했어요|실패가 이어져 멈췄어요|점검에 실패했어요|승인이 필요해요)/;
export function loginLost(text: string): boolean {
	const [first = "", second = ""] = text.split("\n", 2);
	const bare = first.replace(LEAD, "");
	if ([first, bare].some(h => h.startsWith(LOGIN_NO_PASSWORD_KO) || h.startsWith(LOGIN_SECOND_FACTOR_KO) || h.startsWith(LOGIN_BLOCKED_KO))) return true;
	return second === LOGIN_LOST_KO && ISSUE_HEAD.test(bare);
}
// A change report whose only difference was values like times (describeOutput's last words): the line after the reason is exactly WATCH_UNCHANGED_KO.
// Or a report that says so itself ("확인했어요. 바뀐 곳은 없어요.").
export const watchUnchanged = (text: string): boolean => {
	const [first = "", second] = text.split("\n", 2);
	return second === WATCH_UNCHANGED_KO || /바뀐 곳은 없어요\.?$/.test(first);
};

const ISO_ALL = new RegExp(ISO.source, "g");
const LONG_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{9,})\b/gi;

// What a `DOTZ_FAIL <kind>` line means to the owner. A kind that is not here reads as the plain failure phrase.
const FAIL_KO: Record<string, string> = {
	login: LOGIN_LOST_KO, session: LOGIN_LOST_KO, auth: LOGIN_LOST_KO, expired: LOGIN_LOST_KO,
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
	if (l.length > 160 || /\S=\S/.test(l) || /\w_\w/.test(l) || SENTINEL.test(l)) return false;
	const letters = (l.match(/[가-힣A-Za-z0-9]/g) ?? []).length;
	return /[가-힣A-Za-z]{2,}/.test(l) && letters >= l.length * 0.6;
};
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const rows = (list: string[]) => [...list.slice(0, 3), ...(list.length > 3 ? [`외 ${list.length - 3}건`] : [])].map(l => `- ${l}`);
// A changed line shaped "<kind>: <rest>" ("새 이슈: owner/repo#12 ..."), and the item it names: an "owner/repo#n" reference, else the text after the kind.
const KIND = /^([^:\n]{1,20}?):\s+(\S.*)$/;
const ITEM_REF = /(?:^|\s)([\w.-]+\/[\w.-]+#\d+)(?=\s|$)/;
// The text after the kind names an item only when it is more than one word ("서버 A: 정상" and "서버 B: 정상" are two servers).
const itemKey = (l: string): string => ITEM_REF.exec(l)?.[1] ?? KIND.exec(l)?.[2]?.match(/^\S+\s+\S.*$/)?.[0] ?? l;
const kindOf = (l: string): string => KIND.exec(l)?.[1]?.split(" → ").pop() ?? "";
// A removed line whose item is still among the added ones changed, it did not go (새 이슈 -> 이슈 갱신): it leaves the removed list, and the added
// line names the kind it had ("새 이슈 → 이슈 갱신: ...").
function keepMoved(added: string[], removed: string[]): { added: string[]; removed: string[] } {
	const gone = new Map(removed.map(l => [itemKey(l), l] as const)), moved = new Set<string>();
	const now = added.map(l => {
		const old = gone.get(itemKey(l));
		if (old === undefined) return l;
		moved.add(old);
		const was = KIND.exec(old)?.[1], is = KIND.exec(l)?.[1];
		return was && is && was !== is ? `${was} → ${l}` : l;
	});
	return { added: now, removed: removed.filter(l => !moved.has(l)) };
}
// "이슈 갱신 4건" when the lines share one or two short kinds.
function kindTitle(lines: string[]): string | undefined {
	const kinds = [...new Set(lines.map(kindOf))];
	if (kinds.length > 2 || !kinds.every(k => k && k.length <= 12)) return undefined;
	return kinds.map(k => `${k} ${lines.filter(l => kindOf(l) === k).length}건`).join(" · ");
}
// "이슈 갱신 4건" (kindTitle), else "새 항목 N건"; then "사라진 항목 M건".
function changeTitle(added: string[], removed: string[]): string {
	const a = added.length ? [kindTitle(added) ?? `새 항목 ${added.length}건`] : [];
	return [...a, ...(removed.length ? [`사라진 항목 ${removed.length}건`] : [])].join(" · ");
}
// A match whose output lists items one per line ("새 PR: owner/repo#72 ...") is counted as a change is: "새 PR 1건", or "조건에 맞는 항목 3건" when the
// lines have no common kind. One line that is not an item, or output that is not plain Korean, has no count.
const LISTED = /^\S.{0,40}?:\s+\S/;
export function matchTitle(output: string): string | undefined {
	if (!HANGUL.test(output) || isMachineOutput(output)) return undefined;
	const items = linesOf(output).map(l => l.replace(/^[-•]\s+/, "")).filter(l => !SENTINEL.test(l));
	if (!items.length || !items.every(l => LISTED.test(l))) return undefined;
	return kindTitle(items) ?? (items.length > 1 ? `조건에 맞는 항목 ${items.length}건` : undefined);
}
// The items under a match's count (matchTitle): when the count names their one kind ("새 PR 1건"), an item does not say it again ("새 PR: owner/repo#72 ..."
// reads "owner/repo#72 ..."). Items under two kinds or under "조건에 맞는 항목 N건" keep theirs.
export function matchItems(text: string, title: string): string {
	const kind = /^(.+) \d+건$/.exec(title)?.[1];
	if (!kind || kind.includes(" · ")) return text;
	return text.replace(/^([ \t]*(?:[-•][ \t]+)?)([^:\n]{1,20}?):[ \t]+(?=\S)/gm, (m, pre: string, k: string) => (k === kind ? pre : m));
}

function flatJson(v: unknown, key: string, out: string[], now?: number, tz?: string): void {
	if (out.length >= 8) return;
	if (v && typeof v === "object" && !Array.isArray(v)) {
		for (const [k, x] of Object.entries(v)) if (!/(?:^|_)(?:id|uuid|token)$/i.test(k)) flatJson(x, key ? `${key}.${k}` : k, out, now, tz);
		return;
	}
	const val = Array.isArray(v) ? v.map(x => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : String(v);
	const shown = tidy(val, now, tz);
	if (shown) out.push(`${key ? jsonKeyKo(key) : "값"}: ${cut(JSON_VALUE_KO[shown.toLowerCase()] ?? shown, 80)}`);
}
// The usual words of a status JSON in Korean; a key or value outside them (a product, a site) stays as printed.
const JSON_KEY_KO: Record<string, string> = {
	status: "상태", state: "상태", count: "개수", total: "전체", title: "제목", name: "이름", at: "시각", time: "시각", date: "날짜", updated_at: "갱신 시각",
	created_at: "만든 시각", checked_at: "확인 시각", latest: "최근", last: "마지막", price: "가격", message: "메시지", error: "오류", version: "버전", items: "항목", url: "주소",
};
const JSON_VALUE_KO: Record<string, string> = { ok: "정상", true: "예", false: "아니요", error: "오류", fail: "실패", failed: "실패" };
const jsonKeyKo = (key: string): string => key.split(".").map(k => JSON_KEY_KO[k.toLowerCase()] ?? k).filter((w, i, a) => w !== a[i - 1]).join(" ");

export type Described = { text: string; title?: string; readable: boolean };
export type DescribeOpts = { prev?: string; issue?: boolean; now?: number; tz?: string };

// The output of a check as a person reads it, by rules alone: a DOTZ_FAIL kind as a phrase, JSON as key: value lines, the lines that were added or
// removed against the last output (or marked +/-) one per row under a counted `title`, key=value counts and times, plain Korean as it is.
// `readable: false` = none of these fit.
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
		if (!added.length && !removed.length) return { text: WATCH_UNCHANGED_KO, readable: true };
		({ added, removed } = keepMoved(added, removed));
		const head = added.length && removed.length && !added.every(kindOf) ? ["새로 생겼어요"] : [];
		const text = [...head, ...rows(added), ...(removed.length ? ["사라졌어요", ...rows(removed)] : [])].join("\n");
		return { text, title: changeTitle(added, removed), readable: true };
	}
	if (HANGUL.test(out)) return { text: out.split("\n").filter(l => !SENTINEL.test(l.trim())).join("\n"), readable: true };
	if (cur.length <= 3 && cur.every(plainLine)) return { text: cur.join("\n"), readable: true };
	return { text: "", readable: false };
}

export type LineOpts = { raw?: boolean; now?: number; tz?: string; note?: string; prev?: string; summary?: string };

// "<감시 이름>: 결과가 바뀌었어요" (or the counted title of a change, "이슈 갱신 4건"), then the output in words (describeOutput; `summary` is a cached model sentence for output the rules could not read),
// then the raw text folded (raw: false leaves it out, for the bell). A plain Korean output is its own words and is not folded again.
// `note` is added after the first line's phrase.
export function watchLine(label: string, reason: string, output = "", opts: LineOpts = {}): string {
	const out = output.trim();
	const first = (said: string) => `${humanLabel(label)}: ${said}${opts.note ? ` ${opts.note}` : ""}`;
	if (!out || sentinelMatch(reason, out)) return first(watchReasonKo(reason));
	// A recovery's output that is one status word ("ok", "200") is the check passing, not news: said in words.
	if (reason.trim() === "recovered" && /^[\w.-]{1,12}$/.test(out)) return `${first(watchReasonKo(reason))}\n점검이 다시 통과했어요`;
	const d = describeOutput(out, { prev: opts.prev, issue: isIssue(reason), now: opts.now, tz: opts.tz });
	// Only a change or a match is said by its count; "다시 정상이에요" and other reasons stay (notices-store reads them).
	const counted = /^(output changed|change|match|matched \/)/.test(reason.trim());
	const listed = reason.trim().startsWith("match") && d.text !== WATCH_UNCHANGED_KO ? matchTitle(out) : undefined;
	const said = counted && d.readable && (d.title ?? listed);
	const lines = [first(said || watchReasonKo(reason))];
	const text = d.readable ? d.text : opts.summary ?? "";
	const shown = listed && said === listed ? matchItems(text, listed) : text;
	if (text && text === out) return `${lines[0]}\n${shown}`;
	if (shown) lines.push(shown);
	if (opts.raw !== false) lines.push(rawFence(out));
	return lines.join("\n");
}

// The owner's text for a failure, plain: the reason as today, one line of why (by class, or the output's own first line when it is short plain Korean),
// what a heal tried, and where the output was kept. Never the output body, a fence or a stack.
const STACKISH = /(?:^|\s)at\s|\b\w*(?:Error|Exception)\b|Traceback|:\d+:\d+|\.(?:ts|js|mjs|py|sh):\d+|node_modules|^\s*[{[]/;
const homeShown = (path: string): string => {
	const home = process.env.HOME ?? homedir();
	return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};
export function watchIssueLine(label: string, reason: string, info: NotifyInfo | undefined, output = ""): string {
	const t = msg().watchIssue;
	const first = output.replace(ANSI, "").split("\n").map(l => l.trim()).find(l => l && !l.startsWith("DOTZ_"));
	const said = first && HANGUL.test(first) && first.length <= 100 && !STACKISH.test(first) ? first : undefined;
	const why = said ?? (info ? t.cls[info.cls] : undefined);
	return [`${humanLabel(label)}: ${watchReasonKo(reason)}`, ...(why ? [why] : []), ...(info?.note ? [t.tried(info.note)] : []), ...(info ? [t.log(homeShown(info.log))] : [])].join("\n");
}

// The key of a watch ("acme-login", "ch-1234-2") as words the owner reads: known English words become Korean, other words (a site, a product)
// stay. A key that carries no name of its own (a channel's numbered monitor) has no words: "".
const APPS: Record<string, string> = {
	kakao: "카카오톡", kakaotalk: "카카오톡", instagram: "인스타그램", ig: "인스타그램", youtube: "유튜브", yt: "유튜브", gmail: "지메일", naver: "네이버", daum: "다음",
	discord: "디스코드", telegram: "텔레그램", slack: "슬랙", github: "깃허브", notion: "노션",
};
const WORDS: Record<string, string> = {
	...APPS, sns: "SNS", webmail: "메일", comment: "댓글", comments: "댓글", dm: "DM", inbox: "새 영상", due: "예약 글 올리기", tokens: "연결 유지", metadata: "영상 정보",
	login: "로그인", logout: "로그아웃", new: "새 소식", stock: "재고", build: "빌드", update: "업데이트", updates: "업데이트", upgrade: "업그레이드",
	security: "보안", check: "확인", price: "가격", mail: "메일", patch: "패치", version: "버전", release: "릴리스", status: "상태", deploy: "배포",
	error: "오류", session: "세션", keepalive: "유지",
};
export function nameKo(name: string): string {
	const parts = name.replace(/^ch[-_ ](?:ch|\d+)[-_ ]\d+$/i, "").split(/[-_\s]+/).filter(Boolean);
	if (parts[0]?.toLowerCase() === "sns" && APPS[parts[1]?.toLowerCase() ?? ""]) parts.shift();   // "sns-yt-comments" is 유튜브 댓글: the app already says where
	const words = parts.map(p => WORDS[p.toLowerCase()] ?? p);
	if (parts[0]?.toLowerCase() === "webmail" && words.length > 1) [words[0], words[1]] = [words[1]!, words[0]!];   // "webmail-naver" reads 네이버 메일
	return words.join(" ");
}

// A readable label that still carries an app's key ("kakao 새 소식", named before the app had words): the same label with the app's Korean name. Keys are lowercase, so a name the owner typed ("GitHub 감시") stays.
const APP_KEY = new RegExp(`(?<![\\w.-])(?:${Object.keys(APPS).join("|")})(?![\\w.-])`, "g");
export const plainLabel = (label: string): string => humanLabel(label).replace(APP_KEY, k => APPS[k]!);

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

// A label that is still a key ("acme-login", "ch ch 2") and not words written for people.
export const isKeyLabel = (label: string): boolean => KEYISH.test(label.trim().replace(/\s+/g, "-")) && !/[A-Z가-힣]/.test(label);

const TARGETS = /^\s*(?:(?:ch|lane|th):\S+\s*)+/;
// A schedule's name is as long as a title on the web (web/js/30-monitoring.js MON_TITLE_MAX).
const LABEL_MAX = 40;
// A command in a schedule's text (the web's MON_CMD): a file name, a shell command with its flags or a path, a flag, a redirect or pipe, a path, an address.
const CMD = /\b[\w.-]+\.(?:md|jsonl?|ya?ml|toml|log|py|sh)\b|\b(?:ssh|scp|rsync|curl|wget|python3?|node|bun|npm|npx|bash|zsh|git|sudo|docker|osascript)\s+(?:-|[\w.-]*@|~|\.{0,2}\/|[\w.-]+\.(?:py|sh|js|ts|mjs)\b)|(?:^|\s)-{1,2}[A-Za-z][\w-]*(?:=|\s|$)|\s[<>|]{1,2}\s|\$\(|~\/|(?:^|\s)\.{0,2}\/[\w.-]+\/|@\d{1,3}(?:\.\d{1,3}){3}/;
// What the text runs and names for the machine, with the particle after it ("README.md대로", "`bun x.ts`로"): a code span, a path or file name, a commit id.
const PARTICLE = "(?:대로|으로|에서|로|을|를|이|가|은|는|에|의)?";
const RUNS = new RegExp(
	["`[^`\\n]*(?:`|$)", "(?<!\\S)(?:~|\\.{1,2})?\\/[\\w.\\/-]*[\\w\\/]", "(?<![\\w.\\/-])[\\w.\\/-]*\\.(?:md|jsonl?|ya?ml|toml|log|py|sh|ts|js|mjs)\\b", "\\b(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\\b"]
		.map(p => `${p}${PARTICLE}`)
		.join("|"),
	"g",
);
// Where the last bracket or quote still open in s begins (-1: none), so a cut title never ends inside one.
const openAt = (s: string): number => {
	const open: number[] = [];
	let quote = -1;
	[...s].forEach((c, i) => {
		if (c === '"') quote = quote < 0 ? i : -1;
		else if ("([{（“‘".includes(c)) open.push(i);
		else if (")]}）”’".includes(c)) open.pop();
	});
	const at = [...open, ...(quote < 0 ? [] : [quote])];
	return at.length ? Math.min(...at) : -1;
};
const cutWords = (s: string, n: number): string => {
	if (s.length <= n) return s;
	let t = s.slice(0, n - 1);
	const at = t.lastIndexOf(" ");
	if (at > n / 2) t = t.slice(0, at);
	const o = openAt(t);
	if (o >= 0) t = t.slice(0, o);
	return `${t.replace(/[\s,·:(]+$/, "")}…`;
};
// A channel tag the text starts with ("#big-bath-점검(ch:1567…):"): it names where the schedule posts, not what it does.
const CHANNEL_TAG = /^\s*#[^\s(]+\((?:ch|lane|th):[^)\s]+\):?\s*/;

// The short name of a schedule, from its text (the whole instruction it runs): the first sentence without what it runs (RUNS, a bracket or the rest of a
// sentence that holds a command), without the brackets and commas an id leaves behind; a sentence too long for a title keeps the words before its first
// ": " ("flaky-tests 3차"), else it is cut between words. "" when nothing readable is left.
export function scheduleLabel(text: string): string {
	let s = (text.replace(TARGETS, "").replace(CHANNEL_TAG, "").trim().split("\n")[0] ?? "").replace(/\s+/g, " ");
	s = s.replace(/\s*[(（][^()（）]*(?:[)）]|$)/g, m => (CMD.test(m) || /^\s*[(（]state\s/.test(m) ? "" : m)).replace(RUNS, "");
	s = s.replace(/[ \t]*[,·][ \t]*([)）])/g, "$1").replace(/([(（])[ \t]*[,·][ \t]*/g, "$1").replace(/\s*[(（]\s*[)）]/g, "");
	s = s.replace(/\s+([,.!?)])/g, "$1").replace(/\s{2,}/g, " ").trim();
	if (CMD.test(s)) {
		const i = s.search(/[:：]\s/), keep: string[] = [];
		for (const t of (i > 0 ? s.slice(0, i) : s).split(/(?<=[.!?。])\s+/)) {
			if (CMD.test(t)) break;
			keep.push(t);
		}
		s = keep.join(" ");
	}
	const sentence = (s.split(/(?<=[.!?。])\s+/)[0] ?? "").replace(/[\s,·:.。]+$/, "");
	const head = sentence.split(/[:：]\s/)[0]!.trim();
	const label = sentence.length > LABEL_MAX && head !== sentence && head.length <= LABEL_MAX && /[가-힣A-Za-z]{2,}/.test(head) ? head : cutWords(sentence, LABEL_MAX);
	return /[가-힣A-Za-z]{2,}/.test(label) && !isMachineOutput(label) ? label : "";
}

// A schedule fire: its text is the instruction to the orchestrator (often English, with commands). The owner reads that a scheduled job started, plus its
// name (scheduleLabel) when it is Korean; the instruction itself folds (raw: false is the bell's one line: that name, else the plain phrase).
export function scheduleLine(text: string, opts: LineOpts = {}): string {
	const body = text.replace(TARGETS, "").trim();
	const head = "예약한 일이 시작됐어요";
	const label = scheduleLabel(body);
	const said = HANGUL.test(label) ? label : "";
	if (opts.raw === false) return said || head;
	const lines = [head];
	if (said) lines.push(said);
	if (body && body !== said) lines.push(rawFence(body));
	return lines.join("\n");
}
