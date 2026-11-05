// Everyday Korean for anything that reaches the owner as a notification: a toast, a bell row, an 알림 conversation row, a push. The bot writes
// its reports for itself as often as for him (tool names, slash commands, ids, file paths, cron, ssh, [done] marks); this turns them into words
// and keeps the data: a file keeps its name, a count its number. Text that is already plain passes through unchanged. web/js/01-notice-ko.js is the
// same code for the page (generated from this file, hub/notice-ko.test.ts holds the two together).
import { stripMarkers } from "./tone.ts";
import { clockKo } from "./watchtext.ts";

export type PlainOpts = { lane?: (name: string) => string | undefined; error?: boolean; keepFiles?: boolean };

// One name for every identifier that may show: words of a snake_case / dotz_ name, the parts of a target id, an agent tool.
const NAMES: Record<string, string> = {
	watch: "모니터링", watches: "모니터링", schedule: "예약", schedules: "예약", cron: "예약", mail: "메일", lane: "세션", lanes: "세션", session: "세션", inbox: "받은 알림",
	reflect: "되돌아보기", gateway: "게이트웨이", notify: "알림", notice: "알림", kakao: "카카오톡", discord: "디스코드", push: "휴대폰 알림", auth: "로그인", login: "로그인",
	orchestrator: "어시스턴트", web: "웹", search: "검색", fetch: "가져오기", draft: "초안", reply: "답장", send: "보내기", file: "파일", files: "파일", report: "보고",
};
const TOOLS: Record<string, string> = {
	bash: "명령 실행", read: "파일 읽기", edit: "파일 고치기", write: "파일 쓰기", grep: "내용 찾기", glob: "파일 찾기", webfetch: "웹 페이지 읽기", websearch: "웹 검색",
	task: "하위 작업", todowrite: "할 일 정리",
};
const SLASH: Record<string, string> = {
	status: "상태 보기", context: "컨텍스트 보기", compact: "대화 정리", lanes: "세션 보기", model: "모델 바꾸기", effort: "추론 강도 바꾸기", restart: "다시 시작", stop: "멈추기",
	resume: "이어가기", abort: "취소", providers: "공급자 보기", account: "계정 보기", login: "로그인", logout: "로그아웃", quota: "사용 한도 보기", help: "도움말", new: "새 대화", clear: "비우기", 셸: "터미널 명령",
};
const CMD_FIRST: Record<string, string> = {
	curl: "인터넷 요청", wget: "인터넷 요청", ls: "파일 확인", cat: "파일 확인", head: "파일 확인", tail: "파일 확인", grep: "내용 찾기", rg: "내용 찾기", sed: "파일 고치기", awk: "파일 확인",
	find: "파일 찾기", diff: "차이 확인", rm: "파일 정리", mv: "파일 정리", cp: "파일 정리", mkdir: "파일 정리", chmod: "파일 정리", touch: "파일 정리", kill: "프로그램 종료", pkill: "프로그램 종료",
	launchctl: "서비스 관리", systemctl: "서비스 관리", brew: "프로그램 설치", tmux: "작업 창", screen: "작업 창", osascript: "앱 제어", open: "앱 열기", sudo: "관리자 명령",
	scp: "파일 전송", rsync: "파일 전송", docker: "컨테이너 명령", make: "빌드", cargo: "빌드", pip: "프로그램 설치", python: "스크립트 실행", python3: "스크립트 실행", node: "스크립트 실행",
	bun: "프로그램 실행", npm: "프로그램 실행", pnpm: "프로그램 실행", yarn: "프로그램 실행", git: "변경 기록 확인", cd: "명령", echo: "명령", export: "명령", source: "명령", bash: "명령", sh: "명령", zsh: "명령",
};
const SUB: Record<string, string> = { test: "테스트", build: "빌드", install: "설치", check: "검사", lint: "검사", dev: "실행", start: "실행", push: "올리기", pull: "받아오기", commit: "변경 저장", merge: "합치기", rebase: "정리", status: "변경 확인", diff: "변경 확인", log: "변경 기록 확인", checkout: "전환", reset: "되돌리기" };
const FILE_LINE = /^[ \t]*\[file\][ \t].*$/i;
const SHELL_LANGS = new Set(["bash", "sh", "zsh", "shell", "console", "terminal", "cron", "crontab"]);

