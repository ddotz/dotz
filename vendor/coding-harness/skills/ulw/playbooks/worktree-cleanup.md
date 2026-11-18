Reclaim disk from stale git worktrees (and, on request, simulator and build caches) behind a read-only audit and the owner's confirmation. The procedure is `skill://worktree-cleanup`.

1. Record `df -h /`, then run the read-only audit from `skill://worktree-cleanup` step 2 per repository. Paths come from `git worktree list --porcelain`, never hand-typed. Pass `-b <base-ref>` when PRs target a branch other than the default; `MERGED` misses squash merges, so read it with the `PR` column.
2. Treat the bucket as advice, not permission. A worktree the owner is working in, a dotz lane, a running omp task worktree under `~/.omp/wt`, or a `hold-open-pr` row is in use whatever its bucket says. For a row you doubt, have a `scout` read `history://` for that cwd and report whether a session is still using it.
3. Pause on irreversible loss: `wip:N` rows show the diff and wait for a decision; `scratch:N` rows name the files before dropping. Clean, merged and not-in-use rows go on the list that the owner confirms.
4. After the owner confirms the exact list, remove per worktree, `rm -rf` the path if ignored artifacts survive, and prune once (`skill://worktree-cleanup` step 4). Branch refs stay, so no commits are lost.
5. Caches only on request and with sizes listed first (`skill://worktree-cleanup` step 5: simulators, Xcode DerivedData and iOS DeviceSupport, pnpm, uv, brew, yarn). Then record `df -h /` again and re-list.

Reply: in Korean, plain text: `df -h /` before and after with the space reclaimed, the worktrees pruned, and a one-line reason for each one held back (in use, or uncommitted work).

Source: pstack skills/poteto-mode/playbooks/worktree-cleanup.md (MIT, skill://ulw/references/LICENSE-pstack).
