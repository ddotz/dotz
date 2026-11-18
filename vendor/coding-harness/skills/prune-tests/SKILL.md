---
name: prune-tests
description: "Prune tests that guard no behavior, over a path or the whole suite. Use when the owner asks to prune or clean up tests, or when ulw finds a suite that grew copies, tombstone tests, or tests pinned to internals."
disable-model-invocation: true
argument-hint: "[optional path]"
---

# Prune tests

Prune every test that guards no behavior. `skill://principle-test-behavior-not-implementation` defines behavior; this skill applies it to an existing suite.

## 1. Find what each test depends on

Keep a test only if it depends on the intended behavior: it should change only when that behavior changes, and fail only when it regresses.

If another test already guards the same behavior, prune the copy.

Prune tests that depend on:

The past. It guards code that no longer exists, so it has no reason of its own to change.

- A feature was removed, and tests assert it's gone. Removed code never changes, so they can't catch a regression.
- A module was moved, and a test asserts it's absent from its old path.

Nothing. No change to the code can make it fail, so it has no reason of its own to change.

- It tests the platform: a `<button>` renders, or a click event fires. The browser is already tested.
- It mocks the unit under test, then asserts what the mock returns.
- It asserts what the type system already guarantees.

The implementation. It changes whenever the code does, even when behavior didn't.

- The expected value is derived from the same logic as the code, so a wrong result still passes.
- It asserts private state, internal call order, or which helper was invoked.

A test that pins a guard against a past regression is not a test of the past: it stays while the code it guards exists and the regression is still possible.

## 2. Prune

- Delete every test that isn't anchored to intended behavior.
- Where one also covers behavior something relies on, rewrite it against that behavior instead.
- Delete production code that only existed for the tests you removed.
- Run the suite once afterward. It must pass, and each rewritten test must fail against a deliberately broken copy of the behavior it now guards.

## What done looks like

- Every test left is anchored to intended behavior.
- Each one would fail on a regression, and only on a regression.
- No test asserts code that no longer exists.
- No two tests guard the same behavior.
- No production code exists only for tests.
- The reply lists each deleted or rewritten test with its reason (past, nothing, implementation, duplicate).

## Example

```diff
--- a/pricing.test.ts
+++ b/pricing.test.ts
@@ rewritten: the expected value repeated the code's logic @@
 test("applies the discount", () => {
-  const price = 100;
-  expect(applyDiscount(price, 0.2)).toBe(price - price * 0.2);
+  expect(applyDiscount(100, 0.2)).toBe(80);
 });
--- a/cart.test.ts
+++ b/cart.test.ts
@@ rewritten against what callers see: it asserted private state @@
 test("adds an item to the cart", () => {
   const cart = new Cart();
   cart.add(book);
-  expect(cart._items.length).toBe(1);
+  expect(cart.total()).toBe(book.price);
 });
@@ deleted: checkout.test.ts already guards the same total @@
-test("total includes tax", () => {
-  expect(cartTotal([book], { tax: 0.1 })).toBe(11);
-});
--- a/export.test.ts
+++ b/export.test.ts
@@ deleted: it guards code that no longer exists @@
-test("legacy exporter is gone", () => {
-  expect(existsSync("src/export/legacy.ts")).toBe(false);
-});
--- a/session.test.ts
+++ b/session.test.ts
@@ deleted, with the production code that only existed for it @@
-test("clears the cache", () => {
-  _resetCacheForTests();
-  expect(_getCacheSize()).toBe(0);
-});
--- a/session.ts
+++ b/session.ts
@@ @@
-export function _resetCacheForTests() { cache.clear(); }
-export function _getCacheSize() { return cache.size; }
```

Source: caldoai/skills skills/prune-tests/SKILL.md (MIT, skill://prune-tests/LICENSE-caldo).
