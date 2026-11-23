const NP = { models: null };
function npModels(err) {
  if (NP.models) return;
  const hit = TV.get("main");
  (hit ? Promise.resolve(hit) : fetchTV("main")).then(T => { NP.models = T.models || []; }, e => { err.textContent = TX("conv.np.models_failed", { why: e.message }); });
}
function npOpen() {
  const err = usErr();
  npModels(err);
  const name = input({ type: "text", maxlength: "40", "data-np": "name", placeholder: TX("conv.np.name_ph") });
  const purpose = el("textarea", { id: "np-purpose", class: "fi pmv-ta", rows: 3, "data-np": "purpose", placeholder: TX("conv.np.purpose_ph") });
  let model = "", made = "", shut = false;
  const models = () => [{ value: "", label: TX("conv.np.model_default") }, ...modelPickItems(NP.models || [], model)];
  const create = (close, btn) => {
    const title = name.value.trim();
    if (!title) { err.textContent = TX("conv.np.need_name"); name.focus(); return; }
    const aim = purpose.value.trim();
    return usRun(btn, err, async () => {
      const r = await api("/api/projects", "POST", { title, ...(aim ? { purpose: aim } : {}), ...(model ? { model } : {}) });
      await Promise.all([refreshState(), prjLoad(true)]);
      if (shut) { toast(TX("conv.np.made", { name: title }), false, { label: TX("project.open_chat"), onclick: () => go("chat", r.key) }); return; }
      made = r.key;
      close();
    });
  };
  const d = dialog({
    mid: true,
    onclose: () => { if (!made) { shut = true; return; } go("chat", made); $("#text").focus(); },
    title: TX("conv.np.title"),
    body: el("div", { class: "col np" },
      textField(TX("conv.np.name"), name),
      textField(TX("conv.np.purpose"), purpose),
      selectField(TX("conv.np.model"), v => (v ? modelName(v) : TX("conv.np.model_default")), models, "", v => { model = v; }),
      S && S.discord && S.discord.enabled ? el("p", { class: "sup", "data-np": "discord", text: TX("conv.np.discord") }) : null,
      err),
    actions: [{ label: TX("common.cancel"), onclick: close => close() }, { label: TX("conv.np.create"), kind: "pri", onclick: create }],
  });
  name.addEventListener("keydown", ev => { if (plainEnter(ev)) { ev.preventDefault(); d.node.querySelector(".dact .btn.pri").click(); } });
  name.focus();
}
