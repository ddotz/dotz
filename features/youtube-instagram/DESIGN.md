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
- `upload_via` / `post_via`: `api` (default) or `aside` (browser fallback, done by the orchestrator through `aside exec`;
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
  New = newer than baseline, username != owner, no reply by owner. First run: baseline only.
- Reply: `POST /<comment>/replies?message=`. Reels: `POST /me/media` (media_type=REELS, video_url, caption) ->
  poll `GET /<container>?fields=status_code` until FINISHED (bounded, injected sleep) -> `POST /me/media_publish`.
- Token refresh: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=` when
  older than 7 days or expiring within 20 days (a token must be >= 24 h old to refresh).

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
  -> open the printed URL with `aside exec` in a background tab. Instagram: long-lived token from the Meta app dashboard
  via `dotz_auth` -> `setup.ts instagram-token --from <file>`. Fallback: the Aside browser login (channel `logins` for
  studio.youtube.com / instagram.com). Never echo a secret.
- Then create the work channel (`dotz_channel create`, plain title like 유튜브·인스타), run `setup.ts apply ... --channel ch:<id>`,
  check `GET /api/custom` has no errors. Google keeps API uploads private until the project passes its audit: use
  `--youtube-via aside` for public uploads until then.
- Wake-ups: `yt-comment`/`ig-comment` -> draft replies in the owner's voice from `~/.dotz/custom/sns/tone.md` (run
  `sns.ts tone-sample` once if it is empty), `sns.ts job new`, show them as ONE choice-block message (올리기 ← 추천 /
  고쳐서 올리기 / 올리지 않기; batch mode: one block for all). `new-video` -> draft title/description/tags in the base and
  configured languages + IG caption, upload job, ask. `needs-translation` -> draft localizations, metadata job, ask.
  `posted`/`failed`/`aside-needed` -> report in the project channel (aside-needed: do the upload with `aside exec`).
- Only after the owner picks OK: `sns.ts approve <id>` (next posting time unless the owner said now). Nothing public
  before that, ever. Commands are `bun <dotz checkout>/features/youtube-instagram/bin/<script>.ts`.
