# Mailboxes (메일함)

One mail app. Inside it, accounts; under each account, mailboxes; each mailbox has its own handling, tone and rules. Moving a mail to another
mailbox can teach the classifier. The design source is `site/prototype` (`#mailbox`, `s-mailbox.js`, `mailbox.css`); this file is the contract of the
real thing. UI words stay in Korean.

## Terms

- **Account** = one mail app instance (`mail`, `mail-2`, hub/integrations.ts `appEntries`). `custom/apps.json` keeps owning them: `label` is the
  account name, `filter.account` the zele account. With one account no account UI shows.
- **Mailbox** = a named box under one account, stored in `custom/mailboxes.json`. Every account has exactly one base mailbox (일반).
- **Conversation** = a mail thread: `threadIdOf(source, id)` (a poster's trailing `.N` message count is not part of the thread). One conversation is in
  one mailbox.

## Storage

`<data dir>/custom/mailboxes.json`, owned by hub/mailbox.ts, written atomically. Personal classification lives here, never in the repo.

```json
{ "version": 1,
  "accounts": { "<instance>": { "boxes": [ {
    "id": "b-xxxx", "name": "문서 요청", "icon": "file", "mode": "auto", "notify": true, "base": false,
    "conds": { "from": ["@team.example.org"], "subj": ["문서"], "body": [], "src": [] },
    "not": { "from": [] },
    "judge": { "on": false, "text": "" },
    "how": "", "greets": [{ "who": "", "addr": "", "hello": "" }], "folders": [], "bans": [],
    "rules": []
  } ] } },
  "pins": { "<instance>|<source>-<conversation>": "<box id>" } }
```

- A mail record gets an optional `mbox` (the box id; `box` is taken by the mailbox's own read/archived flags, hub/mail-sync.ts) and `mwhy` (`{ kind: "from"|"subj"|"body"|"src"|"judge"|"moved"|"thread", value? }`).
- `pins` remember the owner's moves past the eviction of a record (capped, oldest out).

## Compatibility and rollback

Nothing is rewritten when the feature ships. A missing file, a missing account entry, a record with no `box` or a `box` that no longer exists all
mean the account's base mailbox. The implicit base mailbox has `mode` undefined = **inherit**: `auto_draft`, `draft_rules`, `draft_default`,
`attach_folder` and the tone work exactly as before. So an install without mailbox settings behaves as it does today, its stored mail and app settings
sit in 일반, and removing `custom/mailboxes.json` restores the old behavior with every mail in place.

## Where a new mail goes

`boxOfMail` in hub/mailbox.ts, synchronous, in order; first hit wins:

1. Same conversation: a pin, else a stored record of that conversation (one in-memory map, no file read). `why.kind = "thread"`.
2. Rules in mailbox order: `conds.src` (exact source), `conds.from` (address or `@domain`, a box's `not.from` vetoes), `conds.subj`, `conds.body`.
   Text compares lowercased; `body` sees what the post carried (summary and body), never an extra read.
3. Base mailbox.

Stored mail with no `box` is read the same way for `conds.src` only (so an installation folded from per-source instances needs no rewrite of the store);
other rules never reclassify old mail by themselves.

### The model, only when needed

A mailbox's 내용을 보고 판단 (`judge`) is off by default. It joins the **existing** rule match of features/reply-drafts/lib/rules.ts `matchRule`: the one
short call that already runs for draft rules sees the judge texts as more numbered conditions. A mail a rule placed, a mail that needs no reply, and an
account with no rule or judge on cost no call. There is never a second per-mail call for classification. A hit moves the mail to that box before drafting.

## Handling

`mode` of the mailbox the mail landed in (features/reply-drafts/lib/offer.ts):

| mode | 이름 | New mail |
|---|---|---|
| undefined | (base default) | today's behavior |
| `auto` | 자동 초안 | draft, even with the app switch off |
| `ask` | 확인 먼저 | notify, no draft; the mail's 초안 작성 button drafts on request |
| `notify` | 알림만 | notify, no draft |
| `quiet` | 조용히 모으기 | recorded, unread; no notice, no phone push, no Discord thread, no wake, no draft |

`notify: false` silences the notice for `auto`, `ask` and `notify` too. Whatever the mode: a draft only ever becomes an approval card, the owner's
보내기 is the only way out, and a requested draft (초안 작성) always works. Moving a mail or changing a mode never touches a waiting draft, its card or its
send route: the instance stays the same, because a move never crosses accounts.

Reply settings of a mailbox apply to drafts made in it: `how` after 기본 규칙; `greets` and `bans` as instruction lines; a draft holding a banned phrase
gets a warning on its card; `folders` in front of the app's 첨부 파일 폴더; `rules` in place of the instance's draft rules when non-empty; tone
`tone/<instance>/<box id>.md` (`ToneKey.room`), falling back to the instance, then the install.

## Moving

`POST /api/mailbox/move {keys, box}` moves whole conversations inside one account and pins them; another account's box is refused. The response holds what
undo needs. `POST /api/mailbox/learn {box, kind, value}` adds a `from`/`subj` condition or a `not.from` veto; it is only called when the owner picks it in
the small 앞으로는 어떻게 할까요? box. A move alone teaches nothing.

## Web

The mail app is one row in 모니터링 and one screen for all instances: head card, account chip in the app bar (only with 2+ accounts), left pane on wide
screens and chips on a phone, the existing filter tabs, list, 메일 쓰기. Rows stay `.mr` with the partial redraw, off-screen skipping and paging of
`mbRow`/`mbDrawn`. Mailbox data comes with `GET /api/integrations` (a mail item carries `boxes` and `account`) and `mail.box` / `mail.boxWhy` on the conversation card (the card's `why` is already the 참조로 받음 tag): no new poll.

## Limits

No new polling. No per-card file read. No per-mail model call for classification. 묶음 제안 is on demand, grouping stored records by sender domain.

## Folding per-source instances

Some installs split one mailbox into several app instances by `source`. `bun hub/mailbox-cli.ts fold` turns them into mailboxes of one account, as data
only. See the section written with that tool.
