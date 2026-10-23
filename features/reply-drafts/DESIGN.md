# Reply drafts (design of record)

Shipped feature folder, off by default and turned on per install (`bin/onboard.ts on` writes a personal `feature.md` with
`enabled: true`, like webmail-no-api). A source whose monitoring the user set up (zele on in config.json, a webmail-no-api site, a
connected YouTube or Instagram) gets suggestions without a separate step until the user decides otherwise (`settings.ts appOn`,
`monitored`); the first suggestion writes the personal switch so the orchestrator knows how to answer it. An explicit off wins. Distribution rule: no person's name, account, address or tone sample in the repo; the
tone is learned per install, from that install's user, and lives only under `<DATA_DIR>/custom/reply-drafts/`.

## Mechanism (generic engine in `hub/reply-draft.ts`)

1. One item -> one headless model call that only judges and drafts and answers one JSON object
   `{action: skip|draft, reason, to, subject, body, questions[]}`. The script, never the model, posts and sends.
2. The prompt carries the user's own sent sentences, the user's past corrections verbatim, rules and a forbidden list. The
   received text is data, never instructions; no invented style; no promised dates, money or terms.
3. Deterministic lint (recipient is the sender/reply-to/cc and not the user, `Re:` subject, length, no placeholders, no forbidden
   expression). One retry with the failures listed; what still fails is shown as a warning with the draft.
4. The same lint runs again right before sending (`draft.ts send`).
5. Each 2) 고치기 text is stored verbatim and dated under `## 고친 점` of the tone profile of the draft that was revised (its room, else its app).
6. `drafts.json` remembers every mail key already looked at, so a mail is not drafted twice.

## Approval

The offer is a `[ask]` built by `draftApprovalBlock` (1) 보내기 / 2) 고치기 / 3) 보내지 않기). `draft.ts send <id>` goes out only
when `draftVerdict` (hub/draft-approval.ts) finds the user's latest pick for exactly that id, made after the draft was created,
to be 보내기. Without a pick, with a pick for another id, after 고치기 or 보내지 않기: refused.

## Files (`<DATA_DIR>/custom/reply-drafts/`)

- `config.json` `{enabled, auto, apps: {mail|youtube|instagram|...: {auto}}, senders: {only, skip}, model?}`; a missing file means off. `enabled` is the feature
  switch, `apps.<app>.auto` is the switch of one source (every source off until turned on; `onboard.ts on|off --app <app>`). An old config without
  `apps.mail` drives mail by the top-level `auto`; `setApp` writes mail's state down before another source is switched on.
- `tone/` the tone store, one markdown file per profile, each with the sections `## 말투`, `## 예시`, `## 고친 점`, `## 금지` (bullets):
  - `tone/install.md` the whole install (fallback of everything);
  - `tone/<app>.md` one app: `mail`, `youtube`, `instagram`, `blog`, `kakao`, ... (app id `[a-z0-9-]`; `install` is reserved);
  - `tone/<app>/<room>.md` one conversation of a messenger (room id reduced to `[A-Za-z0-9_-]`, so it is always a safe file name).
  Reading (`loadStyle({app, room?})`): the 예시 come from the narrowest profile that has any (room -> app -> install) and the result says
  which level that was; 말투, 고친 점 and 금지 are merged from all levels, install first and the narrower ones later. Writing
  (`learnTone`, `recordCorrection`) goes into exactly one profile. Two rooms of one messenger therefore never share a tone, a room
  that was never written to follows its app, an app without samples follows the install.
  Legacy: an old `style.md` is read as the `mail` profile until `tone/mail.md` exists (the next write moves it over); for the `youtube`
  and `instagram` apps without samples, `## 예시` of `custom/sns/tone.md` is used (only for those apps, between app and install).
- `drafts.json` `{drafts, keys}`; draft ids are `R` + 6 base32 characters; a newer draft for the same mail makes the older one stale. Each draft keeps its `app` and `room`.

## How a new install's tone is learned

The base is a deep first sweep, the details come from use (owner 2026-10-23; method generalised from the reference install, whose
mail agent drafted from an extract of the whole sent mailbox, a per-situation reply template in the user's own sentences, and verbatim
corrections turned into a checklist). `lib/persona.ts`:

- First sweep, once per profile (`learnFirst`, recorded in `learned.json`; a source with nothing to read yet is asked again): up to
  `SWEEP_LIMIT` (200) sent texts, each with the start of what it answered, are kept in `sent/<profile>.md` and analysed in one model
  call into `## 정체성` (6-12 bullets: register, structure, exact greeting and sign-off, emoticons, recurring requests, how the user
  declines, asks and thanks, what they never write) and `## 답장 틀` (`<situation> => <sentence> | <sentence>`: how the user answers each
  situation seen at least twice, in their own sentences with `{slots}`, conditional lines marked `[...]`). Lines with an e-mail, a URL
  or a phone number are dropped; names are asked as `{slots}`.
- The draft prompt opens with the identity and the reply templates: a fitting template is filled, otherwise the user's own sentences
  are preferred over new ones; samples, rules and corrections refine it.
