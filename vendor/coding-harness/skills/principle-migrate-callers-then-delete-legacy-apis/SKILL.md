---
name: principle-migrate-callers-then-delete-legacy-apis
description: "Apply when introducing a new internal API while old callers still exist. Migrate callers and delete the old API in the same wave instead of preserving compatibility layers. ulw enters it on Refactor and Migration work."
disable-model-invocation: true
---

# Migrate Callers Then Delete Legacy APIs

Introduce the new API, move every caller to it, and delete the old one in the same wave. Do not leave a shim, alias, or re-export behind.

- Update tests to assert the new contract, and delete tests that only protect pre-refactor implementation details.

**When this applies:**
- No external users depend on backward compatibility.
- The project can absorb coordinated breaking changes.
- The new API is part of a simplification or refactor initiative.

Source: pstack skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md (MIT, skill://ulw/references/LICENSE-pstack).
