---
description: "Routes user requests to the hidden routine skills (ulw, pause, automate-me, ketchup, work-history, retro, how, why, teach, worktree-cleanup)"
alwaysApply: true
agents: main
---
Routines by request: read the skill first, then follow it.

- LIGHT path, a bug fix, feature or refactor of three files or fewer with no auth, security, schema, concurrency or external-integration fact: state the goal in one line, make the change,
  run one real-surface check (the test of the changed files, or the command the user sees), report with that evidence; no skill first.
  HEAVY work (those facts, more than three files, an audit or edge-case check, an unattended or multi-step run): `skill://ulw` and
  the playbook it picks, read both before the first edit. Judge by the request, not the diff.
  Questions, lookups, config edits and a dictated one-liner need neither.
- The message starts with or contains the keyword `ulw`, whatever the task: `skill://ulw`.
- PR status ("check on PR X", "babysit", "get it green", "address the review comments"), or landing or shipping a stack: `skill://ulw`, then its `babysit` or `shipping` playbook. "Check on PR X" is babysit's read-only `check` mode (one status pass and a report, no edits or pushes), so it fits the read-only meaning of "check".
- How a subsystem works, when the answer spans more than one file: `skill://how`. Why code is the way it is (history, rationale, a threshold): `skill://why`. "Teach me" or "help me really understand X": `skill://teach`.
- Stop for now, or continue work an earlier session left: `skill://pause`.
- Catch me up on this session ("where are we", "catch me up"): `skill://ketchup`; with a video: `skill://ketchup-video`. On earlier work on a topic ("where did I leave off on X"): `skill://work-history`.
- What did we learn from this session, turn lessons into skills: `skill://retro`.
- Free disk, clean up worktrees or simulators: `skill://worktree-cleanup`.
- Capture my habits or preferences: `skill://automate-me`.
