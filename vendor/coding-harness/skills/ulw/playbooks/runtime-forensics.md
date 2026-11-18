Diagnose a live process by instrumenting it, not by theorizing from source. The deliverable is a cited diagnosis, not a fix. Compare `skill://perf` section 3 for the artifact table; this playbook adds the live-instrumentation steps.

1. Capture the live signal on the matching surface, a real artifact, not a guess:
   - Web page or Electron renderer: the project's `verify-<app>` skill (`skill://verify` creates it) or `aside repl` (`aside guide` first) for a CDP performance trace, `performance.getEntriesByType`, or a heap snapshot. Electron launched with `--remote-debugging-port=<free port>` attaches over CDP. Surface not drivable here (native mobile, a Tauri window beyond its web layer): say so and stop on that surface.
   - Node or bun process: `node --cpu-prof` / `--heap-prof`, `--inspect` or `bun --inspect` with a CDP client.
   - Any macOS process: `sample <pid> 10 -file <path>` for a spin, `spindump <pid>` for a hang, `leaks <pid>` / `heap <pid>` / `vmmap <pid>` for memory, `fs_usage -w -f filesys <pid>` for file activity, `lsof -p <pid>` for handles, `top -pid <pid>` for trend. `dtruss` and `dtrace` need SIP off; do not rely on them.
2. Reduce the artifact to the smoking gun: the hot-path function, the retainer chain from the leaked object to a GC root, the loop firing without input. Main spawns a `task` worker to parse large artifacts (brief: artifact path, the question, a final answer under ~800 characters, `skill://principle-guard-the-context-window`) and keeps only the reduced finding. For an artifact you did not capture, go to `playbooks/trace-forensics.md` instead.
3. Prove the mechanism before believing it. Inject instrumentation into the running process through CDP eval (`aside repl` evaluate, or the inspector session) or hotfix the live code without reloading, to confirm the hypothesis cheaply. Restore the process afterwards; kill only pids this run started, never by process name.
4. Map the finding back to source: file, symbol, the line that allocates or schedules.
5. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only forensics`.

Reply (Korean, plain text): the signal captured, the reduced finding, how the mechanism was proven, the source location, artifact paths. No fix unless asked. Hand back to Bug fix or `skill://perf` once the cause is known.

Source: pstack skills/poteto-mode/playbooks/runtime-forensics.md (MIT, skill://ulw/references/LICENSE-pstack).
