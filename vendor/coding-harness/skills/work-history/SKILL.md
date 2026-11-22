---
name: work-history
disable-model-invocation: true
description: "Rebuild recent working context on a topic from prior sessions, git, and GitHub, then hand back a tight state brief: what was done, what is open, what keeps failing, the next move. Use for /skill:work-history, 'catch me up on X', 'where did I leave off', or before resuming work whose history is not in this session. Not the memory recall tool."
---

Before starting or resuming work, rebuild where things stand and hand back a short brief. Read only what the in-scope threads need, then stop.

Two records hold the story. Prior sessions hold what was done and decided. The shared record holds what happened around the same code under other names: the symptoms users keep reporting, the fixes that shipped and were reverted, the PRs still open. A feature with a long bug tail keeps most of its story in the second record, so do not rebuild it from sessions alone.

Run this in the main session. `gh` reads belong there. Do not fan out a fleet of workers: a handful of targeted reads answers it.

## Steps

1. Classify. One specific prior session to resume is `skill://pause` (Resume), not this. A user who already gave a full state capsule (paths, branch, the change) needs no mining: use it. Everything else continues below.
2. Pin the scope before searching. Window ("recent" is a real range; default the last 7 days), topic if named, project (default the working repo; never read another project's sessions unasked). Say the scope back in one line. Never quietly turn "all" into "recent N".
3. Mine your own history. Start with the memory `recall` tool on the topic: it returns durable facts and decisions. Then `history://` lists registered sessions; read `history://<id>` only for the sessions whose topic matches, and only the relevant stretch. Order candidates by real modification time, not by id. Skip the current session and obvious noise (eval, test, throwaway worker sessions). Note each finding with its session id.
4. Sweep the shared record whenever the topic names a feature, file, subsystem, or bug. This is the default, and "my work on X" does not exempt it.
   - `git log --oneline -n 30 -- <paths>`, `git log -S<symbol>`, `git log --grep=revert -i` for fixes that were reverted;
   - `gh pr list --state all --search "<topic>"` and `gh issue list --search "<topic>"` for open and merged work and the symptoms users keep reporting.
   Null results are findings. Skip only for pure activity recall with no named target ("what did I do this week"): then sessions and live state are the whole answer.
5. Verify against live state. Check every PR, branch, and ticket the mining surfaced with `git` and `gh` (merged, open, deleted, reverted). When the answer hinges on what an agent actually did (tools run, files read, errors hit), read that session through `history://<id>`, not a summary of it.
6. Write the brief to the contract below. Group by thread. Stay on the named topic.

## Output contract

Capsule first, then threads, then problems, then the next move. Cut detail before cutting threads when it outgrows a screen.

- Capsule: at most 5 lines. What this work is and where it stands.
- Threads: one line each, with exactly one status tag: `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, `[planned, not started]`. An untagged thread is not done: tag it.
- Problems: at most 5, the recurring ones. Include symptoms users keep reporting and every fix that shipped and was reverted, so the next attempt starts where the last one failed.
- Next move: the single most useful next action, concrete.

An adjacent feature or ticket stays out unless it blocks this one. Write the brief through `skill://unslop` before returning it. Cite session findings by `history://` id and shared-record findings by source (PR number, commit, issue). Strip private context before anything public.

Source: pstack skills/recall/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