const w = (s: string): string => `\u0001${s}\u0002`;
const PAIRS: string[][] = [["이", "가"], ["은", "는"], ["을", "를"], ["과", "와"], ["으로", "로"], ["이에요", "예요"]];
// A word we put in place of a name takes the particle its last syllable asks for (모니터링 + 로 -> 모니터링으로).
function josa(t: string): string {
	const fixed = t.replace(/\u0001([^\u0001\u0002]*)\u0002([ \t]?)(이에요|예요|으로|로|이|가|은|는|을|를|과|와)(?![가-힣])/g, (m, word: string, gap: string, p: string) => {
		if (gap && p === "이") return m;
		const code = (word.at(-1) ?? "").charCodeAt(0) - 0xac00;
		if (code < 0 || code > 11171) return m;
		const batchim = code % 28, pair = PAIRS.find(x => x.includes(p))!;
		const pick = pair[0] === "으로" ? (batchim === 0 || batchim === 8 ? "로" : "으로") : batchim > 0 ? pair[0]! : pair[1]!;
		return `${word}${pick}`;
	});
	return fixed.replace(/[\u0001\u0002]/g, "");
}
const pad = (n: number): string => (n < 12 ? "오전 " : "오후 ") + (n % 12 || 12) + "시";
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
// A crontab schedule as words.
export function cronKo(expr: string): string {
	const [m = "", h = "", dom = "", mon = "", dow = ""] = expr.trim().split(/\s+/);
	const every = /^\*\/(\d+)$/, num = /^\d+$/, plain = dom === "*" && mon === "*";
	if (plain && dow === "*") {
		if (m === "*" && h === "*") return "1분마다";
		if (every.test(m) && h === "*") return `${m.slice(2)}분마다`;
		if (num.test(m) && every.test(h)) return `${h.slice(2)}시간마다`;
		if (num.test(m) && h === "*") return `매시 ${m}분`;
		if (num.test(m) && num.test(h)) return `매일 ${pad(Number(h))}${Number(m) ? ` ${m}분` : ""}`;
	}
	if (plain && num.test(m) && num.test(h) && /^[0-7]$/.test(dow)) return `매주 ${DAYS[Number(dow) % 7]}요일 ${pad(Number(h))}${Number(m) ? ` ${m}분` : ""}`;
	if (plain && num.test(m) && num.test(h) && dow === "1-5") return `평일 ${pad(Number(h))}${Number(m) ? ` ${m}분` : ""}`;
	return "정해진 시각마다";
}
const CRON = /^\s*(?:[\d*/,-]+\s+){4}[\d*/,A-Za-z-]+\s*$/;

