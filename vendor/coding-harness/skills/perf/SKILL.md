---
name: perf
disable-model-invocation: true
description: "Measure-first performance work: diagnose a slowdown, leak, or CPU spin with a real artifact, fix cheapest-first, and report baseline, after, and delta with run counts. Also vets any speed or size number before it is claimed. Entered from ulw on speed, memory, bundle-size, or startup work."
---

No number from reading code. Every claim comes from a run.

## 1. Define

- Workload that reproduces the complaint (route, interaction, CLI input). None reproduces: fix the repro first.
- Metric, direction, target. Write down before measuring what result would count as "no difference".
- Harness: the end-to-end path a user waits on (cold start, route render, query). Micro results are reported as a share of it.

## 2. Baseline

- Release-like build (Tauri/Electron dev builds are far slower; say which you measured). Simulator timing is not device timing.
- At least 5 runs per side, alternating A,B,A,B; report median and range. A gap smaller than run-to-run spread is no difference.
- Check the work happened inside the timed region (awaited promises, the route actually rendered, the error count is zero). Print the error count and a count of work done.
- Check `uptime`; on a busy or hot machine say so.

## 3. Diagnose when the cause is unknown

| Symptom | Artifact |
|---|---|
| Slow interaction or render (web, Electron) | CDP performance trace / `performance.getEntriesByType` through `aside repl` |
| CPU spin | CPU profile (`node --cpu-prof`, `bun --inspect`, macOS `sample <pid>`) |
| Memory growth | two heap snapshots, compare the retainer chain to a GC root |
| Slow Rust command (Tauri) | timing around the command, `cargo bench`/criterion for the hot function |

Parse large artifacts in a worker and keep only the reduced finding (hot function, retainer chain) with its `file:line`. Prove the mechanism with a targeted measurement before fixing.

## 4. Fix, cheapest first

Try in this order and stop at the first that meets the target: don't do it; don't do it twice (cache, dedupe); do less; do it later; do it off the user's path; do it concurrently; do it cheaper.

One change, one measurement. Keep it only if the metric moves past the noise and the tests stay green; otherwise revert it fully. Never stack untested changes. For a long loop of attempts, turn on `skill://decision-log` (columns: hypothesis, change, before, after, delta, tests, verdict).

## 5. Report

Verdict first: faster, slower, no measurable difference, or inconclusive (when the limiter is unnamed, a side ran untuned, or errors and work-done were not checked). Then baseline, after, delta with unit, run count, range, and the artifact path. One run = say "one run".
