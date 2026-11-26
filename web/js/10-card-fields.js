// An option that asks for several values (a list under it, hub/choices.ts descEnd) is answered field by field: one input per listed item, sent as one
// line `<field>: <value>; ...` after the option (hub/askbuttons.ts fieldsModal sends the same line from Discord). Fewer than two items: the one text box.
const optFields = o => String(o.desc || "").split("\n").filter(l => /^[-*•]\s+\S/.test(l)).map(l => l.replace(/^[-*•]\s+/, "").trim());
const fieldName = f => (/^([^:：]{1,40})[:：]/.exec(f) || [null, f])[1].trim();
const fieldsNote = (fields, vals) => fields.map((f, i) => ((vals[i] || "").trim() ? `${fieldName(f)}: ${vals[i].trim()}` : "")).filter(Boolean).join("; ");
function noteFieldsNode(fields, vals, changed, disabled, keys) {
  return el("div", { class: "dc-fields" }, ...fields.map((f, i) => {
    const inp = el("input", { class: "dc-fv", type: "text", maxlength: "200", disabled, "aria-label": fieldName(f), "data-esc": "field", oninput: () => { vals[i] = inp.value; changed(); }, onkeydown: keys });
    inp.value = vals[i] || "";
    return el("label", { class: "dc-field" }, el("span", { class: "dc-fk", text: f }), inp);
  }));
}
// The chat card's field form (10-decision-card.js editNode): the option, its fields, back and the send button, live only once a field is filled.
function fieldsEditNode(opt, fields, vals, disabled, send, close) {
  const go = el("button", { class: "dc-go", type: "button", disabled: disabled || !fieldsNote(fields, vals), onclick: () => send(fieldsNote(fields, vals)) }, noteGoLabel(opt, false));
  const back = el("button", { class: "dc-back", type: "button", disabled, onclick: close }, TX("decision.back"));
  const ctx = el("div", { class: "dc-ctx" }, el("span", { class: "dc-key", text: String(opt.n) }), el("span", { class: "dc-lb", text: opt.label }));
  return el("div", { class: "dc-edit" }, ctx, noteFieldsNode(fields, vals, () => { go.disabled = !fieldsNote(fields, vals); }, disabled, noteKeys(() => go.click(), () => back.click())), el("div", { class: "dc-eb" }, back, go));
}
