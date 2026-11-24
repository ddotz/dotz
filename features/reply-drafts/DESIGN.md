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
   A try that passes the lint is then checked by the style judge (`hub/style-judge.ts judgeStyle`): one more call on the runner the
   mail rule matcher uses, in a fresh context that sees only the owner's rules in two numbered blocks (`styleConditions`: the standing
   rules of `## 말투` and the hand-added sections, then the corrections a prompt carries without their leading date and its colon, in
   the same order and budget, duplicates once and a correction equal to a standing rule left out; the numbers run on from the standing
   rules into the corrections, and a standing rule beats a correction, a newer correction an older one), a revise's change in its own
   block that wins over every condition (`asked`), the received message (KakaoTalk: the last 1500 characters of the chat window from a
   line start, so the line the draft answers stays; mail and comments: the first 1500) and the draft, with the block markers taken out
   of all three texts. The judge checks wording only (tone, speech level, endings, set phrases, emoji, length, greeting, closing), since
   it does not see the whole situation; it answers `{violations: [{rule, about: wording|content, quote, why}]}`. Code keeps a violation
   only when its `about` is not `content` (none counts as wording), its rule number is listed and its quote is in the draft (whitespace
   and NFC aside; 2+ code points, or one code point that is no letter, digit or space, such as an emoji), at most 5. A kept one
   is a rewritable failure (`it breaks the owner's rule '<rule>' at '<quote>'`) for the same one retry; the retry is judged once more
   and what it still breaks is a `확인: 말투 조건과 달라 보여요: <rule>` note. With no judge or no rule every result equals the
   one without the style judge for the same model answers: a retry the lint asked for keeps its own outcome (a skip or ask stays a skip
   or ask) and its own `lesson`, `forbid` and `scope`. A rewrite only the judge asked for replaces the first draft only when it is
   a draft that passes the lint with no finding (mail and comments: no `lintReply` finding and no attach failure; KakaoTalk: no
   `kakaoLint` note), and is then judged once more; one that has a finding, is not a draft (skip, ask), does not parse or throws leaves
   the first draft with its warnings and the judge's notes, and a judged revise keeps the `lesson`, `forbid` and `scope` of its
   first try, since the rewrite's prompt carried the judge's findings, not the owner's change. A comment draft with a style note is not
   `clean`, so an auto-send rule does not send it by itself and the owner sees its card. At most two judge calls and two draft tries;
   a thrown, late (its own limit, `JUDGE_TIMEOUT_MS`, 15 s) or malformed answer judges nothing and logs one `reply draft:` line. No
   call without conditions, with config `guard.style_judge: false`, at send time or on the owner's own text. Mail (`flow.ts judgeOf`,
   traced as `judge` in the draft's `model calls` line), comments (`EngineDeps.judge`) and KakaoTalk (`WebDeps.judgeModel`, after
   `kakaoLint`) share it.
