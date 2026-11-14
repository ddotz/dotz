# Comment replies (YouTube, Instagram, any website)

One contract for the comments of every platform, shipped in `hub/comments/`, off until the owner asks
(`features/comments/feature.md`). No account, channel, site or name is in the repo: choices live in `~/.dotz/custom/comments/`.

## Contract (`hub/comments/contract.ts`)

- Comment id: `cm:<source>:<platform's own comment id>`. The same on every machine; `collector` only says who saw it first.
  Merging two lists is a union by id (`mergeComments`), the first copy wins.
- A source is one account, channel or site: `{key, kind: youtube|instagram|website, label, watch[], autoDraft, autoSend?, everyMin?, site?, autoMail?, mailApp?}`.
  `watch` lists the post ids to follow (`"*"` = all). An empty `watch` reads nothing and costs nothing.
- An adapter implements `list(src, cursor) -> {comments, cursor}` (comments newer than the adapter's own opaque cursor), `reply(src, comment, text, sendId)`,
  and optionally `posts(src)` (what the owner can choose to follow), `ownReplies(src, limit)` (tone examples) and `history(src, {target, deadline})` (the owner's past replies with the comments they answer, newest first, for the pair file; see below).
  A comment has: stable id, `thread` (the post), `parent` (for a reply), `author`, `text`, `postTitle`, `postLink`, `at`, `mine`.
- One send gate, `dispatchReply`: it posts only after the owner's `보내기` (`POST /api/reply/act {ref: <code>, action: "send"}` or a picked
  `[ask]` checked by `bin/comments.ts send`) or, for a source whose owner turned `autoSend` on, a rule match (regex list, daily cap,
  only clean drafts). A comment gets one reply: a second send is refused while the first is sending or sent; a failed one may be
  retried. State: `보내는 중` -> `보냄` | `실패` + reason (`replies.json`). A reply left `sending` by a restart may or may not be up: it becomes `확인 필요` (`unsure`,
  hub/comments/recover.ts), the gate refuses it, and on boot the platform is read back (`recheck`, or `list` for a site). The owner's reply with the same words proves it `보냄`;
  without proof only the owner ends it: `POST /api/reply/act` with `action: "resolve"` and `as: "retry"` or `as: "sent"` (closed as sent, nothing is posted). It is never sent again by itself.
- A draft's own actions (send, revise, edit, drop, restore, retry, resolve, undo) are the one reply flow's for every kind (`GET /api/reply/queue`, `POST /api/reply/act`,
  hub/reply-actions.ts with hub/comments/reply-adapter.ts); this API has no draft or send action routes of its own.

## Collecting and drafting

`bin/watch.ts` is a dotz_watch script (every 5 minutes): it reads, stores new ids (dedupe by stable id) and prints nothing unless a
source with auto-draft on made a draft. No model call happens while collecting. A draft is one cheap subscription model call with:
the comment stream, the post title, the owner's tone profile (`tone/<source>.md`) and the 8 past replies whose comment reads most like this one, verbatim, from the store's pairs merged with the source's pair file (below). Token use is stored on every draft
(`tokens`; `estimated` when the model reports none) and shown by `bin/comments.ts status`.

## Past replies (`history`, `engine.refreshPast`)

A draft learns from a meaningful amount of the owner's past replies, not only what was collected since connecting (the store trims old rows). Each source keeps its pairs (a comment and the owner's reply to it) in the
reply-drafts pair file of its key (`custom/reply-drafts/pairs/<key>.jsonl`, 1000 newest). `history` is read-only: it returns rows in the shape of `list` (a reply is `mine: true` with its `parent`), stores no comment, makes no draft or card, wakes nobody.

- Limits (`hub/comments/past.ts`): `PAST_TARGET` 1000 pairs per source, newest first, stop as soon as it is reached. YouTube: threads newest first (30 pages = 3000 threads = 30 quota units); Instagram: the newest 300 media, at most 1000 author lookups; every read also stops at its deadline. Rows read so far are kept when a later page fails; a read that got nothing throws.
- Weights: the closeness of a past comment is multiplied by `1 + 0.5^(age in days / 90)` (a reply of today counts double) and by 1.5 for a reply the owner changed by hand before sending; habits are measured over the newest 300 replies.
- When: `bin/watch.ts` calls `refreshPast` after each collect and reads at most ONE source per run, the first whose `pairs-<key>@1` mark is missing in `learned.json`; a failed read sets `pairs-<key>~tried` and waits 24 h. Setting a source up (`onboard.ts on`) reads it right after its first collect, so an existing source is read by the watch alone, with no rerun. Every run also saves the store's pairs into the pair file (no platform call), so a trimmed store loses nothing. A source with an empty `watch` is skipped.
- With 20 or more replies the source's tone profile learns its identity once (`learnFirst`, version `1`); a tuned profile is skipped and a hand-written `## 답장 틀` is kept.
- A bot draft the owner sent unchanged is never learned (also when the platform trimmed it).

## Keeping comments true to the platform (reconcile)

