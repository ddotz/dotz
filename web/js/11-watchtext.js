// The words the owner reads for a watch event or a schedule fire; mirrors hub/watchtext.ts (the hub composes the same text for the bell, Discord and
// the 알림 conversation; this one words the events the web gets raw: inbox "watch" and "schedule"). Raw output never goes in the prose: a one-line
// summary where it is generic, the raw text folded under a "원문" fence (02-basic-markdown.js renders it collapsed).
function watchReasonKo(reason) {
  const r = String(reason || "").trim();
  if (r === "output changed" || r === "change") return "결과가 바뀌었어요";
  if (r === "match" || r.startsWith("matched /")) return "찾던 내용이 나왔어요";
  if (r === "fail") return "점검에 실패했어요";
  if (r === "recovered") return "다시 정상이에요";
  const fails = (r.match(/^failed (\d+) times in a row/) || [])[1];
  if (fails) return `${fails}번 연속 실패했어요`;
  if (r.startsWith("stopped after")) return "실패가 이어져 멈췄어요. 승인하면 다시 돌아요";
  if (r.startsWith("needs the owner")) return "승인이 필요해요";
  return r;
}
function humanLabel(label, fallback = "모니터링") {
  const s = String(label || "").trim();
  if (!s) return fallback;
  return /^[a-z0-9][a-z0-9_-]*$/.test(s) ? s.replace(/[-_]+/g, " ") : s;
}
const WT_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/, WT_HANGUL = /[가-힣]/, WT_PAIR = /(?:^|\s)[A-Za-z_][\w.-]*=\S+/g;
function isMachineOutput(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^[{[]/.test(t)) { try { JSON.parse(t); return true; } catch { /* not JSON: fall through to the line checks */ } }
  return WT_ISO.test(t) || t.split("\n").some(l => (l.match(WT_PAIR) || []).length >= 2);
}
function clockKo(iso, now = Date.now(), tz = "Asia/Seoul") {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const time = new Intl.DateTimeFormat("ko-KR", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);
  const day = t => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t);
  if (day(ms) === day(now)) return time;
  return `${new Intl.DateTimeFormat("ko-KR", { timeZone: tz, month: "long", day: "numeric" }).format(ms)} ${time}`;
}
function watchSummary(output, now, tz) {
  const o = String(output || ""), count = Number((o.match(/(?:^|\s)new=(\d+)(?:\s|$)/) || [])[1] || 0), at = (o.match(WT_ISO) || [])[0];
  return [count > 0 ? `새 소식 ${count}건` : "", at ? clockKo(at, now, tz) : ""].filter(Boolean).join(" · ");
}
function rawFence(raw) {
  const lines = String(raw || "").trim().split("\n").filter(l => l.trim());
  let body = lines.slice(0, 5).map(l => (l.length > 160 ? `${l.slice(0, 159)}…` : l)).join("\n");
  if (body.length > 600) body = `${body.slice(0, 599)}…`;
  else if (lines.length > 5) body += "\n…";
  return `\`\`\`원문\n${body.replace(/```/g, "'''")}\n\`\`\``;
}
const wtIssue = reason => /^(?:fail\b|failed \d+|stopped after|needs the owner)/.test(String(reason || "").trim());
const WT_ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, WT_ISO_ALL = new RegExp(WT_ISO.source, "g");
const WT_LONG_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{9,})\b/gi;
const WT_FAIL = {
  login: "로그인이 풀렸어요", session: "로그인이 풀렸어요", auth: "로그인이 풀렸어요", expired: "로그인이 풀렸어요",
  approval: "승인이 필요해요", fetch: "내용을 가져오지 못했어요", network: "네트워크에 연결하지 못했어요", timeout: "시간이 너무 오래 걸렸어요",
  captcha: "보안 확인(캡차)이 필요해요", off: "연동이 꺼져 있어요", app: "앱이 꺼져 있어요", browser: "브라우저를 열지 못했어요",
  parse: "화면 구조가 바뀌어 읽지 못했어요", rate: "요청이 너무 잦아 잠시 막혔어요", limit: "요청이 너무 잦아 잠시 막혔어요",
};
const wtTidy = (l, now, tz) => l.replace(WT_ANSI, "").replace(WT_ISO_ALL, m => clockKo(m, now, tz)).replace(WT_LONG_ID, "").replace(/\s+/g, " ").trim();
const wtLines = (s, now, tz) => s.replace(WT_ANSI, "").replace(/\r/g, "").split("\n").map(l => wtTidy(l, now, tz)).filter(Boolean);
const wtPlain = l => {
  if (l.length > 160 || /\S=\S/.test(l) || /\w_\w/.test(l)) return false;
  const letters = (l.match(/[가-힣A-Za-z0-9]/g) || []).length;
  return /[가-힣A-Za-z]{2,}/.test(l) && letters >= l.length * 0.6;
};
const wtCut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const wtItems = list => list.slice(0, 3).join(" · ") + (list.length > 3 ? " 외 " + (list.length - 3) + "건" : "");
function wtFlat(v, key, out, now, tz) {
  if (out.length >= 8) return;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) if (!/(?:^|_)(?:id|uuid|token)$/i.test(k)) wtFlat(x, key ? key + "." + k : k, out, now, tz);
    return;
  }
  const val = Array.isArray(v) ? v.map(x => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : String(v);
  const shown = wtTidy(val, now, tz);
  if (shown) out.push((key || "값") + ": " + wtCut(shown, 80));
}
function describeOutput(output, opts = {}) {
  const out = String(output || "").replace(WT_ANSI, "").trim();
  if (!out) return { text: "", readable: true };
  const fail = /^DOTZ_FAIL[ =:]([a-z0-9-]{1,20})\b/m.exec(out);
  if (fail) {
    const said = wtLines(out, opts.now, opts.tz).filter(l => !l.startsWith("DOTZ_") && WT_HANGUL.test(l) && !isMachineOutput(l)).slice(0, 2);
    return { text: [WT_FAIL[fail[1]] || "점검에 실패했어요", ...said.map(l => wtCut(l, 120))].join("\n"), readable: true };
  }
  if (/^[{[]/.test(out)) {
    try {
      const rows = [];
      wtFlat(JSON.parse(out), "", rows, opts.now, opts.tz);
      if (rows.length) return { text: rows.join("\n"), readable: true };
    } catch { /* not JSON: the line rules below */ }
  }
  if (opts.issue) return { text: "", readable: true };
  if (isMachineOutput(out)) {
    const s = watchSummary(out, opts.now, opts.tz);
    return { text: s, readable: !!s };
  }
  const cur = wtLines(out, opts.now, opts.tz), marked = cur.filter(l => /^[+-](?![+-]{2})\s?\S/.test(l));
  let added, removed = [];
  if (opts.prev !== undefined && String(opts.prev).trim()) {
    const old = wtLines(String(opts.prev), opts.now, opts.tz), had = new Set(old), has = new Set(cur);
    added = cur.filter(l => !had.has(l));
    removed = old.filter(l => !has.has(l));
  } else if (marked.length && marked.length >= cur.length / 2) {
    added = marked.filter(l => l.startsWith("+")).map(l => l.slice(1).trim());
    removed = marked.filter(l => l.startsWith("-")).map(l => l.slice(1).trim());
  }
  if (added) {
    if (![...added, ...removed].every(wtPlain)) return { text: "", readable: false };
    const said = [added.length ? "새로 생겼어요: " + wtItems(added) : "", removed.length ? "사라졌어요: " + wtItems(removed) : ""].filter(Boolean);
    return { text: said.join("\n") || "내용은 그대로이고 시각 같은 값만 바뀌었어요", readable: true };
  }
  if (WT_HANGUL.test(out)) return { text: out, readable: true };
  if (cur.length <= 3 && cur.every(wtPlain)) return { text: cur.join("\n"), readable: true };
  return { text: "", readable: false };
}
function watchLine(label, reason, output = "", opts = {}) {
  const out = String(output || "").trim(), first = humanLabel(label) + ": " + watchReasonKo(reason) + (opts.note ? " " + opts.note : "");
  if (!out) return first;
  const d = describeOutput(out, { prev: opts.prev, issue: wtIssue(reason), now: opts.now, tz: opts.tz });
  const text = d.readable ? d.text : opts.summary || "";
  if (text && text === out) return first + "\n" + out;
  const lines = [first];
  if (text) lines.push(text);
  if (opts.raw !== false) lines.push(rawFence(out));
  return lines.join("\n");
}
function scheduleLine(text, opts = {}) {
  const body = String(text || "").replace(/^\s*(?:(?:ch|lane|th):\S+\s*)+/, "").trim(), first = body.split("\n")[0].trim();
  const said = WT_HANGUL.test(first) && !isMachineOutput(first) ? (first.length > 60 ? `${first.slice(0, 59)}…` : first) : "";
  if (opts.raw === false) return said || "예약한 일이 시작됐어요";
  const lines = ["예약한 일이 시작됐어요"];
  if (said) lines.push(said);
  if (body && body !== said) lines.push(rawFence(body));
  return lines.join("\n");
}
