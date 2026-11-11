// Renders page.html with i18n/pages.json into the five committed landing pages (site/index.html, ko/, ja/, zh-cn/, es/).
// Plain placeholders: {{key}} is HTML-escaped, {{{key}}} is raw, {{#key}}...{{/key}} is kept only when the value is not empty.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = import.meta.dir, ORIGIN = "https://ddotz.dev";
const copy: Record<string, Record<string, string>> = JSON.parse(readFileSync(join(SITE, "i18n/pages.json"), "utf8"));
const template = readFileSync(join(SITE, "page.html"), "utf8");
const langs = Object.keys(copy);
const pathOf = (l: string) => (l === "en" ? "/" : `/${l}/`);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stamp = ["style.css", "app.js", "js/stageshow.js"]
  .reduce((h, f) => h.update(readFileSync(join(SITE, f))), createHash("sha1")).digest("hex").slice(0, 12);

// In the headline "||" ends a line (.ln, one sentence a line) and "|" marks where a line may wrap; each piece stays whole (.ph), so Japanese and Chinese never break mid-word.
const phrases = (s: string, sep: string) => s.split("|").map((p) => `<span class="ph">${esc(p)}</span>`).join(sep);
const lines = (s: string, sep: string) => s.split("||").map((l) => `<span class="ln">${phrases(l, sep)}</span>`).join(sep);

// In English and Spanish a short word ("It", "a", "to", "y") is tied to the word after it with a no-break space,
// so a line never ends on it ("...own computer. It / reads new mail"). Only plain text goes through this, never raw HTML.
const glue = (s: string) => s.replace(/(^|[\s("“¿¡])([\p{L}]{1,3})\s+(?=\S)/gu, "$1$2\u00a0");

const render = (lang: string) => {
  const c = copy[lang];
  const sep = /^(ja|zh)/.test(c.htmlLang) ? "" : " ";
  const text = (s: string) => (/^(en|es)/.test(c.htmlLang) ? glue(esc(s)) : esc(s));
  const others = langs.filter((l) => l !== lang);
  const vars: Record<string, string> = {
    ...c,
    pitch: lines(c.pitch, sep),
    stamp,
    path: pathOf(lang),
    canonical: ORIGIN + pathOf(lang),
    alternates: [...langs.map((l) => `<link rel="alternate" hreflang="${copy[l].htmlLang}" href="${ORIGIN + pathOf(l)}">`), `<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">`].join("\n"),
    ogAlternates: others.map((l) => `<meta property="og:locale:alternate" content="${copy[l].ogLocale}">`).join("\n"),
    langMenu: langs.map((l) => `            <li><a href="${pathOf(l)}" lang="${copy[l].htmlLang}" hreflang="${copy[l].htmlLang}"${l === lang ? ' aria-current="page"' : ""}>${esc(copy[l].langName)}</a></li>`).join("\n"),
    footerLangs: langs.map((l) => `      <a href="${pathOf(l)}" lang="${copy[l].htmlLang}" hreflang="${copy[l].htmlLang}"${l === lang ? ' aria-current="page"' : ""}>${esc(copy[l].langName)}</a>`).join("\n"),
  };
  const raw = new Set(["pitch", "alternates", "ogAlternates", "langMenu", "footerLangs", "win1", "win2", "win3"]);
  return template
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}\n?/g, (_, k, body) => (vars[k] ? body : ""))
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, k) => get(vars, k))
    .replace(/\{\{(\w+)\}\}/g, (_, k) => (raw.has(k) ? get(vars, k) : text(get(vars, k))));
};

const get = (vars: Record<string, string>, k: string) => {
  if (vars[k] === undefined) throw new Error(`site/build-pages.ts: page.html uses {{${k}}} but the copy has no such key`);
  return vars[k];
};

for (const lang of langs) {
  const file = join(SITE, lang === "en" ? "" : lang, "index.html");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, render(lang));
  console.log(`wrote ${file.slice(SITE.length + 1)}`);
}
