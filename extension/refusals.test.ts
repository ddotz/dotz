import { expect, test } from "bun:test";
import { createRefusals } from "./refusals.ts";

const REASON = "Blocked by dotz (custom plugin acme): company mail leaves only on the owner's OK: mail 1: no explicit OK";

test("the first refusal is said as it is, a repeat for the same reason ends the turn and the text stays the refusal", () => {
	const r = createRefusals();
	expect(r.say(REASON)).toBe(REASON);
	const again = r.say(REASON);
	expect(again.startsWith(REASON)).toBe(true);
	expect(again).toContain("2nd");
	expect(again).toContain("End this turn");
	expect(r.say(REASON)).toContain("3rd");
});

test("another reason starts its own count, and a new owner input starts all of them over", () => {
	const r = createRefusals();
	r.say(REASON);
	expect(r.say("Blocked by dotz: other")).toBe("Blocked by dotz: other");
	r.reset();
	expect(r.say(REASON)).toBe(REASON);
});
