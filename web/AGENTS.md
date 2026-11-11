# web/ rules

Read before changing a screen: `docs/ui-principles.md` (principles), `web/DESIGN.md` (tokens), `docs/ui-spec.md` (screens).

- One pattern across screens: reuse the existing row, card or sheet; do not add a variant for one screen.
- Before adding a screen or feature, look for an existing screen with the same job and extend it.
- One lead per screen: one bold element, and only what needs attention now stands out.
- New elements match their neighbours (position, size, weight, colour); anchors never move; judge shots against unchanged rows (`web/DESIGN.md` 판단 기준, 목록 줄 구성).
- Spacing comes from tokens only (`web/DESIGN.md`); `hub/design-rules-web.test.ts` fails on literals.
- Copy is natural Korean, written the way a person would say it, with no AI-sounding phrases.
- Screen text is not written in the code: add the key to `web/i18n/ko/<area>.json` and `web/i18n/en/<area>.json` together and read it with `TX("key", vars)` (`web/js/00-i18n.js`; index.html uses `{{key}}`). English is short app copy, not a translation of the Korean. `bun hub/web-i18n-check.ts` fails on a new Hangul literal in web/ and on a key missing from either list.
- A screen change moves the tests that pin it: `grep -l '<selector, id or i18n key you touched>' hub/*-web.test.ts`, run every hit and update the ones your change moved. One red web test skips the whole release slot.
- Before done: side-by-side before/after shots at 390px and 1280px, compared item by item with the request.
