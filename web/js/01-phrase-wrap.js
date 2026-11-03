// Korean line breaks by meaning, like Netflix subtitles (web/DESIGN.md Type). keep-all already keeps words whole; this keeps
// phrases whole. A copy text is cut into nested chunks: sentences (and " · " items), then comma clauses, then connective phrases
// (…고 …면 …지만 …는데). Each chunk with siblings becomes an inline-block, so the browser breaks between the biggest units that fit:
// a sentence that fits the rest of the line stays there, one that does not starts the next line whole, and only a chunk wider than
// the line breaks inside, at its next smaller unit (finally at words). A bracketed or quoted group never splits.
// No measuring: the text is cut once when it is put on the page (one MutationObserver), textContent stays exactly the same.
const WPH_TRAIL = /[)\]}」』”’>"']+$/;
const WPH_OPEN = { "(": ")", "[": "]", "{": "}", "「": "」", "『": "』", "“": "”", "‘": "’" };
const WPH_SEP = /^[·•|—–]$/;
const WPH_CONN = /(?:고|면|며|서|지만|는데|은데|인데|니까|으니|려면|도록|거나|든지|다가|면서|므로|라서|어도|아도|해도|여도|더라도|자마자|때|뒤|후|전에|대신|라면|다면|이면)$/;

// How strongly a line may break after word w: 1 sentence or list item, 2 clause, 3 connective phrase, 4 between plain words.
function phraseLevel(w) {
  const bare = w.replace(WPH_TRAIL, "");
  if (/[.?!…。]$/.test(bare) || /[·•|]$/.test(bare)) return 1;
  if (/[,，;:]$/.test(bare)) return 2;
  return WPH_CONN.test(bare) && !/에서$/.test(bare) ? 3 : 4;
}

// Words that read as one: a one-syllable word and the next ("한 번", "안 정했어요", "할 수"), a short Latin word and the short noun after it
// ("API 키를"). Such a unit, like a bracketed group, keeps its space but never breaks there.
const phraseGlue = (w, next) => /^[가-힣]$/.test(w) || (/^[A-Za-z][A-Za-z0-9+.-]{0,7}$/.test(w) && /^[가-힣]{1,2}[.,!?]?$/.test(next));

// Sentences of clauses of phrases of units, or null when the text is one unit. Every level is a list of [content, gap]: content is
// the next level's list (a unit: its exact substring) and gap the original whitespace after it, so joining gives the text back.
function phraseTree(text) {
  const words = [];
  let cur = "", gap = "", want = [];
  for (const [, ws, tok] of String(text).matchAll(/(\s+)|(\S+)/g)) {
    if (ws) { if (want.length && cur.length <= 40) cur += ws; else if (cur) gap = ws; continue; }
    if (gap && cur) { words.push([cur, gap]); cur = ""; gap = ""; want = []; }
    // a lone separator (" · ") ends the word before it, so it stays at the end of that line
    if (WPH_SEP.test(tok) && !cur && words.length) { const last = words[words.length - 1]; last[0] += last[1] + tok; last[1] = ""; cur = last[0]; words.pop(); continue; }
    cur += tok;
    for (const ch of tok) {
      if (ch === '"') { if (want[want.length - 1] === '"') want.pop(); else want.push('"'); }
      else if (WPH_OPEN[ch]) want.push(WPH_OPEN[ch]);
      else if (ch === want[want.length - 1]) want.pop();
    }
    if (cur.length > 40) want = [];
  }
  if (cur) words.push([cur, gap]);
  for (let i = words.length - 2; i >= 0; i--) if (phraseGlue(words[i][0], words[i + 1][0])) words.splice(i, 2, [words[i][0] + words[i][1] + words[i + 1][0], words[i + 1][1]]);
  if (words.length < 2) return null;
  const split = (list, max) => {
    const out = []; let run = [];
    list.forEach(([w, g], i) => { run.push([w, g]); if (i === list.length - 1 || phraseLevel(w) <= max) { out.push(run); run = []; } });
    return out;
  };
  const node = (run, lv) => [lv === 3 ? run : split(run, lv + 1).map(r => node(r, lv + 1)), run[run.length - 1][1]];
  const tree = split(words, 1).map(r => node(r, 1));
  const one = tree.length === 1 && tree[0][0].length === 1 && tree[0][0][0][0].length === 1 ? tree[0][0][0][0][0][0] : null;
  return one && (one.length === 1 || !one.some(([u]) => /\s/.test(u))) ? null : tree;
}

