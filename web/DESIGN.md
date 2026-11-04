# dotz web UI - design tokens

`web/index.html` + modules in `web/css/*.css` and `web/js/*.js` (served joined as `/app.css`, `/app.js`), tokens in `:root` / `:root[data-theme="dark"]`. Tone: Toss Securities - gray page,
borderless white cards, one sparing blue accent, big bold titles, short copy. Light and dark keep the same hierarchy.

## Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` / `--side` | `#f2f4f6` | `#121214` | page canvas, sidebar (same surface, no divider) |
| `--card` / `--pop` | `#ffffff` | `#1d1d21` / `#26262b` | cards, lists, menus, dialogs - no border |
| `--card-hover` | `#f9fafb` | `#232328` | hover on a tappable card or row |
| `--layer` | `#f2f4f6` | `#26262b` | tonal fill inside a card (owner bubble, tags, segmented control) |
| `--hover` / `--active` | `#e9ecf0` / `#e5e8eb` | `#2b2b31` / `#303036` | hover / pressed on the canvas |
| `--line` / `--line-2` | `#e5e8eb` / `#d1d6db` | `#2b2b31` / `#3d3d45` | hairlines inside a card; fields carry no border (see `--ff-fill`) |
| `--fg` | `#191f28` | `#ececf0` | text |
| `--fg-2` | `#4e5968` | `#b0b4bc` | secondary text |
| `--fg-3` | `#6b7684` | `#8e939c` | meta text (4.5:1 on white) |
| `--accent` | `#3182f6` | `#4c94ff` | primary button, send, selected / in-use, progress. Nothing else |
| `--ok` / `--warn` / `--err` | `#0a8754` / `#b85e00` / `#e42939` | `#3ecf8e` / `#f5a524` / `#ff6369` | status dots and short status words only |

Rules: one accent per screen; status colors never decorate; no colored stripes on rounded surfaces; selection is a
fill (`--card` on the canvas, `--fg` chip), not a border.

Status color rule (owner 2026-10-28, the same on every screen). Pick the color by the state shown, never by the class at hand:

- Blue `--accent` (`dot pri`, `tag pri`, `hs pri`): running or progressing normally. A turn working or starting, a background
  worker or subagent running, a lane working, work handed off and in progress (맡긴 작업 진행 중), sending / processing, a check
  running, a queued item waiting for its turn (compaction queued, an update deferred).
- Orange `--warn` (`warn`, `att`): the owner must act or answer. An open question or decision, a reply draft waiting for
  approval, a login or reconnect only he can do, a billing / auth pause, a usage-limit pause, a monitor flagged as needing him,
  usage or context running out. A login is orange even when it is ranked 중요.
- Red `--err` (`err`): an error, a failure, a dead process. A failed run or check is red from the first failure.
- Green `--ok`: done or healthy (finished, passed, connected).
- Grey (no tone): neutral. Idle, paused or turned off by the owner, aborted by the owner.

## Type

Pretendard, then the system Korean face (`Apple SD Gothic Neo`). No Inter/Geist.

| Role | Size / line | Weight |
|---|---|---|
| Page title (app bar) | 22/30 (phone 20/28) | 700 |
| Big value | 20/28 | 700 |
| Card title | 16/22 | 600 |
| Section label | 14/20 | 600, `--fg-2` |
| Body / list row | 14/22, rows 15/22 | 400 / 500 |
| Chat body | 15/24 | 400 |
| Meta | 12/16 | 400, `--fg-3` |

Korean wraps at phrase boundaries (`word-break: keep-all` on body, long tokens still break), like Netflix subtitles. Copy text (settings descriptions, notes, empty states, cards, dialogs, chat paragraphs) is also cut by meaning (`01-phrase-wrap.js`): a line breaks at a sentence end or ` · ` first, then after a comma, then after a connective (…고, …면, …지만), and never inside brackets, quotes, or a one-syllable word and the word after it.

## Motion

Quiet screen: nothing moves without a cause, nothing loops or decorates. Causes and their one motion, helpers in
`web/js/01-motion.js` (Web Animations, transform/opacity only, tokens below, `--m-ease` ease-out):

