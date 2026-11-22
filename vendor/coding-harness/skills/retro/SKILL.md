---
name: retro
disable-model-invocation: true
description: "After a session, mine its transcript for durable lessons and route each one to a concrete skill or rule edit, through three review lenses and a synthesizer. Use for /skill:retro, 'what did we learn', or after a long session with corrections, reverts, or manual hand-offs. Not the memory reflect tool."
---

Mine one session for lessons that survive code drift, then route each into a skill or rule. Skip a trivial or off-topic session, and a session where a skill was followed correctly. One-offs are not lessons.

The main session coordinates. Workers never spawn, so the three reviewers and the synthesizer are separate `task` calls from here.

## 1. Locate the transcript

Find this session in `history://` (bare lists registered sessions; read `history://<id>`). Reviewers get the id, not the content. Do not read other projects' sessions. If no session matches, pass a tight digest of the conversation instead: goals, corrections received, reverts, tools and flags discovered.

## 2. Three reviewers in parallel

One `task` batch, three workers, each brief with an Acceptance line. Each brief names its template to read first (`skill://retro/references/<lens>-reviewer.md`), the transcript id (or digest), and the output file `local://retro-<lens>.md`. The final answer is the path plus the finding count, never the findings.

| Lens | Template | Agent and tier |
|---|---|---|
| Judgment | `judgment-reviewer.md` | `reviewer` (base) |
| Tooling | `tooling-reviewer.md` | `scout` (worker tier) |
| Divergent | `divergent-reviewer.md` | `reviewer` (base) |

Tiers come from the model-tiers extension. Never write a model name. Deep tier is not used: a retro is not a one-way door.

## 3. Synthesize

One more `task`, agent `reviewer`, brief naming `skill://retro/references/synthesizer.md` and the three `local://retro-*.md` files. It writes Accepted, Rejected, and Backlog to `local://retro-synthesis.md`.

## 4. Structure over prose

Every Accepted lesson goes through `skill://correct` first. Move an item to Backlog when a config line, guard, done-gate class, lint rule, test, or script would enforce it more reliably than prose. Prose in a skill is for judgment no check can decide. A mistake that can recur and has no check yet is recorded with the `mistake` tool.

## 5. Apply, after the owner confirms

Show the full Accepted, Rejected, Backlog output and the destination file of each Accepted row. Wait for the owner's confirmation before any skill edit. Skills affect every future session. Never auto-apply, never push, never open a PR.

After confirmation:

- Trivial edit (a bullet, a tightened sentence, a stale fact): the main session edits it directly.
- Substantive edit (a new section, more than about 10 lines): follow `ulw/playbooks/authoring-a-skill.md`.
- `tune description: <skill>` (the skill existed but did not trigger): rewrite the description to front-load the trigger words.
- `new skill: <kebab-name>`: only when no existing skill is a real home and the pattern recurs.

Edit the source in the harness repo, never an installed copy. Validate every touched skill with `omp skill list --json`.

Backlog items go to `.omp/backlog.md` of the repo, one line each: pattern, what was hit, suggested mechanism.

## 6. Reply

Short list, no preamble: edits applied (path and one line each), new skills (rare), Backlog written, Dropped with the synthesizer's reason.

Source: pstack skills/reflect/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
