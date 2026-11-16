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

## Structure rules

- Module contract: each area keeps one state owner object, the mutator functions that change it, a paint function, and named hook functions registered once per screen with `screenHooks(id, { route, enter, back, chain })`, one function per key per id (after SCREENS lands). Other files call the owner's mutators; they never write its fields. Model file: `web/js/25-settings-devices.js` (`DEV` owner, loader, paint, row dialog).
- Add a screen: (1) a data-only row in `web/js/03-screens.js` (after SCREENS lands); (2) keys in `web/i18n/ko` and `web/i18n/en`; (3) code in the area's file, or a new file plus its key in `hub/web-areas.json`; (4) a `go("id")` call from the parent screen; (5) an entry in `hub/ui-surfaces.json`; (6) `hub/<screen>-web.test.ts`; (7) `bun hub/screen-map.ts`; (8) `DOTZ_GOLDEN_WRITE=1 bun test hub/web-golden-web.test.ts`, then check that the `hub/web-golden.json` diff touches only the new screen.
- Add an overlay (`docs/ui-spec.md` sheets and dialogs): pick one of the five shared parts, `ask()` for a short confirm, `dialog({ mid: true })` for one input or a short list, `fsOpen` for long edit or read, `showMenu` for a menu, the one side drawer for a list read beside the screen. Never call `el("dialog")`, `showModal()` or `ovOpen(` directly. Finish with `DOTZ_GOLDEN_WRITE=1 bun test hub/web-golden-web.test.ts`, then check that the `hub/web-golden.json` diff touches only the new overlay.
- Ratchet: `hub/web-structure-web.test.ts` counts foreign state writes, `go()` branches, overlay sites, raw network calls and empty-state bypasses against `hub/web-structure-allow.json`. Numbers only go down: lower one in the same commit that removes the violation, never raise one. Pre-push refuses a raised number.
- Lanes: `hub/web-areas.json` maps every `web/js` file to one area. A lane edits the files of its own area; touching another area means calling that owner's mutators or hooks, not its internals.
- Never add code to `web/js/30-monitoring.js` (near its ceiling); new monitoring routing goes in `web/js/30-monitoring-route.js` (after SCREENS lands), and edits to `30-monitoring.js` stay line-neutral or shrink it.