// The tree as plain arrays of strings (the gaps dropped), for reading and testing the split points.
const phraseChunks = text => (phraseTree(text) || []).map(([s]) => s.map(([c]) => c.map(([p]) => p.map(([u]) => u))));

const WPH_COPY = [".sup", ".note", ".empty", ".hc-none", ".cv-empty", ".bell-none", ".dr-none", ".dc-q", ".dc-ds", ".fs-body", ".md p", ".md li", ".md blockquote",
  "dialog p", "[class$='-note']", "[class*='-note ']", "[class$='-sub']", "[class*='-sub ']", "[class$='-hint']", "[class*='-hint ']", "[class$='-desc']",
  "[class*='-desc ']", "[class$='-msg']", "[class$='-body']", "[class*='-body ']"].join(", ");
// code, inputs, links (an underline does not reach into an inline-block), mail bodies, the file viewer, and boxes that clamp or
// ellipsize their text (an inline-block there would hide whole phrases instead of trimming the last line)
const WPH_SKIP = ["pre", "code", "kbd", "samp", "textarea", "input", "select", "svg", "a", "[contenteditable]", ".btn", ".chip", ".tag", ".mb", ".mb-txt", ".tv-body",
  ".clamp", "[class*='clamp']", ".ntf .bd2", ".pn .pt", ".ml-snip", ".qt", ".lg-q", ".lb", ".pj-sc .tx", ".hm-n .s", ".hm-sh .s", ".wh", ".rq-orig",
  ".tr-rb", ".mr-sum", "#tl .bm", ".dr-ob", ".kk-lp-t", ".kk-lp-d", ".fr-sum", ".rc-title", ".mt-head .sup", ".ended .sup", ".sh-t .sup", ".wph"].join(", ");

function phraseFrag(tree) {
  const box = (into, text) => { const b = document.createElement("span"); b.className = "wph"; if (text) b.append(text); into.append(b); return b; };
  // a phrase: its units as plain text, a unit with a space inside as its own box
  const units = (into, list) => {
    let run = "";
    list.forEach(([u, gap], i) => {
      if (list.length > 1 && /\s/.test(u)) { if (run) into.append(run); run = ""; box(into, u); } else run += u;
      if (i < list.length - 1) run += gap;
    });
    if (run) into.append(run);
  };
  const put = (into, list, lv) => list.forEach(([content, gap], i) => {
    const b = list.length > 1 ? box(into) : into;
    if (lv === 3) units(b, content); else put(b, content, lv + 1);
    if (gap && i < list.length - 1) into.append(gap);
  });
  const f = document.createDocumentFragment();
  put(f, tree, 1);
  return f;
}

function phraseText(t) {
  const s = t.data;
  if (s.length < 12 || !/\S\s+\S/.test(s)) return;
  const p = t.parentElement;
  if (!p || !p.closest(WPH_COPY) || p.closest(WPH_SKIP)) return;
  const tree = phraseTree(s.trim());
  if (!tree) return;
  const lead = s.match(/^\s*/)[0], tail = s.slice(lead.length).match(/\s*$/)[0];
  const f = phraseFrag(tree);
  if (lead) f.prepend(lead);
  if (tail) f.append(tail);
  t.replaceWith(f);
}

const WPH_PRUNE = new Set(["PRE", "CODE", "TEXTAREA", "INPUT", "SELECT", "SCRIPT", "STYLE", "svg", "A"]);
function phraseIn(n) {
  if (n.nodeType === 3) { if (n.isConnected) phraseText(n); return; }
  if (n.nodeType !== 1 || !n.isConnected || WPH_PRUNE.has(n.nodeName) || n.classList.contains("wph")) return;
  const w = document.createTreeWalker(n, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    { acceptNode: x => x.nodeType === 3 ? NodeFilter.FILTER_ACCEPT : WPH_PRUNE.has(x.nodeName) || x.classList.contains("wph") || x.classList.contains("mb") || x.classList.contains("mb-txt") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP });
  const ts = [];
  for (let t; (t = w.nextNode());) ts.push(t);
  for (const t of ts) phraseText(t);
}

if (typeof document !== "undefined" && document.body && typeof MutationObserver !== "undefined") {
  new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) phraseIn(n); }).observe(document.body, { childList: true, subtree: true });
  phraseIn(document.body);
}