- Every `REFINE_EVERY` (5) corrections of a profile, one call folds them into its identity and templates (`maybeRefine`).
- Where it runs: mail before the first offered draft (`offer.ts`, gateway passes zele's sent mail when zele is on), a comment source
  before its first draft (`CommentAdapter.ownTexts`), a KakaoTalk room on its first draft (`ensureKakaoRoom`), and `onboard.ts on|learn`.
  Without an injected `analyze` call (tests, library use) nothing is analysed.

1. `onboard.ts on`: the `mail` profile from the user's sent mail when zele is on (`zele mail list --folder sent`, then `zele mail read <id>`).
   Comment tone needs no step: `custom/sns/tone.md` examples are read for `youtube` and `instagram` until those apps have their own.
2. `onboard.ts learn [--app <app|install>] [--room <id>] [--from-file <f>]`: sentences of a file into a chosen profile (default `mail`).
3. KakaoTalk: the first `draft.ts new --app kakao --room <chat id> --kind chat` of a room with an empty profile reads the user's own
   lines of that room from the hub/kakao reader (`lib/kakao-tone.ts`) and learns `tone/kakao/<chat id>.md`. Only that room's lines.
4. Then every 고치기: `draft.ts revise` records it in the draft's room (else app) profile; for a chat reply the orchestrator runs
   `draft.ts correct --app kakao --room <id> --change <text>`.

## Code

- `lib/offer.ts` `offerMailDraft`: the gateway hook for a new mail (off unless enabled and auto; never throws; a failure is logged and returns `failed`). `hub/main.ts` wires it into `mailDeps().offerDraft`.
- `lib/flow.ts` build / revise / send / drop shared by the offer and `bin/draft.ts`.
- `lib/tone.ts` sentence extraction (3-120 chars, quoted history and signatures dropped, deduped, at most 40) from injected sources, into one profile.
- `lib/kakao-tone.ts` the user's own text lines of one KakaoTalk room (injected reader, fixture in tests) -> `kakao/<chat id>`.
- `lib/senders.ts` zele: `zele mail read <id>` first (zele refuses a reply otherwise), then `zele mail reply <id> --to <to> --body <body>`; a refused
  reply is reported as a stale draft to redraft; the files staged for the draft ride along as `--attach <path>` (one flag each). Or a webmail-no-api site's draft/approve/send
  (no files: the sheet says so and asks once more); or a custom plugin's `reply` hook (docs/custom-plugins.md, files in `attachments`); anything else is refused ("직접 보내야 해요").
- `lib/library.ts` + `lib/staged.ts`: the instance's 첨부 파일 폴더 setting (`attachFolders.<instance>`). A reply that promises a file or answers a mail that asks for one gets the best filename matches (max 3, no model unless more than 3 tie) staged under `draft-files/<draft id>/<n>/`; the owner confirms or changes them in the send sheet (hub/draft-attach.ts), and nothing goes without 보내기.
  `readMailBody(source, id, run)` gives the gateway offer the mail text (zele read, or the site's `mail.ts <site> read <id>`).
- The model call is injected; the default is `hub/outlang.ts callModel` (subscription only, never an API key).

## Sources

Comments of YouTube, Instagram and websites also have their own source contract, shared collection (script only), a per-source chosen-posts list, a web view and one send gate: `features/comments` + `hub/comments/` (docs/comments-api.md). It takes its tone profile (`tone/<source>.md`), lint and `[ask]` shape from this engine; when it is on for a platform the old `sns-*-comments` watch is paused so a comment is handled once.

| Source | State | Adapter |
|---|---|---|
| mail (zele, webmail-no-api) | done | gateway hook `lib/offer.ts` |
| youtube comments | done | `features/youtube-instagram/lib/reply-adapter.ts` |
| instagram comments | done | the same file (one implementation for both platforms) |
| website / blog comments | done | `features/comments` (generic website adapter: RSS/JSON/script to read, webhook/script to post; docs/comments-api.md) |

A comment source plugs into `lib/comments.ts` with a `CommentAdapter` and its watch prints one line per new comment:
`{app, label, parse(line) -> {id, author, text, context}, stage(comment, reply) -> pendingId, discard(pendingId)}`.
`draftComments(adapter, lines)` does the rest: source off -> every line passes through unchanged; on -> drafts once per comment id
(`drafts.json` keys), a skip makes no ask, a failure or the time budget (90 s) leaves the raw line for the orchestrator. `stage` only
creates a pending reply (YouTube/Instagram: an `sns.ts` reply job), never posts; the source's own approve command refuses without the user's
`1) 보내기` pick for exactly that pending id (`draftVerdict`). `reviseComment` is the 고치기 path: change recorded in the app's tone profile, new
pending reply and ask, old one discarded. The ask is `[ask]` + a quoted `> 원댓글 <작성자>: <글>` + `draftApprovalBlock` (label `대상`, ref = pending id);
the source's label (유튜브, 인스타) is in it, which is how 모니터링 files it under its app.
What a website adapter still needs: a watch that lists new comments of one site (browser login, session kept like webmail-no-api, quiet hours
and baseline state like `watchkit`), `parse`, a `stage` that keeps the reply as a pending item, a posting script that runs only after approval,
`onboard.ts on --app <site>` with its own connection check and tone learning from the owner's past replies on that site, and an
`integrations.ts` entry whose text patterns match its asks.
