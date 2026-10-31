# Comment replies (YouTube, Instagram, any website)

One contract for the comments of every platform, shipped in `hub/comments/`, off until the owner asks
(`features/comments/feature.md`). No account, channel, site or name is in the repo: choices live in `~/.dotz/custom/comments/`.

## Contract (`hub/comments/contract.ts`)

- Comment id: `cm:<source>:<platform's own comment id>`. The same on every machine; `collector` only says who saw it first.
  Merging two lists is a union by id (`mergeComments`), the first copy wins.
- A source is one account, channel or site: `{key, kind: youtube|instagram|website, label, watch[], autoDraft, autoSend?, everyMin?, site?}`.
  `watch` lists the post ids to follow (`"*"` = all). An empty `watch` reads nothing and costs nothing.
- An adapter implements `list(src, cursor) -> {comments, cursor}` (comments newer than the adapter's own opaque cursor), `reply(src, comment, text, sendId)`,
  and optionally `posts(src)` (what the owner can choose to follow) and `ownReplies(src, limit)` (tone examples).
  A comment has: stable id, `thread` (the post), `parent` (for a reply), `author`, `text`, `postTitle`, `postLink`, `at`, `mine`.
- One send gate, `dispatchReply`: it posts only after the owner's `보내기` (route `POST /api/comments/drafts/<code>/send` or a picked
  `[ask]` checked by `bin/comments.ts send`) or, for a source whose owner turned `autoSend` on, a rule match (regex list, daily cap,
  only clean drafts). A comment gets one reply: a second send is refused while the first is sending or sent; a failed one may be
  retried. State: `보내는 중` -> `보냄` | `실패` + reason (`replies.json`).

## Collecting and drafting

`bin/watch.ts` is a dotz_watch script (every 5 minutes): it reads, stores new ids (dedupe by stable id) and prints nothing unless a
source with auto-draft on made a draft. No model call happens while collecting. A draft is one cheap subscription model call with:
the comment stream, the post title and at most 5 of the owner's past replies (`tone/<source>.md`). Token use is stored on every draft
(`tokens`; `estimated` when the model reports none) and shown by `bin/comments.ts status`.

## Web