4. The same lint runs again right before sending (`draft.ts send`).
5. A revision records only the lasting preference the change shows (the model's `lesson`), dated under `## 고친 점` of the tone profile of the draft that was revised (its room, else its app). A one-off change (`lesson` empty) records nothing; a model that gives no `lesson` leaves the change itself. A revise also yields the wordings the user banned (`forbid`: verbatim in his change, 2 to 40 characters, never a `/regex/`) and a `scope` that says for whom the lesson holds: `recipient` when the change is about the person this reply goes to (이분께는, 이 사람한테는, a name), which moves the record to that person's recipient file; `everywhere` when he says it holds always or everywhere or rejects the wording itself (grammar, spelling, a habit of language), which moves it to the install profile; `channel` otherwise. An older answer's `everywhere` boolean still parses (true is `everywhere`, false or absent `channel`), and an unknown `scope` string is `channel`. Bans go to `## 금지`, where the lint enforces them on every later draft. A mail, comment or chat prompt carries the corrections of all levels newest first by date within a character budget (`CORRECTIONS_BUDGET`, 4000; KakaoTalk 1200), not a fixed count. A standing request made in chat takes the same path through `draft.ts correct` (`--forbid`, `--allow`, `--forget`; `draft.ts tone` shows what is stored), never a hand edit of a tone file.
6. `drafts.json` remembers every mail key already looked at, so a mail is not drafted twice.
7. A mail draft reads the whole mail and the sender's earlier mail, and judges who wrote before writing: `recipient {who, evidence}`, where the evidence must be the sender's own words.
8. An edit asked outside a card goes through the gateway's one reply flow (a typed change read by code, or the turn's one `[revise <id>] <change>` line), which records it once, so the next draft sees it.
9. A text the owner wrote himself (직접 수정, `editedFrom`) and sent teaches through `lessonOfEdit` (`lib/edit-lesson.ts`), never as the raw `초안 "…" 대신 "…"` line. One call (12 s at most) sees the draft as the assistant wrote it, the text as the owner sent it and the received message (cut to 1500 characters), each fenced as data with `<<<`/`>>>` markers stripped, and answers `{"lesson","everywhere"}`: the lasting wording preference as one short Korean line with its condition ("~에는 ..."), in the owner's words where possible, or `""` when the edit only changes facts, names, dates, files or what this one message says; `everywhere` only when it is about the language itself (grammar, spelling, a habit of wording). Code keeps one line of 1..288 code points; texts that differ only in whitespace ask nothing; `""`, a throw, a late or a malformed answer stores nothing (a failure logs one `reply draft:` line). It starts after the send's status is written, in the background: the send's result, its stored status and what the owner sees never wait for it. Every lesson goes through the one learning door: `learnLine` (curation against the profile's lines, the journal), then `refineAfterCorrection` for a stored correction. Mail: `learnSentEdit` reads the sent draft from the store, asks through `learnCall` of the draft's app and stores the lesson with `learnLine` (a standing rule of install when `everywhere`, else a dated correction of the draft's own profile), then `refineAfterCorrection`; without `learnCall` nothing is stored. Comments: the engine (`learnSent`, hub/comments/draft-run.ts `learnSentParts`) asks its reply model with the comment the draft answered (`EngineDeps.edits.lessonOfEdit`) and stores the lesson through `edits.learn` (hub/reply-mail.ts `replyLearning().learn`, wired by hub/comments/real.ts; the source's profile, or install). The mail that rides on a comment card is sent by the mail link with `learn: false` and learned like any mail (`edits.mail` -> hub/reply-mail.ts `learnMailEdit` -> `learnSentEdit`) for every send that carried it: the whole card or 메일만 (보내기, 메일만 보내기, its 다시 보내기). Who learns a sent draft is a stored fact, not the process flow: each sent draft that can teach (the mail draft, the comment draft's reply, the KakaoTalk draft) carries `editLearned`, which its one learner (`learnSentEdit`, `learnEdited`, the KakaoTalk adapter's `learnEdit`) claims under that store's file lock before the model call (store.ts, hub/comments/store.ts and hub/kakao/send.ts `claimEditLearned`); a draft already marked is never learned again, by any caller in any process, and a record without the field counts as unmarked. So every place that finds an approved send sent may start the learning: the gateway's send queue (`SenderDeps.learn` -> the adapter's `learnSent`, with the part the send carried, resolved by ref, never by a send target) after a run's outcome, for a job a boot finds left `sending` or `queued` and already sent, for a live one the later check finds sent, for an unsure one a proof reads back, and on `settle` (the owner's 나갔어요, a comment child that finished after a restart); the comment engine on a reply it saw posted; and a send CLI run by hand. The queue still runs `draft.ts send` / `comments.ts send` with `--no-learn`, so the learning is the gateway's. A send CLI run by hand (`draft.ts send`, `comments.ts send`, `mail-cli.ts send --draft`) prints its result, then waits for its lesson (`learningSettled`, `engine.idle`) before it exits; that wait is bounded by the lesson call (12 s), the curation (12 s), and for a stored correction the identity refinement (up to 120 s) and the compaction (30 s). KakaoTalk: after a send that is sent and confirmed (the in-process run's `yes`, or the owner's 나갔어요 on an unconfirmed press), the reply adapter (`KakaoKit.edits`, `learnSent`) reads the chat lines the draft answered (since the owner's last line, up to the draft's basis message), asks the room's model in the background and hands the lesson to `onRevise` (that room's profile, or install).

## Approval

The offer is a `[ask]` built by `draftApprovalBlock` (1) 보내기 / 2) 고치기 / 3) 보내지 않기). `draft.ts send <id>` goes out only
when `draftVerdict` (hub/draft-approval.ts) finds the user's latest pick for exactly that id, made after the draft was created,
to be 보내기. Without a pick, with a pick for another id, after 고치기 or 보내지 않기: refused.

