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
`POST .../thread/<source>/<thread>/read`, `POST /api/comments/comment/<id>/draft`, `POST /api/comments/drafts/<code>/send|drop|revise`.
Events (ids only): `comment`, `comment_draft`, `comment_send`, `comment_sources`.
모니터링 > 앱 has one entry per platform (유튜브, 인스타그램, 웹사이트 댓글) with the status line `답장 확인 N건 · 안 읽음 N`.

## Plugging in a website

Turn it on with one request; the agent runs
`bun features/comments/bin/onboard.ts on --app site --name <short-name> --read-kind rss|json|script --read <url|command> --post-kind webhook|script --post <url|command> [--secret <file>] [--owner <name>]`.
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
