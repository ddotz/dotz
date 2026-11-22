---
name: figure-it-out
disable-model-invocation: true
description: "Design an auditable playbook when no narrower one fits: a large migration, an ambitious multi-part change, or work the owner reviews after stepping away. Scales rigor to the task, runs a hypothesis loop, and logs decisions. Entered from ulw when no playbook matches and the work is large or unattended."
---

When the task matches no playbook, design one. The deliverable before any code is the workflow itself: a sequence of phases that scales rigor to the task, runs the scientific method, and leaves a decision trail the owner can audit after stepping away.

## Phases

Open a todo list whose first item is to read the principles that apply (`skill://principle-prove-it-works`, `skill://principle-sequence-verifiable-units`, `skill://principle-never-block-on-the-human`). Then add the phases below as todos: Frame, Design the workflow, Loop, Trail, Verify.

### Frame

Ground first, then commit. Do not start the run until you can state:

- The definition of done as a falsifiable predicate (`skill://principle-prove-it-works`).
- Scope, quantified: rough units and effort, plus the blockers grounding surfaced.
- The rigor level, biased high. One-way doors and high blast radius get more. Reversible low-stakes steps get less. Rigor is gates and artifacts, not "try harder".

Present the framing and tradeoffs before committing to a long run. Reversible work proceeds (`skill://principle-never-block-on-the-human`), but a multi-hour run earns one checkpoint with the `ask` tool.

### Design the workflow

Decompose into atomic, independently landable units. Sequence the riskiest unknown first. Scaffold and verification come before features (`skill://principle-foundational-thinking`).

- Build the verification harness before the work, with the baseline captured from the pre-change state, so the check reads as "old value vs new value".
- For one-way-door design decisions, run `skill://architect`, which runs `skill://arena`. Skip it for mechanical work whose shape is already concrete. A second arena over a settled design is over-engineering (`skill://principle-laziness-protocol`).
- Decide what fans out. Parallelize only across seams, and give each writing worker its own isolated worktree (`skill://principle-separate-before-serializing-shared-state`). Fan out through `skill://swarm`. Do not over-fan. Workers never spawn; the main session coordinates every one.
- Write the designed phase list down in `.omp/plans/<name>.md`. That list is what the owner reviews.

Then execute the design. Add its steps to the todo list as concrete items between the Loop and Trail entries. Run each under the Loop discipline, and log a row as each step lands rather than saving the whole trail for the end.

### Loop

Each unit is an experiment. State the hypothesis, make the smallest change, measure against the predicate on the real artifact, keep it if it advanced, revert it if it did not. Verify each unit before starting the next instead of batching checks at the end (`skill://principle-sequence-verifiable-units`).

- Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the observation method before the system.
- Pair delegated work with a judge: a `reviewer` worker that did not write the patch. If a worker games the gate, reset and harden the contract. If the gate itself is wrong, fix the gate in its own change rather than routing around it.
- A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass. Do not hide a negative.

### Trail

Log the run with `skill://decision-log`. This work is usually ambitious enough to commit the trail so the reviewer can read it in the PR. The trail plus the diff is what lets the owner come back and trust the work.

### Verify

Check the whole against the Frame predicate on the real product, not just the harness. Encode any recurring correction as a gate, a lint rule, a check, or a script (`skill://principle-encode-lessons-in-structure`; the `mistake` tool and `skill://correct` pick the layer).

Final reply, in Korean to the owner: the playbook you designed, the rigor level and why, the decision-trail path, what is verified against the predicate, and what is still open.

Source: pstack skills/figure-it-out (MIT, skill://ulw/references/LICENSE-pstack).
