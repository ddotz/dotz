# KakaoTalk per-room chat: web API contract

Rooms the owner chose ("watched") are the only rooms the gateway watches, stores, shows and wakes the bot on. The list lives in
the install's custom layer: `<dataDir>/custom/kakao/config.json` field `watch_chats: string[]` (chat ids). Absent or empty = no
room is watched (default for a new install; onboarding asks the owner to pick rooms in 모니터링 > 앱 > 카카오톡).

All routes are under the gateway's normal owner check. Times are epoch milliseconds. logId values are strings (64-bit).

- `GET /api/kakao/rooms` -> `{ on: boolean, rooms: [{ chatId, name, kind, watched, unread, lastAt }], error?: string }`
  `on` = integration enabled. `rooms` comes from the KakaoTalk database (cached up to 30 s); kinds `channel` and `open` are left
  out. `error` is a plain Korean line when the database could not be read (rooms is then []).
- `PUT /api/kakao/rooms/<chatId>` body `{ watched: boolean }` -> `{ ok: true, watched: string[] }`. Broadcasts `{kind:"kakao_rooms"}`.
- `GET /api/kakao/chat/<chatId>?limit=80&before=<logId>&after=<logId>` -> 403 `{error}` when the room is not watched, else
  `{ room: { chatId, name, kind, group }, messages: [{ logId, authorId, sender, text, type, sentAt, fromMe }], read: <logId|null>,
  kakaoUnread: number, drafts: [{ code, text, basisLogId, created }], sends: [{ id, text, state, reason?, at, draft? }] }`.
  Messages oldest first. `read` = the owner's read position in the web app for this room (null = never opened; the client then
  uses `kakaoUnread`, KakaoTalk's own unread count, to place the marker). `drafts` = pending drafts of this room only. `sends` =
  this room's sends of the last 24 h (`state`: `sending` | `sent` | `failed`).
- `POST /api/kakao/chat/<chatId>/read` body `{ logId }` -> `{ ok: true }` (moves forward only).
- `POST /api/kakao/chat/<chatId>/send` body `{ text }` -> 202 `{ id, state: "sending" }`. The owner typed it: no approval step.
  The send runs in the background, one at a time for the whole gateway.
- `POST /api/kakao/drafts/<code>/send` body `{ text? }` -> 202 `{ id, state: "sending" }`. The click is the owner's explicit
  approval. `text` given = the owner edited the draft (고치기) and this text is sent instead. Refused (409 `{error}`) when the draft is
  not pending or a newer incoming message made it stale.
- `POST /api/kakao/drafts/<code>/drop` -> `{ ok: true }` (버리기).

Drafts are made only on demand (owner decision 2026-10-23, token efficiency). Collecting messages of chosen rooms is
script-only, no model call. Per room `auto_draft` (config `auto_draft_chats: string[]`, default empty) lets the dotz watch wake
the bot for that room; rooms without it never wake the bot.

- `POST /api/kakao/chat/<chatId>/draft` -> 202 `{ state: "drafting" }`, then `{kind:"kakao_draft", chatId}` when the draft is
  stored (or `{kind:"kakao_draft", chatId, error}`). One model call with the small/cheap model: messages since the owner's last
  reply in the room (cap 30 lines, ~2K tokens), the room's short summary file `<dataDir>/kakao/summaries/<chatId>.md`
  (refreshed by the same call, only when a draft is made), and up to 5 of the owner's own past lines in that room as style
  samples. No whole-history reads. The stored draft records `tokens: { in, out }`.
- `PUT /api/kakao/rooms/<chatId>` also accepts `{ autoDraft: boolean }`; `GET /api/kakao/rooms` rows carry `autoDraft`.

Server-sent events on `/api/events` (ids only, never bodies or names):
- `{ kind: "kakao", chatId, logId }` a new message in a watched room (the client fetches `?after=`).
- `{ kind: "kakao_send", chatId, id, state, reason? }` a send changed state.
- `{ kind: "kakao_draft", chatId }` the drafts of a room changed.
- `{ kind: "kakao_rooms" }` the watched list changed.
