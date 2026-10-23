// lib/login.ts: the sign-in runs through the injected aside repl runner (never the Aside agent) and maps its marker to a result.
import { expect, test } from "bun:test";
import { loginCode, loginViaRepl } from "../lib/login.ts";

const stub = (marker: string) => {
	const calls: { code: string; ms: number }[] = [];
	return { calls, repl: async (code: string, ms: number) => (calls.push({ code, ms }), `noise\nWM_LOGIN ${marker}\n`) };
};

test("each marker maps to a login result and the code runs in a tab it closes", async () => {
	for (const [marker, want] of [["LOGIN_OK", "in"], ["NEED_2FA", "need-2fa"], ["NEED_PASSWORD", "need-password"], ["LOGIN_FAILED", "failed"]] as const) {
		const s = stub(marker);
		expect(await loginViaRepl(s.repl, "https://mail.example.com/inbox", false)).toBe(want);
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0]!.code).toContain('openTab("https://mail.example.com/inbox")');
		expect(s.calls[0]!.code).toContain("closeTab(pg)");
	}
});

test("no marker (repl died or timed out) is a failed login, and --approve waits longer for the second factor", async () => {
	const dead = { repl: async () => "boom" };
	expect(await loginViaRepl(dead.repl, "https://m.example.com", false)).toBe("failed");
	const a = stub("LOGIN_OK");
	const b = stub("LOGIN_OK");
	await loginViaRepl(a.repl, "https://m.example.com", false);
	await loginViaRepl(b.repl, "https://m.example.com", true);
	expect(b.calls[0]!.ms).toBeGreaterThan(a.calls[0]!.ms);
});

test("the login script is valid JavaScript for the repl", () => {
	const Fn = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => unknown;
	for (const allow of [false, true]) expect(() => new Fn("openTab", "closeTab", "sleep", loginCode("https://m.example.com", allow))).not.toThrow();
});
