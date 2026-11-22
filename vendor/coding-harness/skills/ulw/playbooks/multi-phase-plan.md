### Multi-phase or multi-PR plan

**You own the plan, not the code. The plan is a checklist the main session runs box by box and the operator audits from the evidence.** The plan is the deliverable. Do not implement.

1. When the change is one or two files with an obvious approach, skip the plan. Say so and stop.
2. Settle open questions by prototype before you write. Run `playbooks/prototype.md` for each. Keep the branch, the SHA, and the artifact paths for Appendix A. Ask the operator (the `ask` tool, main session only) about a product or preference call that no run can settle. Give options (`skill://principle-never-block-on-the-human`).
3. Explore with `scout` workers (`skill://principle-guard-the-context-window`). Each returns file pointers, conventions, test commands, and entry points. No inlined dumps.
4. Copy the skeleton below into the plan file and fill every placeholder. Write `.omp/plans/<name>.md` unless the operator names a path. Keep every heading and every sub-block in the order shown. One section per PR. One PR is one change with its own evidence (`skill://principle-sequence-verifiable-units`). Name the execution playbook in **How to read this**. Pick `playbooks/autopilot-full.md` only when the operator explicitly asked for merges and granted the queue. Pick `playbooks/autopilot-stack.md` otherwise, so the operator lands the PRs. A standing program takes `playbooks/orchestrate.md`. Set the live lane count once for the whole plan. The default is 3 because lanes share one machine's ports, browsers, and disk. Raise it only when each lane gets its own port and data directory.
5. Write under `skill://technical-writing` in full, then `skill://unslop`. The body is one Diátaxis mode, how-to. Appendices hold explanation and reference. Each heading states the task or the finding. No long dashes. No mid-sentence colons. The plan is an English artifact.
6. Run `bun ~/.omp/agent/skills/ulw/scripts/check-plan.ts <plan>` and fix every line it prints (`skill://principle-encode-lessons-in-structure`). Run it again after every edit and hand the plan over only on exit 0.
7. Hand back. Post the plan path and the script's output, then stop. Execution starts on the operator's explicit go, under the execution playbook the plan names.

**Owners.** An owner is a `task` worker, isolated, one per PR. It returns a patch and its evidence. It never pushes, opens a PR, or writes to GitHub. The main session reads each patch, runs `git apply --check`, applies it, runs the check, and does every `gh` action.

**Verification.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked (`skill://principle-prove-it-works`). That sentence is the verification rule. Every verification block opens with it. The live block is mandatory. Lanes at the PR head drive the real surface through the project's `verify-<app>` skill (`skill://verify` creates it). Each lane is one box with a concrete scenario, the artifact path it saves, and its pass predicate. The artifact is a screenshot, a log, a trace, or any file a reader can open. Lane 1 is the **Regression lane against trunk.** It runs the same load-bearing scenario on trunk and head. If trunk does not have the feature, the lane records that fact and gates the behavior the diff adds plus the end state the user waits for instead of inventing a trunk result. The perf gate is dual-sided. Trunk and head must both produce the named metric. If trunk lacks the feature, also isolate the work the diff adds and set an absolute budget for that work plus the end-to-end state the user waits for. Do not claim a ratio between unlike scenarios. The perf block names the metric, the interleaved probe, the trunk baseline measured first, and the rule with the number that fails. A PR that changes an interaction is review-gated. The operator reviews it in chat with screenshots and a video before merge. A PR that changes no interaction writes `**Review gate.** None. <PR id> is not review-gated.` and no boxes under it.

**Verify skill.** Every live lane drives the surface through the project's `verify-<app>` skill. A PR that touches two surfaces gets lanes on both. A surface with no verify skill, or one that cannot be driven here (native mobile, a Tauri window), is a risk in Appendix C, and its live block still names how each lane drives it or says the lane is not drivable here.

````markdown
# <Program> plan

<Under ten lines. What changes, for whom, the rule the program enforces, and the PR ids in order.>

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, an artifact, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skill://ulw/playbooks/<execution playbook>.md`. <Who merges, and which PR ids are the operator's items that stop at merge-ready.>

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these at program start. Re-read them at every tick.
  - [ ] `skill://ulw/playbooks/<execution playbook>.md`
  - [ ] `.omp/skills/verify-<app>/SKILL.md`
  - [ ] `skill://ulw/playbooks/opening-a-pr.md`
  - [ ] `skill://<each other skill the program uses>`