| Token | Value | For |
|---|---|---|
| `--m-fast` | 150ms | press / hover / leave, small transitions |
| `--m-base` | 220ms | arrive, change in place, sheet opens |
| `--m-slow` | 300ms | large surfaces, progress bar width |
| `--m-ease` | `cubic-bezier(.2, .7, .2, 1)` | every transition and animation; `EASE` in 01-motion.js |

- something arrives (decision card, answer, sheet): `motionIn(el)` rise 8px + fade; new row at the top of a list: `motionIn(el, "top")`, picked with `freshKeys(store, keys)` so a first paint never animates
- the same thing changes state in place (보내기 -> 보냈어요, a task finishing): `motionSwap(el, change)`
- something leaves (sheet, dismissed row): `await motionOut(el)`, then remove it
- a count changes: `rollCount(el, n)` rolls only the changed digit

`prefers-reduced-motion: reduce` turns every transition and animation off (pseudo-elements included) and makes each helper an
instant change. The product has no motion on/off setting: the system setting is the only switch.

## Per-form spec

Heights, padding, gaps, type steps and don'ts for each display form (list row, card, settings row, sheet, button, badge, empty, toast, chips, field, progress) live in `docs/ui-spec.md`. Height tokens: `--row-h` 44 (rows), `--menu-h` 30 / `--menu-h-sheet` 44 (menu items), `--sheet-h` 44 (sheet items), `--btn-h` 36 (`.btn`), `--btn-h-sm` 32 (`.btn.sm`), `--btn-h-row` 28 (`.btn.inrow`, 40px touch target via padding); settings row = `.li` + `.li-end`; row-level add action = `.sec.sec-act` > `.btn.tonal.sm`. Screens use these; no one-off heights.

## Shape and space

| Token | Value | For |
|---|---|---|
| `--r-card` | 18px | cards and lists |
| `--r-sheet` | 20px | sheets and dialogs |
| `--r-menu` | 14px | popover menus, floating notices |
| `--r-ctl` | 10px | buttons, fields, chips, tabs, bubbles, menu items |
| `--r-seg` / `--r-seg-in` | 8px / 6px | segmented control track / chosen cell |
| `--r-pill` | 999px | only a small status tag (`.tag`) and the two-value toggle (`.chip.tgl`) |

Cards keep 20px padding, list rows 8/16px with a 44px minimum height. No shadows on cards; menus and dialogs keep one soft
float shadow (`--float`, `--shadow-menu`, `--shadow-dialog`, `--shadow-sheet`). Type and space use the scale tokens
(`--fs-*`, `--lh-*`, `--sp-*`) in `web/css/01-tokens.css`; the pill-sparingly rule is in `docs/ui-spec.md`.

### Space scale

Every `padding*`, `margin*`, `gap`, `row-gap` and `column-gap` takes a step of this scale, written as its token (`--sp-N` = N x 4px). 0 needs no token.
The app is a dense tool, so the small steps carry most of the layout; 6px stays because `docs/ui-spec.md` specifies it, and 2px is its half-step.

| Token | Value | For |
|---|---|---|
| `--sp-05` | 2px | hairline gaps, segmented cells |
| `--sp-1` | 4px | tight inline groups |
| `--sp-15` | 6px | icon or dot + text, tag padding |
| `--sp-2` | 8px | list row vertical padding, field groups |
| `--sp-3` | 12px | gaps between rows |
| `--sp-4` | 16px | list row horizontal padding |
| `--sp-5` | 20px | card padding |
| `--sp-6` | 24px | gaps between card sections |
| `--sp-8` | 32px | page and section breathing room |
| `--sp-10` | 40px | large blocks, empty states |
| `--sp-12` | 48px | the largest step, for rare page-level space |

10, 14 and 18px are off the scale: pick the step by what the rule is for (chip, row, card, field, menu), never by rounding the number. A value off the scale, or an on-scale px
literal where a token exists, is allowed only when the declaration is followed on the same line by `/* nudge: <reason> */` with a reason
(a 1px line compensation, an optical nudge); a file may carry at most 3 of them. The `space` check in `hub/design-rules-web.test.ts` counts
the violations per file against a baseline that can only shrink (a count below it fails too, so lower the entry), and counts literal
padding, margin and gap px in strings of `web/js`, `web/custom.js` and `web/index.html` the same way. The mail iframe CSS in
`11-mailbody.js` is its own document and is exempt.
