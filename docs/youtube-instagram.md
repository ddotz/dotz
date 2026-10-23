# YouTube + Instagram: token source and troubleshooting

Design of record for the feature is `features/youtube-instagram/DESIGN.md`. This page covers two things a user runs into: keeping the
tokens fresh when they live outside dotz, and the usual Instagram API surprises.

## External token source

dotz keeps its own copy of the tokens in the secrets folder of its data directory (`secrets/instagram.json`, `secrets/youtube-oauth.json`).
The gateway runs under launchd, which cannot read the macOS keychain, so a token that only exists in the keychain (or in another app's
file) never reaches dotz by itself. An optional **token source** per app fixes that: the login keeper (`sns-tokens`, or the per-app
watches `sns-ig-tokens` / `sns-yt-tokens`) reads the source and updates the dotz copy. The flow is one way: nothing is written back to the source.

A source is either a **file** or a **command**, set per app in `custom/sns/config.json`:

```json
{
  "instagram": { "user_id": "...", "username": "...", "post_via": "api", "token_source": { "file": "/Users/me/.config/dotz-token-source/instagram.json" } },
  "youtube":   { "channel_id": "UC...", "...": "...", "token_source": { "command": ["/Users/me/bin/print-youtube-token"] } }
}
```

Exactly one of `file` (absolute path, `~/` allowed) or `command` (argv list, no shell, 20 s limit, exit 0, token on stdout). The command runs
as the gateway user, so it must work without the keychain and without a GUI session; a script that needs the keychain belongs in **your own
session** (see below), not here. `setup.ts apply --ig-token-file <path|off>` and `--yt-token-file <path|off>` write the setting and add the
per-app watch, so a failure shows under the app's internal features (내부 기능).

Formats:

- Instagram: a JSON object `{"access_token": "...", "obtained_at": "<ISO>", "expires_at": "<ISO>"}` (`obtained_at` and `expires_at` optional) or one line with the bare token.
- YouTube: a JSON object `{"refresh_token": "...", "client_id": "...", "client_secret": "..."}`; the client fields are optional when dotz already has them.

Rules (the ones the old keeper used for Instagram):

- Instagram is looked at only when the dotz copy is **due**: last refresh older than 7 days, or expiry in under 20 days, and never within 24 hours of issue.
- A token is taken only after `GET /me` accepted it and it belongs to the connected account. A different account, a rejected token, an older or identical token are never stored.
- With a source, dotz does **not** refresh the Instagram token itself: whoever owns the source refreshes it. A source that stays behind while the copy is due is a failure.
- YouTube: a changed `refresh_token` is exchanged once with Google before it replaces the old one; if Google refuses it the old one is restored.
- Failures are counted per app. The first one is silent; the **second in a row** prints `DOTZ_FAIL token-source` ("토큰 원본을 읽지 못했어요") under the app's internal features. One good run resets the count. Network trouble is not a source failure.
- Secrets are never printed; the notice names the step only.

### Wiring a keychain-backed source

The keychain can be read only from your own logged-in session. Run a small script there that copies the token into a file the gateway can read.
Nothing here is dotz-specific; use whatever scheduler you already trust (a Terminal login item, a Shortcuts automation, a LaunchAgent in your GUI session).

```sh
#!/bin/sh
# Run in YOUR session. Copies the keychain token into a 0600 file; touches it only when the token changed.
set -eu
OUT="$HOME/.config/dotz-token-source/instagram.json"
TOKEN=$(security find-generic-password -s "<keychain service>" -a "<keychain account>" -w)
mkdir -p "$(dirname "$OUT")"
umask 077
if ! grep -q "\"$TOKEN\"" "$OUT" 2>/dev/null; then
  printf '{"access_token":"%s","obtained_at":"%s"}\n' "$TOKEN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT.tmp"
  mv "$OUT.tmp" "$OUT"
fi
```

Then point dotz at the file once: `bun features/youtube-instagram/bin/setup.ts apply --ig-token-file "$HOME/.config/dotz-token-source/instagram.json"`.
Whatever refreshes the keychain token (your old keeper, a manual regenerate) keeps working; this script only mirrors the result.
If the script stops running, the file goes stale, and after two runs the app shows the token-source notice.

## Troubleshooting

### Reels: "릴스를 올리려면 instagram_business_content_publish 권한이 필요해요"

Publishing a Reel needs the `instagram_business_content_publish` permission on the **token**. A token made before that permission was added
to the app's use case lacks it, and Meta answers the final publish with API error code 10. dotz remembers this (`custom/sns/cache/ig-publish.json`):

- the Reels job waits (nothing is sent to Meta), the watch prints one `ig-publish-blocked <job>: ...` line, the home card shows "릴스 올리기: 아직 올릴 수 없어요 ...", and the approval row of a Reels upload carries the same text;
- fix: in the Meta app dashboard open Instagram API settings, step 2 "액세스 토큰 생성", create the token again for the account (two-step verification may ask), then give dotz the new token (`setup.ts instagram-token --from <file>` or your token source);
- a new token clears the state; a publish that works clears it too.

### Comments: `comments_count` is above 0 but `/{media-id}/comments` is empty

While the Meta app is in **development mode**, the comments edge returns an empty array for comments of accounts that have no role on the app,
even though the media shows a count. It starts returning them once the app is **Live** (App dashboard > switch to Live). Until then dotz sees
no new comments; this is not a dotz fault and no token refresh changes it.

### A comment has no username

Left, restricted or deleted accounts come without `username`. dotz shows "알 수 없는 사용자" (or the `from` id) and always addresses a reply by the
**comment id**, never by name.

### dotz keeps asking for a reply the owner already gave

A reply in the Graph payload has no author. dotz decides "already answered" like the old script: the reply's id is one of the owner's own
comments (the media's `/comments` list carries `from.id`), or the owner @mentioned that commenter under the same media. A reply typed in the
Instagram app that does none of these (no mention, not listed with the owner's id) cannot be told from a stranger's reply; tap 답장 안 함 to clear the badge.