const words = (s: string): string => {
	const parts = s.split(/[_\s]+/).filter(Boolean);
	if (parts.length > 1 && parts[0]!.toLowerCase() === "dotz") parts.shift();
	return parts.map(p => NAMES[p.toLowerCase()] ?? p).join(" ");
};
// "ssh -p 22 me@box 'ls'" -> "box에 원격 접속"
const sshKo = (s: string): string => s.replace(/\bssh\s+(?:-\S+\s+(?:\d+\s+|\S+\s+(?=\S+@|[\w.-]+\s*$))?)*(?:[\w.-]+@)?([A-Za-z0-9][\w.-]*)(?:\s+(?:'[^']*'|"[^"]*"))?/g, (_m, host: string) => `${host}에 원격 접속`);
function commandKo(s: string): string | undefined {
	const t = s.trim().replace(/^\$\s+/, "");
	const first = /^([A-Za-z][\w.-]*)(?:\s+(?:run\s+)?([a-z]+))?/.exec(t);
	if (!first) return undefined;
	const [, cmd = "", sub = ""] = first;
	if (cmd === "ssh") return sshKo(t);
	if (!(cmd in CMD_FIRST)) return undefined;
	return (cmd === "bun" || cmd === "npm" || cmd === "pnpm" || cmd === "yarn" || cmd === "git") && SUB[sub] ? SUB[sub] : CMD_FIRST[cmd];
}
const isFile = (seg: string): boolean => /\.[A-Za-z0-9]{1,6}$/.test(seg) && !/^\.[^.]+$/.test(seg);
function pathKo(p: string): string {
	const segs = p.replace(/\/+$/, "").split("/").filter(Boolean);
	const last = segs.at(-1) ?? "";
	return !p.endsWith("/") && isFile(last) ? last : "폴더";
}
const PATH = /(?<![\w@:/.~-])(?:~|\.{1,2})?(?:\/[\w@+.-]+)+\/?|(?<![\w@:/.~-])[\w@+-]+(?:\/[\w@+.-]+)+\/?/g;
const isPath = (p: string): boolean => {
	if (!/[A-Za-z]/.test(p)) return false;
	const segs = p.split("/").filter(Boolean);
	if (/^[~/.]/.test(p)) return segs.length >= 2 || isFile(segs.at(-1) ?? "") || p.startsWith("~");
	return segs.length >= 3 || isFile(segs.at(-1) ?? "");
};
const LONG_ID = /\b(?:id|uuid|hash)\s*[:=]\s*(?=[\w-]*\d)[\w-]{6,}|#\d{6,}\b|\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{16,}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12})\b/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;
const STATUS = /[ \t]*\[(?:run|done|ask|fail|warn|blocked|partial|later|ok|error|err|완료|진행|결정|실패|경고|차단|부분|나중|오류)\](?!\()/gi;
const SLASH_RE = new RegExp(`(?<![\\w/:.])\\/(${Object.keys(SLASH).join("|")})(?![\\w/가-힣-])`, "g");
const TARGET = /\b(lane|ch|th|mail|settings|auth|msg|dec)((?::[\w.@~%-]+)+)/g;

function target(kind: string, rest: string, o: PlainOpts): string {
	const id = rest.slice(1);
	if (kind === "lane") return o.lane?.(id.split(":")[0]!) ?? "세션";
	if (kind === "ch") return "채널";
	if (kind === "th") return "대화";
	if (kind === "mail") return "메일";
	if (kind === "settings") return "설정";
	if (kind === "auth") return "로그인 요청";
	return "";
}

function span(code: string, o: PlainOpts): string {
	const r = spanRaw(code, o);
	return r.startsWith("`") ? r : w(r);
}
function spanRaw(code: string, o: PlainOpts): string {
	const t = code.trim();
	if (CRON.test(t)) return cronKo(t);
	if (t.startsWith("/") && SLASH[t.slice(1).split(/\s/)[0]!]) return SLASH[t.slice(1).split(/\s/)[0]!]!;
	if (/^\/[\w가-힣-]+(?:\s|$)/.test(t) && !isPath(t)) return "명령";
	const cmd = commandKo(t);
	if (cmd) return cmd;
	if (/[|&;]\s*\w+/.test(t) && /^[a-z]/.test(t) && /\s/.test(t)) return "명령";
	if (TOOLS[t.toLowerCase()] && /^[A-Za-z]+$/.test(t)) return TOOLS[t.toLowerCase()]!;
	if (/^mcp__\w+?__\w+$/.test(t)) return words(t.split("__").at(-1)!);
	if (!/\s/.test(t) && t.includes("/") && isPath(t)) return pathKo(t);
	if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t)) return words(t);
	if (new RegExp(TARGET.source).test(t) && !/\s/.test(t)) return t.replace(TARGET, (_m, k: string, r: string) => target(k, r, o));
	return `\`${code}\``;
}

function prose(s: string, o: PlainOpts): string {
	let t = s.replace(/`?\b(Bash|Read|Edit|Write|Grep|Glob|WebFetch|WebSearch|TodoWrite)\b`?\s*(?:도구|tool\b)/g, (_m, n: string) => w(TOOLS[n.toLowerCase()]!));
	t = t.replace(/`([^`\n]+)`/g, (_m, c: string) => span(c, o));
	t = t.replace(/^[ \t]*\$[ \t]+(.+)$/gm, (_m, c: string) => w(commandKo(c) ?? "명령"));
	t = t.replace(/\bhttps?:\/\/([^\s/)>\]"'`]+)[^\s)>\]"'`]*/g, (_m, host: string) => (/^(?:localhost|\d+\.\d+\.\d+\.\d+)(?::\d+)?$/.test(host) ? "내부 주소" : host.replace(/^www\./, "")));
	t = t.replace(ISO, m => clockKo(m) || m);
	t = t.replace(PATH, m => (isPath(m) ? pathKo(m) : m));
	t = t.replace(SLASH_RE, (_m, c: string) => w(SLASH[c]!));
	t = t.replace(/\bssh\b[^\n]*/g, m => { const r = sshKo(m); return w(r === m ? "원격 접속" : r); });
	t = t.replace(/\bcron(?:tab)?\b/gi, w("예약")).replace(/\blaunch(?:d|ctl)\b/gi, w("서비스"));
	t = t.replace(/\b(bun|npm|pnpm|yarn)\s+(?:run\s+)?(test|build|install|check|lint|dev|start)\b/g, (_m, _c: string, sub: string) => w(SUB[sub]!));
	t = t.replace(/\bgit\s+(push|pull|commit|merge|rebase|status|diff|log|checkout|reset)\b/g, (_m, sub: string) => w(SUB[sub]!));
	t = t.replace(/\bmcp__\w+?__(\w+)/g, (_m, n: string) => w(words(n)));
	t = t.replace(TARGET, (_m, k: string, r: string) => w(target(k, r, o)));
	t = t.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b(?!\.[A-Za-z0-9])/g, m => w(words(m)));
	t = t.replace(LONG_ID, "");
	t = t.replace(STATUS, "");
	t = t.replace(/^\[([^\]\n]{2,30})\][ \t]+(?=\S)/gm, (m, label: string) => (/^[\d\sx]+$/i.test(label) ? m : `${label}: `));
	// An id can be all a code span held, or all a "근거:" piece: neither its marks nor its separator stay behind.
	t = t.replace(/``/g, "").replace(/(:|·)[ \t]*·/g, "$1");
	return josa(t).replace(/\(\s*[,·]?\s*\)|\[\s*\]/g, "").replace(/[ \t]+([,.!?)])/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "").replace(/[ \t]*·[ \t]*$/gm, "");
}

