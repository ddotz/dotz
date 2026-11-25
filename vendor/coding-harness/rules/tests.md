---
description: "Test-file edits: a new test only when asked or cheap and local; never bend a test to a wrong implementation"
condition: ".*"
scope: "tool:edit(*.test.*), tool:write(*.test.*), tool:edit(*.spec.*), tool:write(*.spec.*), tool:edit(*_test.*), tool:write(*_test.*), tool:edit(test_*.py), tool:write(test_*.py)"
interruptMode: "never"
repeatMode: "once"
---
You are writing a test.

- Write a new test only when the user asked for one or the bug has an obvious, cheap, local test target. Prefer no new test over a bad one: a test that mostly tests mocks, encodes implementation details, depends on timing or global state, or needs expensive setup for a small fix.
- Never change a test to match a wrong implementation, and never weaken an assertion unless the expected behavior changed.

Procedure: `skill://tdd`. Property tests only on request: `skill://pbt`.