A stored comment must show what the platform shows now, on every read. `engine.reconcile()` is idempotent (a second run changes nothing, a closed draft is never reopened) and posts nothing:

- An adapter may implement `recheck(src, open) -> {comments, gone}`: the engine hands it the still-open comments (top-level, waiting for a reply or holding a pending draft; at most 200 per run, oldest first, rotating) and it answers the owner's replies under them (`mine: true`, `parent` = the comment's native) and the natives that no longer exist. A comment found gone gets `gone` (a time, never cleared) and is no longer 미답장.
- YouTube: `commentThreads.list?id=` (1 unit per 50 ids), `comments.list?parentId=` when a thread has more replies than returned; a thread missing from the answer is deleted. Instagram: the media of open comments are read again (paged); a reply's author comes from one `GET /{reply-id}?fields=username,from` and is kept in `authors.json` for good; replies are keyed by their real id (an old `<comment>.<index>` row is replaced, with its drafts, send record and 답장 안 함 moved along).
- Website sources: the read output SHOULD include the owner's own replies (`mine: true`, `parent`) of the last 30 days, so answered comments close.
- Every pending draft whose comment no longer waits (his reply is in the stream, the comment is gone, or 답장 안 함) becomes status `answered` with `closedReason` `answered-on-platform | deleted | dismissed`. A linked mail draft is detached and stays its own pending mail draft; the closed draft gets the note `확인: 댓글은 이미 답했어요. 메일은 따로 확인해 주세요`.
- `collect()` ends with it (re-checking at most every 30 minutes unless forced), the gateway runs it once at start, and `POST /api/comments/reconcile` runs it now and answers `{answered, gone, draftsClosed, errors?}` (the backfill).

## Web

`GET /api/comments/sources`, `PUT /api/comments/sources/<key>` `{watch?, autoDraft?, autoMail?, mailApp?}`, `GET /api/comments/sources/<key>/posts`,
`GET /api/comments/threads?app=<app instance id>` (youtube, instagram, site, or a site added as its own app: `site-<name>`, custom/apps.json `{"app":"site","filter":{"source":"<name>"}}`; each source lists the instance that owns it as `app`), `GET /api/comments/thread/<source>/<thread>`,
`POST .../thread/<source>/<thread>/read`, `POST /api/comments/comment/<id>/draft` (no body: the model drafts; `{text, extra?}`: a draft written by a script outside, no model call, answers `{code}`; `extra` is shown to the owner as the note `함께 할 일: ...` so the script knows what else it does once `comment_send` says sent; such a draft is never auto-sent. `extra` may also be `{ note?, mail: { app, to, subject, body, attach?: string[], fromLibrary? } }`: the gateway then records a mail draft (hub/mail-cli.ts compose, not listed in the mail app on its own) and the one approval card shows the reply and then the mail; the owner's 보내기 posts the reply and then sends the mail, and `comment_send` carries `mail: "sent"|"failed"` (+ `mailReason`) once the mail was tried; a failed mail leaves the reply posted. `revise` takes `part: "reply"|"mail"` for such a draft, `drop` drops both, and a reply that carries a mail wakes no 이어서 할 일 rule), `POST /api/comments/drafts/<code>/send|drop|revise`.
**Linked mail (`autoMail`, off by default).** With `autoMail: true` and `mailApp: "<mail app instance id>"` (e.g. `mail`, `mail-work`; config.json or the PUT above) a reply draft for a comment that asks for a file (`asksForFile`: 문서/음원/보조/음원/파일/PDF…) and writes an e-mail address also gets one compose mail draft (to = the address as written, files picked from the 첨부 파일 폴더 by the post title and the comment words), in the same card; the mail goes out only with the owner's 보내기. Without `mailApp` the card gets `확인: 메일 앱이 정해지지 않아 메일 초안은 만들지 않았어요`; a library miss is a `확인:` line. An install can hold files back from these drafts or narrow the pick with its own `custom/reply-drafts/auto-attach.json` (off without the file; `hub/auto-attach.ts`). `POST /api/comments/link-mail` `{code}` does the same for an existing pending draft (backfill, idempotent) and answers `{ok:true, mail, existing?}` or `{ok:false, skipped:<reason>}`.
`GET /api/comments/threads` rows sum those marks as `mails: {drafted, sent, failed}` when any comment has one, for the post's row.
The thread view marks each comment with its linked mail (`comments[].mail = {state: drafted|sent|failed, label}`; label `메일 초안 작성됨` / `메일 보냄` / `메일 실패: <이유>`), also for a comment answered outside the app whose mail draft stays; `GET /api/comments/drafts` and the thread's `drafts[]` carry `mailMark`.
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
- The cursor `1` (`--since 1`, JSON `?since=1`) means "from the beginning": answer with the owner's past replies (`mine: true`, `parent`) and the comments they answer, as many as you can (the read gets 240 s). It must only read: no mark, no read receipt, nothing changed on the site. RSS is read as usual. The private-message inbox (`site.dm`) is not read for history.

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
