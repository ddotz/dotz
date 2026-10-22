import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The computer chip's loader (web/js/33-peers.js prLoad), run on the real source text. The page starts from the service worker's cached
// shell before the phone's network is back after a trip to the other computer, so the first /api/peers can fail.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "33-peers.js"), "utf8");
const loader = src.slice(src.indexOf("/* ---------- computers"), src.indexOf("function prPaint"));

type Peer = { name: string; url: string; self: boolean; online: boolean; unread?: number };
const MAC: Peer = { name: "맥북", url: "https://mac:8443", self: true, online: true };
const MINI: Peer = { name: "맥미니", url: "https://mini:8445", self: false, online: true };

function page(stored: string | null, answers: Array<Peer[] | Error>) {
	const store = new Map<string, string>(stored == null ? [] : [["dotz-peers", stored]]);
	const timers: Array<{ fn: () => Promise<void>; ms: number }> = [];
	let painted = 0, calls = 0;
	const env: Record<string, unknown> = {
		api: async () => { const a = answers[Math.min(calls++, answers.length - 1)]!; if (a instanceof Error) throw a; return a; },
		prPaint: () => { painted++; },
		lsJson: (k: string, fb: unknown) => { try { return JSON.parse(store.get(k) ?? "null") ?? fb; } catch { return fb; } },
		localStorage: { setItem: (k: string, v: string) => void store.set(k, v) },
		setTimeout: (fn: () => Promise<void>, ms: number) => timers.push({ fn, ms }),
		clearTimeout: () => {},
	};
	const api = new Function(...Object.keys(env), `${loader}\nreturn { PR, prLoad };`)(...Object.values(env)) as { PR: { list: Peer[] }; prLoad: () => Promise<void> };
	return { ...api, timers, store, painted: () => painted };
}

describe("computer chip after coming back from the other computer", () => {
	test("a failed first fetch is retried within seconds, not left for the minute tick", async () => {
		const p = page(null, [new Error("network"), [MAC, MINI]]);
		await p.prLoad();
		expect(p.PR.list).toEqual([]);
		expect(p.timers.length).toBe(1);
		expect(p.timers[0]!.ms).toBeLessThanOrEqual(5000);
		await p.timers[0]!.fn();
		expect(p.PR.list.map(x => x.name)).toEqual(["맥북", "맥미니"]);
		expect(p.painted()).toBe(1);
	});

	test("retries are bounded", async () => {
		const p = page(null, [new Error("network")]);
		await p.prLoad();
		for (let i = 0; i < 10 && p.timers[i]; i++) await p.timers[i]!.fn();
		expect(p.timers.length).toBe(3);
	});

	test("the last list is there from the first moment, from storage, without the unread counts", async () => {
		const first = page(null, [[MAC, { ...MINI, unread: 4 }]]);
		await first.prLoad();
		const saved = first.store.get("dotz-peers")!;
		expect(JSON.parse(saved)).toEqual([MAC, MINI]);
		const offline = page(saved, [new Error("network")]);
		expect(offline.PR.list.map(x => x.name)).toEqual(["맥북", "맥미니"]);
		expect(page("not json{", [new Error("x")]).PR.list).toEqual([]);
		expect(page(JSON.stringify([1, { name: "x" }]), [new Error("x")]).PR.list).toEqual([]);
	});
});
