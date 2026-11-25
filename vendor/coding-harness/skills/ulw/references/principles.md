# Principles index

Router for the 24 principle skills. Each entry names the trigger. The leaf is `skill://principle-<kebab>`.

## Rules

- Read the leaf in full before you apply a principle. Do not apply one from its trigger line alone.
- Worker briefs that need a principle name its `skill://` URL and say "read it first". Workers can read hidden skills by URL.


## Core

- [`principle-laziness-protocol`](skill://principle-laziness-protocol): Refactoring, sizing a diff, or tempted to add abstractions, layers, or signal threading. Bias to deletion and the smallest change that solves the problem.
- [`principle-foundational-thinking`](skill://principle-foundational-thinking): Before writing logic: core types and data structures, scaffold-vs-feature sequencing, what concurrent actors share.
- [`principle-redesign-from-first-principles`](skill://principle-redesign-from-first-principles): Integrating a new requirement into an existing design. Redesign as if it had been foundational from day one.
- [`principle-attack-the-premise`](skill://principle-attack-the-premise): Two or more fixes that share one premise have failed the same gate. Write the premise down and test it directly before you write another fix that assumes it.
- [`principle-subtract-before-you-add`](skill://principle-subtract-before-you-add): Sequencing an addition, refactor, or rewrite. Remove dead weight first, then build on the simpler base.
- [`principle-minimize-reader-load`](skill://principle-minimize-reader-load): Reviewing or shaping code that's hard to trace. Count layers and hidden state, collapse one-caller wrappers, shrink mutable scope.
- [`principle-outcome-oriented-execution`](skill://principle-outcome-oriented-execution): Planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture, don't preserve throwaway compatibility states.
- [`principle-experience-first`](skill://principle-experience-first): Product, UX, or feature-scope tradeoffs. Choose user delight over implementation convenience.
- [`principle-exhaust-the-design-space`](skill://principle-exhaust-the-design-space): A novel interaction or architectural decision with no precedent. Build 2-3 competing prototypes and compare before committing.
- [`principle-build-the-lever`](skill://principle-build-the-lever): Any non-trivial work. Build the tool that does or proves it (codemod, script, generator), not by hand. The tool is the artifact a reviewer reruns.

## Architecture

- [`principle-model-the-domain`](skill://principle-model-the-domain): Writing stateful logic, or code that branches a lot or repeats a shape assumption across files. Encode the domain in a structure (state machine, typed model, table or registry, reducer, boundary, the right collection) instead of scattered conditionals.
- [`principle-boundary-discipline`](skill://principle-boundary-discipline): Wiring validation, error handling, or framework adapters. Guards at system boundaries, trust internal types, keep business logic pure.
- [`principle-type-system-discipline`](skill://principle-type-system-discipline): Designing types or a signature in any typed language. Make illegal states unrepresentable, brand primitives, parse external data at boundaries.
- [`principle-make-operations-idempotent`](skill://principle-make-operations-idempotent): Designing commands, lifecycle steps, or loops that run amid crashes and retries. Converge to the same end state.
- [`principle-migrate-callers-then-delete-legacy-apis`](skill://principle-migrate-callers-then-delete-legacy-apis): Introducing a new internal API while old callers exist. Migrate and delete in one wave.
- [`principle-separate-before-serializing-shared-state`](skill://principle-separate-before-serializing-shared-state): Concurrent actors might write the same file, branch, key, or object. Eliminate the sharing first.

## Verification

- [`principle-prove-it-works`](skill://principle-prove-it-works): After a task, before declaring done. Verify against the real artifact, not a proxy or "it compiles".
- [`principle-fix-root-causes`](skill://principle-fix-root-causes): Debugging. Trace each symptom back to the first place the system went wrong and fix it there. A guard is a fix only when the state it handles is legitimate.
- [`principle-sequence-verifiable-units`](skill://principle-sequence-verifiable-units): Multi-step work (sweeps, migrations, runs of similar edits) and how you stack commits and PRs. Small units that each end in a check, verified before the next.
- [`principle-test-behavior-not-implementation`](skill://principle-test-behavior-not-implementation): Writing, changing, or keeping a test. Assert what the code's users can observe, so the test fails when that behavior breaks and keeps passing when only the internals change.
- [`principle-explain-the-number`](skill://principle-explain-the-number): Before you measure, and before you trust, report, or act on a number you measured. Find what limits it, and rule out that it measured something other than the work you think.

## Delegation

- [`principle-guard-the-context-window`](skill://principle-guard-the-context-window): Context fills up: large outputs, long files, repeated reads, fan-out planning. Route bulk to workers, keep summaries in the main thread.
- [`principle-never-block-on-the-human`](skill://principle-never-block-on-the-human): Tempted to ask "should I do X?" on reversible work. Proceed, present the result, let the owner course-correct.

## Meta

- [`principle-encode-lessons-in-structure`](skill://principle-encode-lessons-in-structure): You catch yourself writing the same instruction a second time. Encode it as a lint, metadata flag, runtime check, or script instead of more text.

Source: pstack skills/poteto-mode/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
