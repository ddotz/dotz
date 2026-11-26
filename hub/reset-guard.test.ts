// A test run never reaches the call that spends a real 리셋권: with the preload's real sender (fetch, omp) in place, every spend answers 409
// before it reads a login or sends a request, and a fake sender passes the guard. Nothing here calls a real reset.
import { expect, test } from "bun:test";
import { useClaudeReset } from "./claude-reset.ts";
import { useResetCredit } from "./codex-usage.ts";
import { useOmpReset } from "./omp-reset.ts";
import { isRealFetch, testSpendRefusal } from "./reset-guard.ts";

const refused = { status: 409, body: { error: expect.stringContaining("refused") } };

test("the fetch a test run starts with is the real network, and a fake one is not", () => {
	expect(isRealFetch(globalThis.fetch)).toBe(true);
	expect(isRealFetch((async () => new Response("")) as unknown as typeof fetch)).toBe(false);
	expect(testSpendRefusal(true)).toMatchObject({ status: 409 });
	expect(testSpendRefusal(false)).toBeUndefined();
});

test("Codex, Claude and omp spends refuse through the real senders, even with confirm and a named grant", async () => {
	expect(await useResetCredit({ confirm: true, account: "me@example.com" })).toMatchObject(refused);
	expect(await useClaudeReset({ confirm: true, provider: "anthropic", account: "main", grant_id: "g1" })).toMatchObject(refused);
	expect(await useOmpReset({ confirm: true, account: "a@x.io", grant_id: "g1" })).toMatchObject(refused);
});

test("a spend without confirm is still the same 400 it always was", async () => {
	expect((await useResetCredit({ account: "me@example.com" })).status).toBe(400);
	expect((await useClaudeReset({ provider: "anthropic", account: "main", grant_id: "g1" })).status).toBe(400);
	expect((await useOmpReset({ account: "a@x.io", grant_id: "g1" })).status).toBe(400);
});
