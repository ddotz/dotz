# Mailboxes (메일함)

One mail app. Inside it, accounts; under each account, mailboxes; each mailbox has its own handling, tone and rules. Moving a mail to another
mailbox can teach the classifier. The design source is `site/prototype` (`#mailbox`, `s-mailbox.js`, `mailbox.css`); this file is the contract of the
real thing. UI words stay in Korean.

## Terms

- **Account** = one mail app instance (`mail`, `mail-2`, hub/integrations.ts `appEntries`). `custom/apps.json` keeps owning them: `label` is the
  account name, `filter.account` the zele account. With one account no account UI shows.
  `zele.accounts` in config.json (a list of addresses, e.g. `["a@example.com"]`; restart to apply) limits which logged-in zele accounts dotz watches; see docs/custom-plugins.md.
- **Mailbox** = a named box under one account, stored in `custom/mailboxes.json`. Every account has exactly one base mailbox (일반).
- **Conversation** = a mail thread: `threadIdOf(source, id)` (a poster's trailing `.N` message count is not part of the thread). One conversation is in
  one mailbox.

## Storage

`<data dir>/custom/mailboxes.json`, owned by hub/mailbox.ts, written atomically. Personal classification lives here, never in the repo.

```json
{ "version": 1,
  "accounts": { "<instance>": { "boxes": [ {
    "id": "b-xxxx", "name": "자료 요청", "icon": "file", "mode": "auto", "notify": true, "base": false,
    "conds": { "from": ["@team.example.org"], "subj": ["자료"], "body": [], "src": [] },
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

1. Same conversation: a pin, else a stored record of that conversation, which keeps a conversation that began in 일반 there too (one in-memory map, no file read). `why.kind = "thread"`.
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
`tone/<instance>/<box id>.md` (`ToneKey.room`), falling back to the instance (the shared mail profile when the instance has none of its own), then the install.
A draft records its `box` and `instance`, so a revision and the send check use the same tone, and a correction goes to the box's tone only when that file exists. A mail a judge moved is not matched against that box's own `rules` (no second call); the box's mode and the other reply settings apply.

### Who a mail must be addressed to

By default a mail reads 답장 필요 only when one of the install's addresses is in To. A mail where the address is only in Cc, or that came to a group address, stays out
(tags 참조로 받음, 단체 메일): no 답장 필요, no wake, and no automatic draft unless a draft rule matches.

An install where people often ask in Cc turns this off: mail app 설정 > 답장 필요는 받는 사람이 나인 메일만, or `{"mail":{"to_only":false}}` in `custom/apps.json`. It is one
value for the install, shown on every mail instance, and a change applies without a restart. Off, such a mail goes through the same reading as a mail in To, so a request
in it reads 답장 필요, wakes the bot and gets a draft under the mailbox's mode. The other exclusions stay on: his own mail, a machine sender, a List-Id or unsubscribe mail, a bulk
subject or notice, a mail greeting another To recipient. Stored mails are read again by the next classification (a restart, a new account list): with it off that marks only recent mails,
with it on again the gateway's own 답장 필요 on such mails goes; the owner's own mark stays either way.

A sent mail stays out of the boxes; 답 없는 메일 다시 묻기 (`unanswered_days` of the mail app, `hub/mail-unanswered.ts`) follows it by the app it belongs to, and its follow-up draft takes that app's and box's reply settings like any draft.

## Moving

`POST /api/mailbox/move {keys, box}` moves whole conversations inside one account and pins them; another account's box is refused. The response holds what
undo needs. `POST /api/mailbox/learn {box, kind, value}` adds a `from`/`subj` condition or a `not.from` veto; it is only called when the owner picks it in
the small 앞으로는 어떻게 할까요? box. A move alone teaches nothing.

## Voice

An account with 2 or more mailboxes learns one voice per mailbox from what the owner himself wrote in it (features/reply-drafts/lib/box-voice.ts); an account with one mailbox behaves as before and shows nothing.

- Source: the stored reply pairs, which now keep `conv`, `subj` and `account`. A sent draft of ours and an edited draft are left out, even when he changed them, because they are not his own words. A mail he started himself has no received mail, so it is not a pair and does not count.
- Which mailbox a pair belongs to is worked out when it is read (`pastPass`, hub/routes-mailbox.ts), so a move, an undo or a deleted mailbox rewrites nothing. In order: the pin of its conversation, the stored mail it answered, the mailbox it was learned in (its mail left the store), the mailboxes' rules, the base mailbox. A source with no conversation id matches the stored mail by sender and subject.
- Amount: the newest 200 of a mailbox, under the same size caps as the account's sweep. Fewer than 20 keep the account's voice, and the 말투 item and `onboard.ts status` say so. Below 20 the examples of a draft are the account's too.
- Cost: one Sonnet-level call per mailbox, after the pair refresh of a draft, at most 3 mailboxes in one pass and one try a day per mailbox. It runs again only when at least 20 or a quarter of the newest replies changed, so a move and its undo cost nothing.
- Result: `tone/<instance>/<box>.md`, which a draft already read. The file is copied to `.bak-<date>` before every write. `## 고친 점` and sections he wrote stay; a file with a voice of its own is not learned over (`kept`), and one with corrections is learned once and then only by 다시 배우기. A mailbox that fell under 20 returns to the account's voice, and its corrections stay.
- 기본 지시 still goes over the voice.
- Existing installs: the first refresh with mailboxes reads each sent source once more for the mailbox facts of the stored pairs, after copying the pairs file to `pairs/mail.jsonl.bak-boxes`.

## Settings and 메일함 추가 (web)

Two more screens of the same view, drawn in place of the list: `MX.scr` is `set` or `new` and is the last part of the address, `monitoring/i%3Amail/<account>/<box>/set` (an old address without it opens the list). 메일함 설정 saves each change at once with
`PUT /api/mailbox/box` (the whole box, so `alone`, `rules` and `conds.src` come back unchanged); a refused save restores the box and shows the hub's reason. A box list's `n:<name>` entry opens the first account's box of that name. The base box has no delete; deleting another sends
`DELETE /api/mailbox/box` and its mail reads as 일반. 메일함 추가 starts from a suggestion, an empty box or another box's settings; a suggestion fills the name and a `conds.from` domain, and the mail already there moves only when the owner switches that on (then `POST /api/mailbox/move`).

- `GET /api/mailbox/tone?app=<instance>&box=<id>` -> `{ok, own, summary, corrections, voice}`: the box's tone file `tone/<instance>/<box>.md` (the summary falls back to the instance's, then the install's, like a draft does; `corrections` is the box's own file only). `voice` is `{state, count, need, at?, texts?}` (see "Voice"). Read when the settings item 말투 opens, never per card.
- `POST /api/mailbox/relearn {app, box}` -> `{ok, result, voice}`: 다시 배우기, `result` one of `learned`, `few`, `busy`, `empty`. It is the only thing that replaces a voice the owner tuned.
- `GET /api/mailbox/examples?app=<instance>&box=<id>` -> `{ok, examples: [{received, reply}]}`: 예시 보기, the newest 5 replies he wrote himself in this box.
- `GET /api/mailbox/suggest?app=<instance>` -> `{ok, groups: [{domain, label, count, senders, keys}]}`: one pass over the stored mail of that account that is still in its base box, grouped by sender domain (at most 8 groups of 2 mails or more, 3 senders and 100 keys each), without free-mail domains and outgoing mail. No model call; once per opening of the screen.

