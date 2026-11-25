---
name: pbt
disable-model-invocation: true
description: "Property-based tests with fast-check (TS/JS) or proptest (Rust) for parsers, serializers, shell or query builders, date and number math, and pure transforms. Use only when the owner asks for property tests."
---

Example tests check the cases you thought of. A property checks a rule over generated inputs and shrinks a failure to the smallest case.

1. Pick properties that a bug would break:
   - round trip: `parse(format(x)) == x`;
   - invariant: output sorted, no duplicates, length preserved, total unchanged;
   - oracle: matches a slow obvious implementation;
   - metamorphic: changing the input in a known way changes the output in a known way;
   - never throws on any input of the declared type.
2. Generators produce the real input shape, including the ugly parts: empty, unicode and Korean text, quotes and shell metacharacters, very large and negative numbers, NaN, time zones.
3. Install as a dev dependency with the project's package manager (`bun add -d fast-check`; in a pnpm project use its lockfile's manager; Rust: `proptest` in `[dev-dependencies]`).
4. Run. A failure prints a shrunk counterexample: add it as a fixed example test too, then fix the code (never narrow the generator to dodge it).
5. Keep run counts deterministic in CI (fixed seed or default runs); report the seed of any failure.
