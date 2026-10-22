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
function watchLine(label, reason, output = "", opts = {}) {
  const out = String(output || "").trim(), first = `${humanLabel(label)}: ${watchReasonKo(reason)}${opts.note ? ` ${opts.note}` : ""}`;
  if (!out) return first;
  const issue = wtIssue(reason);
  if (!issue && !isMachineOutput(out) && WT_HANGUL.test(out)) return `${first}\n${out}`;
  const lines = [first], summary = issue ? "" : watchSummary(out, opts.now, opts.tz);
  if (summary) lines.push(summary);
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
