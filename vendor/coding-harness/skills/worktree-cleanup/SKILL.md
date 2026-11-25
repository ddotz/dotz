---
name: worktree-cleanup
disable-model-invocation: true
description: "Reclaim disk from stale git worktrees (and, on request, simulator and build caches) behind a read-only audit and the user's confirmation. Entered from ulw after isolated or parallel runs, or when the user asks to free disk."
---

This deletes user state with no code review, so the gates below are the review.

1. `df -h /` before.
2. Run the read-only audit per repository and show the table:

       skill://worktree-cleanup/scripts/audit.sh [-b <base-ref>] <repo>

   Columns: `SIZE AGE_DAYS MERGED DIRTY REMOTE PR NOTE BUCKET WORKTREE`. Paths come from `git worktree list --porcelain`, never hand-typed: a worktree can live outside the directory you expect and a typed path misses it. The script fetches the base ref first (`NOTE` says `stale-base` and stderr says why when it is offline) and `-b` is needed when PRs target a branch other than the remote default. `AGE_DAYS` counts from the HEAD commit, not the directory. `REMOTE` is `pushed`, `aheadN`, `no-remote` or `detached`. `PR` is `#N/open|merged|closed` from `gh pr list --head <branch>`, `-` when the branch has none or `gh` is absent, `?` when `gh` failed (`NOTE` says `pr-unknown`). `wip:N` = tracked edits, losing them is irreversible. `scratch:N` = untracked files; name them before dropping. `MERGED` misses squash merges, so read it with `PR`. Buckets are advice only: `hold-wip`, `hold-open-pr` (the branch has an open PR), `review`, `safe`.
3. Never touch worktrees another tool owns while it runs (dotz lanes under `~/Code/dotz`, a running omp task worktree under `~/.omp/wt`). A worktree the user is working in wins over any bucket, and so does `hold-open-pr`. For a row you doubt, have a `scout` read `history://` for that cwd and report whether a session is still using it. `wip:N` rows show their diff and wait for the user's decision; `scratch:N` rows name their files before anything is dropped.
4. Ask the user to confirm the exact list. Before removing a `wip:` row, save its uncommitted work: `git -C <path> diff HEAD > ~/.omp/agent/worktree-backups/<repo>-<branch>-<UTC timestamp>.patch` (and copy its untracked files beside it). Then per worktree, using the path the audit printed from `git worktree list`: `git worktree remove <path>` (add `--force` only for a confirmed `scratch:` row or a `wip:` row whose patch was saved). If the directory survives on ignored build artifacts, `rm -rf <path>` that same path. Run `git worktree prune` once at the end. Branch refs stay, so commits are not lost.
5. Caches, only on request, each listed with its size first (`du -sh`) and cleared only when the user has not said to keep it: `xcrun simctl delete unavailable`, `xcrun simctl --set testing delete all` (XCTestDevices clones), `xcrun simctl runtime list` then `xcrun simctl runtime delete <id>` for old runtimes, `~/Library/Developer/Xcode/DerivedData`, `~/Library/Developer/Xcode/iOS DeviceSupport`, `src-tauri/target` of inactive projects, `~/.bun/install/cache`, and the pnpm, uv, brew and yarn caches (`pnpm store path`, `uv cache dir`, `brew --cache`, `yarn cache dir` name each one).
6. `df -h /` after, and run the audit again. Reply with the reclaimed space, the worktrees pruned, and a one-line reason for each one kept (in use, or uncommitted work).