The owner is asked once, with a complete draft (owner 2026-10-26): a draft that comes back with `questions` goes back to the model
once (`buildDraft`, mail and comments) to settle them from the message, context and tone; what is still open is a fact only the owner
knows and is asked in the same card, as a `정할 것:` list (one `- ` line each) right above `결정: 이 답장 보낼까요? (<id>)` (draftApprovalBlock
`decide`; owner 2026-11-02: joined into the question it read as one run-on line). Lint warnings stay a `-# 확인:` line.
A change to how a card shows its files or warnings must reach the cards already waiting, not only new ones: every open card is re-read
on start and re-checked against its staged files on start, after a file changes and when the approvals or the bell are read
(hub/notices.ts refreshNoticeDrafts, refreshDraftFiles).
A mail whose words and files disagree does not go out on 1) 보내기 (owner 2026-11-04: rules in the prompt did not hold, and a warning shown once did not either). `hub/attach-check.ts` compares
them, with plain code and no model, for every rendering of the card and again in `sendDraft`; `draftAttachIssues` adds the files chosen but not on the draft yet (`wantFiles`). The card carries a
`-# ⚠️ 첨부 확인:` line and a 4th option 이대로 보내기 (`send-as-is`, also a typed "이대로 보내": the pick on Discord spends the card's buttons), and both follow the staged files (`withAttachIssues`).
A refused send leaves the draft pending and opens the card again (`markDraftSend`). On a reply + mail card the refusal comes before the reply is posted (hub/comments/engine.ts `mailRefusal`).
A chat message that needs his own decision still asks first (exit 4), since the reply depends on it.

## Files (`<DATA_DIR>/custom/reply-drafts/`)

- `config.json` `{enabled, auto, apps: {mail|youtube|instagram|...: {auto}}, senders: {only, skip}, model?}`; a missing file means off. `enabled` is the feature
  switch, `apps.<app>.auto` is the switch of one source (every source off until turned on; `onboard.ts on|off --app <app>`). An old config without
  `apps.mail` drives mail by the top-level `auto`; `setApp` writes mail's state down before another source is switched on.
- `tone/` the tone store, one markdown file per profile, each with the sections `## 말투`, `## 예시`, `## 고친 점`, `## 금지` (bullets):
  - `tone/install.md` the whole install (fallback of everything);
  - `tone/<app>.md` one app: `mail`, `youtube`, `instagram`, `blog`, `kakao`, ... (app id `[a-z0-9-]`; `install` is reserved);
  - `tone/<app>/<room>.md` one conversation of a messenger (room id reduced to `[A-Za-z0-9_-]`, so it is always a safe file name);
  - `tone/<app>/to/<recipient>.md` one person the owner answers in that app (`ToneKey.to`): for a mail the address its reply goes to by
    default (`replyAddress`: a usable Reply-To, else the first address of From), kept under `mail/to/` for every mail app instance and
    mailbox (`recipientApp`: a person's address is the same in each), or a comment's author as the card shows it. The name is `recipientFile(id)`: the id NFC, trimmed and lowercased,
    `[a-z0-9-]` kept and every other UTF-16 code unit written `_` plus its four hex digits, so it is injective and `recipientOf` reads it back.
    An empty id, one over 120 code units or whose name would pass 250 characters, and the nobody values (`익명`, the adapters' unknown user)
    have no recipient level. KakaoTalk has none: its room already is the person.
  Reading (`loadStyle({app, room?, to?})`, levels from `levelsOf`): the 예시 come from the narrowest profile that has any (to -> room -> app -> install) and the result says
  which level that was; 말투, 고친 점 and 금지 are merged from all levels, install first and the narrower ones later. The recipient's own 말투
  and 고친 점 lines are also listed apart (`ReplyStyle.recipient`): the draft prompt shows them under their own heading as holding for this
  recipient and winning over a broader line that says otherwise, and the style judge numbers them last under the same meaning. The
  prompt's and the judge's one corrections budget takes the recipient's corrections first and the other levels' in what is left. Every style
  load of a mail or comment draft adds its recipient (`flow.ts` `styleKey`; the comment engine `EngineDeps.style(src, author)`), and a mail
  that rides on a comment is written (`mailStyleOf`) from the shared `mail` profile with that same recipient file; with no
  recipient file the style, the prompts and the lint are exactly those of the key without `to`. Writing
  (`learnTone`, `recordCorrection`) goes into exactly one profile. A revise lesson goes to the key of its `scope` (mail: `flow.ts`
  `lessonKey` beside `styleKey`; comments: `draft-run.ts` `commentLessonKey`; KakaoTalk: `kakaoLessonKey`): the install for `everywhere`;
  for `recipient` the draft's recipient file (a mail's `replyAddress`, a comment's author, a mail that rides on a comment that address
  under the shared `mail` profile), or the channel's profile when the draft has no recipient with a file name (a sender with only a
  name, an anonymous author); for KakaoTalk the room, which already is the person; for `channel` the draft's channel. The card path
  (`hub/reply-actions.ts` `learn`) and `draft.ts revise` (`teach`) pass that key unchanged to the line's curation, the wording pattern
  (proposed against the app's replies, as for a channel lesson), the bans, refinement and compaction, so a recipient lesson writes that
  person's file only, and the card says `앞으로 <id>에게 보내는 답장에 반영해요: <line>` (the id as stored, cut to 40 characters). Besides
  that, `draft.ts correct|tone --app <app> --to <id>` reads and writes a recipient file (a mail app, `instanceIdOf("mail", app)`, takes exactly one
  address and stores it bare; `--app kakao` refuses `--to`). Two rooms of one messenger therefore never share a tone, a room
  that was never written to follows its app, an app without samples follows the install. A mailbox is a room of its account (`tone/<instance>/<box>.md`);
  what its voice was learned from is in `box-voice.json` (docs/mailbox.md "Voice").
  A profile with corrections or a section of its own is not relearned. A `## ` section the code does not know reaches the rules.
  Legacy: an old `style.md` is read as the `mail` profile until `tone/mail.md` exists (the next write moves it over); for the `youtube`
  and `instagram` apps without samples, `## 예시` of `custom/sns/tone.md` is used (only for those apps, between app and install).
  A `## 금지` bullet is one ban (`hub/ban.ts` `parseBan`): `shape <JSON>` a wording rule the product wrote, `/re/flags` a regex the owner
  wrote by hand, anything else a literal wording (matched with whitespace runs as one space, NFC, case aside). A regex is tested once on the
  body as written (an invalid one never hits), named as written, exactly as before wording rules existed; `/x/ = y` is a literal. A `shape`
  bullet holds `{"parts":[...],"label":"..."}` on one line and is read back with `JSON.parse` and a strict check (only those keys, the limits
  below); one that fails is a literal of its whole text. The label of a wording rule says what to write instead, so it is never listed as
  forbidden: the mail and comment prompt and the KakaoTalk prompt list literals and regexes under the forbidden list ("Never use" on KakaoTalk)
  and labels under "Wording rules the owner set (a draft that breaks one is rejected):"; the lint says `it breaks the owner's wording rule
  '<label>'` (rewritable), the owner reads `정해 둔 표현 규칙과 달라요: <label>` (reason `wording_rule`), and `draft.ts tone` shows `<label>
  (표현 규칙)`. The product never compiles a regex: `matchShape` reads body and wordings in NFC, lower case, with every whitespace removed but
  a newline kept as a sentence break, and from every start position takes an `any` part as one of its wordings by `startsWith` (not when the
  text right before ends with one of its `notAfter` wordings) and a `gap` part as 0..n characters that are not `.`, `!`, `?` or a newline.
  A failed part at a position is remembered, every `startsWith` and every gap position is one step, and past 2000000 steps the check stops, counts as not used and
  logs one `reply draft:` line naming the label. `proposePattern` asks the reply model of the profile's app once for `{parts, label, bad,
  good}` or `null`, where a part is `{any: [wordings], notAfter?: [wordings]}` or `{gap: n}`; the limits (`acceptPattern` and the reader) are
  1 to 5 parts, `any` first and last, at most 2 gaps never in a row, gap 1..30, 1..40 wordings of 1..20 code points on one line, `notAfter` at
  most 10 of 1..6 code points, a label of 1..80 code points on one line. `acceptPattern` keeps it only when it hits every bad example and no
  good one, and hits at most 15% of the owner's own past replies in the profile's scope (checked from 20 of them): an app profile its own
  `pairs/<app>.jsonl`, a KakaoTalk room the owner's own lines there, the KakaoTalk app profile his lines in every room the reader may read, the
  install all pairs and all those lines; a missing pairs file or reader is an empty corpus. Bad and good examples count only when they occur
  in the texts the caller lets it quote: `draft.ts correct --rule/--change` the rule text itself, a revise (the card or `draft.ts revise`,
  `revisePattern`) the previous draft and the owner's change, never the model-written lesson line. A revise asks only when it banned literal
  words or the change quotes a wording ('…', "…", ‘…’, “…”, 「…」), and waits 12 s at most (a later answer is dropped). A word the revise
  banned as a literal is not stored only when one of the kept good examples uses it (the owner's own text shows it is right in some use);
  every other word is stored, and the card names what was stored. The revise prompts keep `forbid` for a fixed phrase that is wrong wherever
  it appears and put a rejected kind of sentence or ending into `lesson` with his examples. `correct --forbid` is always stored. The rule goes
  under `## 금지` of the profile the rule or lesson went to, once per parts, and the card or the CLI says `표현 규칙으로도 정해 뒀어요:
  <label>`; `correct --allow "<label>"` takes it out.
  A line the owner asks for (`draft.ts correct --rule/--change`) is learned by `learnLine` (`lib/flow.ts`): `curate` (`lib/curate.ts`)
  asks the reply model of the profile's app once (through `learnCall`, 12 s at most) with that profile's own `## 말투` lines as `R1..`
  and `## 고친 점` lines as `C1..` (dates kept; hand-added sections, 예시 and 금지 are never shown) and the new line with its kind, for
  `{"replaces":[{"id","why":"same"|"overridden"}]}`. Code keeps only ids that exist, each once, the first three, and no `R` id for a
  correction (one corrected draft never removes a rule the owner set). A rule that an `R` line already says (`same`, or equal apart from
  case and whitespace, which asks nothing) stores nothing; otherwise the kept lines are written to `tone/journal.jsonl` (one JSON line
  `{at, profile, heading, line, why, by: "curate", newLine}`, `profile` the tone file relative to `tone/`) and taken out, and the new
  line is added as `recordRule` / `recordCorrection` add it, all in one locked edit of the profile (the journal line is written first, so
  a crash never loses a removed line). No similarity threshold: a contradiction shares few words, and every removal is printed with the
  `correct --restore <n>` that undoes it. No `learnCall`, an empty profile, a throw, a late or a malformed answer removes nothing and
  stores the line as before (one `reply draft:` log line for a failed call). `tone --journal` lists the newest 20 entries, each with its
  own number counted from the oldest (so a number never moves when later entries are added; an entry after a line a crash cut short starts
  on a new line); `restoreEntry(n)` adds the line back at the end of its section unless an equal line is there and marks the entry
  `restoredAt`; the replacing line stays. A revise's lesson line (the card's `learning.record` in `hub/reply-mail.ts`, and `teach` behind
  `draft.ts revise`) is learned the same way through `learnLesson`: a standing rule for the install key, a dated correction for any other.
  Its wording pattern is proposed beside it (`proposeLinePattern` / `revisePattern`, run side by side with the line, so a revise waits for
  the slower of the two) and written by its `keep` only when the line was stored (or the revise had no line); a line that was already
  there (`same`), not stored or whose recording failed keeps no pattern, and `correct --rule/--change` follows the same rule. The card's
  first line says `기존 조건 N개를 이 조건으로 바꿨어요` after the lesson when curation replaced lines, and `이미 있는 조건이에요: <line>`
  instead of `앞으로 … 반영해요` when the line was already there. Only a stored correction refines.
  A long `## 고친 점` is compacted by `compactCorrections` (`lib/compact.ts`): after a correction is stored and the card redrawn
  (`refineAfterCorrection`, a failure only logged) when the profile holds more than 12 of them, and on `draft.ts correct --tidy` (at
  least 2). One call through `learnCall` (30 s at most) sees only that profile's `## 고친 점` lines as `C1..` with their dates, as data,
  and answers `{"lines":[{"text","sources":["C1"]}],"dropped":[{"id","why":"one-off"|"not a rule"|"duplicate"}]}`: at most 8 lasting
  conditions in the owner's words, each merged only from lines that say the same thing, the newer winning a disagreement, a one-off
  rewrite, a question or a chat remark dropped. Code applies it only when it keeps at least one line, every text is one line of 1..288
  code points (300 with its date; a leading date is cut), each line has a source, every id exists and every listed line appears exactly
  once across all sources and drops, and the section holds nothing but bullets (a note or sub-heading there would be lost); anything
  else changes nothing and logs one `reply draft:` line. A kept line takes the newest date of its sources and the section is written
  oldest first (the order `recordCorrection` appends in, which `promptCorrections` turns newest first and the identity refinement reads
  as oldest first). The rewrite is one locked edit (`rewriteSection`) that happens only while the section still holds exactly the lines
  the model saw (a correction stored meanwhile wins and the compaction is skipped); before it, every original line is journalled with
  `by: "compact"`, `why: "merged"` and the line it went into, or `why: "dropped"` and an empty `newLine`, so `correct --restore` puts any
  of them back. `tone --journal` shows a dropped one as `"<line>" → 지움`.