- [ ] On the operator's go, arm the audit tick with the tick prompt below. In an interactive TUI main session, enter loop mode with the `loop` tool (`action: enter`) with that prompt as the `prompt`, an `iterations` or `minutes` bound, and a `condition` command that exits 0 when the Close the program boxes are checked. Where the `loop` tool is refused (any other session), run `sleep 3600` as a background bash job with `timeout: 0`, run the tick when its result arrives, then start the next job. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this tick. Probe every active worker and judge progress by side effects only. Stand down a stuck worker and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck worker and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in the decision log. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, stop every running worker at once and start no new one.

### Spawn owners

- [ ] Spawn one isolated `task` worker per PR with the lifecycle the execution playbook names. Each returns a patch and its evidence, and never pushes or opens a PR.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] <PR id> and <PR id> are independent and first. Both branch from `main`.
  - [ ] <PR id> after <PR id>.
- [ ] Hold the file boundaries. <PR id or class> touches only `<glob>`.
- [ ] Hold the review gate. <PR ids> change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] The main session runs every `gh` action. Use `gh` only. Workers never push or write to GitHub.
- [ ] Open the PR ready, never draft, per `skill://ulw/playbooks/opening-a-pr.md` with `gh pr create --base <base-branch>`. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `skill://no-comments` and `skill://unslop` before each commit.
- [ ] Triage every review-bot and security-reviewer comment per `skill://ulw/playbooks/babysit.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] A full lane run happens once, at the code-ready head. Another full run happens only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. One gates lane. The live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes with `reviewer` workers, each with its own focus, that read the diff and the receipts and distrust the PR body. The main session audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `skill://ulw/playbooks/shipping.md`.
- [ ] <The merge or handoff rule from the execution playbook, with the patch-id rule from `skill://ulw/playbooks/shipping.md`.>

### Boot recipe, for every live lane

Each live lane runs as an isolated `task` worker on this machine at the PR head. Drive through the project's `verify-<app>` skill. Give each lane its own port and data directory.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] <Start the backend and the surface. Wait for ready.>
- [ ] <Deliver input only through the verify skill's commands. Name the read-only diagnostics.>
- [ ] Save every artifact to `/tmp/<plan name>-<pr-id>/lane-<n>/<slug>.<ext>` and return the paths with the report.

## <Task as a verb phrase> (<PR id>)

**Depends on.** <PR id, or None.>

**Files.**

- [ ] Edit `<path>`.
- [ ] Create `<path>`.
- [ ] Delete `<path>`.

**Build.**

- [ ] <One change. Name the symbol and the file.>

**You see.**

- [ ] <One observable result, with the exact log line or screen state.>

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] <Test file and the case it gains.> Run `<command>`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. 3 lanes on `verify-<app>` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run <the same load-bearing scenario> at trunk and head. If trunk lacks the feature, record that and gate <the behavior the diff adds plus the end state the user waits for>. Save `<artifact path>`. Pass when <predicate>.
- [ ] Lane 2. <Scenario.> Save `<artifact path>`. Pass when <predicate>.
- [ ] Lane 3. <Scenario.> Save `<artifact path>`. Pass when <predicate>.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. <What is measured at both trunk and head. If trunk lacks the feature, also name the diff-added work and the end-to-end state the user waits for.>
- [ ] Probe. <The command or procedure, run at trunk and at the head, interleaved. Both sides must produce the metric.>
- [ ] Baseline. Record the trunk <value> first.
- [ ] Rule. <Head against trunk, with the number that fails. If the scenarios differ, add absolute budgets for the diff-added work and the user-visible end state instead of an invalid ratio.>

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane <n> screenshots into `<media path>/<pr-id>-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change running through the verify skill. Save it as `<media path>/<pr-id>-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Main's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] <The main session squash-merges the PR with gh after the operator's grant, or appends it to the base-branch stack and the operator lands it bottom-up.>

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

<Each open question a prototype answered, with the branch, the SHA, and the artifact links. Each question that stays unproven.>

## Appendix B. Alternatives rejected

<Each approach weighed and why it lost.>

## Appendix C. Risks

<Each risk with the PR it lands in and what the owner watches.>

## Appendix D. Links and reading list

<Docs to read before editing. Which PRs get `skill://interrogate`. The trail per `skill://decision-log`.>
````

**Reply:** the plan path, the PR ids with their dependencies and the review-gated set, what the prototypes proved and what stays unproven, and the check script's output, in Korean plain text.

Source: pstack skills/poteto-mode/playbooks/multi-phase-plan.md and scripts/check-plan.mjs (MIT, skill://ulw/scripts/LICENSE-pstack).
