"use strict";
// Screen text and number/date locale. The server puts `const I18N_LANG = "ko", I18N = {...};` right after the WEB_BUILD line (hub/webapp.ts);
// this file reads those two constants and nothing else, and touches no DOM, so hub/web-i18n.ts runs the same source on the server.
// A catalog value is a string with {name} placeholders, {name+이/가} Korean particles (picked from the word's last letter), or an
// object of plural forms ({ one, other }) chosen by Intl.PluralRules on vars.n.
// Any language tag the gateway serves (pt-br, zh-hant-tw): canonicalised once (pt-BR), and a tag Intl rejects falls back to en-US instead of breaking the page.
const TX_LOCALE = (() => { try { return Intl.getCanonicalLocales(I18N_LANG === "ko" ? "ko-KR" : I18N_LANG)[0]; } catch { return "en-US"; } })();
const TX_PLURAL = new Intl.PluralRules(TX_LOCALE);
// word + the first form of `pair` ("이/가", "을/를", "은/는", "과/와", "으로/로") when the word ends in a final consonant, else the second;
// a last letter that is not Hangul takes the second form, and 로 follows ㄹ.
function txJosa(word, pair) {
  const [a, b] = String(pair).split("/"), w = String(word), c = w.slice(-1).charCodeAt(0) - 0xac00;
  const final = c >= 0 && c <= 11171 ? c % 28 : 0;
  return `${w}${final && !(a === "\uc73c\ub85c" && final === 8) ? a : b}`;
}
function TX(key, vars) {
  const v = I18N[key], text = typeof v === "string" ? v : v && typeof v === "object" ? v[TX_PLURAL.select(Number(vars && vars.n))] ?? v.other : undefined;
  if (typeof text !== "string") return key;
  if (!vars) return text;
  return text.replace(/\{(\w+)(?:\+([^/{}]+\/[^{}]+))?\}/g, (m, name, pair) => !(name in vars) ? m : pair ? txJosa(vars[name], pair) : String(vars[name]));
}
// Whether a text (a model's thinking, a status line) reads in the screen language: Korean needs Hangul, any other language only needs text.
const txInLang = s => I18N_LANG === "ko" ? /[\uac00-\ud7a3]/.test(s) : String(s).trim() !== "";