- `drafts.json` `{drafts, keys}`; draft ids are `R` + 6 base32 characters; a newer draft for the same mail makes the older one stale. Each draft keeps its `app` and `room`.

## How a new install's tone is learned

The base is a deep first sweep, the details come from use (owner 2026-10-23; method generalised from the reference install, whose
mail agent drafted from an extract of the whole sent mailbox, a per-situation reply template in the user's own sentences, and verbatim
corrections turned into a checklist). `lib/persona.ts`:

- First sweep, once per profile (`learnFirst`, recorded in `learned.json` once it produced an identity; a source with nothing to read yet, a model failure or an answer with no identity is asked again): up to
  `SWEEP_LIMIT` (200) sent texts, each with the start of what it answered, are kept in `sent/<profile>.md` and analysed in one model
  call into `## 정체성` (6-12 bullets: register, structure, exact greeting and sign-off, emoticons, recurring requests, how the user
  declines, asks and thanks, what they never write) and `## 답장 틀` (`<situation> => <sentence> | <sentence>`: how the user answers each
  situation seen at least twice, in their own sentences with `{slots}`, conditional lines marked `[...]`). Lines with an e-mail, a URL
  or a phone number are dropped; names are asked as `{slots}`.
- The draft prompt opens with the identity and the reply templates: a fitting template is filled, otherwise the user's own sentences
  are preferred over new ones; samples, rules and corrections refine it. With past replies as examples (mail, comment), a message close to one of them
  (`examplesUse` in `hub/reply-draft.ts`: mail 0.27, comment 0.36, plain similarity of the shown pairs) follows that reply's shape; any other message is
  unfamiliar and is written in the user's voice in new sentences, with three examples for voice only.
