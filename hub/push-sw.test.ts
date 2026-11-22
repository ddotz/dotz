import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { swScript } from "./webapp.ts";

type Shown = { title: string; opts: { body?: string; tag?: string; data?: { id?: string; url?: string } } };

function worker(opts: { navigator?: Record<string, unknown>; fetch?: (url: string) => Promise<{ ok: boolean; status?: number }> } = {}) {
	const on: Record<string, (ev: unknown) => void> = {}, shown: Shown[] = [], opened: string[] = [], posted: { url: string; body: string }[] = [];
	const self = {
		addEventListener: (k: string, f: (ev: unknown) => void) => void (on[k] = f),
		clients: { matchAll: async () => [], openWindow: async (u: string) => void opened.push(u) },
		registration: { showNotification: async (title: string, o: Shown["opts"]) => void shown.push({ title, opts: o }), getNotifications: async () => [], pushManager: { getSubscription: async () => null } },
		...(opts.navigator ? { navigator: opts.navigator } : {}),
	};
	const caches = { open: async () => ({ put: async () => {} }) };
	const answer = opts.fetch ?? (async () => ({ ok: true, status: 200 }));
	const fetchStub = (url: string, init?: { body?: string }) => (posted.push({ url, body: init?.body ?? "" }), answer(url));
	const instant = (fn: () => void) => void fn();
	const source = swScript(readFileSync(join(import.meta.dir, "..", "web", "sw.js"), "utf8"));
	new Function("self", "location", "caches", "fetch", "setTimeout", source)(self, new URL("https://dotz.test"), caches, fetchStub, instant);
	const run = async (name: string, ev: object) => {
		const wait: Promise<unknown>[] = [];
		on[name]!({ ...ev, waitUntil: (p: Promise<unknown>) => void wait.push(p) });
		await Promise.all(wait);
	};
	return {
		shown,
		opened,
		taps: () => posted.filter(p => p.url === "/api/push/tap").map(p => JSON.parse(p.body) as Record<string, string>),
		push: (msg: object) => run("push", { data: { json: () => msg } }),
		press: (action: string) => run("notificationclick", { notification: { close: () => {}, tag: "decision:n7", data: { url: "/#chat/main", id: "n7", ts: "", nid: "" } }, action }),
	};
}

test("a push's unread count sets the app badge, and 0 clears it", async () => {
	const calls: string[] = [];
	const navigator = { setAppBadge: async (n: number) => void calls.push(`set:${n}`), clearAppBadge: async () => void calls.push("clear") };
	const w = worker({ navigator });
	await w.push({ kind: "result", title: "끝", body: "본문", url: "/", tag: "t1", unread: 3 });
	await w.push({ kind: "withdraw", title: "", body: "", url: "/", withdraw: ["t1"], unread: 0 });
	expect(calls).toEqual(["set:3", "clear"]);
});

test("each decision button press is reported to the gateway with whether its answer was taken", async () => {
	const taken = worker();
	await taken.press("opt:1");
	expect(taken.taps()).toEqual([{ tag: "decision:n7", path: "action", why: "answered", reason: "" }]);
	const refused = worker({ fetch: async url => (url.endsWith("/answer") ? { ok: false, status: 503 } : { ok: true, status: 200 }) });
	await refused.press("opt:0");
	expect(refused.taps()).toEqual([{ tag: "decision:n7", path: "action", why: "failed", reason: "503" }]);
});

test("a push on a platform without the badge API still shows its notification", async () => {
	const w = worker();
	await w.push({ kind: "result", title: "끝", body: "본문", url: "/", tag: "t2", unread: 2 });
	expect(w.shown.map(s => s.title)).toEqual(["끝"]);
});

test("a decision button whose answer did not reach the gateway says so and does not open the app", async () => {
	for (const fetch of [async () => ({ ok: false }), async () => { throw new Error("offline"); }]) {
		const w = worker({ fetch });
		await w.press("opt:0");
		expect(w.opened).toEqual([]);
		expect(w.shown).toHaveLength(1);
		expect(w.shown[0]!.title).toBe("답을 보내지 못했어요");
		expect(w.shown[0]!.opts.body).toBe("앱을 열어 다시 눌러 주세요");
		expect(w.shown[0]!.opts.data).toMatchObject({ id: "n7", url: "https://dotz.test/#chat/main" });
	}
});

test("a decision button whose answer was taken confirms it and shows no failure", async () => {
	const w = worker();
	await w.press("opt:1");
	expect(w.opened).toEqual([]);
	expect(w.shown.map(s => s.title)).toEqual(["답변을 보냈어요"]);
});
