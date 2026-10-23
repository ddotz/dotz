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
- Photos, files and other non-text messages: a message has `media` only when its type carries something to show; the web never gets
  a URL, a local path or the raw `NTChatMessage.attachment` JSON. `text` is sent for text (1), replies (26), feed lines (0) and unknown
  types (e.g. 71); for photo / video / voice / file / emoticon / location types it is `""` and `media` says what to draw:
  - `{ kind: "photo", w?, h?, count, expired }` types 2 and 27 (album: `count` = number of images; `w`/`h` = the thumbnail size of the first)
  - `{ kind: "video", w?, h?, d?, expired }` type 3 (`d` = seconds)  - `{ kind: "voice", d?, expired }` types 4 and 5
  - `{ kind: "file", name, size?, local, expired }` type 18; `local` = the owner downloaded it and it still exists on this computer
  - `{ kind: "emoticon", alt, text? }` types 12, 20, 25 (`alt` like `(이모티콘) 하트`, no image; `text` is the message written with the sticker, absent when it went out alone)
  - `{ kind: "reply", quote, quoteSender? }` type 26 (`quote` = the replied-to text, clipped to 80 characters; `quoteSender` when that author is
    among the senders of the same page, `나` for the owner); `text` is the reply itself
  - `{ kind: "location", label, lat, lng }` type 16 (`label` = address, else title)
  `expired` = the attachment's `expire` (epoch seconds) is in the past (a file the owner downloaded is never expired).
- `GET /api/kakao/media/<chatId>/<logId>?i=<index>&v=thumb|full` (default `i=0`, `v=full`; `i` = the album image) -> the bytes of a
  photo (thumb = the stored thumbnail URL), video (thumb = a stored thumbnail URL when there is one, else 404; full = the video) or
  voice message. The gateway fetches the URL stored in the database itself with a plain GET: https only, host must end in
  `.kakaocdn.net`, no cookies or auth headers, redirects followed by hand (at most 3) with the same host check, 25 MB cap (413 when
  declared larger; a stream that grows past it is cut off), 20 s timeout, nothing cached on disk. The answer keeps the upstream
  `Content-Type` only when it is `image/*`, `video/*` or `audio/*` (else 502), with `Cache-Control: private, max-age=86400`,
  `nosniff` and a sandboxing CSP. Errors are `{ error }`: 403 room not watched, 409 integration off, 400 bad ids / index, 404 no such
  message in that room (or nothing to show), 410 `기간이 지나 볼 수 없어요` (expired, or upstream 403 / 404 / 410), 413 too big,
  502 the fetch failed or the URL is not an allowed one. This is the only HTTP the integration makes to Kakao hosts.
- `GET /api/kakao/media/<chatId>/<logId>/file` -> the file of a type 18 message from its `localFilePath` (only when it exists on this
  computer) as `Content-Disposition: attachment` with an RFC 5987 `filename*`; else 404 `{ error: "이 컴퓨터에 내려받은 파일이 없어요" }`.
- `GET /api/kakao/chat/<chatId>/reads?from=<logId>` -> `{ counts: { [logId]: number } }` for the room's messages with logId >= `from`
  (oldest first, at most 500), zeros included, no bodies. 403 when the room is not watched, 400 when `from` is not a logId. The client
  calls it with the oldest shown logId to refresh the counters after a `kakao_read` event.
- `GET /api/kakao/chat/<chatId>/head` -> `{ logId }`, the newest logId of the room (`""` when it has no message), nothing else. While the database
  files (db and -wal) do not change it is answered from memory (no query). A page showing another computer's room asks it every ~2 s
  through `/api/peer/proxy` (that room's events are not on this computer's stream) and fetches `?after=` only when it moved.
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
  stored (or `{kind:"kakao_draft", chatId, error}`). One model call (the reply-drafts `model` setting, else sonnet-class; never a mini model): messages since the owner's last
  reply in the room, the room's short summary file `<dataDir>/kakao/summaries/<chatId>.md` (refreshed by the same call, only when a
  draft is made), up to 14 (other's message -> owner's reply) pairs from the last 300 messages, the room's register (반말/존댓말, counted
  from the owner's own lines) and the owner's voice profile (`tone/kakao.md` + `tone/kakao/<chatId>.md`). The whole prompt is capped at
  4400 characters (~3K tokens). The first draft of a room reads it once: the draft model gets the last ~1000 messages as (other's message ->
  owner's reply) pairs plus the counted habits and writes a short Korean profile (`## 대화 이해` in `tone/kakao/<chatId>.md`); later drafts only read the
  cached files. The global `tone/kakao.md` counts the owner's lines of his 8 most recent non-excluded rooms. Recent lines weigh double (newest
  100 own lines), and numbers, links and test lines never enter a profile. After 200 more own lines the model updates the old profile from the new
  lines only, and an edited send (고치기) is recorded in the room profile. The stored draft records `tokens: { in, out }`.
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
- `{ kind: "kakao", chatId, logId }` a new message in a watched room (the client fetches `?after=`). fs.watch gets no event for KakaoTalk's files,
  so while a page is connected the gateway stats the db and -wal files every 500 ms and queries only when they changed.
- `{ kind: "kakao_read", chatId }` somebody read more in a watched room (its read positions changed): the client refreshes the
  counters with `/reads`. Like `kakao`, it is only looked for while a page is connected.
- `{ kind: "kakao_send", chatId, id, state, reason? }` a send changed state.
- `{ kind: "kakao_draft", chatId }` the drafts of a room changed.
- `{ kind: "kakao_rooms" }` the watched list changed.
