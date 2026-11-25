---
description: "Routes user requests to the hidden routine skills (ulw, pause, automate-me, ketchup, work-history, retro, how, why, teach, worktree-cleanup)"
alwaysApply: true
agents: main
---
Routines by request: read the skill first, then follow it.

- LIGHT path, a bug fix, feature or refactor of three files or fewer with no auth, security, schema, concurrency or external-integration fact: state the goal in one line, make the change, run one real-surface check, report with that evidence; no skill first.
  Those facts, an audit or edge-case check, an unattended or multi-step run: `skill://ulw` and the playbook it picks, read both before the first edit. More files alone stay LIGHT. Questions, lookups, config edits and a dictated one-liner need neither.
- The keyword `ulw` anywhere in the message: `skill://ulw`.
- PR status ("check on PR X", "babysit", "get it green", "address the review comments"), or landing a stack: `skill://ulw`, then its `babysit` (read-only `check` mode for "check on") or `shipping` playbook.
- How a subsystem works across files: `skill://how`. Why code is the way it is: `skill://why`. "Teach me": `skill://teach`.
- Stop for now, or continue earlier work: `skill://pause`. Catch me up: `skill://ketchup` (with a video: `skill://ketchup-video`); earlier work on a topic: `skill://work-history`.
- Lessons from this session into skills: `skill://retro`. Free disk, worktrees or simulators: `skill://worktree-cleanup`. Capture my habits: `skill://automate-me`.
