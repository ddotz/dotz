---
description: "Routes user requests to the hidden routine skills (ulw, pause, automate-me, ketchup, work-history, retro, how, why, teach, worktree-cleanup)"
alwaysApply: true
agents: main
---
Routines by request: read the skill first, then follow it.

- A bug report, a feature request, a refactor, or a multi-step or unattended run: `skill://ulw` and the playbook it picks, both read before the first edit. Decide from the request, not from how small the diff looks once you have read the code: two bugs, two files, or a fix that needs a check is not a one-line edit. Skip it only for quick questions, lookups, config-only edits, and a single-line change the user dictated.
- The message starts with or contains the keyword `ulw`, whatever the task: `skill://ulw`.
- PR status ("check on PR X", "babysit", "get it green", "address the review comments"), or landing or shipping a stack: `skill://ulw`, then its `babysit` or `shipping` playbook. "Check on PR X" is babysit's read-only `check` mode (one status pass and a report, no edits or pushes), so it fits the read-only meaning of "check".
- How a subsystem works, when the answer spans more than one file: `skill://how`. Why code is the way it is (history, rationale, a threshold): `skill://why`. "Teach me" or "help me really understand X": `skill://teach`.
- Stop for now, or continue work an earlier session left: `skill://pause`.
- Catch me up on this session ("where are we", "catch me up"): `skill://ketchup`; with a video: `skill://ketchup-video`. On earlier work on a topic ("where did I leave off on X"): `skill://work-history`.
- What did we learn from this session, turn lessons into skills: `skill://retro`.
- Free disk, clean up worktrees or simulators: `skill://worktree-cleanup`.
- Capture my habits or preferences: `skill://automate-me`.
