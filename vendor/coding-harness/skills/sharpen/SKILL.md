---
name: sharpen
disable-model-invocation: true
description: "Make a task deeper, not bigger, then rewrite the prompt. Entered from ulw when the owner asks to sharpen a task, or when a vague or shallow task needs a stronger prompt before any worker runs."
---

I want a deeper version of this task, not a bigger one. Before rewriting it, do four things:

1. Say what a top professional in this field would do here that I am not asking for.
2. Name the rawest material they would start from instead of what has already been digested for me.
3. Name the specific methods and tools they would use.
4. Say what, other than you or me, would show the result is right.

Then rewrite my prompt to ask for exactly that.

Have the rewritten prompt ask the agent to prototype any choice an experiment can settle (`skill://prototype`) and recommend an option based on what it observed. Leave product or preference choices that no experiment can settle for me to make.

Source: pstack skills/sharpen (MIT, skill://ulw/references/LICENSE-pstack).
