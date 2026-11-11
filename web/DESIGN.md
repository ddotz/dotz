# dotz web UI - design tokens

`web/index.html` + modules in `web/css/*.css` and `web/js/*.js` (served joined as `/app.css`, `/app.js`), tokens in `:root` / `:root[data-theme="dark"]`. Tone: Toss Securities - gray page,
borderless white cards, one sparing blue accent, big bold titles, short copy. Light and dark keep the same hierarchy.

## 판단 기준 (before adding anything)

- A new element joins the existing pattern of its surface: look at its neighbours (same list, card, screen) and match their position, size, weight, colour and rhythm.
- Anchors the eye scans (left icons, titles, the right-edge status or time) never move.
- Dense surfaces (홈, lists) get the most compact form; detail screens get the full one.
- Judging a screenshot: compare the changed rows or blocks with the unchanged ones beside them, not only whether the new thing appears.

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
| `--fg-3` | `#616b78` | `#8e939c` | meta text (4.5:1 on `--bg`, `--row-sel` and `--hover`) |
| `--accent` | `#3182f6` | `#6ca7ff` | primary button, send, selected / in-use, progress. Nothing else (dark is lighter so its text reaches 4.5:1 on its own 14% tint) |
| `--on-accent` / `--on-err` | `#ffffff` / `#ffffff` | `#121214` / `#121214` | text on a solid accent or danger fill (dark ink on the lighter dark colors, 4.5:1) |
| `--ok` / `--warn` / `--err` | `#0a8754` / `#ae5900` / `#e32435` | `#3ecf8e` / `#f5a524` / `#ff6369` | status dots and short status words only |
| `--warn-ink` | `#8f4900` | `#f5a524` | text of the `.tag.warn` status word only (its dot stays `--warn`): `--warn` darkened, 4.5:1 on every surface, hovered and selected rows too |

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
| Dialog / sheet title (`.dtitle`, `.fs-t`) | 20/28 | 700 |
| Open chat title on a phone (up to two lines) | 16/22 (card title step) | 700 |
| Big value | 20/28 | 700 |
| Card title | 16/22 | 600 |
| Section label | 14/20 | 600, `--fg-2` |
| Body / list row | 14/22, rows 15/22 | 400 / 500 |
| Chat body | 15/24 | 400 |
| Meta | 12/16 | 400, `--fg-3` |
| Tag, count badge (`.bd`, `#bell-n`) | 11/16 (`--fs-tag`, the floor) | 500-600 |

