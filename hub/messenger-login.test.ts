import { describe, expect, test } from "bun:test";
import { oneShotInbox } from "./aside.ts";
import { inboxPost, loginCaptureScript } from "./messenger-login.ts";

describe("login capture inbox", () => {
	test("a post to an inbox that never answers ends by its time limit, in a repl that has no AbortSignal", async () => {
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
		const post = new AsyncFunction("fetch", "setTimeout", "AbortSignal", inboxPost("http://127.0.0.1:1/x", "{ a: 1 }"));
		const never = () => new Promise(() => {});
		const atOnce = (f: () => void) => f();
		await expect(post(never, atOnce, undefined)).rejects.toThrow("timed out");
	});

	test("takes one POST on its random path from this machine and answers 404 to everything after", async () => {
		const inbox = oneShotInbox();
		try {
			expect(new URL(inbox.url).hostname).toBe("127.0.0.1");
			expect(inbox.got()).toBeUndefined();
			const wrong = await fetch(`${new URL(inbox.url).origin}/nope`, { method: "POST", body: "{}" });
			expect(wrong.status).toBe(404);
			const first = await fetch(inbox.url, { method: "POST", body: JSON.stringify({ refresh_token: "rt-abc" }) });
			expect(first.status).toBe(204);
			expect(inbox.got()).toEqual({ refresh_token: "rt-abc" });
			const second = await fetch(inbox.url, { method: "POST", body: JSON.stringify({ refresh_token: "rt-other" }) });
			expect(second.status).toBe(404);
			expect(inbox.got()).toEqual({ refresh_token: "rt-abc" });
		} finally {
			inbox.stop();
		}
	});

	test("refuses a body that is not a JSON object", async () => {
		const inbox = oneShotInbox();
		try {
			const res = await fetch(inbox.url, { method: "POST", body: "not json" });
			expect(res.status).toBe(400);
			expect(inbox.got()).toBeUndefined();
		} finally {
			inbox.stop();
		}
	});
});

describe("login capture script", () => {
	test("posts the page value to the inbox and prints only a verdict", () => {
		const code = loginCaptureScript({ key: "jandi", url: "https://example.test/app/", read: "() => ({ a: 1 })", inbox: "http://127.0.0.1:9/abc" });
		expect(code).toContain("http://127.0.0.1:9/abc");
		expect(code).toContain("() => ({ a: 1 })");
		expect(code).toContain("closeTab");
		expect(code).not.toMatch(/console\.log\([^)]*\bv\b/);
		expect(code.split("\n")).toHaveLength(1);
	});

	test("a read that fails while the page navigates keeps the tab: the owner may be logging in there", () => {
		const code = loginCaptureScript({ key: "jandi", url: "https://example.test/app/", read: "() => null", inbox: "http://127.0.0.1:9/abc" });
		expect(code).toContain("tab.isClosed()");
	});
});
