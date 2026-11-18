---
name: pause
disable-model-invocation: true
description: "Pause or resume work safely: stop at a safe boundary and leave a resume note, or pick up work a previous session left. Entered from the omp router rule ~/.omp/agent/rules/routines.md when the user asks to stop for now or to continue earlier work. Not for \"keep going\"."
---

## Pause

1. Trigger is explicit only. "Keep going", "going to bed, keep going", or "don't stop" are not a pause.
2. Finish or back out of the current atomic step. Start nothing new. Cancel running workers and record what each was doing.
3. No irreversible action to pause: no push, PR, deploy, or message.
4. Save uncommitted work without touching shared history: in a repo you own the branch of, commit with the eval `commit` namespace as `wip: <step>` (say in the body if the tree is red); otherwise leave the tree as is and list the changed paths.
5. Write the resume note to `<repo>/.omp/resume.md` (no repo: `local://resume.md`), at most 40 lines:
   - Intent: the user's goal in their words.
   - Doing: the step in progress when paused.
   - Verified: what is done, each with its evidence (command, path, commit).
   - State: branch, last commit, dirty paths, running services or ports.
   - Next: the first three actions on resume.
   - Gotchas: traps already hit. Point at an existing plan or decision log instead of copying it.
6. Reply: what is on disk vs only in this conversation, commits made, whether the tree is clean, the first action on resume.

## Resume

1. Find the trail in this workspace only: `.omp/resume.md`, the plan or decision log it points to, `git log` and `git status`, and the previous session via `history://` for this cwd. Never read other projects' sessions.
2. Rebuild state: done vs pending, open decisions, what is waiting on the user. Treat the trail as authoritative for what happened; do not redo finished work.
3. Re-check every number and claim you will repeat to the user against the tree now (counts, test results, versions).
4. For each item waiting on the user, show one decision card: the question, the options, your recommendation, and what it blocks.
5. Pick the playbook for the next step (via `skill://ulw` for code work) and continue. Before calling anything done, verify inherited claims on the real artifact: a previous self-report is not proof.
6. Delete `.omp/resume.md` once its next steps are done.
