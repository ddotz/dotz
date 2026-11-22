Blinded A/B of a skill or rule change on omp. Main owns the experiment design: frame, blind, run, grade, synthesize. For the routing regression set (does a prompt reach the right skill) use the runner `agent/harness/evals/run.ts`: `bun agent/harness/evals/run.ts --list`, `--case <id>`, or `--all`. This playbook is for judging whether a variant changes behavior.

Blinding, non-negotiable:

- None of `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, `arena` appears in any directory name, file name, file content, or prompt the run sees.
- The prompt reads like an organic user request: the goal, not the meta.
- No chain-eliciting cues. Never ask the run to list which skills, principles, or files it used. Ask for design notes generally; grade chain-following from what it actually read, never from its own claims.
- Directory and slug names are project-shaped, something a user might pick.
- Do not tell a run that other runs exist.
- The judge may know it is judging but sees outputs only under neutral labels (A, B), never a tier or run id.
- Two variants: one judge scores both sets in a single pass on one scale, blind to which set came from which variant.

Steps:

1. Frame. State the variant under test (a skill or rule diff against the current one) and what behavior counts as success. Write the rubric, 3 to 6 concrete criteria, for the judge only. Hold it back from every run.
2. Set up scratch repos. One per run, under a sanitized path (`/tmp/<project-shaped-name>-<n>`), a copy of a realistic project skeleton, with the variant installed the way a real session would find it (the changed skill or rule in that repo's `.omp/skills/` or `AGENTS.md`, or an isolated `--profile`/agent dir when the change is to the global harness). The control copy gets the current version. Plant the context an organic task would have; keep meta words out of it.
3. Write one organic prompt: what a user would type. No leakage of what is measured.
4. Run N candidates as `omp -p "<prompt>" --cwd <scratch repo>` (add `--session-dir <dir>` to keep the session files findable; do not pass `--no-session`), N per variant, same prompt, launched in parallel as background bash jobs. Diversity is by tier, not vendor (only one vendor is available): vary the model tier per the Fan out phase of `skill://arena`; only `--model` sets a run's model, taken from the owner's configured roles, and a model name is never written into a skill or brief. Pick effort per job. The runs are the owner's own `omp` processes, not `task` workers, so main launches them; workers never spawn.
5. One blinded judge: a `reviewer` worker (a different tier than the runs where possible and never one that authored the variant), per the Judge phase of `skill://arena`. It gets the rubric, the task, and each run's output diff or files under labels A, B, C, with no tier or variant names. Use `deep-reviewer` only when the verdict is a one-way door.
6. Verify the chain from session files, not self-report. Read each run's session under `~/.omp/agent/sessions/` (or the `--session-dir` used), or `history://<id>` for registered agents: which files it opened, which `skill://` URLs it read, in what order. Stay inside the sessions this experiment created; do not glob across unrelated projects' sessions. Grade chain-following from the files actually read plus the shape of the code, never from the run's claims.
7. Read every run's output end to end yourself. Compare with the judge's verdict. Disagreement means the judge is biased or the rubric is ambiguous; name which criterion decides it. Synthesize. Delete the scratch repos afterwards.

Reply (Korean, plain text): the variant under test, the rubric, per-run notes, the judge's verdict, your synthesis, and a recommendation on whether to promote the variant (and the router or rule edit that follows).

Source: pstack skills/poteto-mode/playbooks/eval.md (MIT, skill://ulw/references/LICENSE-pstack).
