---
name: how
disable-model-invocation: true
description: "Explain how a subsystem works, walk through code before changing it, or answer placement, ownership, and layering questions (where should this live, which package owns this, is this the right layer). Read-only. ulw enters it for 'how does X work' and for investigation turns that need a mental model. Use why for motivation."
---

Explore the codebase to answer "how does X work?" questions. Nothing is changed.

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

## 1. Explain

Spawn one `task` worker (not a read-only agent, since it must write one file). The guard caps every worker's final answer at about 800 characters, so the worker writes the explanation to a file and returns only its path. The brief has five parts:

- The user's question, verbatim, plus your interpretation of its scope.
- The grounding: paths, symbols, or entry points you already know. Pass paths, not pasted code.
- The role: "You are writing an architectural explanation for a senior engineer who is unfamiliar with this area. Explore the codebase and write an explanation they could read and walk away with a solid mental model. They should understand the architecture well enough to start working in it confidently. Do not edit repo files; write the explanation to `local://how-<topic>.md`; your final answer is that path."
- An Acceptance line: "Done when `local://how-<topic>.md` names each component involved, the runtime flow between them with file:line references, and what owns each piece of state."
- The length: under about 800 words in the file, with file:line references for every claim.

For a placement, ownership, or layering question, add to the brief: name the module that owns the concept today, the layer each caller sits in, what depends on what, and where the new code would fit if the existing layering is respected. If the layering is the problem, the worker says so and names the smaller move that fixes it.

## 2. Present

Read `local://how-<topic>.md` and present it. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it. Check two or three of its file:line references yourself before you present them as fact.

Source: pstack skills/how (MIT, skill://ulw/references/LICENSE-pstack).
