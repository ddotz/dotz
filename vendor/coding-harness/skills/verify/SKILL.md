---
name: verify
disable-model-invocation: true
description: "Create or maintain a project's verify-<app> skill: launch, doctor, drive, evidence and cleanup recipes plus a feature map, so agents prove UI and app behavior on the real surface instead of the user checking by eye. Entered from ulw when a change touches a user-visible surface and the repo has no .omp/skills/verify-*/, or when that skill fails or drifts."
---

Two modes. CREATE when the repo has no `.omp/skills/verify-*/`. MAINTAIN when it has one and a drive failed, a recipe drifted, or features changed since their `last-proven` commit.

The output is read cold by a future agent. Every recipe must be runnable as written.

## Surfaces on this machine

| Surface | Drive | Proof | Status |
|---|---|---|---|
| Web (any dev server) | `aside repl --file <script.js>`: `openTab(url)`, `snapshot(page,{interactive:true})`, locator actions by ARIA role/name, `page.setViewportSize` | snapshot `diff` after each action + `page.screenshot({path})`; each changed screen also opened cold (fresh tab, first open, no prior state) at 390 px and 1280 px wide, one screenshot per width | drivable |
| Existing project harness (Playwright, component runners, CLI tests) | the project's own command | its output plus a screenshot or artifact it writes | drivable; prefer it when it exists |
| CLI / TUI | one tmux session per drive (`tmux new -d`, `send-keys`, `capture-pane -p`) | captured pane text | drivable |
| HTTP service | `curl` against the launched instance | response + side effect (row, file) | drivable |
| Electron | launch with `--remote-debugging-port=<free port>`, attach over CDP | as web | untested here: prove once before relying |
| Tauri (macOS WKWebView) | web layer only, through the Vite dev URL in `aside repl`; native commands absent | as web, labelled `partial: web layer only` | partial |
| Native iOS / Android | none (no simulator devices, no adb/idb/maestro) | none | `not drivable here` |

A surface marked partial or not drivable is reported as such. Never pass it off as verified through another path.

## CREATE

