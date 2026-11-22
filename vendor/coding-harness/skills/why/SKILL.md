---
name: why
disable-model-invocation: true
description: "Answer 'why does X work this way', 'why did we pick Y', design rationale, regressions, postmortems, and data-backed thresholds from the history, with citations. ulw enters it at the start of an investigation or bug fix to learn what the code was meant to do. Use how for runtime behavior."
---

Answer from the record, not the code. Read the commits and PR discussions that introduced the target and each later change. Use other sources if the trail is thin.

## Find the record

1. Locate the target's origin. `git log -S'<symbol or string>' --oneline -- <path>` finds the commit that added or removed it. `git log -G'<regex>'` finds changes to lines matching a pattern. `git log --follow -- <file>` crosses renames.
2. Blame the lines that matter: `git blame -w -C -L <start>,<end> <file>`, then `git show <sha>` for the full message and diff. Skip commits that only moved or reformatted code and blame through them.
3. Read the PR text behind each commit that matters: `gh pr view <n> --comments`, plus review comments with `gh api repos/<owner>/<repo>/pulls/<n>/comments`. Commits often hold the what and the PR holds the why. These are read-only calls.
4. Thin trail: check linked issues (`gh issue view`), design docs and plans in the repo, `.omp/decision-log.tsv`, and earlier sessions through `history://` or `skill://work-history` when it exists.
5. Read each later change to the target, not only the first. A rationale often changed after a bug.

## Write the answer

- Cite what the authors wrote: author, date, commit or PR number, and a short quote. "Alice, PR #412: 'cache per request, not per process, because ...'".
- Mark your own inferences as inferences, with the confidence labels from `agent/AGENTS.md` ([High] from the record itself, [Medium] credible inference, [Low] guess, [Unknown] no evidence). Put the evidence next to each one. Never present a plausible story as the record.
- Say what the record does not answer. Name the missing piece and where an answer could still live, such as a person to ask or a measurement to run.
- Where the record and the current code disagree, say so. The code may have drifted from its stated reason.
- For a threshold or constant, find the data or incident behind it. If none exists, say the number is unexplained.

Use `how` for what the code does today.

Source: pstack skills/why (MIT, skill://ulw/references/LICENSE-pstack).
