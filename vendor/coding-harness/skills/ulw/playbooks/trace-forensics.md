Diagnose from an artifact that already exists (cpuprofile, `.json.gz` trace, heapsnapshot, spindump, sample output). The artifact is a fixed dataset: read it, do not re-run it. For a live process use `playbooks/runtime-forensics.md`.

1. Identify the format and load it with the right tool: DevTools-style trace parsing for cpuprofile and `.json.gz`, plain text reading for `sample`/spindump output, heap tooling for a heapsnapshot. Main spawns a `task` worker to parse a large artifact (brief: artifact path, the question, final answer under ~800 characters; `skill://principle-guard-the-context-window`) and keeps only the reduced finding.
2. Sqlite-ify the artifact before reading it: dump it into a sqlite database, one row per sample, frame, node, or edge (a short bun script with `bun:sqlite`; delete it after use unless the owner wants it). Reach the queryable shape first; do not page through raw JSON.
3. Narrow to the cause by query. Frames holding the most self and total time, then the call tree down to the hot path. For a leak, follow the retainer chain from the leaked object to a GC root. For a spindump or `sample`, find the thread stuck on-CPU or blocked and its wait reason.
4. Attribute to source: map the hot frame to file, symbol, and line through the artifact's own symbols or its source maps. A frame with no source mapping is not a diagnosis. Resolve the symbols, or say plainly that the artifact does not carry them.
5. Paired capture (before and after, good and bad): diff the two databases to confirm. Unpaired capture: label the finding the strongest hypothesis the artifact supports, not a confirmed cause, and name the capture that would confirm it.
6. Hand back a cited diagnosis; no fix unless asked. Route to Bug fix or `skill://perf` once the cause is known. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only forensics`.

Reply (Korean, plain text): the artifact and format, the reduced finding, the source location, the artifact and database paths, and whether a paired capture confirmed it or it is a hypothesis.

Source: pstack skills/poteto-mode/playbooks/trace-forensics.md (MIT, skill://ulw/references/LICENSE-pstack).
