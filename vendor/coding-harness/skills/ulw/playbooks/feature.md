Build new behavior with the design owned by the main session and the implementation delegated to workers.

1. Trace the affected subsystem and map callers and boundaries with lsp references. A change to a shared symbol, persisted shape, IPC contract or config: `skill://blast-radius` before the design.
2. Write the call site or the screen first (how a caller or user will use it), then name the data shape and its organizing structure (`skill://principle-model-the-domain`): a typed model over repeated shape assumptions, a state machine or one discriminated union over scattered booleans, a table or registry over branching. Scrap the sketch when it needs a flag per caller or explaining takes longer than writing. A scope or UX tradeoff: `skill://principle-experience-first`.
3. Run `skill://architect` for parallel design exploration of the shape. A one-way door: `skill://arena` on the design sketch before implementing. A state-heavy flow (retries, payments, sync, multi-step forms): `skill://statechart` first; a promise like "never charged twice" on HEAVY concurrency work: `skill://formal-verify`.
4. Write the throughput checkpoint as four todos. A dimension that does not apply keeps its todo as `n/a: <reason>`:
   - Blocking first steps: gates that run before fan-out.
   - Independent workstreams: disjoint files, services, or layers parallelize; shared writes serialize.
   - Shared mutable state: default to splitting the target (`skill://principle-separate-before-serializing-shared-state`); serialize only for a real invariant.
   - Smallest safe decomposition: when one worker is best, name why.
5. Delegate code-writing to workers with a specific scope: file paths, the named data shape from step 2, and success criteria. When the implementation admits several valid shapes (error handling, abstraction layer, test structure), run `skill://arena` instead so the runners surface the alternatives and the judge guards the pick; the lazy-change rule does not override it, because the gain is review separation, not fewer lines. Code-coupled work (one feature, one migration) goes to a single worker with the checkpoint inline.
6. Rewrite the checkpoint at every phase boundary and start a fresh owner worker per phase, with the previous result's path in its brief; never chain steering messages onto a finished worker.
7. Prove each criterion on the real surface (`verify-<app>`; `skill://verify` when none exists). Wrong-surface or inconclusive is not a pass; flag it.
8. Return the work as small, ordered commits, each unit built and verified before the next (`skill://principle-sequence-verifiable-units`). A contested design: `skill://interrogate` on the diff before shipping.
9. The main session applies the patches. A PR only when the owner asked for one (or an autopilot queue grant covers it): run `playbooks/opening-a-pr.md` from the main session.

Reply: what you built, what you chose and why, the throughput checkpoint, open decisions, in Korean plain text. Describe design alternatives in sentences; a table is for artifacts only.

Source: pstack skills/poteto-mode/playbooks/feature.md (MIT, skill://ulw/references/LICENSE-pstack).
