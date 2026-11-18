---
name: no-comments
disable-model-invocation: true
description: "Semantic review pass over the comments in a diff: spawn the comment-sicko agent, apply accepted findings, and offer encodings for claimed constraints. ulw enters it before review or ship when the diff keeps or touches comments."
---

# No comments

The done gate already refuses new comments and suppressions on the lines a session adds. It cannot judge the comments already in the diff or the ones the gate lets through: a `why(...)` that is not about foreign code, a workaround sermon, a "do not remove" with no proof. This skill is that semantic pass. The main session runs it. Comment Sicko reviews and reports; it has read, grep, and glob only. The main session applies the deletions.

Defer to Comment Sicko's fresh perspective.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Spawn one `task` with `agent: "comment-sicko"`. The brief names the scope (exact file paths or the diff command), and ends with an Acceptance line: "Done when the report lists every comment in scope as kill, MUST KILL, or keep with its exception." The agent is already read-only, so no isolation is needed.
2. Inspect its report against the code. Reject a flag that treats kept intentional code as guilty, a `MUST KILL` with a misstated reason, a flag outside the scope, and a keep that has no proof. Audit what it missed: scoped lint and TypeScript suppressions. A suppression of a correctness or safety rule is an actionable `MUST KILL`. Before accepting a thin `IMPORTANT` or `do not remove` verdict, either way, trace the symbol or follow `skill://why`. If a kill is ambiguous, delete the comment anyway when the exception cannot be proven. A keep survives only with proof that it is about something we cannot change. Reshape flags on surprises in our own code stay actionable. Do not restore those comments. If a rejection needs a second look, spawn one new `comment-sicko` on only that part. Do not send the first one more work.
3. Delete the accepted comments yourself, and fix the trivial flags directly: delete a dead path, drop a parameter, use the real API. If a fix needs a shape, run `skill://architect` once for the accepted set and the surrounding code, and stop at the sketch. Architect shapes; step 4 implements.
4. Make the smallest root-cause fix in scope. Remove every workaround a flag names. If the root cause is out of scope, land the smallest in-scope fix and report the rest as open. `skill://principle-fix-root-causes` and `skill://principle-redesign-from-first-principles` guide intent only. Neither widens the scope or authorizes fixing instances outside it. Never add a symptom guard.
5. A constraint comment says `do not remove`, `do not change wording`, or `talk to X before changing`. Leave the ones about things we cannot change, written as a `why(...)` with a reference. For the rest, offer the cheapest in-scope encoding: a type, a runtime check, a test, or a CI lint. Ask the owner with the `ask` tool when the run is interactive. An unattended run needs a pre-approval from the caller. If approved, encode the constraint, then delete the comment. Otherwise delete the comment, report the constraint as open, and sketch the out-of-scope work.
6. Run the project's check once. The done gate then confirms the diff has no new comments or suppressions. Report the deletion count, restored comments, reruns, fixes, encoding offers, encodings, unenforced constraints, and other open work.

Source: pstack skills/no-comments/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
