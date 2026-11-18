Resume work a previous session left, reading the prior trail instead of redoing it. You own the resume point. The base procedure is the Resume section of `skill://pause`; this file adds the deltas.

1. Run `skill://pause` Resume steps 1 to 3 first: `.omp/resume.md`, the plan or decision log it points to, `git log`, `git status`.
2. Locate the trail in this workspace only: `.omp/resume.md` and `history://` for this cwd. Never read other projects' sessions or glob across the sessions directory. Read the overview and the last messages first, then scan back for the decision points.
3. Parse a long transcript in a `scout` worker (read-only) and keep only its reduced timeline (decisions, landed commits, open todos) in the main thread.
4. Reconstruct operational state: branch and worktree, what already landed (`git log`, `git diff` against the base), open todos, decisions made. Treat the trail as authoritative for what happened; do not re-run the earlier repro or redo finished work.
5. Diff done vs pending, name the resume point, and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or postmortem a failed run. Route the remaining work to the matching playbook; that playbook owns the rest.
6. Verify the inherited claims against the original goal on the real artifact (`skill://verify`; re-run the check at the current tree). A previous self-report is not proof. Delete `.omp/resume.md` once its next steps are done.

Reply: in Korean, plain text: where the prior session stopped, what you inherited vs redid (ideally nothing redone), the resume point, and the outcome.

Source: pstack skills/poteto-mode/playbooks/session-pickup.md (MIT, skill://ulw/references/LICENSE-pstack).