`GET /api/comments/sources`, `PUT /api/comments/sources/<key>` `{watch?, autoDraft?}`, `GET /api/comments/sources/<key>/posts`,
`GET /api/comments/threads?app=<app instance id>` (youtube, instagram, site, or a site added as its own app: `site-<name>`, custom/apps.json `{"app":"site","filter":{"source":"<name>"}}`; each source lists the instance that owns it as `app`), `GET /api/comments/thread/<source>/<thread>`,
`POST .../thread/<source>/<thread>/read`, `POST /api/comments/comment/<id>/draft` (no body: the model drafts; `{text, extra?}`: a draft written by a script outside, no model call, answers `{code}`; `extra` is shown to the owner as the note `함께 할 일: ...` so the script knows what else it does once `comment_send` says sent; such a draft is never auto-sent. `extra` may also be `{ note?, mail: { app, to, subject, body, attach?: string[], fromLibrary? } }`: the gateway then records a mail draft (hub/mail-cli.ts compose, not listed in the mail app on its own) and the one approval card shows the reply and then the mail; the owner's 보내기 posts the reply and then sends the mail, and `comment_send` carries `mail: "sent"|"failed"` (+ `mailReason`) once the mail was tried; a failed mail leaves the reply posted. `revise` takes `part: "reply"|"mail"` for such a draft, `drop` drops both, and a reply that carries a mail wakes no 이어서 할 일 rule), `POST /api/comments/drafts/<code>/send|drop|revise`.
Events (ids only): `comment`, `comment_draft`, `comment_send`, `comment_sources`.
모니터링 > 앱 has one entry per platform (유튜브, 인스타그램, 웹사이트 댓글) with the status line `답장 확인 N건 · 안 읽음 N`.

## Plugging in a website

Turn it on with one request; the agent runs
`bun features/comments/bin/onboard.ts on --app site --name <short-name> --read-kind rss|json|script --read <url|command> --post-kind webhook|script --post <url|command> [--secret <file>] [--owner <name>]`.
After an update the gateway makes the app instance of every site already configured here by itself (`hub/migrations.ts`, once per install); the command above stays for turning on a new site.
The same settings can be written by hand into the source's `site` object in `~/.dotz/custom/comments/config.json`.

Reading (`site.read`):

- `rss`: a comment feed. One `<item>` per comment: `guid` = id, `dc:creator` = author, `description` = text, `link` without `#...` = the post,
  `title` ("Comment on <post> by <author>") = post title. Comments by `site.owner` are his own.
- `json`: `GET <url>?since=<cursor>` answering the shape below.
- `script`: `command` is run as `<command...> --since <cursor>` (a leading `{site}` is replaced by `~/.dotz/custom/comments/sites`) and prints the shape below to stdout.

```json
{"comments": [{"id": "42", "thread": "post-7", "parent": "40", "author": "A", "text": "...", "postTitle": "...", "postLink": "https://...", "at": "2026-01-01T00:00:00Z", "mine": false}], "cursor": "42"}
```

Posting (`site.post`), body `{"sendId", "commentId", "thread", "parent?", "text"}`:

- `webhook`: `POST <url>` with that JSON (header `Authorization: Bearer <contents of ~/.dotz/secrets/<secret>>` when `secret` is set); a 2xx answer is success, `{"ref"}` is kept.
- `script`: the body arrives on stdin; print `{"ok":true,"ref":"..."}` or `{"ok":false,"reason":"..."}`; a non-zero exit is a failure with its output as the reason.

Scripts and commands run with the owner's rights and come only from his own config; nothing from a comment is ever used as a command.

## Post title, thumbnail and link (2026-10-23)

`GET /api/comments/threads` rows and `GET /api/comments/thread/<source>/<thread>` carry the post: `title` (the video title, or the first 80 characters of an Instagram caption),
`link` (the video or post URL), `thumb` (picture URL or null) and, on the rows, `kind` (`youtube` | `instagram` | `website`). A comment collected before its title was readable is renamed
on the next poll (`adapter.retitle`); the drafts' [ask] text names the post (`> 영상 <title>`) and says nothing about it while the title is unknown.

## Per-source options (off by default)

- `mailMatch: true`: before a draft, the owner's mail is searched read-only (zele `mail search`/`mail read`, window +-14 days, `-from:me`) for a mail from the
  commenter (same sender name or the commenter's handle in the mail; a mail that only names the same post is reported as someone else's). The draft gets the
  notes `메일 대조: 있음|못 찾음|확인 실패 ...`, `근거: ...` and, when that mail is not answered yet, `초안 메모: ...` (`hub/comments/mail-match.ts`).
- `pastSeed: true`: the 3 stored comments most like this one that the owner answered (his reply under it, or a reply sent through the gate) go into the
  draft prompt; when the model skips or leaves the reply empty, the closest past answer becomes the draft with a `확인 필요:` note (`hub/comments/past.ts`).
- Sending one part of a reply + mail card: `features/comments/bin/comments.ts send <code> --only reply|mail` (after the owner's 보내기, 답글만/메일만 보내기
  or own-words pick). `reply` posts the reply and leaves the mail draft as a mail of its own; `mail` sends the mail and leaves the reply draft pending alone.

## Website DM inbox (`site.dm`, optional)

```json
{"site": {"read": {"kind": "rss", "url": "https://blog.example/comments/feed"}, "post": {"kind": "script", "command": ["bun", "{site}/post.ts"]},
  "dm": {"read": {"kind": "script", "command": ["bun", "{site}/dm-read.ts"]}, "post": {"kind": "script", "command": ["bun", "{site}/dm-post.ts"]}}}}
```

- Read: `<command...> [--since <cursor>] [--room <room>]` (or `GET <url>?since=&room=`) prints
  `{"messages":[{"room","id","author","text","at","mine?","title?"}],"cursor?"}`. Each message is a comment of thread `dm:<room>` (id `dm:<room>:<id>`);
  a room is answered once the owner wrote in it after the message. A DM read failure keeps the comments and becomes the source's error (`쪽지함: ...`).
- Post: `{"sendId","room","text"}` to the webhook or on the script's stdin, same answers as a comment post. Then the room is read back (`--room`) and the
  send counts only when its newest message is the owner's with that text.
- The site's own login, tokens and API stay in the owner's scripts under `~/.dotz/custom/comments/sites/`; nothing from a message is ever run.
