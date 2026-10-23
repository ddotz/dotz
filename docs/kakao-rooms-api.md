# KakaoTalk per-room chat: web API contract

Rooms the owner chose ("watched") are the only rooms the gateway watches, stores, shows and wakes the bot on. The list lives in
the install's custom layer: `<dataDir>/custom/kakao/config.json` field `watch_chats: string[]` (chat ids). Absent or empty = no
room is watched (default for a new install; onboarding asks the owner to pick rooms in 모니터링 > 앱 > 카카오톡).

All routes are under the gateway's normal owner check. Times are epoch milliseconds. logId values are strings (64-bit).

- `GET /api/kakao/rooms` -> `{ on: boolean, rooms: [{ chatId, name, kind, watched, autoDraft, unread, lastAt }], error?: string }`
  `on` = integration enabled. `rooms` comes from the KakaoTalk database (cached up to 30 s); kinds `channel` and `open` are left
  out, the owner's own memo chat (`self`) is listed. `error` is a plain Korean line when the database could not be read (rooms is then []).
- `PUT /api/kakao/rooms/<chatId>` body `{ watched?: boolean, autoDraft?: boolean }` (at least one) -> `{ ok: true, watched: string[], autoDraft: string[] }`.
  Turning `watched` off also turns `autoDraft` off; `autoDraft: true` on a room that is not watched is refused (409). Broadcasts `{kind:"kakao_rooms"}`.
- `GET /api/kakao/chat/<chatId>?limit=80&before=<logId>&after=<logId>` -> 403 `{error}` when the room is not watched, else
  `{ room: { chatId, name, kind, group }, messages: [{ id, collector, logId, authorId, sender, text, type, sentAt, fromMe }], read: <logId|null>,
  kakaoUnread: number, drafts: [{ code, text, basisLogId, created }], sends: [{ id, text, state, reason?, at, draft? }] }`.
  Messages oldest first. `read` = the owner's read position in the web app for this room (null = never opened; the client then
  uses `kakaoUnread`, KakaoTalk's own unread count, to place the marker). `drafts` = pending drafts of this room only. `sends` =
  this room's sends of the last 24 h (`state`: `sending` | `sent` | `failed`).
  Each message also has `unread: number`, KakaoTalk's read counter (the yellow number beside a bubble): how many members have
  not read it yet. It comes from `NTChatRoom.watermarkKeys` / `watermarkValues` (binary plists, each an array of int64: member user
  ids and, in the same order, each member's last-read logId). Rule: members whose id is neither the message's author nor the owner
  and whose last-read logId is below the message's logId. `0` = nothing to show (also when the room has no readable watermarks).
- `GET /api/kakao/chat/<chatId>/reads?from=<logId>` -> `{ counts: { [logId]: number } }` for the room's messages with logId >= `from`
  (oldest first, at most 500), zeros included, no bodies. 403 when the room is not watched, 400 when `from` is not a logId. The client
  calls it with the oldest shown logId to refresh the counters after a `kakao_read` event.
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
- `autoDraft` is stored in config `auto_draft_chats` (a subset of `watch_chats`). The dotz watch reports only rooms in both lists and
  never a message older than 30 minutes; with the list empty it reads no database at all.
- The draft route answers 403 for a room that is not watched and 409 while a draft of that room is still being made. A skip or a
  failure comes as `{kind:"kakao_draft", chatId, error}` (plain Korean). In the memo room (`self`) every message counts as incoming.

Two Macs (cross-machine contract, `hub/kakao/contract.ts`): `id` of a message is `k:<chatId>:<logId>` (KakaoTalk's ids come from
the Kakao server, so they match on every Mac), or `h:<chatId>:<hash of author, time and text>` when there is no logId.
`collector` is the name of the Mac that read it (also on send records). `mergeMessages` joins lists of several collectors by id,
idempotently. Every send, typed or confirmed draft, goes through `dispatchSend`, whose optional `lease(chatId)` hook can refuse
the send (a failed send with its reason) before kmsg runs.

Server-sent events on `/api/events` (ids only, never bodies or names):
- `{ kind: "kakao", chatId, logId }` a new message in a watched room (the client fetches `?after=`).
- `{ kind: "kakao_read", chatId }` somebody read more in a watched room (its read positions changed): the client refreshes the
  counters with `/reads`. Like `kakao`, it is only looked for while a page is connected.
- `{ kind: "kakao_send", chatId, id, state, reason? }` a send changed state.
- `{ kind: "kakao_draft", chatId }` the drafts of a room changed.
- `{ kind: "kakao_rooms" }` the watched list changed.
