---
description: "Test file edited: check the test guards behavior, not implementation"
scope: "tool:edit(**/*.test.*), tool:write(**/*.test.*), tool:edit(tests/**), tool:write(tests/**)"
condition: ".*"
---
You edited a test of <app>. Before you report done, check it:

- Two-edit check: name one plausible bug in the product code that this test would catch, and one harmless refactor it must survive. If it fails either, rewrite it.
- It asserts what a user or caller can observe, not private calls, render counts, or source text.
- You did not loosen an existing assertion to make a failing run pass. A failing test is fixed in the product code unless the requirement itself changed; say which.
