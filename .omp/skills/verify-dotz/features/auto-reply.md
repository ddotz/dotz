last-proven: 44a0f30d

# Auto-reply

When a mail that needs an answer arrives, dotz writes a reply draft in the owner's voice and shows it as an approval card (받는이, 제목, 첨부, body, 보내기 / 고치기 / 보내지 않기). The home screen counts it under 답변 필요 as 답장 초안 확인; 모니터링 → 답장 대기 lists it. 보내기 starts a 10-second window with 되돌리기, then the gateway sends the reply through the mail source, the card turns into 보냈어요, and the mail's conversation keeps a 보낸 답장 line. Nothing goes out without that tap.

## Sub-features

- `card`: the draft card shows sender, original, recipient, subject, body and the three choices.
- `home-entry`: home 답변 필요 shows 답장 초안 확인 · N건 and opens 답장 대기.
- `undo-window`: 보내기 shows "10초 후 보내요" with 되돌리기 before anything is sent.
- `send`: after the window the draft is sent once (`zele mail reply <mail id> --to <sender>`), `drafts.json` status `sent`.
- `sent-state`: the card shows 보냈어요 and 보낸 것 lists the mail on the page that sent it; opened cold, the mail's conversation shows 보낸 답장 and 답장 대기 no longer lists the mail as waiting.

## How to get to it (user POV)

- Home → 답변 필요 → 답장 초안 확인 · N건.
- Bottom tab 모니터링 → 답장 대기 (`#monitoring/replies`).
- A push notification for the card opens `/#chat/mail:<mail key>` (the mail's conversation, card above the composer).

## Driving it with scripts/drive.ts

Preconditions: a launched run passing doctor; the feature's files equal HEAD when the run is `--tree head`.

- **Arrange the mail.** `POST /api/mail` with the hub token, source `zele`, `needsReply: true`, sender `Sender A <sender@example.invalid>`. Answer `{ok: true, key, target}`.
- **Arrange the draft.** `scripts/seed-auto-reply.ts` runs the real `buildDraft` with a canned model answer (the model call is the only stand-in), stores it with `addDraft`, and prints `askText`; the driver posts that text to the mail's conversation with `POST /api/send`, as the bot does. Read back: `drafts.json` status `pending`, no `zele mail reply` for this mail in `outbound/calls.log`.
- **Open from home.** Click button `답장 초안 확인 · 1건`. The list shows the card with buttons 보내기, 고치기, 보내지 않기 (`replies-before.aria.txt`, `replies-before-390.png`).
- **Send.** Click button `보내기` (exact). A status `10초 후 보내요` with button 되돌리기 appears (`undo-window.aria.diff`, `undo-window-390.png`).
- **Sent.** Within 45 s the status reads `보냈어요` and 보낸 것 lists the mail (`replies-after.aria.diff`, `replies-after-390.png`). Read back: `drafts.json` status `sent`, `outbound/calls.log` has `zele whoami`, `zele mail read <id>`, `zele mail reply <id> --to sender@example.invalid --body ...`.
- **Cold.** Fresh tabs at 390 and 1280: home (`cold-home-<w>.png`, shows `verify`), the mail conversation `#chat/<mail target>` (`cold-mail-sent-<w>.png`, shows 보낸 답장), and `#monitoring/replies` (`cold-replies-<w>.png`, shows 기다리는 답장이 없어요).
- **Proof.** `bun .omp/skills/verify-dotz/scripts/drive.ts auto-reply $RUN` does all of the above and writes `<run>/auto-reply/manifest.json`.

## Gotchas

- The draft text comes from a canned model answer: the model's wording, tone learning and the automatic offer queue (`offerMailDraft`) are not driven. A change there needs its own unit tests; this recipe proves the card, the approval and the send path.
- The send reaches the `zele` stub, which answers success. A real mail account, a stale-thread refusal from zele, and the Discord copy of the card are not exercised.
- A second pending draft makes `보내기` ambiguous: drive auto-reply once per run.
- Home also counts the mail under 답 안 한 댓글 · 1건 while its draft waits; seen on the first run, not investigated.
- Product gap, seen 2026-11-19 at 44a0f30d: after a reload, 답장 대기 → 보낸 것 no longer lists a mail reply sent today. `GET /api/reply/queue` builds mail items from pending drafts only (`hub/reply-mail.ts` `list` filters `status === "pending"`), so `counts.sentToday` is 0 and only the page that sent it shows the row. The recipe captures the reload state as it is; when this is fixed, change the cold `#monitoring/replies` wait to the sent row.
- Use `http://localhost:<port>`, not `127.0.0.1`: the owner's HttpOnly `dotz_local` cookie for `127.0.0.1` shadows the run's cookie there.
