---
name: principle-guard-the-context-window
description: "Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to workers; keep summaries in the main thread, not raw payloads. ulw enters it when planning a fan-out or reading large output."
disable-model-invocation: true
---

# Guard the Context Window

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
- **Route bulk to workers.** Large outputs, long files, and noisy searches go to a `task` worker or the `scout` agent. The main thread keeps the summary.
- **Pass paths, not contents.** A brief names files; the worker reads them. A worker's final answer is a short summary plus the path of any long output, never a transcript.
- **Read once.** Do not re-read content already in context. Read ranges of a large file, not the whole.

Source: pstack skills/principle-guard-the-context-window/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
