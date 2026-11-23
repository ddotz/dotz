last-proven: 6079c674

# Fallback keys

On 모델 · 폴백 the API 키 사용 card holds the master switch for `guard.allow_api_key`. Turning it on asks first (API 키 사용을 켤까요? with 취소 and 켜기); turning it off is one tap. A fallback step that is down because the switch is off shows an "API 키 사용 안 함(설정)" tag that opens the explanation and the same switch. 삭제 on a step saves the chain without it at once and raises a toast with 되돌리기, which saves the previous chain again. An agent holding the hub token cannot change the switch (403).

## Sub-features

- `switch-on`: 취소 in the confirm leaves the switch off; 켜기 writes `guard.allow_api_key: true` to config.json.
- `switch-off`: one tap writes `false`, with no question.
- `tag`: the step's "API 키 사용 안 함(설정)" tag is its own button and opens a sheet with the explanation and the switch, not the step editor.
- `undo`: 삭제 then 되돌리기 restores the chain; no dialog on 삭제.
- `agent-refused`: `PUT /api/guard/allow-api-key` with the hub token answers 403 and config.json is unchanged.

## How to get to it (user POV)

- 설정 → 모델 · 폴백, scroll to API 키 사용 at the bottom.
- Open the assistant's row (the instance name) to see its fallback steps; tap a step to open its editor with 삭제.

## Driving it with scripts/drive.ts

Preconditions: a launched run passing doctor.

- **Arrange.** A placeholder key file `<data>/secrets/anthropic-api-key`, then an owner `PUT /api/fallbacks` with a Sonnet step and an Opus API-key step; `/api/models` must show the key step with `down_reason: "api_key_off"`. An agent `PUT /api/guard/allow-api-key` must answer 403 and leave config.json as it was.
- **On.** At 390 on `/#models`: switch → confirm (`keys-confirm-390.png`) → 취소 (switch stays off) → switch → 켜기 (`keys-on-390.png`); config.json reads `true`.
- **Off and tag.** Switch once (`keys-off-390.png`, no confirm); config.json reads `false`; open the assistant's row and tap the tag (`tag-dialog-390.png`).
- **Undo.** Open step 2, 삭제 (`delete-toast-390.png`), 되돌리기 (`undo-after-390.png`); `/api/models` shows the arranged chain again. Then `#models` cold at 390 and 1280.
- **Proof.** `bun .omp/skills/verify-dotz/scripts/drive.ts fallback-keys $RUN` writes `<run>/fallback-keys/manifest.json`.

## Gotchas

- The run has no model account, so steps show 계정 연결 notes; the chain and the switch do not depend on it.
- A run drives this feature once: the switch ends off and the chain as arranged, but the manifest refuses a second drive in the same run.