## Web

The mail app is one row in 모니터링 and one screen for all instances: head card, account chip in the app bar (only with 2+ accounts), left pane on wide
screens and chips on a phone, the existing filter tabs, list, 메일 쓰기. Rows stay `.mr` with the partial redraw, off-screen skipping and paging of
`mbRow`/`mbDrawn`. Mailbox data comes with `GET /api/integrations` (a mail item carries `boxes` and `account`) and `mail.box` / `mail.boxWhy` on the conversation card (the card's `why` is already the 참조로 받음 tag): no new poll.

## Limits

No new polling. No per-card file read. No per-mail model call for classification. 묶음 제안 is on demand, grouping stored records by sender domain.

## Folding per-source instances

Some installs split one mail account into several app instances by `filter.source`: an outside watch classifies the mail and posts it under a source per
category. `hub/mailbox-cli.ts` turns them into mailboxes of one account. It changes data only; the classification stays the watch's, and a generic `conds.src`
reads its sources.

    bun hub/mailbox-cli.ts fold --base <the instance that becomes 일반>           # prints the plan, writes nothing
    bun hub/mailbox-cli.ts fold --base <instance> --apply                         # keeps a backup under custom/mailbox-fold-<time>/
    bun hub/mailbox-cli.ts undo <that backup>

- The target is always the default `mail` instance, because it is the one that claims mail no other instance claims; it must have no `filter.source` of its own.
  Each folded instance becomes a box with `conds.src`; `--base` folds one into 일반. By default it takes the instances with a `filter.source` on the same
  `filter.account` as the target; `--from` narrows that list.
- An instance with the same 기본 규칙, rules and folder as the target inherits them. One that differs becomes an `alone` box and keeps exactly what it had,
  so no mail starts following rules it did not follow. `mode` stays undefined, so drafting does not change until the owner picks a mode.
- Watches move to the target. `tone/<instance>.md` is copied to `tone/<target>/<box>.md`; the old file stays for drafts still waiting.
- Stored mail is not rewritten: a record with no `mbox` is read through `conds.src`. Waiting drafts keep working: their send route is the mail's source and account.
- Not carried, listed by the plan: `discord`, `delete_original`, `push`, `off`. Anything that names an old instance outside these files (`--app <old id>` in a rule
  or a watch script) has to be changed by hand before `--apply`: search the install for the old ids first.

Before `--apply` on another install, ask its owner. Test it on a copy with `--data <dir>`.
