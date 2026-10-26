# App requests (앱 연결 요청)

One file per kind of app: the request the bot follows when the owner asks to connect that app ("카카오톡 연결해 줘", or 앱 관리 > 새로 추가하기,
which sends `연결할 앱: <name>`). The web shows no list of these; the bot picks the matching file itself, and 다시 켜기 of an app that needs
reconnecting puts that app's request in the chat box (GET /api/app-templates, hub/app-templates.ts).

- `<key>.md`: frontmatter `label` (the app in the owner's words) and `order`, then the request in Korean. `{{항목}}` are the owner's own
  details: ask for them in the secure form (dotz_auth), never in chat.
- `_rule.md`: the closing rule every request ends with.
- No file fits: start from `custom.md`.
- The owner's own versions live in `<data>/custom/app-templates.json` `{suffix?, templates: [{key, label?, text}]}`: a template with a shipped key
  replaces it, a new key is added, `suffix` replaces `_rule.md`.
