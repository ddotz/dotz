const dcFolded = t => DC.fold[t] !== false;
function dcFoldSum(dc) {
  const opts = dc.blocks[0] ? dc.blocks[0].options.length : 0;
  return `· ${dc.blocks.length > 1 ? TX("decision.fold_many", { n: dc.blocks.length }) : opts ? TX("decision.fold_pick", { n: opts }) : TX("decision.waiting_tag")}`;
}
