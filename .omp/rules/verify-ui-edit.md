---
description: "UI file edited: prove the change through this project's verify skill"
scope: "tool:edit(**/web/js/*.js), tool:write(**/web/js/*.js), tool:edit(**/web/css/*.css), tool:write(**/web/css/*.css), tool:edit(**/web/index.html), tool:write(**/web/index.html), tool:edit(**/web/i18n/**/*.json), tool:write(**/web/i18n/**/*.json), tool:edit(**/web/sw.js), tool:write(**/web/sw.js), tool:edit(**/web/custom.js), tool:write(**/web/custom.js)"
condition: ".*"
---
You edited a UI file of dotz. Before you report this task done, read `skill://verify-dotz` and prove the changed behavior on the running app:

- Capture the affected screen before the change (or from the base commit) and after it, at the same viewport and data.
- Drive the user path that reaches the change; save the snapshot diff and screenshot under `.omp/verify/runs/`.
- Layout or styling change: also run `skill://visual-diff` against the stored baseline.
- If the surface is partial or not drivable here, say so in the reply. Do not describe unverified UI as working.
