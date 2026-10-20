# dotz web UI - design tokens

One file (`web/index.html`), tokens in `:root` / `:root[data-theme="dark"]`. Tone: Toss Securities - gray page,
borderless white cards, one sparing blue accent, big bold titles, short copy. Light and dark keep the same hierarchy.

## Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` / `--side` | `#f2f4f6` | `#121214` | page canvas, sidebar (same surface, no divider) |
| `--card` / `--pop` | `#ffffff` | `#1d1d21` / `#26262b` | cards, lists, menus, dialogs - no border |
| `--card-hover` | `#f9fafb` | `#232328` | hover on a tappable card or row |
| `--layer` | `#f2f4f6` | `#26262b` | tonal fill inside a card (owner bubble, tags, segmented control) |
| `--hover` / `--active` | `#e9ecf0` / `#e5e8eb` | `#2b2b31` / `#303036` | hover / pressed on the canvas |
| `--line` / `--line-2` | `#e5e8eb` / `#d1d6db` | `#2b2b31` / `#3d3d45` | hairlines inside a card, field edges only |
| `--fg` | `#191f28` | `#ececf0` | text |
| `--fg-2` | `#4e5968` | `#b0b4bc` | secondary text |
| `--fg-3` | `#6b7684` | `#8e939c` | meta text (4.5:1 on white) |
| `--accent` | `#3182f6` | `#4c94ff` | primary button, send, selected / in-use, progress. Nothing else |
| `--ok` / `--warn` / `--err` | `#0a8754` / `#b85e00` / `#e42939` | `#3ecf8e` / `#f5a524` / `#ff6369` | status dots and short status words only |

Rules: one accent per screen; status colors never decorate; no colored stripes on rounded surfaces; selection is a
fill (`--card` on the canvas, `--fg` chip), not a border.

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

## Shape and space

`--r-card` 18px (cards, lists, dialogs 20px), `--r-ctl` 10px (buttons, fields), chips 16px (pill). Card padding 20px,
list rows 10/16px, min row height 48px. No shadows on cards; menus and dialogs keep one soft float shadow.