Korean wraps at phrase boundaries (`word-break: keep-all` on body, long tokens still break), like Netflix subtitles. Short copy text (settings descriptions, notes, empty states, cards, dialogs) is also cut by meaning (`01-phrase-wrap.js`), never chat or agent prose (`#tl`, `.md`, a question and its option text in a sheet), which flows with real newlines only at paragraph ends: a line breaks at a sentence end or ` · ` first, then after a comma, then after a connective (…고, …면, …지만), and never inside brackets, quotes, or a one-syllable word and the word after it.

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
- something leaves that the owner closed (sheet, menu, toast): `await motionOut(el)`, then remove it
- a result the hub confirmed (approve, send, drop, answer, dismiss, delete, move): see Result motion below
- a count changes: `rollCount(el, n)` rolls only the changed digit
- a split pane is dragged (`web/js/43-panes-motion.js`): the ghost lifts in (`--m-fast`), the drop zone glides (`--m-fast`, a script-placed box like the board's `.bph`),
  a new pane grows its flex share from 0 (`--m-base`, its text reflows, nothing is stretched), a replaced pane is `motionSwap`, a cancel sends the ghost back (`--m-base`)

`prefers-reduced-motion: reduce` turns every transition and animation off (pseudo-elements included) and makes each helper an
instant change. The product has no motion on/off setting: the system setting is the only switch.

### Result motion

The answer to "did it really go?": a card or row leaves only after the hub said yes. Four motions, three helpers (01-motion.js):

| Motion | When | Helper |
|---|---|---|
| press, then wait | the tap that posts: the button says the screen's existing pending text, keeps its width, is disabled and `aria-busy` | `undo = pressWait(btn, label?)` |
| fold away | after the hub's OK only: the card fades (`--m-fast`) where it stands | `await motionGone(el)` |
| rows rise | same moment: what was below glides into place (`--m-base`, FLIP on transform, layout read once); a rounded list box keeps its height and wipes its bottom edge with a clip-path on the same curve | inside `motionGone` |
| failure in place | the hub refused or the line dropped: no motion; the card stays, `undo()` gives the button back, the reason is the screen's existing failure line (`role=alert`) or the failure toast | `undo()` + existing failure |

- Order on success: change the local data first (so no redraw can draw the row again), then `motionGone(row)`. A list drawn as a whole calls `if (motionAfter(box, () => paint())) return;` first: a redraw asked for while a row leaves runs once, after it is gone.
- The rows that glide are `inert` until they stand still (at most `--m-base`, also with reduced motion), so a second tap on the same spot never presses the next card's button. Everything else stays live.
- Focus inside the leaving card goes to the card that took its place (else the one above, else the list). The leaving card is `aria-hidden` at once; the result is read by the existing toast (`role=status`) or failure line.
- `motionGone(el, { keep: true })` hides a box that is used again (the decision dock) instead of removing it; `motionStay(el)` stops that leave when the box is needed again. `{ with: [...] }` adds elements that move but are not after it.
- It fires `motion-gone` on document (`detail.el`) when the element is out of the DOM; tests wait on that, never on time.
- Not for: entrances, hover, press-to-grow, tab or view changes, anything whose result does not come from the hub.

## Per-form spec

Heights, padding, gaps, type steps and don'ts for each display form (list row, card, settings row, sheet, button, badge, empty, toast, chips, field, progress) live in `docs/ui-spec.md`. Height tokens: `--row-h` 44 (rows), `--menu-h` 30 / `--menu-h-sheet` 44 (menu items), `--sheet-h` 44 (sheet items), `--btn-h` 36 (`.btn`), `--btn-h-sm` 32 (`.btn.sm`), `--btn-h-row` 28 (`.btn.inrow`, 44px touch target via `::after`); settings row = `.li` + `.li-end`; row-level add action = `.sec.sec-act` > `.btn.tonal.sm`. Screens use these; no one-off heights. Touch: on a phone a control drawn under `--btn-hit` (44) keeps its drawn size and extends only its hit area (`::after`, or padding with the same negative margin in a row that clips); the areas of neighbours never overlap.

## 목록 줄 구성 (row anatomy)

The one layout for a row in any list or home card (home cards, 작업내역, projects, monitoring, mail, notices). `hub/row-anatomy-web.test.ts` measures it.

- Left: the leading dot or icon, then the title with its subtitle under it.
- Right edge: the row's status or time, always last and at the same x on every row of the list. Row actions (✕, ⋯, a chevron) sit after it in a fixed slot every row keeps.
- Any extra marker (count, badge, attachment, 결과 N) goes immediately before the status or time, never after it.
- On dense surfaces (home cards, lists) a marker is one line at meta size and colour (`--fs-meta`, `--fg-3`/`--fg-2`); a row with a marker is as tall as one without. Full chips only on a detail screen or after the row is expanded.
- A card is as tall as its content; it never stretches to its neighbour's height.
- An embedded block (chart, list, code) uses the app's `--accent` and neutral tokens, and its title is the list block title (`.md .mlist-h`: 600 13/18 in `--fg-3`, as `hub/chart.ts` draws it), so it never outweighs the message around it.

## Shape and space

| Token | Value | For |
|---|---|---|
| `--r-card` | 18px | cards and lists |
| `--r-sheet` | 20px | sheets and dialogs |
| `--r-menu` | 14px | popover menus, floating notices |
| `--r-ctl` | 10px | buttons, fields, chips, tabs, bubbles, menu items |
| `--r-seg` / `--r-seg-in` | 8px / 6px | segmented control and filter track / chosen cell; the two-value toggle (`.chip.tgl`) |
| `--r-pill` | 999px | round icon buttons only; never a status, filter or tab |

Cards keep 20px padding, list rows 8/16px with a 44px minimum height. No shadows on cards; menus and dialogs keep one soft
float shadow (`--float`, `--shadow-menu`, `--shadow-dialog`, `--shadow-sheet`). Type and space use the scale tokens
(`--fs-*`, `--lh-*`, `--sp-*`) in `web/css/01-tokens.css`.

### Status, filter, screen tab (no capsules)

| Pattern | Use when | Shape |
|---|---|---|
| Status | a word that says the state of a row or card (`.tag`, `.mon-ptag`, `.ct-pill`, `.tr-st`, `.dr-hit`) | no fill, no padding: a 6px tone dot (`::before`, `--tone`) + the word, 600 in the tone colour; `.pri`/blue states keep the blue in the dot and the word in `--fg-2`; `.off` (꺼짐, turned off on purpose) is the same shape in gray (`--fg-3` dot and word). A tag with no tone is a meta word (`--fg-3`, 500). Status text is >= 4.5:1 in light and dark. |
| Filter | narrows the same list (`.mr-f` in `.mr-filter`/`.pl-chips`/`.mon-tabs`, `.nsc-fb`) | one segmented track (`--seg-track`, `--r-seg`) drawn by the segments, the chosen one a `--seg-on` cell (`--r-seg-in`) + `--fg` 600. Each segment stays the button (touch hit areas sit on it). A long row scrolls sideways, `segKeep` keeps the chosen one in view. |
| Screen tab | swaps the whole view under it (`.mx-tab` mailboxes, `.cm-tabs` 댓글/DM: a different list, not a narrower one) | words over a 1px `--line` hairline, chosen = `--fg` 600 + 2px `--fg` underline; side padding `--sp-3` and the full `--btn-hit` 44px height as the hit area. |

Count badges (`.nb`, unread circles) and dots stay as they are; the palette does not change with these shapes.

A COUNT is a badge, a STATE is a dot + word. The unread count `.nb` is a filled capsule on every row that shows it (app and project rows, home cards, mail and comment rows): `--accent` fill with `--on-accent` text in light, `--unreplied` orange in dark (owner 2026-11-05). "미답장 N" (a number) is the tinted orange count badge `.nb.unreplied`; one item that is owed, with no number, is `.tag.unreplied`, a dot and a word. The same count has the same size and fill on every row; do not set a bare number or coloured text for it.

**Keep a capsule only where it is the natural shape**: a standalone object you pick up or remove, a count, a switch, or a round action
next to other buttons. Kept: count badges (`.nb`, `.pr-n`, `.pl-nb`, `.mth-n`, `.mlist-b`, `.pk-n`, `.tr-n`, `.fb-n`); switches (`.hs-sw`, `.kk-sw`);
recipient and token chips (`.dr-chip`, `.pj-tg` channel/file, `.sl-c`/`.sl-a` slash-command arguments, `.fatt` attachments); round icon
buttons (`.mxs-cx`, `.dr-rc-x`) and the thread mailbox button (`.mth-mb`); KakaoTalk's own date and system chips (`.kk-date`, `.kk-sys`)
and the jump-back float (`.kk-backpill`), which copy the messenger. Changed to status: `.conn` (연결 끊김), `.cchip.capi` (api사용중), `.dr-st`, `.dsk-pill`.
Split panes (`web/css/26-panes.css`) add no tokens: a pane is a card, the active pane is marked by `--ff-ring` only, and a drop
zone is the file-drop look (`--accent` at 12% + `--ff-ring`); the rules are in `docs/ui-spec.md` (분할 칸).

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
(a 1px line compensation, an optical nudge); a file may carry at most 3 of them. An indent that lines up with something is a sum of tokens or a
named custom property, so the two stay together; a sum is for that only, not a way around a step. A layout measure (`--view-w`, `--sheet-w`) is not
spacing and has its own token. The `space` check in `hub/design-rules-web.test.ts` fails on any violation, and reads literal padding, margin and gap
px in strings of `web/js`, `web/custom.js` and `web/index.html` the same way. The mail iframe CSS in `11-mailbody.js` is its own document and is exempt.
