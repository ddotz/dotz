# YouTube + Instagram channel management (design of record)

Shipped feature folder (hub/featuredirs.ts). Every install gets it; nothing runs until the owner finishes the first-run
setup, because the watches need an account. So this folder has NO watch.json: `bin/setup.ts` adds the watches.

Origin: a second dotz-like install (another owner's assistant) ran this by hand for months. What was kept, in general terms:
- a drop folder for short vertical videos -> probe (length, orientation) -> drafted title/description/hashtags in several
  languages + Instagram caption -> approval card -> upload to YouTube and Instagram Reels; done files move to `done/`;
- multilingual metadata on existing videos: target-language sections appended under the untouched original description
  plus `localizations` (title + description), a backup written once before the first change, a restore command, and a
  daily quota budget per Pacific day (the YouTube quota resets at midnight Pacific) with resume on the next day;
- comment monitoring: only items without an owner reply, a cheap filter first, a model draft only for what passed, a
  quiet-hours window, a review card per batch, and posting only after the owner's OK;
- Instagram: scan only media whose `comments_count` changed since the last run (a full backfill only on the first run);
- login upkeep: YouTube OAuth refresh token (no quota cost to refresh), Instagram long-lived token refreshed when it is
  older than 7 days or expires within 20 days; two failures in a row -> one alert; the browser login is the fallback;
- Reels need a public video URL: a short-lived local file server behind a `cloudflared` quick tunnel during the upload.
Left out: every channel/account name, id, token, video, comment, reply template, the owner's school/family details,
machine paths and the owner's own launchd jobs.

## Multilingual metadata is opt-in (owner 2026-10-22)

The owner: "다국어 메타 데이터 적용 이런건 사용자 취향의 영역이라 초기 적용에는 빼". So the first-run setup never
asks about languages and never turns it on: `youtube.languages` defaults to `[]`, upload drafts are in the base
language only, and the `sns-yt-metadata` watch is not added. It is turned on later only when the owner asks
(`setup.ts apply --languages en,ja` adds the languages and the watch; `--languages off` removes both).

## Layout

```
features/youtube-instagram/
  feature.md            short prompt body (it rides in every orchestrator prompt): when to read playbook.md + the approval rule
  playbook.md           read on demand: setup questions, login order, what each watch line means, commands
  DESIGN.md             this file
  lib/config.ts         paths, config schema + load/save, secrets read/write (0600), Ctx (injected fetch/now/exec/sleep)
  lib/watchkit.ts       shared watch runner: state file, transient-failure absorption, quiet hours, DOTZ_FAIL lines
  lib/quota.ts          YouTube quota ledger per Pacific day (shared by every script), COSTS table
  lib/youtube.ts        Data API v3 client: token refresh, channel stats, comment threads, videos list/update, insert, reply
  lib/instagram.ts      Graph API (Instagram Login) client: me, media, comments, reply, reels publish, token refresh
  lib/jobs.ts           approval jobs (upload / reply / metadata): draft -> approved -> (scheduled) -> done|failed|rejected
  lib/tunnel.ts         serve one file over a cloudflared quick tunnel for the length of an Instagram upload
  bin/yt-comments.ts    watch: new YouTube comments without an owner reply
  bin/ig-comments.ts    watch: new Instagram comments without an owner reply
  bin/inbox.ts          watch: new video files in the drop folder (local only, no network)
  bin/due.ts            watch: publish approved jobs whose time came (local only while nothing is due)
  bin/tokens.ts         watch: token upkeep (silent when fine)
  bin/yt-metadata.ts    watch: recent uploads missing the configured languages (daily)
  bin/sns.ts            action CLI the orchestrator runs: job new|approve|reject|publish|status, tone-sample, restore
  bin/card.ts           data command of the home card (kv): stats + counts, from cache, refreshed at most hourly
  bin/setup.ts          first-run setup: youtube-auth, instagram-token, apply (config, card, pins, project record, watches)
  test/*.test.ts        one test file per script, fake fetch/exec, temp DOTZ_DIR, no network
```

All TypeScript, run with `bun <abs path>`. Each script exports a pure-ish `run(ctx, args)` returning
`{ lines: string[]; code: number }` and has a `if (import.meta.main)` block that builds the real ctx, prints the lines
and exits with the code. Tests call `run` with a fake ctx.

## Paths (lib/config.ts)

- `DATA_DIR` = `process.env.DOTZ_DIR ?? ~/.dotz` (same rule as hub/config.ts; do not import hub/config.ts, it loads the
  gateway config at import time).
- Project folder (owner data, never in the repo): `SNS_DIR = DATA_DIR/custom/sns`
  - `config.json` settings, `tone.md` the owner's reply voice (examples, filled by `sns.ts tone-sample` and the owner),
  - `jobs/<id>.json`, `inbox/` drop folder (default), `inbox/done/`, `backup/<videoId>.json`, `cache/` (stats.json,
    quota.json, access-token cache is NOT here, see secrets).
- Secrets (0600, never printed, never in argv): `DATA_DIR/secrets/youtube-oauth.json`
  `{client_id, client_secret, refresh_token}`, `DATA_DIR/secrets/youtube-access.json` `{access_token, expires_at}`
  (cache), `DATA_DIR/secrets/instagram.json` `{access_token, user_id, username, obtained_at, expires_at}`.
- Watch state: `process.env.DOTZ_WATCH_STATE_DIR` (one folder per watch, set by the gateway).

## Config schema (`config.json`)

```json
{
  "version": 1,
  "youtube": { "channel_id": "UC...", "title": "...", "base_language": "ko", "languages": [],
               "privacy": "private", "upload_via": "api" },
  "instagram": { "user_id": "...", "username": "...", "post_via": "api" },
  "timezone": "Asia/Seoul",
  "posting_times": ["18:00"],
  "approval": "each",
  "quiet_hours": { "from": "00:00", "to": "08:00" },
  "inbox_dir": "<SNS_DIR>/inbox",
  "quota": { "daily_budget": 9000 },
  "channel": "ch:123"
}
```

- `youtube` / `instagram` are optional (an owner may run only one).
- `upload_via` / `post_via`: `api` (default) or `aside` (browser fallback, done by the orchestrator through `aside repl`;
  scripts then only prepare the job and print what to do). Note: Google locks videos uploaded through an unaudited API
  project to private; until the project passes the audit, public uploads go through `aside` (YouTube Studio).
- `approval`: `each` (one decision block per item) or `batch` (one decision block per batch). Both ask before anything
  goes public; there is no auto-publish mode.
- `posting_times`: when `publish_at` is not given, `sns.ts approve` schedules the job at the next posting time.

## Watches (added by setup through POST /api/watches)

| name | command | every | on | why that interval |
|---|---|---|---|---|
| `sns-yt-comments` | `bun <repo>/features/youtube-instagram/bin/yt-comments.ts` | 30 | match `.` | 1 unit per page, ~48-150 units/day |
| `sns-ig-comments` | `.../bin/ig-comments.ts` | 60 | match `.` | 1 media call + only changed media |
| `sns-inbox` | `.../bin/inbox.ts` | 5 | match `.` | local folder scan |
| `sns-due` | `.../bin/due.ts` | 5 | match `.` | local until a job is due |
| `sns-tokens` | `.../bin/tokens.ts` | 720 | change | refresh only when needed |
| `sns-yt-metadata` | `.../bin/yt-metadata.ts` | 1440 | match `.` | 1 unit per 50 videos; ONLY when `youtube.languages` is non-empty (opt-in) |

`to` = `orchestrator` (only that target wakes the model; hub/main.ts), `channels` = `[<id>]` when setup got the
project channel, so the wake-up runs in that channel. A channel-owned watch cannot be deleted over the API (409), so
`--languages off` pauses `sns-yt-metadata` (PATCH `paused: true`).
Only the watches for the connected platforms are added. Commands use `command` (not `script`) so repo updates apply.

### Output contract (every watch)

- exit 0 + empty stdout = nothing new. Waiting and filtering happen inside the script.
- One decisive line per new item, stable text (the gateway compares output between runs):
  - `yt-comment <commentId> video=<videoId> by=<author>: <text, one line, max 200 chars>`
  - `ig-comment <commentId> media=<mediaId> by=<username>: <text>`
  - `new-video <abs path> <seconds>s <W>x<H> <vertical|landscape> <ok|too-long|not-vertical>`
  - `posted <jobId> youtube=<videoId>` / `posted <jobId> instagram=<mediaId>` / `failed <jobId> <reason>`
  - `needs-translation <videoId> missing=<en,ja>: <title>`
- Baseline in `$DOTZ_WATCH_STATE_DIR/state.json`. First run records the baseline and prints nothing (no flood).
- Transient failures (network error, timeout, HTTP 5xx, 429) are absorbed: one in-script retry after a short wait, then
  a fail counter in state; exit 0 silently until 3 runs in a row failed, then `DOTZ_FAIL network` + exit 1. A success
  resets the counter.
- Auth failures (401, `invalid_grant`, OAuthException 190) print `DOTZ_FAIL youtube-auth` / `DOTZ_FAIL instagram-auth`
  at once (exit 1). Missing config or secret: `DOTZ_FAIL setup` (exit 1).
- Quiet hours (config, owner time zone): comment watches exit 0 silently; the next run after the window catches up
  because the baseline did not move.
- Quota: before any YouTube call the script asks `quota.can(cost)`; over budget -> exit 0 silently (the baseline does
  not move, so nothing is lost). `due.ts` uploads and `sns.ts` publish also check it and fail with `quota` when short.

## YouTube API use (quota-aware)

- Comments: `commentThreads.list?allThreadsRelatedToChannelId=<channel>&order=time&maxResults=100&part=snippet,replies&textFormat=plainText`
  (1 unit, all videos in one call), paging until a thread older than the baseline `publishedAt`, at most 3 pages.
  New = top-level comment newer than the baseline, author is not the channel, and no reply by the channel.
- Stats: `channels.list?part=statistics,snippet&id=<channel>` (1 unit), cached in `cache/stats.json`, at most hourly.
- Recent uploads: `playlistItems.list` on the uploads playlist (1 unit) then `videos.list?part=snippet,localizations&id=<<=50 ids>`
  (1 unit per 50 ids).
- Metadata apply: `videos.update?part=snippet,localizations` (50 units) after a one-time backup.
- Upload: resumable `videos.insert` (cost in COSTS; documented by Google, keep it a single constant).
- Reply: `comments.insert?part=snippet` with `parentId` (50 units).
- Token: refresh with `refresh_token` at `https://oauth2.googleapis.com/token` (no quota), access token cached in
  secrets until 60 s before expiry.
- Ledger: `cache/quota.json` `{ day: <YYYY-MM-DD in America/Los_Angeles>, units }`, shared by all scripts; budget
  `quota.daily_budget` (default 9000 of the 10,000 default quota).

## Instagram API use

- Base `https://graph.instagram.com/v23.0` (Instagram API with Instagram Login). Token in `secrets/instagram.json`.
- Comments: `GET /me/media?fields=id,caption,comments_count,timestamp&limit=50` (one call); compare `comments_count` with
  the baseline map; for changed media only `GET /<media>/comments?fields=id,text,username,timestamp,replies{username}`.
  New = newer than baseline, not the owner's, and not answered by him. Replies carry no author, so "answered" (lib/ig-owner.ts) is: a reply id
  that is one of the owner's own comments (the media list has `from.id`), or the owner @mentioning that commenter under the same media. The hub
  comments adapter (hub/comments) marks the owner's replies `mine` the same way, which clears the 미답장 badge. Replies always go to a comment id.
  First run: baseline only.
- Reply: `POST /<comment>/replies?message=`. Reels: `POST /me/media` (media_type=REELS, video_url, caption) ->
  poll `GET /<container>?fields=status_code` until FINISHED (bounded, injected sleep) -> `POST /me/media_publish`.
- Token refresh: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=` when
  older than 7 days or expiring within 20 days (a token must be >= 24 h old to refresh).
- External token source (`instagram.token_source` / `youtube.token_source` = `{file}` or `{command}`, lib/token-source.ts, docs/youtube-instagram.md):
  the same schedule decides when `tokens.ts` reads it; the token is taken after `GET /me` accepted it for the same account, and the 2nd failed
  run in a row prints `DOTZ_FAIL token-source`. `setup.ts apply --ig-token-file|--yt-token-file <path|off>` also adds `sns-ig-tokens` / `sns-yt-tokens`.
- Reels need `instagram_business_content_publish`; API code 10 on publish sets `cache/ig-publish.json` (lib/ig-publish.ts) until a new token
  arrives. While set, `due.ts` does not publish a Reel (`ig-publish-blocked <job>: <Korean line>` once), `sns.ts job new` and the home card carry the
  same line, and the hub approval row says it cannot publish yet.

## Jobs and approval (lib/jobs.ts)

```json
{ "id": "j-<yyyymmddhhmm>-<4 hex>", "kind": "upload" | "reply" | "metadata", "status": "draft",
  "created": "...", "targets": ["youtube", "instagram"], "publish_at": "ISO?",
  "upload": { "file": "/abs", "title": "...", "description": "...", "tags": [], "localizations": { "en": { "title": "", "description": "" } },
              "privacy": "private", "ig_caption": "..." },
  "reply": { "platform": "youtube" | "instagram", "comment_id": "...", "text": "..." },
  "metadata": { "video_id": "...", "append": { "en": "..." }, "localizations": { "en": { "title": "", "description": "" } } },
  "approved_at": "?", "result": {}, "error": "?" }
```

- Status flow: `draft` -> `approved` (owner chose OK in the decision block; the orchestrator runs `sns.ts approve <id>`)
  -> `scheduled` (approve with a future `publish_at` or a posting time) -> `posting` -> `done` | `failed`; `rejected`.
- Nothing public happens from a job that is not `approved`/`scheduled`: `sns.ts publish` and `due.ts` refuse others.
- The orchestrator shows drafts as a MODE choice block (`결정: ...`, `**1) 올리기** ← 추천`, `**2) 고쳐서 올리기**`,
  `**3) 올리지 않기**`); in `batch` mode one block covers a batch and option 1 approves all of them.

## Home card and project

- Card `DATA_DIR/custom/cards/sns-channels/card.json`: title `유튜브·인스타`, view `kv`, command `bun <repo>/features/youtube-instagram/bin/card.ts`,
  every_minutes 60, timeout 20, actions: `댓글 지금 확인` (prompt), `영상 올리는 법` (prompt). Output keys (Korean):
  `유튜브 구독자`, `유튜브 영상`, `인스타 팔로워`, `인스타 게시물`, `답 기다리는 초안`, `예약된 게시`, plus `연결` when a platform
  is not connected. Never fails when offline: falls back to the cached stats with `(캐시)`.
- pins.json project `{ name: "유튜브·인스타 관리", path: SNS_DIR, channel?: "ch:<id>", note: "유튜브와 인스타 올리기, 댓글, 통계를 맡아요" }`
  (merged, never duplicated).
- Before setup (no config.json) the card prints `{"상태": "설정 전이에요. 채팅에서 '유튜브·인스타 설정해줘'라고 말해 주세요"}`.
- Project record `PUT /api/projects` key `dir:<SNS_DIR with ~>` or `ch:<id>`: title, purpose, milestones
  (계정 연결, 기본값 정하기, 감시 켜기).

## playbook.md (read on demand; feature.md keeps only a pointer and the approval rule, ~430 chars, so installs that
## never use the feature pay almost nothing per prompt)

- Setup on request: ask in ONE message with MODE choice blocks (platforms; posting time; approval each ← 추천 / batch;
  quiet hours) and accept free text. Do not ask about languages: multilingual metadata is off until the owner asks
  for it later (then `setup.ts apply --languages <codes>`).
- Credential order (contract login order): official API with a long-lived token first. YouTube: Google Cloud OAuth
  desktop client -> `dotz_auth` kind secret into `~/.dotz/secrets/youtube-client.json` -> `setup.ts youtube-auth --client <file>`
  -> open the printed URL with `aside repl` in a background tab. Instagram: long-lived token from the Meta app dashboard
  via `dotz_auth` -> `setup.ts instagram-token --from <file>`. Fallback: the Aside browser login (channel `logins` for
  studio.youtube.com / instagram.com). Never echo a secret.
- Then create the work channel (`dotz_channel create`, plain title like 유튜브·인스타), run `setup.ts apply ... --channel ch:<id>`,
  check `GET /api/custom` has no errors. Google keeps API uploads private until the project passes its audit: use
  `--youtube-via aside` for public uploads until then.
- Wake-ups: `yt-comment`/`ig-comment` -> draft replies in the owner's voice from `~/.dotz/custom/sns/tone.md` (run
  `sns.ts tone-sample` once if it is empty), `sns.ts job new`, show them as ONE choice-block message (올리기 ← 추천 /
  고쳐서 올리기 / 올리지 않기; batch mode: one block for all). `new-video` -> draft title/description/tags in the base and
  configured languages + IG caption, upload job, ask. `needs-translation` -> draft localizations, metadata job, ask.
  `posted`/`failed`/`aside-needed` -> report in the project channel (aside-needed: do the upload with `aside repl`).
- Only after the owner picks OK: `sns.ts approve <id>` (next posting time unless the owner said now). Nothing public
  before that, ever. Commands are `bun <dotz checkout>/features/youtube-instagram/bin/<script>.ts`.

## Round 2 (owner 2026-10-22): reliability fixes and one-sentence onboarding

Owner rules: integrations ship off and turn on through their setup; onboarding optimization and automation are the core
("켜 달라는 한마디로 설치·권한·로그인·시험·감시·카드까지", owner touches minimal and asked once, batched); known follow-ups
are fixed now, not later; use iMessage to receive verification codes; Aside automation first, ask only what cannot be
automated.

### R1. Idempotent YouTube upload (no duplicate after a network drop)
- Before `insertVideo`, due.ts writes the upload intent into the job: `upload_intent: { fingerprint, started }`.
  fingerprint = `dz-` + first 12 hex of sha256(job id + file size + file mtime). The upload sends it as a tag
  (`snippet.tags` gets the fingerprint appended) so the API can find it again.
- On the next attempt with an intent present and no youtube result, first look it up: `recentUploads` (1 unit) and
  `videos.list part=snippet` on those ids (1 unit per 50); a video whose tags contain the fingerprint is the result
  (record it, no new upload). Only when none matches, upload again. The intent stays until done.
### R2. Quota exhausted is its own state
- `lib/youtube.ts`: 403 with reason `quotaExceeded` or `dailyLimitExceeded` -> `QuotaError` (not TransientError).
- `lib/quota.ts`: `markExhausted(ctx)` stores `exhausted_until` = next midnight America/Los_Angeles in the ledger
  (and fills units to the budget); `can()` is false until then. Ledger writes take a lock file
  (`cache/quota.lock`, O_EXCL create, stale after 10 s) around read-modify-write.
- watchkit: a QuotaError marks the ledger and prints, once per Pacific day (state in the ledger `reported_day`),
  `yt-quota-exhausted until=<HH:MM in the owner time zone>` with exit 0; later runs that day stay silent. The
  orchestrator reports it in plain Korean ("유튜브 하루 쿼터를 다 써서 <시각>에 다시 이어서 해요"), no choice block.
### R3. Other follow-ups (gate review)
- A job stuck in `posting` (process killed mid-publish) is released back to `scheduled` when `posting_since` is
  older than 30 min (dueJobs does this; publishJob sets posting_since). The upload intent (R1) prevents a duplicate.
- yt-comments: when 3 pages are read without reaching the baseline, print one extra line
  `yt-comment-overflow more than <n> new comments; older ones not listed` so nothing is dropped silently.
- `sns.ts restore` is an owner-requested revert only (playbook says so); it keeps working without a job.

### R4. One-sentence onboarding (`bin/onboard.ts`)
"유튜브·인스타 연결해줘" -> the orchestrator runs `bun <feature>/bin/onboard.ts run [--youtube] [--instagram]` and, for
an unavoidable owner step, asks once and re-runs it. A resumable state machine, state in `SNS_DIR/onboard.json`
(`{ steps: { <id>: { status: pending|done|needs-owner|failed, at, note } }, platforms, asks }`); `run` continues at the
first step that is not done; `status` prints one Korean line per step; `reset [<step>]` re-opens steps.
Steps, in order (each skips itself when already satisfied, e.g. a valid secret file exists):
1. `deps`: bun, aside CLI answering, ffprobe, cloudflared (Instagram only), Messages database readable (for codes).
   Missing brew packages are installed with `brew install ffmpeg cloudflared` (no prompt). Messages unreadable ->
   needs-owner (Full Disk Access for bun), codes fall back to asking.
2. Google Cloud, one `aside repl` step each (background tab, `lib/pages.ts`; never the Aside agent, which spends Aside's
   own rate limit). Every script checks the page state before and after each action and ends `ok`, `owner` (login page),
   `code` (verification prompt) or `unexpected` (unknown page); the last two non-ok kinds stop the step with an owner ask
   (exit 3), nothing is guessed. `gcp-project` creates or reuses "dotz-youtube" (its ID is kept in onboard.json `ids`),
   `gcp-api` enables YouTube Data API v3, `gcp-consent` makes the consent screen (External, app "dotz", the signed-in
   account as contact), `gcp-publish` publishes it to Production (Testing would expire refresh tokens after 7 days),
   `youtube-client` creates a Desktop OAuth client. In the same run client_id/secret are read from the dialog and POSTed
   to a one-shot localhost receiver (`lib/receiver.ts`) that writes `secrets/youtube-client.json` 0600; no secret passes
   through a model or argv. All five skip themselves once the client file exists.
3. `youtube-auth`: the loopback flow of setup.ts; the consent URL opens in an Aside background tab and an `aside repl`
   script picks the account, accepts the unverified-app screen ("고급 -> 이동") and allows; the redirect completes on its own.
4. `instagram-account`: an `aside repl` script checks the account is professional (creator/business); if not, switches
   it to creator (owner default) on instagram.com settings and re-checks.
5. `meta-app` creates or reuses the Meta app "dotz-instagram" (use case Instagram; app id kept in `ids`);
   `instagram-token` opens its Instagram API setup page, generates the long-lived token (the account must already be
   added to the app) and POSTs it to the receiver -> `secrets/instagram-token-new.json`, then `setup.ts instagram-token`.
6. `detect`: myChannel / me() fill channel and account (no questions).
7. `apply`: `setup.ts apply` with defaults, no questions: posting 18:00, approval each, quiet 00:00-08:00, privacy
   private for API uploads, `upload_via aside` until the Google project passes the audit (public uploads), languages off.
8. `test-read`: one cheap read per platform (channelStats 1 unit, me 1 call) + card command runs; failure -> failed.
9. `done`: progress shows the result.
- Verification codes: when a step hits a code prompt, `lib/otp.ts` reads the newest code from the macOS Messages
  database (`~/Library/Messages/chat.db`, read-only; text or attributedBody) that arrived after the step started,
  matching the service (Google "G-123456", Instagram/Facebook/Meta 6-8 digits), waits inside up to 120 s, and hands it
  to `aside repl` through the one-shot localhost URL (`const secret`), never printing it. Owner basis: owner
  2026-10-22 "아이메시지도 적극적으로 활용해서 인증 코드 받아야함".
- Owner touches are batched: steps that need the owner (password not saved in Aside, a phone push, Full Disk Access)
  are marked needs-owner and `run` continues with every independent step; at the end it prints ONE
  `ask` block (Korean, numbered, each one line saying exactly what to tap) and exits 3. The orchestrator posts it once
  (dotz_auth approve/secret where a value is needed) and re-runs `run` after the owner answers.
- Progress: `run` updates one evolving message through the gateway (`POST /api/send` with
  `update_key: "sns-onboarding"`, target = `--target` or `chat`): a checklist line per step (✅ ⏳ ❓ ❌).
- Every external effect (aside repl, brew, gateway, API) goes through injected runners; `--dry-run` uses a
  scripted runner set, and the test drives the whole flow, an interruption, and the resume.

## Video titles and Instagram DMs (owner 2026-10-23)

### Video titles
- A YouTube comment carries `videoId`, the video `title` and a thumbnail. Titles come from ONE `videos.list?part=snippet&id=a,b,c` call per poll (1 quota
  unit, 50 ids per call), never one call per comment. `cache/videos.json` keeps them by id: a title 7 days, a video that has none (deleted or private) 1 day.
  When the call fails the cache still answers, so a poll never fails because of titles (`lib/youtube.ts` videoInfos).
- The `yt-comment` watch line gets ` title="<JSON string>"` after `video=`; `ig-comment` gets the caption start the same way. The 모니터링 comment
  engine names the post the same way (hub/comments). A stored comment that was collected without a title (`유튜브 영상` / `인스타 게시물`) is renamed on the
  next poll (`adapter.retitle`), so old items are backfilled.

### Instagram DMs (read only)
- API: Instagram API with Instagram Login, Conversations API (graph.instagram.com). `GET /me/conversations?platform=instagram` lists conversations;
  `GET /<conversation-id>?fields=messages{message,from,to,created_time,attachments}` lists the latest 20 messages. Permission:
  `instagram_business_manage_messages` (with `instagram_business_basic`). Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api
  (checked 2026-10-23). Nothing here sends a message.
- Watch `sns-ig-dm` (every 10 min, silent) runs `bin/ig-dm.ts`: one conversation-list call, and the messages only of the conversations whose
  `updated_time` moved. The result is `cache/ig-dm.json`; the 모니터링 > 인스타그램 > DM tab reads it (docs/ig-dm-api.md).
- The feature row "DM 읽기" (hub/app-features.ts, id `dm_read`) is the switch (`featureEnabled`). Off: the watch makes no request and deletes the stored DMs.
- A missing permission (OAuthException code 10 or 200-299) is stored as `perm: "missing"` and re-checked only after a new token or 6 hours. Onboarding
  (`instagram-dm` step) reads the list once with the new token and asks for the permission only when it is missing.
