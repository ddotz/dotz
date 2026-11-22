---
name: architect
disable-model-invocation: true
description: "Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Entered from ulw on a feature or refactor whose code crosses a function or module boundary, or when jumping to code would lock in the wrong shape."
---

Sketch types, function signatures, class shapes, and module boundaries with `not implemented` bodies and pseudocode. Compare several designs, then fill in code against the chosen sketch.

## Phases

Open one todo per phase: Ground, Sketch, Agree, Implement, Scrap.

### Phase A: Ground the problem

Build a real mental model of every system the new code touches. Trace the relevant subsystems. Naming a file is not grounding. Write an architectural explanation of each. If the design redefines ownership or layering, also read the history of the existing shape (`git log -S`, blame, the PR that introduced it) so the old rationale becomes a constraint, not a guess.

Skip Phase A only for greenfield work with no surrounding system to integrate.

### Phase B: Sketch

Run `skill://arena` with the design-sketch task and the Phase A grounding artifacts. Each candidate's brief points at `skill://architect/references/runner-prompt.md`, names its own output file, and carries its own Acceptance line.

Seats. Where the tier roles allow it, seat candidates on different tiers, and make the judge a different tier from every author. The judge is `deep-reviewer` only when the design is a one-way door; otherwise `reviewer`. Tier choice belongs to the model-tiers extension. Never write a model name.

Design it twice. Require at least two structurally distinct candidates before synthesis, even when the first looks sufficient. Whole-shape alternatives, not point fixes inside one shape. The alternatives and the graft decision are `skill://arena` territory; do not re-run the comparison by hand.

Screen every candidate against `skill://architect/references/design-red-flags.md` before the judge sees it. Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo.

Compare viable candidates on interface depth. Prefer the design that hides more complexity behind a smaller public surface. A rich interface keeps call chains short by concentrating capability instead of scattering it across layers.

Arena returns one synthesized design. Its synthesis decision fills the rationale's "Synthesis decision" section.

### Phase C: Agree (opt-in)

Default: go straight to implementation with the synthesized design. No human checkpoint.

Opt in only when the owner asks for it ("stop and show me before implementing", "with checkpoint"). Then surface the design with the `ask` tool and wait for sign-off.

The synthesis can ship as its own commit either way (`skill://principle-foundational-thinking`, "scaffold first"). Planned and scoped breakage during fill-in is fine (`skill://principle-outcome-oriented-execution`). For adversarial pressure on the design before implementing, run `skill://interrogate` on the synthesized sketch.

If the owner pushes back on the shape, at a checkpoint or after, treat that as Phase A evidence. Re-ground and re-run Phase B before writing more code.

### Phase D: Implement against the sketch

Replace `not implemented` bodies with code, pseudocode with logic. The synthesized sketch is the contract. A deviation from it is a signal to surface, not friction to absorb. If a function needs a parameter the sketch did not anticipate, decide which it is: the sketch was wrong, a requirement was missed, or the implementation is overreaching.

Implementation workers get the sketch path in the brief and the rule that a deviation goes in their final answer, not silently into code.

### Phase E: Scrap when the architecture is wrong

If implementation keeps producing friction the sketch cannot absorb, throw the sketch out. Do not bolt fixes onto a wrong design (`skill://principle-redesign-from-first-principles`, `skill://principle-fix-root-causes`).

The signal is a pattern, not a single instance. Tells:

- The same shape of workaround appears repeatedly across unrelated code.
- Several unrelated edge cases each need a special-case branch.
- Types need escape hatches (`any`, casts, optional fields that are always set in practice) to compile. The done gate already counts new `any`; treat a rising count as this tell.
- The "we need a lock" reflex appears where the sketch said the state was not shared.
- Callers must know the abstraction's internal rules to use it.
- Two or more independent Phase D deviations of the same shape.

Use judgment. A few edge cases do not condemn an architecture. Some problems are legitimately complex. Complexity in the data is not complexity in the design.

When you scrap:

1. Trace what has been built.
2. Redesign as if the new constraints had been day-one assumptions.
3. Subtract before adding (`skill://principle-subtract-before-you-add`). The new sketch is smaller than the old one before it grows.
4. Return to Phase B and run arena again.

## Outputs

The caller's usage is written first and the type sketch derived from it. One file with new types and signatures for a small change. A module map plus type definitions for larger work. The rationale ships alongside, shaped per `skill://architect/references/rationale-template.md`, including the usage sketch and the synthesis decision.

Source: pstack skills/architect (MIT, skill://ulw/references/LICENSE-pstack).
