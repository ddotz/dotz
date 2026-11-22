---
name: principle-never-block-on-the-human
description: "Apply when tempted to ask 'should I do X?' on reversible work. Proceed, present the result, and let the owner course-correct. ulw enters it whenever a question would stall reversible work."
disable-model-invocation: true
---

# Never Block on the Human

The human supervises asynchronously. Agents must stay unblocked. Make reasonable decisions, proceed, and let the human course-correct after the fact. Since code changes are reversible and reviewable, a wrong decision usually costs less than blocking.

- Proceed, then present. Do the work, show the result. Don't ask "should I do X?" Do X, explain why.
- Make the system self-healing. When you notice a problem, log it and fix it in the next round.
- Irreversible actions (force-push, delete production data, send external messages, merge, deploy) still require confirmation. Workers never take them; the main session does, within what the owner asked for.
- Reversible actions (write code, edit notes, split tasks) should proceed without blocking.
- Product direction comes from the human. Execution should not block.
- A worker has no `ask` tool. It states the open question in its final answer and finishes everything else it can.

Source: pstack skills/principle-never-block-on-the-human/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
