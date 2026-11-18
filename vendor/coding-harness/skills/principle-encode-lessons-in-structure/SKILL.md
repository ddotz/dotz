---
name: principle-encode-lessons-in-structure
description: "Apply when you catch yourself writing the same instruction a second time, or notice a recurring correction. Encode the rule as a lint, metadata flag, runtime check, or script instead of more text. ulw enters it after a correction from the owner or a repeated failure."
disable-model-invocation: true
---

# Encode Lessons in Structure

When the same instruction appears a second time, stop writing text. Encode the rule where it fails on its own: a lint rule, a metadata flag, a runtime check, or a script.

In this harness the structural homes already exist:
- A mistake that can recur becomes a check through the `mistake` tool and `skill://correct`.
- The done gate (`.omp/gate.json`) and the lint kit (`.omp/lint/`) refuse bad output without anyone reading an instruction.
- A rerunnable script beats a paragraph that asks someone to remember a step.

If the lesson needs judgment and cannot be encoded, make the instruction more prominent and add an example of the failure mode.

**Corollary:** If the fix is structural, only use the structural fix. The instruction is the symptom.

Source: pstack skills/principle-encode-lessons-in-structure/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
