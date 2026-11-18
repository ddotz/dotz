---
name: prototype
disable-model-invocation: true
description: "Settle an observable design fork (layout, interaction, animation timing, API ergonomics, library behavior) by building throwaway variants and looking at them, instead of asking the user. Entered from ulw's 'run it, don't ask it' rule."
---

No decision to make means no prototype; go back to the Feature playbook.

1. Write the decision as a question with 2-4 candidate answers. Add one variant the user did not ask for when a plausible one exists.
2. Build in a scratch folder outside the repo (`/tmp/proto-<slug>/`): the lightest stack that shows the difference (one HTML file with inline CSS/JS and CDN imports for visual work; the smallest script for behavior or timing). No tests, no abstractions, no polish.
3. Visual variants live on one page behind a labeled switcher (buttons or number keys), with the same content in each.
4. Observe every variant: screenshot each through `aside repl` at the target viewport(s) and drive the interaction; for behavior, print the timings or outputs. The observation is the result.
5. Reply: the decision, one line of evidence per variant (screenshot path or numbers), and "this code is throwaway".
6. Never copy prototype code into the product. The real build starts from the decision in the Feature playbook.

When the user's taste decides (not an observable fact), show the screenshots and ask one question with the variants as options.
