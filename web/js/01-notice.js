// The wording of anything that reaches the owner as a notice. Korean: the Korean engine (01-notice-ko.js, generated from hub/notice-ko.ts) unchanged.
// Any other language: no word substitution. Marks are stripped, the text stays as written, and an error or a cron schedule is worded from the notice.* catalog.
// hub/notice.ts runs this file for a non-Korean install, so a push and the page word things the same way (stripMarkers and clockKo are given to it).
const NOTICE_MARK = /[ \t]*\[(?:run|done|ask|fail|warn|blocked|partial|later|ok|error|err|완료|진행|결정|실패|경고|차단|부분|나중|오류)\](?!\()/gi;
const NOTICE_HANGUL = /[가-힣]/;

function noticeErrorText(msg) {
  const m = String(msg).trim();
  if (NOTICE_HANGUL.test(m)) return m;
  const http = /^HTTP (\d{3})/.exec(m)?.[1];
  if (http) {
    const c = Number(http);
    if (c === 401) return TX("notice.err.signin");
    if (c === 403) return TX("notice.err.denied");
    if (c === 404) return TX("notice.err.notfound");
    if (c === 408 || c === 504) return TX("notice.err.slow");
    if (c === 429) return TX("notice.err.toomany");
    return c >= 500 ? TX("notice.err.server") : TX("notice.err.request");
  }
  if (/failed to fetch|network ?error|load failed|econn|enotfound|network/i.test(m)) return TX("notice.err.network");
  if (/time(?:d)? ?out|etimedout/i.test(m)) return TX("notice.err.slow");
  if (/unauthori[sz]ed|forbidden/i.test(m)) return TX("notice.err.denied");
  if (/not found|enoent/i.test(m)) return TX("notice.err.notfound");
  return m;
}

function noticeCron(expr) {
  const [m = "", h = "", dom = "", mon = "", dow = ""] = expr.trim().split(/\s+/);
  const every = /^\*\/(\d+)$/, num = /^\d+$/, plain = dom === "*" && mon === "*";
  // Sunday 2024-01-07 + dow, read in UTC so the clock the schedule names is the clock shown.
  const at = (day, hour, min) => new Date(Date.UTC(2024, 0, 7 + day, hour, min));
  const time = (hour, min) => new Intl.DateTimeFormat(TX_LOCALE, { timeZone: "UTC", hour: "numeric", minute: min ? "2-digit" : undefined }).format(at(0, hour, min));
  const clock = num.test(m) && num.test(h) && Number(h) < 24 && Number(m) < 60;
  if (plain && dow === "*") {
    if (m === "*" && h === "*") return TX("notice.cron.minutes", { n: 1 });
    if (every.test(m) && h === "*") return TX("notice.cron.minutes", { n: Number(m.slice(2)) });
    if (num.test(m) && every.test(h)) return TX("notice.cron.hours", { n: Number(h.slice(2)) });
    if (num.test(m) && h === "*") return TX("notice.cron.hourly", { m: m.padStart(2, "0") });
    if (clock) return TX("notice.cron.daily", { time: time(Number(h), Number(m)) });
  }
  if (plain && clock && /^[0-7]$/.test(dow)) {
    const day = new Intl.DateTimeFormat(TX_LOCALE, { timeZone: "UTC", weekday: "long" }).format(at(Number(dow) % 7, 0, 0));
    return TX("notice.cron.weekly", { day, time: time(Number(h), Number(m)) });
  }
  if (plain && clock && dow === "1-5") return TX("notice.cron.weekdays", { time: time(Number(h), Number(m)) });
  return TX("notice.cron.other");
}

function noticeDropId(s) {
  return String(s).replace(/`[^`\n]+`|[ \t]*\((?:st_[0-9a-f]{8}|(?:ch|th):\d{10,})\)|(?<![\w/.:=-])st_[0-9a-f]{8}(?:,[ \t]*st_[0-9a-f]{8})*(?![\w-]|\.\w)/g, m => {
    if (m[0] === "`") return m;
    if (m.trimStart()[0] === "(") return "";
    const n = m.split(",").length;
    return n > 1 ? TX("notice.worker.many", { n }) : TX("notice.worker.one");
  });
}

function noticePlain(raw, o = {}) {
  let src = String(raw ?? ""), files = [];
  if (o.keepFiles) {
    const lines = src.split("\n");
    files = lines.filter(l => /^[ \t]*\[file\][ \t].*$/i.test(l));
    if (files.length) src = lines.filter(l => !/^[ \t]*\[file\][ \t].*$/i.test(l)).join("\n");
  }
  let text = stripMarkers(src);
  if (o.error) {
    const m = /^(.{1,60}?):\s+([^\n]+)$/.exec(text);
    if (m && !NOTICE_HANGUL.test(m[2])) text = NOTICE_HANGUL.test(m[1]) ? m[1] : /\s/.test(m[1]) ? noticeErrorText(text) : `${m[1]}: ${noticeErrorText(m[2])}`;
    else text = noticeErrorText(text);
  }
  let fence = false;
  const body = text.split("\n").map(line => {
    if (/^\s*```/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    return line.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(NOTICE_MARK, ""))).join("").replace(/[ \t]+$/, "");
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return files.length ? `${body}\n${files.join("\n")}`.trim() : body;
}

const { noticeKo, errorKo, cronKo, plainTable, dropIdNote } = I18N_LANG === "ko"
  ? NOTICE_KO
  : { noticeKo: noticePlain, errorKo: noticeErrorText, cronKo: noticeCron, plainTable: NOTICE_KO.plainTable, dropIdNote: noticeDropId };
