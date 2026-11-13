import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { sentAccounts } from "../lib/tone.ts";

let which: ReturnType<typeof spyOn>;
beforeEach(() => void (which = spyOn(Bun, "which").mockReturnValue("/bin/zele")));
afterEach(() => which.mockRestore());

test("with zele on and no list, the sent mail of every account is read", () => {
	expect(sentAccounts({ zele: { enabled: true } })).toEqual([undefined]);
	expect(sentAccounts({ zele: { enabled: true, accounts: [] } })).toEqual([undefined]);
});

test("with zele on and a list, only the listed accounts' sent mail is read", () => {
	expect(sentAccounts({ zele: { enabled: true, accounts: ["a@example.com", " b@example.com "] } })).toEqual(["a@example.com", "b@example.com"]);
});

test("a list with no address in it reads every account; an entry that is not an address is dropped", () => {
	expect(sentAccounts({ zele: { enabled: true, accounts: "a@example.com" } })).toEqual([undefined]);
	expect(sentAccounts({ zele: { enabled: true, accounts: ["", 3] } })).toEqual([undefined]);
	expect(sentAccounts({ zele: { enabled: true, accounts: ["a@example.com", 3] } })).toEqual(["a@example.com"]);
});
