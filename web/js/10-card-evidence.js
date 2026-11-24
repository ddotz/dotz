const chEvidence = l => !!l.trim() && !CH_CLOSE.test(l) && !/^\s*\[file\]\s+\S/.test(l) && !CH_OPT.test(l) && !CH_HEAD.test(l);
function chOpens(lines, i) {
  const rest = lines.slice(i + 1), stop = rest.findIndex(l => CH_HEAD.test(l) || CH_FENCE.test(l)), own = stop < 0 ? rest : rest.slice(0, stop), first = own.findIndex(l => CH_OPT.test(l));
  if (first < 0) return false;
  if (!own.slice(0, first).some(l => l.trim())) return true;
  const block = parseChoices([lines[i], ...own].join("\n")).blocks[0];
  return !!block && block.options.length > 1;
}
function inlineBody(text) {
  const lines = stripRecMark(String(text ?? "")).split("\n"), out = [];
  let fence = false, block = false;
  for (let i = 0; i < lines.length; i++) {
    if (CH_FENCE.test(lines[i])) { fence = !fence; block = false; }
    else if (!fence && CH_HEAD.test(lines[i]) && chOpens(lines, i)) { block = true; for (; !CH_OPT.test(lines[i + 1]); i++) if (lines[i + 1].trim() && !chEvidence(lines[i + 1]) && !CH_CLOSE.test(lines[i + 1])) out.push(lines[i + 1]); continue; }
    else if (!fence && block && CH_OPT.test(lines[i])) { if (isDescLine(lines[i + 1])) i++; continue; }
    else if (!fence && CH_CLOSE.test(lines[i])) continue;
    else if (lines[i].trim()) block = false;
    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
const dcEvNode = b => (b.evidence ? answerNode(b.evidence.join("\n"), { cls: "md dc-ev", lead: false }) : null);
function ntEvFold(n, text) {
  const ev = n.decision.evidence;
  if (!ev || !ev.length) return null;
  const lines = String(text ?? "").split("\n"), cut = lines.findIndex(l => !l.trim()), lead = cut < 0 ? [] : lines.slice(cut + 1), file = /^\s*\[file\]\s+\S/;
  return { head: [...ev.map(l => noticeKo(l, { ...NK, keepFiles: true })), ...lines.filter(l => file.test(l))].join("\n"), rest: choiceBody(lead.filter(l => !file.test(l)).join("\n"), ntPlain(n.title)) };
}