1. Interview the repo from code; ask the user only what code cannot show (credentials, which features matter most). Five answers:
   - Surface: which rows of the table apply.
   - Run: the dev command and port; package manager from the lockfile (run the project's own scripts; do not reinstall with another manager).
   - Drive: existing harnesses first (`tests/*`, Playwright configs, scripts that open a browser); the generic recipe second.
   - Observe: what proves each feature (visible state, file, DB row, log line).
   - Isolate: can two instances run side by side (port, data dir, lock files)? If not, the skill must say "single instance: never drive a shared instance from two agents".
2. Refuse to generate against a broken checkout: run the dev command once; if it fails for reasons unrelated to verification, stop and report. Exception: an irrelevant missing asset that blocks startup (a static dir the app never serves, a sample config) may be created by the generated Launch step, named there as verification scaffolding, and removed by its Cleanup.
3. Write `<repo>/.omp/skills/verify-<app>/`:
   - `SKILL.md` with frontmatter `name: verify-<app>`, a trigger description ("Use to prove any change to <app>'s UI or behavior ..."), and sections:
     - Launch: command, free-port choice, empty disposable data dir keyed by a run id, seed data, readiness = usable (the first screen renders), not just "port answers".
     - Doctor: read-only check that the running instance is ours and worth driving (port owned by the pid we started, URL, build revision, auth state).
     - Drive: the harness invocation with one worked example.
     - Evidence: where artifacts go (`.omp/verify/runs/<run-id>/<feature>/`), what each proof must contain (action + resulting state, side effects, app identity visible in the screenshot), and the rule that an agent runs the driver and never writes or edits a `manifest.json` or an artifact by hand. Run the driver after the last edit and commit of the feature's files: an edit made after the driver ran makes its manifest stale. When the safe path is a dry-run or test mode, the recipe checks what it really skips by observing files, network and git refs, not by trusting its name.
     - Cleanup: kill only the pids this run started (never by process name); never delete evidence.
     - Surfaces: each surface's status from the table above, with "not drivable here" written out where it applies.
   - `features/README.md`, the index: baseline preconditions, driving conventions, proof and skip reporting, the feature entry contract, and one link per feature. Shape: `skill://verify/references/feature-map-example/` (index plus two feature files).
   - `features/<id>.md` for the top 1-3 features only, each with a first line `last-proven: <commit>`, an H1 and one paragraph of user-visible behavior, then exactly four sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, `Gotchas`. A seed that lacks a journey's precondition makes the journey report a failure with the reason in `Gotchas`; never weaken the journey to pass.
   - `scripts/` helpers (launch/doctor/cleanup) when the recipe is more than one command; executable, invocation shown in SKILL.md. The driver script (for example `scripts/drive.sh <feature> <run-id>`) is the only thing that writes a run's `manifest.json`: after it captures the artifacts into `.omp/verify/runs/<run-id>/`, its last step is `bun ~/.omp/agent/harness/gate/evidence.ts manifest --repo <repo> --feature <id> --driver <repo-relative path of the driver> --command "<how it was invoked>" --run <run dir> <artifact path relative to the run dir>[:<kind>]...`, which computes `tree` and the sha256 values, writes `manifest.json`, and exits non-zero naming any artifact that does not check out; the agent never runs that `manifest` command itself. `bun ~/.omp/agent/harness/gate/evidence.ts tree --repo <repo> --feature <id>` prints the current `tree`.
4. Write the two project rules (copy from `skill://verify/rules/`, replacing `<app>` and the UI globs with this repo's real extensions and paths):
   - `<repo>/.omp/rules/verify-ui-edit.md`: fires on edits to UI files.
   - `<repo>/.omp/rules/verify-test-edit.md`: fires on edits to test files.
5. Add `.omp/verify/runs/` to the repo's `.gitignore`. A repo without `<repo>/.omp/gate.json` gets one only from `bun ~/.omp/agent/harness/gate/bootstrap.ts <repo>`: run it first and never write `.omp/gate.json` by hand. Then add the evidence entry to that file, keeping its existing entries: `{ "name": "ui", "paths": [<the UI globs of the rule above>], "dir": ".omp/verify/runs" }` under `evidence`. A gate file that is neither committed nor exactly what the script wrote is refused once per run that changes source, so say in the reply that the user has to commit the edited `.omp/gate.json`.
   Write `<repo>/.omp/verify/features.json`, the machine-readable feature map the gate reads: `[{ "id": "<feature>", "paths": [<globs of the files the feature lives in>], "proof": "screenshot|video|log|db" }]`, one entry per feature, `id` equal to the `features/<id>.md` name. Every UI file the evidence entry's `paths` match must lie in some entry's `paths`; the gate refuses a changed file that matches the evidence entry but no feature, naming the missing entry. Commit it with the skill.
   The done gate then refuses to finish a run that changed a feature's files unless some `manifest.json` under `.omp/verify/runs/` names that feature, carries the content fingerprint (`tree`) of the feature's files as they are now, lists artifacts whose sha256 matches and whose bytes are what their `kind` says (a PNG with an IHDR chunk of nonzero width and height, or a JPEG with an SOF0/SOF2 frame of nonzero size, for `screenshot`; WebM/MP4 for `video`; non-empty UTF-8 for `log`; a SQLite file or non-empty UTF-8 for `db`; at least one of the feature's `proof` kind), and names as `driver` a script under `.omp/skills/verify-*/`. It also refuses a `features.json` that, against the session base, lowers a feature's proof from `screenshot`/`video` to `log`/`db`, drops a feature or narrows its paths, or adds a log/db-only feature over changed UI files. File times are not read for manifests. A `waiver-<slug>.md` in that directory, newer than the changed files and stating why the surface cannot be driven, is the only substitute; it is logged and shown to the user.
6. Prove it: launch, doctor, drive ONE feature end to end, capture, cleanup; then check that the evidence still exists and the launched processes are gone. Run cleanup after every failed attempt too. Stamp that feature's `last-proven` with the current commit. Proved in a stand-in for the real target (a container instead of a fresh VM, a local stack instead of a remote one): list every setup step the stand-in did that the target will not; those stay unverified until a run on the real target.
7. Reply: the skill path, the surfaces table for this repo, the proven feature with its evidence paths, and what is partial or not drivable.

## MAINTAIN

1. Index hygiene: read `features/README.md` and list its sibling files; fix missing, extra, duplicate or dead entries, and keep `.omp/verify/features.json` in step.
2. Source wave: list features whose `last-proven` commit is older than the latest change to the files they cover (`git log -1 --format=%h -- <paths>`). Only those get re-driven; the rest stay as they are. Spawn one `scout` per stale feature, all at once: each explains how the feature works from source, cites likely drift, and returns one live recipe (summary / entry points / drift or none / recipe). Scouts never drive the app or edit files. Then sweep commits since the oldest stamp for user-facing surfaces missing from the map; call one missing only with a concrete source path.
3. Doctor before the first drive and after any failed drive. A wedged instance gets reset (cleanup + launch), not retried.
4. Drive each stale feature through its recipe, merging overlapping recipes into as few app states as practical. Triage each failure:
   - doc drift (the map describes the UI wrongly) -> fix the feature file;
   - harness gap (the feature works but the recipe cannot drive it) -> fix the helper and re-drive it live before saving;
   - product gap (the feature is broken) -> report it to the user; do not edit product code or weaken the recipe.
5. A feature that cannot be reached is `verified-unreachable` only with the concrete prerequisite and the route attempted written down.
6. Edit scope: the verify skill directory and `<repo>/.omp/verify/features.json` (keep it in step with `features/`: a new, renamed or moved feature changes its entry). Outcome is one of: clean, changed (list the files), blocked (say what).

## Rules

- Real user path, never internal setters or injected state. Mocks only at an existing production boundary.
- No baseline, no claim: a "before" capture is required to claim a change; the symptom of a bug must be seen twice through the real UI before a fix counts as proven.
- A toast or a green test is not proof of the visible result. Capture the resulting state.
- Layout or styling changes also run `skill://visual-diff`.
- A web or terminal app with many screens: after the feature drives pass, run `skill://bombadil` against the same isolated instance for a short time budget; it explores sequences no recipe covers. Record its run command in the generated skill's Evidence section.
