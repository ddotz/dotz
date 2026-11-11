# App requests (앱 연결 요청)

One file per kind of app: the request the bot follows when the owner asks to connect that app ("카카오톡 연결해 줘", or what he types in the box on top of 앱 관리,
sent as `연결할 앱: <what he typed>`). The web shows no list of these; the bot picks the matching file itself, and 다시 켜기 of an app that needs
reconnecting puts that app's request in the chat box (GET /api/app-templates, hub/app-templates.ts).

- `<key>.md`: frontmatter `label` (the app in the owner's words) and `order`, then the request in Korean. `{{항목}}` are the owner's own
  details: ask for them in the secure form (dotz_auth), never in chat.
- `listed: false` in the frontmatter: a prepared request for a service (쿠팡, SRT, 정부24 ...) that stays off every list and off the last-item
  fallback; the bot finds it by its label (`grep -l "label: 쿠팡" docs/app-templates/*.md`) or `GET /api/app-templates?key=<key>`. Each one says
  what users usually want, the best connection path (existing skill or CLI first, then the Aside browser login with `session_url`/`expect`),
  the steps that need the user's hand, a watch idea, and what was checked live. A skill or CLI it names is used only when this install
  has it; otherwise the browser path is the way.
- `_rule.md`: the closing rule every request ends with.
- No file fits: start from `custom.md`.
- The owner's own versions live in `<data>/custom/app-templates.json` `{suffix?, templates: [{key, label?, text}]}`: a template with a shipped key
  replaces it, a new key is added, `suffix` replaces `_rule.md`.
