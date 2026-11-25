Reclaim disk from stale git worktrees (and, on request, simulator and build caches) behind a read-only audit and the owner's confirmation.

1. Run `skill://worktree-cleanup` in full: the audit, the in-use checks, the owner's confirmation of the exact list, removal, caches only on request, and the audit again.

Reply: in Korean, plain text, as `skill://worktree-cleanup` says: `df -h /` before and after, the worktrees pruned, and the reason for each one kept.

Source: pstack skills/poteto-mode/playbooks/worktree-cleanup.md (MIT, skill://ulw/references/LICENSE-pstack).
