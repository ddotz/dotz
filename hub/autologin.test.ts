// The sign-in body hub/autologin.ts hands to the Aside tab, run against a scripted login page (no browser, no network): a form that
// still shows its password field after the submit is a rejected login, not a run that "did not finish" and is retried later.
import { expect, test } from "bun:test";
import { reloginBody } from "./autologin.ts";

type Page = { pw: boolean; filled: boolean; otp: boolean; factor: boolean };

// `after` is what the page shows once Enter was pressed; time is a counter the body's sleep moves, so the 25 s wait takes no real time.
async function runBody(before: Page, after: Page, secret?: string) {
	let t = 0, submitted = false;
	const typed: string[] = [];
	const field = { count: async () => 1, fill: async (v: string) => void typed.push(v), press: async () => void (submitted = true) };
	const pg = { evaluate: async () => (submitted ? after : before), locator: () => ({ first: () => field }) };
	const run = new Function("pg", "sleep", "secret", "Date", `return (async () => { ${reloginBody(secret ? { secret: "site" } : {})} })();`);
	const verdict = await run(pg, async (ms: number) => void (t += ms), secret, { now: () => t });
	return { verdict, typed: typed.length };
}

const form = { pw: true, filled: false, otp: false, factor: false };

test("a dotz_auth password the site rejects ends as rejected-secret after one submit", async () => {
	const r = await runBody(form, form, JSON.stringify({ username: "u", password: "p" }));
	expect(r).toEqual({ verdict: "rejected-secret", typed: 2 });
});

test("a browser-filled password the site rejects ends as rejected, and an accepted one as in", async () => {
	expect((await runBody({ ...form, filled: true }, { ...form, filled: true })).verdict).toBe("rejected");
	expect((await runBody({ ...form, filled: true }, { ...form, pw: false })).verdict).toBe("in");
});
