---
name: formal-verify
disable-model-invocation: true
description: "Create or maintain a project's formal check of its riskiest promise (no double charge, one lease owner, writes serialized, resume never loses data): a TLA+ model for ordering and concurrency, a code-level verifier or generated-input tests on the real code, left as a project skill with a coverage record. Entered from ulw on HEAVY work touching concurrency, retries, locks, sync, or state machines, and after merges that touched verified code."
---

A test checks the cases someone thought to write. A formal check covers every case in a stated scope: every order of steps in a model, every input up to a bound, or every input. The owner must be able to trust the result without learning the verification language.

Two modes. CREATE when the repo has no `.omp/skills/formal-*/`. MAINTAIN when it has one and code it covers changed since its `last-confirmed` commit.

## CREATE

1. Choose the promise from the code. Ask the owner only what you cannot observe; start at the area or bug they named. Pick the promise whose break hurts users most and that tests rarely reach (interleavings, crash mid-write, retry after timeout, two owners), not the easiest one to check. Write it in the user's words.
2. Pick the tool by the question. The cheapest tool that answers it wins; tell the owner why you chose it.
   - ordering, interleaving, crash points, ownership handover: TLA+ model checked with TLC through `skill://statechart`. This is the default for ordering, in any language;
   - per-input behavior of a function (parsers, merge rules, migrations): generated-input tests on the real code through `skill://pbt` (fast-check for TS, proptest for Rust); stateful sequences use fast-check `commands` or proptest state machines;
   - memory safety, overflow, or a data-structure invariant in Rust code: Kani, which checks the real code. Install on demand: `cargo install --locked kani-verifier && cargo kani setup`. Write the check as a `#[kani::proof]` harness over `kani::any()` inputs and run `cargo kani`. Bound loops explicitly and report the bound;
   - a property that must hold at every size, where a bound is not enough: Lean 4, only then. Install on demand: `brew install elan-init`. It costs a proof, so it is the last choice.
   Install a tool only when the question needs it, and tell the owner what you installed. Prefer a tool the repo's developers can install and run.
3. Quality gates, all required:
   - True to the code: every model variable and action cites the `file:line` it stands for. One indivisible step in code is one action, never split or merged. Names come from this repo.
   - Able to fail: break the real code (or the model's guard) on purpose, such as removing a check or reordering a step, show the check failing, then revert. A check never seen failing proves nothing.
   - Findings stay findings: never weaken a property or the model to make it pass; never change product code unasked. A violation is replayed against the real code (a test or a live repro) before it is called a bug, and reported with the counterexample in the code's words.
   - Honest scope: list what is verified, under which bounds and assumptions, and what the model leaves out (actors, failure kinds). A pass covers the model or the bound, not the whole system.
   - Readable without the tool: state the property and the harm in one plain sentence each. Tell a counterexample as a short sequence of steps in the code's words.
   - Cheap to rerun: one command, pinned tool versions, a run short enough to use on every relevant change.
   - Kept in step: record which files and functions each check covers and the commit where the verification was last confirmed to describe them.
4. Write `<repo>/.omp/skills/formal-<promise>/SKILL.md`. It needs frontmatter naming the area and saying when to use it (without it the skill never registers). It holds the promise, the run command, what each property means, the scope list, and a coverage record with `last-confirmed: <commit>`. From it alone the next agent must be able to tell whether a change touches verified code, run the check, tell a real bug from a modeling error, and update the verification when a change is intended. Use the repo's real commands and nouns, no placeholders. Tell the next agent to move `last-confirmed` only after confirming the verification describes the code at the new commit. For a TLA+ check, tell it to read every result with `skill://statechart`; refer to it by name and copy none of its commands or paths, they change.
5. Prove the handoff: follow the new skill cold, as the next agent would, on a scratch change that breaks the promise in real code. It must catch it. Drop the scratch change and confirm the baseline is back where it started. A verify skill that was never run is a draft. If it misses the break or a step does not run, fix the skill or the verification, not the scratch change.
6. Hand off: what you verified, which tool and why, the bounds, what the check found in plain words, how to run it, what it does not cover. Suggest a second target only if a close one exists.

## MAINTAIN

A check keeps passing while describing code that no longer exists: that pass looks like a proof and is the dangerous case. The project skill handles changes made while using it. This mode handles changes that skipped it: merges, edits made without the skill, drift across many commits.

Give each check one outcome: in sync (no change alters what it describes, passes); updated (code changed, the verification now describes it, passes); bug (the verification describes the current code and the code breaks the property, which is a finding, not drift); blocked (could not be brought in line or could not run: say why). A check can be updated and bug.

Edit only verification files (models, harnesses, property files, the verify skill itself). Never product code unless the owner asks. Never weaken a property or model to pass.

1. Find the checks. A verify skill has no fixed name: find project skills that run a model checker, prover, or code-level verifier against named code. For each, collect the property, covered code, bounds, assumptions, run command, and sync commit. No verify skill: stop and use CREATE. No recorded sync commit: use the last commit that changed the verification files, and say so.
2. Run it as it is and record the result. A pass only means the old description still holds. A failure here can be drift or a bug: do not decide yet.
3. Read every change to covered code: `git log <last-confirmed>..HEAD -- <covered files>` and each commit message. Also look for code that moved (a covered function renamed, split, or moved is still covered) and new code that writes the state a check guards. Classify each change:
   - no effect: formatting, comments, paths the verification does not cover. Check against the model or harness, not the commit message;
   - the verification no longer describes the code: a step became two, a branch added or removed, a check moved, a new path reaches the guarded state, a value has a new range;
   - the promise changed on purpose: cite the evidence (doc comment, tests, changelog, commit message);
   - the promise may be broken: no evidence it changed. A failure that follows is a bug candidate.
4. Update from the code, not from the result. Each changed part must again point to code a reviewer can open, one indivisible step in code staying one step in the verification. Write the update before rerunning. Change a property only for a promise that changed on purpose, recording old wording, new wording, and evidence. Keep the bounds unless the change makes them wrong; report any reduction.
5. Rerun and judge each result.
   - Pass: it may now pass on a description that lost the ability to fail. Break the new code the way the property guards against and confirm the check catches it. Then drop the break.
   - Fail: replay the counterexample against the real code, step by step. A step that cannot happen means the verification is wrong: fix it and say what was wrong. Every step possible means a bug: name the commit that introduced it, tell the counterexample in the code's words, state the harm in one sentence. A cheap test or repro on the real code is evidence for the report, not a commit to product code.
6. Update the verify skill: covered code, commands, bounds, assumptions, and `last-confirmed` set to the commit you checked. Do not advance it for a blocked check; say so. Then follow the skill once as the next agent would.
7. Commit the verification updates separately from any product fix.

Reply: per check, the outcome and the commits read; what changed in the verification and why; the rerun result and the break that showed it can still fail; each bug (counterexample, harm, introducing commit); what is still out of scope, including new code it should cover. Say outright which failures were drift and which were bugs. A check that passed before the update and fails after had a stale pass.

Source: pstack skills/create-formal-verification-skill/SKILL.md and skills/maintain-formal-verification-skill/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
