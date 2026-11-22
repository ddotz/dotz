Stop cleanly and leave a checkpoint a cold-start session can resume from. Explicit request only: "keep going", "going to bed, keep going" and "don't stop" are not a pause. The procedure is the Pause section of `skill://pause`.

1. Run `skill://pause` Pause steps 1 to 3: confirm the trigger is explicit, finish or back out of the current atomic step and start nothing new, cancel running workers and record what each was doing, take no irreversible action (no push, PR, deploy or message).
2. Make the work durable: commit uncommitted edits with the eval `commit` namespace as `wip: <step>` (body says so when the tree is red), or list the changed paths when you do not own the branch.
3. Write the resume note to `<repo>/.omp/resume.md` (no repo: `local://resume.md`) in the shape `skill://pause` step 5 gives. Point at an existing plan or decision log instead of copying it.

Reply: in Korean, plain text: where you are in the work, what is on disk vs only in the conversation (paths, no diff dumps), the commits made and whether the tree is clean, and the first action on resume. This is a pause, not a final report.

Source: pstack skills/poteto-mode/playbooks/pause-safely.md (MIT, skill://ulw/references/LICENSE-pstack).
