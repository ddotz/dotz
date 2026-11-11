# web/ rules

Read before changing a screen: `docs/ui-principles.md` (principles), `web/DESIGN.md` (tokens), `docs/ui-spec.md` (screens).

- One pattern across screens: reuse the existing row, card or sheet; do not add a variant for one screen.
- Before adding a screen or feature, look for an existing screen with the same job and extend it.
- One lead per screen: one bold element, and only what needs attention now stands out.
- New elements match their neighbours (position, size, weight, colour); anchors never move; judge shots against unchanged rows (`web/DESIGN.md` 판단 기준, 목록 줄 구성).
- Spacing comes from tokens only (`web/DESIGN.md`); `hub/design-rules-web.test.ts` fails on literals.
- Copy is natural Korean, written the way a person would say it, with no AI-sounding phrases.
- Before done: side-by-side before/after shots at 390px and 1280px, compared item by item with the request.
