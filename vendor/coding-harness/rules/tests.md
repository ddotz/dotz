---
description: "Test-file edits: red first, generated ugly input for parsers and math, assertions on what a user observes"
condition: ".*"
scope: "tool:edit(*.test.*), tool:write(*.test.*), tool:edit(*.spec.*), tool:write(*.spec.*), tool:edit(*_test.*), tool:write(*_test.*), tool:edit(test_*.py), tool:write(test_*.py)"
interruptMode: "never"
repeatMode: "once"
---
You are writing a test.

- A bug fix starts red: run the new test before the fix and read the failure; it must fail on the assertion that states the bug, not on an import, typo or timeout. After the fix, remove the fix once and see exactly that test fail again.
- Never edit a test to fit the code, and never loosen an assertion without a changed requirement you can name. When the code disagrees with the test, the code changes.
- Parsers, serializers, shell or query builders, date and number math, pure transforms: add one property over generated input when the repo already has a property-testing library, or the change adds a new parser or encode/decode pair (then `bun add -d fast-check` in TS). A bug fix in existing code never adds the dependency. Generators include empty input, Unicode and Korean text, quotes and shell metacharacters, huge and negative numbers, NaN, and time zones. A shrunk counterexample becomes a fixed example too; never narrow the generator to dodge it.
- Assert what a caller or user observes (return value, error type they branch on, state read back, request sent, row written), with the expected value taken from the requirement, not from a run of the code. Each test must fail when that behavior breaks and keep passing when only internals change; no assertion on private helpers, call order or data the test built itself.

Procedures: `skill://tdd` (mutation proof), `skill://pbt` (property kinds).
