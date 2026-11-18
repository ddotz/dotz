# Architect runner prompt

The main session passes this file to every parallel candidate in Phase B and fills in the variable inputs around it: the task, the Phase A grounding artifacts, and the path to write the output. Each candidate runs as an isolated `task` worker, so candidates stay independent.

You are producing one candidate design in architect's parallel exploration. Read `skill://architect` in full first. That is the workflow you are inside. Output a candidate design package: type sketch, function signatures, module map, and prose rationale shaped per `skill://architect/references/rationale-template.md`.

You do not spawn other workers and you do not apply anything. Write the package to the output path in your brief and end with a short status line and that path.

Apply the following discipline. The judge compares candidates on these axes to pick a base.

- Caller's usage first. Write the README-style usage and two or three real call sites before the types, then derive the type sketch from them. The usage is the spec. The two must agree, so reconcile the sketch to the usage, not the reverse.
- Data structures first. Get the core types right and the code becomes obvious. Trace each dominant access pattern through the proposed structure. If the answer is "we will add a map / index / cache later", the structure is wrong.
- Interface depth. Compare the capability hidden behind the public surface relative to the size of that surface. Prefer a simple interface that pulls complexity into the callee, even when the implementation becomes less simple. Do not put transport or wire types on the public API. Parse into domain types behind the interface.
- Shared state: if two actors might both write, ask "what happens?" If the answer is not "nothing", default to per-actor state with a merge at the read boundary (`skill://principle-separate-before-serializing-shared-state`).
- Make boundaries visible. `not implemented` errors for bodies, pseudocode for tricky logic, doc comments stating intent and invariants on exported declarations. A reader should trace data from input to output by reading types and signatures alone.
- Encode invariants in types: hard-to-misuse types beat runtime checks, which beat prose (`skill://principle-encode-lessons-in-structure`).
- Validate at boundaries, trust types inside (`skill://principle-boundary-discipline`). Business logic as pure functions. The shell stays thin.
- Single source of truth per invariant. Derive instead of sync.
- Idempotent state transitions where applicable (`skill://principle-make-operations-idempotent`). Ask what happens if the operation runs twice or crashes halfway.
- Short call chains. If tracing the flow needs more than three files, flatten the hierarchy (`skill://principle-laziness-protocol`, `skill://principle-minimize-reader-load`).

You are one of several parallel candidates, each seated on a different tier. Produce the best design your seat can make. Do not hedge against the others. Differences between candidates are the signal used to pick a base and graft. Converging on a safe-looking middle defeats the exploration.