// An error message as the owner reads it. Korean stays; an English / HTTP one becomes a sentence; "name: <english error>" keeps the name.
export function errorKo(msg: string): string {
	const m = msg.trim();
	if (/[가-힣]/.test(m)) return m;
	const http = /^HTTP (\d{3})/.exec(m)?.[1];
	if (http) {
		const c = Number(http);
		if (c === 401) return "다시 로그인해 주세요";
		if (c === 403) return "권한이 없어요";
		if (c === 404) return "찾지 못했어요";
		if (c === 408 || c === 504) return "시간이 너무 오래 걸렸어요";
		if (c === 429) return "요청이 너무 잦아요. 잠시 뒤에 다시 해 주세요";
		return c >= 500 ? "서버에 문제가 있어요. 잠시 뒤에 다시 해 주세요" : "요청을 처리하지 못했어요";
	}
	if (/failed to fetch|network ?error|load failed|econn|enotfound|network/i.test(m)) return "연결이 끊겨 처리하지 못했어요";
	if (/time(?:d)? ?out|etimedout/i.test(m)) return "시간이 너무 오래 걸렸어요";
	if (/unauthori[sz]ed|forbidden/i.test(m)) return "권한이 없어요";
	if (/not found|enoent/i.test(m)) return "찾지 못했어요";
	return /[A-Za-z]{2,}/.test(m) ? "처리하지 못했어요. 잠시 뒤에 다시 해 주세요" : m;
}

// The text as everyday Korean. `error`: a failure message (a toast's `e.message`): its English / HTTP tail is worded too.
// A table as a one-line preview reads it: the rule line goes and a row's cells are joined. The text a card draws keeps its table.
export function plainTable(text: string): string {
	return text.split("\n").flatMap(l => {
		if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)) return [];
		const row = /^\s*\|(.*)\|\s*$/.exec(l);
		return [row ? row[1].split("|").map(c => c.trim()).filter(Boolean).join(" · ") : l];
	}).join("\n");
}
export function noticeKo(raw: string, o: PlainOpts = {}): string {
	let src = String(raw ?? "");
	let files: string[] = [];
	if (o.keepFiles) {
		const lines = src.split("\n");
		files = lines.filter(l => FILE_LINE.test(l));
		if (files.length) src = lines.filter(l => !FILE_LINE.test(l)).join("\n");
	}
	let text = stripMarkers(src);
	if (o.error) {
		const m = /^(.{1,60}?):\s+([^\n]+)$/.exec(text);
		if (m && !/[가-힣]/.test(m[2]!)) text = /[가-힣]/.test(m[1]!) ? m[1]! : /\s/.test(m[1]!) ? errorKo(text) : `${m[1]}: ${errorKo(m[2]!)}`;
		else text = errorKo(text);
	}
	let fence = false, keep = false;
	const out: string[] = [];
	let chunk: string[] = [];
	const flush = () => { if (chunk.length) out.push(prose(chunk.join("\n"), o)); chunk = []; };
	for (const line of text.split("\n")) {
		const f = /^\s*```(\S*)/.exec(line);
		if (f) {
			if (!fence) { flush(); fence = true; keep = !SHELL_LANGS.has(f[1]!.toLowerCase()); if (keep) out.push(line); }
			else { fence = false; if (keep) out.push(line); }
			continue;
		}
		if (fence) { if (keep) out.push(line); continue; }
		chunk.push(line);
	}
	flush();
	const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	return files.length ? `${body}\n${files.join("\n")}`.trim() : body;
}
