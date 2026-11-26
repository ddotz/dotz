/* dotz demo language: the demo is a static site, so the page picks its language itself from the browser's language list
   (navigator.languages, the same list Accept-Language is sent from), or an explicit ?lang=. Korean for ko, English for anything else,
   as the gateway serves the web app (hub/web-i18n.ts resolveView). build-demo.ts writes i18n.js, which calls these two right
   before app.js: pick() chooses the catalog, fill() writes the `{{key}}` tokens of index.html in it.
   The page's language is picked once, here, as `lang`: i18n.js, fixtures.js and demo-api.js all read it, and L(ko, en) is how the
   demo's own content (fixtures, scripted replies) carries both languages in one source. */
(() => {
  const TEXT = {
    ko: {
      "demo.title": "dotz — 데모", "demo.description": "dotz 웹 앱을 직접 써 보는 데모예요.", "demo.tag": "데모", "demo.back": "랜딩으로",
      "demo.home_aria": "dotz 랜딩으로", "demo.apps": "앱 목록", "demo.subagents": "서브에이전트", "demo.setup_detail": "구성 상세",
    },
    en: {
      "demo.title": "dotz — Demo", "demo.description": "Try the dotz web app yourself.", "demo.tag": "Demo", "demo.back": "Back to site",
      "demo.home_aria": "Back to the dotz landing page", "demo.apps": "Apps", "demo.subagents": "Subagents", "demo.setup_detail": "Setup details",
    },
  };
  const pick = (tags, query) => {
    const first = String(query || (tags && tags[0]) || "").trim().toLowerCase().replace(/_/g, "-");
    return first && first.split("-")[0] !== "ko" ? "en" : "ko";
  };
  const fill = (lang, catalog) => {
    const word = key => { const v = TEXT[lang][key] ?? catalog[key]; return typeof v === "string" ? v : v && v.other; };
    const sub = s => s.replace(/\{\{([a-z0-9_.]+)\}\}/g, (m, key) => word(key) ?? m);
    document.documentElement.lang = lang;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());)
      if (n.nodeValue.includes("{{") && !/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)) n.nodeValue = sub(n.nodeValue);
    for (const el of document.querySelectorAll("*"))
      for (const a of [...el.attributes]) if (a.value.includes("{{")) a.value = sub(a.value);
  };
  const lang = pick(navigator.languages || [navigator.language], new URLSearchParams(location.search).get("lang"));
  const L = (ko, en) => lang === "ko" ? ko : en;
  window.dotzDemoLang = { pick, fill, lang, L };
})();
