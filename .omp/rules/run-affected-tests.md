---
description: "Source edited: run only the tests it can break; the whole suite runs once per batch"
scope: "tool:edit(**/*.ts), tool:write(**/*.ts)"
condition: ".*"
---
After a change, run `bun run test:affected`: it runs the test files that import a changed file directly or through one module, and leaves out the slow tier (`scripts/slow-tests.txt`, browser, golden and e2e tests) unless a changed file is under `web/`. Do not run the whole `bun test` after each change. The main session runs `bun test` once per batch, before landing.
