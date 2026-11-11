// The words the owner reads for a watch event or a schedule fire; mirrors hub/watchtext.ts (the hub composes the same text for the bell, Discord and
// the 알림 conversation; this one words the events the web gets raw: inbox "watch" and "schedule"). Raw output never goes in the prose: a one-line
// summary where it is generic, the raw text folded under a "원문" fence (02-basic-markdown.js renders it collapsed).
function watchReasonKo(reason) {
  const r = String(reason || "").trim();
  if (r === "output changed" || r === "change") return TX("home.watch.changed");
  if (r === "match" || r.startsWith("matched /")) return TX("home.watch.matched");
  if (r === "fail") return TX("home.watch.check_failed");
  if (r === "recovered") return TX("home.watch.recovered");
  // hub/release-exit.ts SLOT_SKIPPED_EXIT: the release-slot watch fails every minute of a skipped slot; that is one skipped slot, not that many failed checks.
  if (/^failed \d+ times in a row.*\(exit 3\)$/.test(r)) return TX("home.watch.slot_skipped");
  const fails = (r.match(/^failed (\d+) times in a row/) || [])[1];
  if (fails) return TX("home.watch.fails", { n: Number(fails) });
  if (r.startsWith("stopped after a password")) return TX("home.watch.no_password");
  if (r.startsWith("stopped after")) return TX("home.watch.stopped");
  if (r.startsWith("needs the owner's approval for a second factor")) return TX("home.watch.second_factor");
  if (r.startsWith("needs the owner")) return TX("home.watch.needs_approval");
  return r;
}
function humanLabel(label, fallback = TX("common.monitoring")) {
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
  const time = new Intl.DateTimeFormat(TX_LOCALE, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);
  const day = t => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t);
  if (day(ms) === day(now)) return time;
  return `${new Intl.DateTimeFormat(TX_LOCALE, { timeZone: tz, month: "long", day: "numeric" }).format(ms)} ${time}`;
}
function watchSummary(output, now, tz) {
  const o = String(output || ""), count = Number((o.match(/(?:^|\s)new=(\d+)(?:\s|$)/) || [])[1] || 0);
  const lines = o.split("\n").filter(l => l.trim()).length, log = !count && lines > 2, at = (log ? (o.match(WT_ISO_ALL) || []).at(-1) : undefined) || (o.match(WT_ISO) || [])[0];
  return [count > 0 ? TX("home.watch.news", { n: count }) : "", log ? TX("home.watch.log_lines", { n: lines }) : "", at ? (log ? TX("home.watch.last", { time: clockKo(at, now, tz) }) : clockKo(at, now, tz)) : ""].filter(Boolean).join(" · ");
}
function rawFence(raw) {
  const lines = String(raw || "").trim().split("\n").filter(l => l.trim());
  let body = lines.slice(0, 5).map(l => (l.length > 160 ? `${l.slice(0, 159)}…` : l)).join("\n");
  if (body.length > 600) body = `${body.slice(0, 599)}…`;
  else if (lines.length > 5) body += "\n…";
  return `\`\`\`원문\n${body.replace(/```/g, "'''")}\n\`\`\``;
}
// One token a check prints for its own filter: a program's word, not a line to read. A match whose whole output is that token says nothing more.
const WT_SENTINEL = /^(?:[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+|[A-Z][A-Z0-9_-]{3,})$/;
const wtSentinelMatch = (reason, out) => String(reason || "").trim().startsWith("match") && WT_SENTINEL.test(String(out).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "").trim());
const wtIssue = reason => /^(?:fail\b|failed \d+|stopped after|needs the owner)/.test(String(reason || "").trim());
const WT_ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, WT_ISO_ALL = new RegExp(WT_ISO.source, "g");
const WT_LONG_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{9,})\b/gi;
const WT_FAIL = {
  login: TX("home.watch.fail_login"), session: TX("home.watch.fail_login"), auth: TX("home.watch.fail_login"), expired: TX("home.watch.fail_login"),
  approval: TX("home.watch.needs_approval"), fetch: TX("home.watch.fail_fetch"), network: TX("home.watch.fail_network"), timeout: TX("home.watch.fail_timeout"),
  captcha: TX("home.watch.fail_captcha"), off: TX("home.watch.fail_off"), app: TX("home.watch.fail_app"), browser: TX("home.watch.fail_browser"),
  parse: TX("home.watch.fail_parse"), rate: TX("home.watch.fail_rate"), limit: TX("home.watch.fail_rate"),
};
const wtTidy = (l, now, tz) => l.replace(WT_ANSI, "").replace(WT_ISO_ALL, m => clockKo(m, now, tz)).replace(WT_LONG_ID, "").replace(/\s+/g, " ").trim();
const wtLines = (s, now, tz) => s.replace(WT_ANSI, "").replace(/\r/g, "").split("\n").map(l => wtTidy(l, now, tz)).filter(Boolean);
const wtPlain = l => {
  if (l.length > 160 || /\S=\S/.test(l) || /\w_\w/.test(l) || WT_SENTINEL.test(l)) return false;
  const letters = (l.match(/[가-힣A-Za-z0-9]/g) || []).length;
  return /[가-힣A-Za-z]{2,}/.test(l) && letters >= l.length * 0.6;
};
const wtCut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const wtRows = list => [...list.slice(0, 3), ...(list.length > 3 ? [TX("home.watch.more", { n: list.length - 3 })] : [])].map(l => "- " + l);
// hub/watchtext.ts keepMoved / changeTitle: a removed item still among the added ones changed kind, it did not go; the title counts the change.
const WT_KIND = /^([^:\n]{1,20}?):\s+(\S.*)$/;
const WT_REF = /(?:^|\s)([\w.-]+\/[\w.-]+#\d+)(?=\s|$)/;
const wtKey = l => (WT_REF.exec(l) || [])[1] ?? ((WT_KIND.exec(l) || [])[2] || "").match(/^\S+\s+\S.*$/)?.[0] ?? l;
const wtKind = l => { const m = WT_KIND.exec(l); return m ? m[1].split(" → ").pop() : ""; };
function wtKeepMoved(added, removed) {
  const gone = new Map(removed.map(l => [wtKey(l), l])), moved = new Set();
  const now = added.map(l => {
    const old = gone.get(wtKey(l));
    if (old === undefined) return l;
    moved.add(old);
    const was = (WT_KIND.exec(old) || [])[1], is = (WT_KIND.exec(l) || [])[1];
    return was && is && was !== is ? was + " → " + l : l;
  });
  return { added: now, removed: removed.filter(l => !moved.has(l)) };
}
function wtKindTitle(lines) {
  const kinds = [...new Set(lines.map(wtKind))];
  if (kinds.length > 2 || !kinds.every(k => k && k.length <= 12)) return undefined;
  return kinds.map(k => TX("home.watch.kind_count", { kind: k, n: lines.filter(l => wtKind(l) === k).length })).join(" · ");
}
function wtChangeTitle(added, removed) {
  const a = added.length ? [wtKindTitle(added) ?? TX("home.watch.new_items", { n: added.length })] : [];
  return [...a, ...(removed.length ? [TX("home.watch.removed_items", { n: removed.length })] : [])].join(" · ");
}
// hub/watchtext.ts matchTitle: a match that lists items one per line is counted as a change is.
function wtMatchTitle(output) {
  if (!WT_HANGUL.test(output) || isMachineOutput(output)) return undefined;
  const items = wtLines(output).map(l => l.replace(/^[-•]\s+/, "")).filter(l => !WT_SENTINEL.test(l));
  if (!items.length || !items.every(l => /^\S.{0,40}?:\s+\S/.test(l))) return undefined;
  return wtKindTitle(items) ?? (items.length > 1 ? TX("home.watch.matching_items", { n: items.length }) : undefined);
}
// hub/watchtext.ts matchItems: under a count that names one kind ("새 PR 1건"), an item does not say that kind again.
function wtMatchItems(text, title) {
  const kind = (/^(.+?)(?: \d+건| \(\d+\))$/.exec(title) || [])[1];
  if (!kind || kind.includes(" · ")) return text;
  return text.replace(/^([ \t]*(?:[-•][ \t]+)?)([^:\n]{1,20}?):[ \t]+(?=\S)/gm, (m, pre, k) => (k === kind ? pre : m));
}
function wtFlat(v, key, out, now, tz) {
  if (out.length >= 8) return;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) if (!/(?:^|_)(?:id|uuid|token)$/i.test(k)) wtFlat(x, key ? key + "." + k : k, out, now, tz);
    return;
  }
  const val = Array.isArray(v) ? v.map(x => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : String(v);
  const shown = wtTidy(val, now, tz);
  if (shown) out.push((key ? key.split(".").map(k => WT_JSON_KEY[k.toLowerCase()] || k).filter((w, i, a) => w !== a[i - 1]).join(" ") : TX("home.watch.value")) + ": " + wtCut(WT_JSON_VALUE[shown.toLowerCase()] || shown, 80));
}
const WT_JSON_KEY = {
  status: TX("home.watch.json_status"), state: TX("home.watch.json_status"), count: TX("home.watch.json_count"), total: TX("home.watch.json_total"), title: TX("home.watch.json_title"), name: TX("home.watch.json_name"), at: TX("home.watch.json_time"), time: TX("home.watch.json_time"), date: TX("home.watch.json_date"), updated_at: TX("home.watch.json_updated"),
  created_at: TX("home.watch.json_created"), checked_at: TX("home.watch.json_checked"), latest: TX("home.watch.json_latest"), last: TX("home.watch.json_last"), price: TX("home.watch.json_price"), message: TX("home.watch.json_message"), error: TX("home.watch.json_error"), version: TX("home.watch.json_version"), items: TX("home.watch.json_items"), url: TX("home.watch.json_url"),
};
const WT_JSON_VALUE = { ok: TX("home.watch.json_ok"), true: TX("home.watch.json_yes"), false: TX("home.watch.json_no"), error: TX("home.watch.json_error"), fail: TX("home.watch.json_failed"), failed: TX("home.watch.json_failed") };
function describeOutput(output, opts = {}) {
  const out = String(output || "").replace(WT_ANSI, "").trim();
  if (!out) return { text: "", readable: true };
  const fail = /^DOTZ_FAIL[ =:]([a-z0-9-]{1,20})\b/m.exec(out);
  if (fail) {
    const said = wtLines(out, opts.now, opts.tz).filter(l => !l.startsWith("DOTZ_") && WT_HANGUL.test(l) && !isMachineOutput(l)).slice(0, 2);
    return { text: [WT_FAIL[fail[1]] || TX("home.watch.check_failed"), ...said.map(l => wtCut(l, 120))].join("\n"), readable: true };
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
    if (!added.length && !removed.length) return { text: TX("home.watch.unchanged"), readable: true };
    ({ added, removed } = wtKeepMoved(added, removed));
    const head = added.length && removed.length && !added.every(wtKind) ? [TX("home.watch.fresh")] : [];
    return { text: [...head, ...wtRows(added), ...(removed.length ? [TX("home.watch.gone"), ...wtRows(removed)] : [])].join("\n"), title: wtChangeTitle(added, removed), readable: true };
  }
  if (WT_HANGUL.test(out)) return { text: out.split("\n").filter(l => !WT_SENTINEL.test(l.trim())).join("\n"), readable: true };
  if (cur.length <= 3 && cur.every(wtPlain)) return { text: cur.join("\n"), readable: true };
  return { text: "", readable: false };
}
function watchLine(label, reason, output = "", opts = {}) {
  const out = String(output || "").trim(), head = said => humanLabel(label) + ": " + said + (opts.note ? " " + opts.note : "");
  if (!out || wtSentinelMatch(reason, out)) return head(watchReasonKo(reason));
  if (String(reason).trim() === "recovered" && /^[\w.-]{1,12}$/.test(out)) return head(watchReasonKo(reason)) + "\n" + TX("home.watch.passes_again");
  const d = describeOutput(out, { prev: opts.prev, issue: wtIssue(reason), now: opts.now, tz: opts.tz });
  const listed = String(reason).trim().startsWith("match") && d.text !== TX("home.watch.unchanged") ? wtMatchTitle(out) : undefined;
  const said = /^(output changed|change|match|matched \/)/.test(String(reason).trim()) && d.readable && (d.title ?? listed);
  const first = head(said || watchReasonKo(reason));
  const text = d.readable ? d.text : opts.summary || "";
  const shown = listed && said === listed ? wtMatchItems(text, listed) : text;
  if (text && text === out) return first + "\n" + shown;
  const lines = [first];
  if (shown) lines.push(shown);
  if (opts.raw !== false) lines.push(rawFence(out));
  return lines.join("\n");
}
// hub/watchtext.ts scheduleLabel: a schedule's short name, its first sentence without what it runs.
const WT_CMD = /\b[\w.-]+\.(?:md|jsonl?|ya?ml|toml|log|py|sh)\b|\b(?:ssh|scp|rsync|curl|wget|python3?|node|bun|npm|npx|bash|zsh|git|sudo|docker|osascript)\s+(?:-|[\w.-]*@|~|\.{0,2}\/|[\w.-]+\.(?:py|sh|js|ts|mjs)\b)|(?:^|\s)-{1,2}[A-Za-z][\w-]*(?:=|\s|$)|\s[<>|]{1,2}\s|\$\(|~\/|(?:^|\s)\.{0,2}\/[\w.-]+\/|@\d{1,3}(?:\.\d{1,3}){3}/;
const WT_RUNS = new RegExp(["`[^`\\n]*(?:`|$)", "(?<!\\S)(?:~|\\.{1,2})?\\/[\\w.\\/-]*[\\w\\/]", "(?<![\\w.\\/-])[\\w.\\/-]*\\.(?:md|jsonl?|ya?ml|toml|log|py|sh|ts|js|mjs)\\b", "\\b(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\\b"]
  .map(p => p + "(?:대로|으로|에서|로|을|를|이|가|은|는|에|의)?").join("|"), "g");
function wtScheduleLabel(text) {
  let s = (String(text || "").replace(/^\s*(?:(?:ch|lane|th):\S+\s*)+/, "").trim().split("\n")[0] || "").replace(/\s+/g, " ");
  s = s.replace(/\s*[(（][^()（）]*(?:[)）]|$)/g, m => (WT_CMD.test(m) || /^\s*[(（]state\s/.test(m) ? "" : m)).replace(WT_RUNS, "");
  s = s.replace(/[ \t]*[,·][ \t]*([)）])/g, "$1").replace(/([(（])[ \t]*[,·][ \t]*/g, "$1").replace(/\s*[(（]\s*[)）]/g, "");
  s = s.replace(/\s+([,.!?)])/g, "$1").replace(/\s{2,}/g, " ").trim();
  if (WT_CMD.test(s)) {
    const i = s.search(/[:：]\s/), keep = [];
    for (const t of (i > 0 ? s.slice(0, i) : s).split(/(?<=[.!?。])\s+/)) { if (WT_CMD.test(t)) break; keep.push(t); }
    s = keep.join(" ");
  }
  const sentence = (s.split(/(?<=[.!?。])\s+/)[0] || "").replace(/[\s,·:.。]+$/, ""), head = sentence.split(/[:：]\s/)[0].trim();
  let label = sentence;
  if (sentence.length > 40 && head !== sentence && head.length <= 40 && /[가-힣A-Za-z]{2,}/.test(head)) label = head;
  else if (sentence.length > 40) { const t = sentence.slice(0, 39), at = t.lastIndexOf(" "); label = (at > 20 ? t.slice(0, at) : t).replace(/[\s,·:(]+$/, "") + "…"; }
  return /[가-힣A-Za-z]{2,}/.test(label) && !isMachineOutput(label) ? label : "";
}
function scheduleLine(text, opts = {}) {
  const body = String(text || "").replace(/^\s*(?:(?:ch|lane|th):\S+\s*)+/, "").trim(), label = wtScheduleLabel(body);
  const said = WT_HANGUL.test(label) ? label : "";
  if (opts.raw === false) return said || TX("home.watch.schedule_started");
  const lines = [TX("home.watch.schedule_started")];
  if (said) lines.push(said);
  if (body && body !== said) lines.push(rawFence(body));
  return lines.join("\n");
}
