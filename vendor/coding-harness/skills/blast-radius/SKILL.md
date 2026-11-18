---
name: blast-radius
disable-model-invocation: true
description: "Before changing a shared symbol, persisted shape, IPC contract, or config, or when reviewing a small diff you do not trust, find what it could break somewhere else and prove the one or two facts it is safe because of by running real code. Entered from ulw before touching shared contracts, or when a change is not trusted."
---

Listing callers is grep's job. This finds the breakage grep does not show, and proves it.

A writeup that sounds right proves nothing: it reads as convincing whether or not it is true. Do not hand back the writeup alone. Find the one or two facts the whole thing depends on and prove them by running code.

## How sure are you

For each fact the change's safety depends on, get it as far down this ladder as is cheap, and say where it stopped.

1. You said so. Worthless alone.
2. You pointed at the line: a real `file:line`, or the library's own source.
3. You showed the bad case cannot happen: you walked the failure step by step and it never reaches.
4. You ran it: a script or test that calls the real code and fails loudly if you are wrong. Usually one small script that imports the same library the app ships and calls the exact function you worry about.
5. You reproduced it in the running app (through the project verify skill).

## Steps

1. Read the change: the diff, the symbols it adds, changes, and deletes, and what it now does differently, including the part the diff does not spell out. Read the PR description and its commits too.
2. Say what the change does in one sentence.
3. Name the fact it is safe because of ("this field is only read by the settings screen", "this call only drops already-dead cache entries", "old rows are migrated on open"). Most risky-looking changes are safe because of one fact; if it holds, most risky cases clear at once. If safety rests on two independent facts, name both. Spend the effort here, not on a long list of maybes.
4. Look where grep stops:
   - the source of every library you call, at the pinned version and with any local patch (read `node_modules` or `Cargo` source, not the docs);
   - when things run: microtasks, effects, unmount and teardown, framework differences (Solid versus React), races on startup;
   - persisted data: localStorage, IndexedDB, SQLite rows and columns, files and settings written by older versions;
   - wire formats: the JSON an API returns, field casing, Tauri command args (camelCase in TS versus Rust serde names), Electron IPC channels, HTTP APIs;
   - the same bytes read by another language or process;
   - feature flags, environment and OS-version branches, code three hops downstream.
5. Be honest about each risk. Give it a real chance of happening and a real cost if it does. Keep confirmed risks and cleared ones apart. Cite a real `file:line`. A search that finds nothing is still an answer. Never invent a caller or an API.
6. Prove the one fact: write a script or test that runs the real code, run it, and keep the output.
7. For a big or wide change, run the question as an `arena` so different tiers of reviewer answer it and the answers merge. Different seats catch different real bugs.

## Hand back

- What it does: what changed, including the part that is not obvious.
- The fact it is safe because of: state it, say which rung of the ladder you got it to, and show the proof (command and output). If you could not prove it, write unproven.
- Risks: each names how it breaks, `file:line`, how likely and how bad, and how to check. Paste the proof for the ones that matter.
- Cleared: what you checked and found safe.
- Before merging: the cheapest test or repro that catches the real bug, including the script you wrote.

Cite real code and strip anything private before it goes anywhere public.

Source: pstack skills/blast-radius/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
