---
description: "UI file edited: prove the change through this project's verify skill"
scope: "tool:edit(src/**/*.tsx), tool:write(src/**/*.tsx), tool:edit(src/**/*.css), tool:write(src/**/*.css)"
condition: ".*"
---
You edited a UI file of <app>. Before you report this task done, read `skill://verify-<app>` and prove the changed behavior on the running app:

- Capture the affected screen before the change (or from the base commit) and after it, at the same viewport and data.
- Drive the user path that reaches the change; save the snapshot diff and screenshot under `.omp/verify/runs/`.
- Layout or styling change: also run `skill://visual-diff` against the stored baseline.
- If the surface is partial or not drivable here, say so in the reply. Do not describe unverified UI as working.
