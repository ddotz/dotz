---
description: "TypeScript edits: the type, narrowing and validation rules that change how a .ts or .tsx file is written"
condition: ".*"
scope: "tool:edit(*.ts), tool:write(*.ts), tool:edit(*.tsx), tool:write(*.tsx)"
interruptMode: "never"
repeatMode: "once"
---
You are editing TypeScript. Runtime is bun (`bun add`, `bun test` with `bun:test`, `bun <script>`); never npm, pnpm, jest or vitest. The done gate refuses a net new `any` outside tests, swallowed errors (`catch {}`, `.catch(() => {})`) and lint or type suppressions on added lines.

- Variants: a discriminated union on a `kind` literal, never a bag of optional fields. Default arms end in `const _exhaustive: never = x;`.
- Make the illegal value unbuildable: `[T, ...T[]]` for non-empty, `start` plus `duration` for a range. Keep `T[]` while every use stays total; strengthen only where the loose type forces `!`, a cast or a "never happens" throw.
- Brand primitives that mix up (`string & { readonly __brand: "UserId" }`); a brand comes from a verifying guard (`input is UserId`), never from `as`.
- External data is `unknown`. Parse it once where it crosses in, into a named type, with the repo's schema library and an inferred type (`z.infer`) before any hand-written guard. `Record<string, unknown>` stops at that parse. Handle a parse failure; never swallow it.
- No `as` except right after validation; `satisfies` to check a literal without widening. Narrow by discriminant switch, then `in`, then `typeof`/`instanceof`, then a guard named `isX` that verifies its claim.
- Derive types (`Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, `typeof`) before declaring a new interface.
- Object arguments over positional ones, except on hot paths (parsers, per-frame code).
- No `console.log` in shipped code except a CLI's intended output; log with context and an id.

Examples of each pattern: `skill://typescript-best-practices/references/patterns.md`.
