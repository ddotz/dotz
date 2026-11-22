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
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
	type Tab = { evaluate: (read: () => unknown) => Promise<unknown>; isClosed: () => boolean };
	// The repl's globals the script reaches: openTab, closeTab, fetch (real, against a one-shot inbox), a timer that runs the page wait at once and never fires the post's limit, console, and globalThis for the kept tabs.
	const runScript = async (read: string, inboxUrl: string, tab: Tab, kept: Record<string, unknown> = {}) => {
		const logs: string[] = [], closed: Tab[] = [];
		let opened = 0;
		const code = loginCaptureScript({ key: "jandi", url: "https://example.test/app/", read, inbox: inboxUrl });
		await new AsyncFunction("openTab", "closeTab", "fetch", "setTimeout", "console", "globalThis", code)(
			async () => (opened++, tab), async (t: Tab) => void closed.push(t), fetch, (f: () => void, ms: number) => { if (ms < 10_000) f(); }, { log: (s: string) => logs.push(s) }, { dzLogin: kept });
		return { logs, closed, opened, kept };
	};

	test("posts the page value to the inbox and prints only a verdict", async () => {
		const inbox = oneShotInbox();
		try {
			const tab: Tab = { evaluate: async read => read(), isClosed: () => false };
			const r = await runScript("() => ({ token: 'secret-value' })", inbox.url, tab);
			expect(inbox.got()).toEqual({ token: "secret-value" });
			expect(r.logs).toEqual(['RESULT {"ok":true}']);
			expect(r.closed).toEqual([tab]);
			expect(r.kept).toEqual({ jandi: undefined });
		} finally {
			inbox.stop();
		}
	});

	test("a read that fails while the page navigates keeps the tab: the owner may be logging in there", async () => {
		const inbox = oneShotInbox();
		try {
			const tab: Tab = { evaluate: async () => { throw new Error("Execution context was destroyed"); }, isClosed: () => false };
			const first = await runScript("() => null", inbox.url, tab);
			expect(first.logs).toEqual(['RESULT {"ok":true,"waiting":"login"}']);
			expect(first.closed).toEqual([]);
			expect(first.kept.jandi).toBe(tab);
			const again = await runScript("() => null", inbox.url, tab, first.kept);
			expect([again.opened, again.closed]).toEqual([0, []]);
			expect(inbox.got()).toBeUndefined();
			const gone: Tab = { evaluate: async () => { throw new Error("target closed"); }, isClosed: () => true };
			expect((await runScript("() => null", inbox.url, gone)).kept.jandi).toBeUndefined();
		} finally {
			inbox.stop();
		}
	});
});