- Every `REFINE_EVERY` (5) corrections of a profile, one call folds them into its identity and templates (`maybeRefine`).
- Reply pairs (`pairs/<app>.jsonl`, `lib/pairs.ts`) are read from the sent mail of the accounts the mail apps name, even when zele is not switched on in config.json. They are refreshed without a model call: the first 500 threads, then the newest 40 once a day. Each pair keeps who it answered, and up to 3 newest replies to the same sender lead the examples (`hub/comments/past.ts` `sameFirst`, `same`); a comment's pairs keep their author, and up to 3 whose author is this comment's (as `recipientFile` normalises it; the nobody values never match) lead the same way, the rest by similarity, `EXAMPLES` in all.
- Where it runs: mail before the first offered draft (`offer.ts`, gateway passes zele's sent mail when zele is on), a comment source
  before its first draft (`CommentAdapter.ownTexts`), a KakaoTalk room on its first draft (`ensureKakaoRoom`), and `onboard.ts on|learn`.
  Without an injected `analyze` call (tests, library use) nothing is analysed.

1. `onboard.ts on`: the `mail` profile from the user's sent mail when zele is on (`zele mail list --folder sent`, then `zele mail read <id>`).
   Comment tone needs no step: `custom/sns/tone.md` examples are read for `youtube` and `instagram` until those apps have their own.
2. `onboard.ts learn [--app <app|install>] [--room <id>] [--from-file <f>]`: sentences of a file into a chosen profile (default `mail`).
3. KakaoTalk: the first `draft.ts new --app kakao --room <chat id> --kind chat` of a room with an empty profile reads the user's own
   lines of that room from the hub/kakao reader (`lib/kakao-tone.ts`) and learns `tone/kakao/<chat id>.md`. Only that room's lines.
4. Then every 고치기: the gateway's revise (hub/reply-actions.ts) records it in the draft's room (else app) profile, once, after the new draft is stored;
   a KakaoTalk room's change goes the same way. `draft.ts revise` only hands the change to the gateway when one answers.

## Code

- `lib/offer.ts` `offerMailDraft`: the gateway hook for a new mail (off unless enabled and auto; never throws; a failure is logged and returns `failed`). `hub/main.ts` wires it into `mailDeps().offerDraft`. The automatic offers waiting or running are kept in `custom/reply-drafts/offer-queue.json` (`{ "<thread>": { mail, tries } }`); a settled offer leaves it, a failed one stays with `tries` + 1 until the third try and is marked `답장 대기` on a mail that needs a reply (`suggest.state` "waiting"), and `resumeOffers` (called once at gateway start) puts back only what the file still holds. A rules-only install whose rule-judging call fails returns `failed` and leaves the mail unmarked; the judge answer counts only when it is just a number. A draft written from the subject alone carries `본문을 읽지 못해 제목만 보고 썼어요`.
- `lib/flow.ts` build / revise / send / drop shared by the offer and `bin/draft.ts`.
- `lib/box-voice.ts` one learned voice per mailbox from his own replies in it (docs/mailbox.md "Voice"), run beside the pair refresh of a draft, once, not per mail.
- `lib/tone.ts` sentence extraction (3-120 chars, quoted history and signatures dropped, deduped, at most 40) from injected sources, into one profile.
- `lib/kakao-tone.ts` the user's own text lines of one KakaoTalk room (injected reader, fixture in tests) -> `kakao/<chat id>`.
- `lib/senders.ts` zele: `zele mail read <id>` first (zele refuses a reply otherwise), then `zele mail reply <id> --to <to> [--cc <list>] --body <body>`; a refused
  reply is reported as a stale draft to redraft; the files staged for the draft ride along as `--attach <path>` (one flag each). Or a webmail-no-api site's draft/approve/send
  (no files: the sheet says so and asks once more; one 받는 사람 and no 참조: it refuses several in Korean); or a custom plugin's `reply` hook
  (docs/custom-plugins.md, `to` a comma list, `cc`, `all`, files in `attachments`; only a plugin that declares `needsAccount` is held for an unsettled zele account); anything else is refused ("직접 보내야 해요").
- `lib/recipients.ts` 답장 | 전체 답장: the sender alone, or the sender plus the original mail's 받는 사람·참조 minus the owner's own addresses (hub/mail-state.ts
  `ownAddresses`). The owner edits the list on the card; hub/draft-recipients.ts stores it and rewrites the waiting approval notice.
- `lib/library.ts` + `lib/staged.ts`: the instance's 첨부 파일 폴더 setting (`attachFolders.<instance>`). Files are chosen by what the mail asks for, not by name overlap alone. Before the draft call `flow.ts candidatesFor` lists the files the model may choose from: the matched rule's files (resolved) first, then the library files with a score above 0, at most `CANDIDATE_MAX` (12), names only, no model call. They ride in the one draft call (`ReplyItem.candidates`); the answer carries `"files":[exact names]` (`ReplyResult.files`: kept only if a member of the candidates, `[]` = none, absent key = the model did not choose and today's name matching runs). Only the chosen files are staged under `draft-files/<draft id>/<n>/` (`stageForReply`); a rule's files are candidates like the rest, they no longer replace the library. A body that promises a file while none is chosen (`attachIssues` missing | partial) is rewritten once. A rule's files with no folder set are staged as they are. A 고치기 about files (`fileChange`) offers the files on the draft plus the library matches for the change, and the staged set becomes exactly what the model returns; a change about wording keeps the files. `mail-cli compose --from-library` takes only the top-scoring files (at least `MIN_SCORE`). The owner confirms or changes the files in the send sheet (hub/draft-attach.ts), and nothing goes without 보내기.
  `readMailBody(source, id, run)` gives the gateway offer the mail text (zele read, or the site's `mail.ts <site> read <id>`).
- `hub/auto-attach.ts`: one install's own rules for draft files in `custom/reply-drafts/auto-attach.json`, no file = no rule: `withhold` (path patterns never picked by keywords in `composeMail`), `narrow` (`when` words in the request, `only` a file pattern, `note` in that install's words), `fileWords` and `audioWords` (extra words for a document or a sound file in `asksForFile`, `claimsAttachment` and `attachIssues`; a Latin word matches whole), `noiseWords` (words in a file name that tie it to nothing), `genericWords` (words that never rank a library file). The built-in words stay general; a trade's own words belong here. An unusable file attaches nothing and says so on the card. It is a file of its own because `saveSettings` drops keys it does not know.
- A file that cannot be copied yet (an iCloud file that was evicted: EDEADLK) is never lost: after a short wait (`tries` 5 in the offer path) it goes to the draft's `wantFiles` (`{name, path}`), the card is posted at once, and `staged.ts retryWanted` retries in the background (about 5 minutes, off the offer queue); a file that lands is staged, leaves `wantFiles` and calls `changed` (hub/main.ts: `syncCardFiles`, so the waiting card updates). A copy that fails for another reason is kept in `wantFiles` too, so the send gate sees it. Pending drafts with `wantFiles` made by another process (`draft.ts new`, `revise`) or left by a restart get the same retry when the gateway re-reads its cards (`syncCardFiles` -> `resumeWantedFiles`). `draft.ts detach` by name takes off a file that will not come. `requestDownload` runs `/usr/bin/brctl download` on the real path (the 첨부 파일 폴더 is often a symlink into iCloud). A file iCloud keeps only as a `.<name>.icloud` placeholder is that file not downloaded yet, everywhere: `listLibrary` lists it as `<name>` (size 0), staging it is an eviction (brctl gets the placeholder), `draft.ts attach` keeps an evicted file in `wantFiles` (exit 0) instead of failing, and `sendDraft` tries the `wantFiles` once more (`stageWanted`) before its gate, so a file that landed after the background retry ran out still goes out.
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
