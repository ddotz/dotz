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

// Switching computers in the installed app (web/js/33-peers.js prGo): the phone would open another origin outside the app, so the other
// computer opens in a full-screen frame inside it; a browser tab still goes to the other address.
const embed = src.slice(src.indexOf("// The installed app (iPhone"), src.indexOf("function prPick(p, o = {}) {"));
function shell(standalone: boolean) {
	const appended: any[] = [], listeners: Record<string, (ev: unknown) => void> = {}, loc = { href: "https://mac:8443/", replace(h: string) { loc.href = h; } };
	let open = 0;
	const win: any = { addEventListener: (k: string, fn: (ev: unknown) => void) => void (listeners[k] = fn) };
	win.top = win; win.self = win;
	const el = (tag: string, props: Record<string, unknown>, ...kids: any[]) => { const n: any = { tag, ...props, firstElementChild: kids[0], removed: false, remove() { n.removed = true; } }; return n; };
	const env: Record<string, unknown> = {
		isStandalone: () => standalone, window: win, location: loc, document: { body: { append: (n: unknown) => appended.push(n) } }, el,
		ovOpen: () => ({ n: ++open }), ovDone: () => {}, prLoad: () => {}, PR: { list: [MAC, MINI] }, prUrl: (p: Peer, x = "") => `${p.url}/${x}`, enc: encodeURIComponent, DEVICE_ID: "d1",
	};
	const api = new Function(...Object.keys(env), `${embed}\nreturn { prGo, PRF };`)(...Object.values(env)) as { prGo: (h: string) => void; PRF: { node: any } };
	return { ...api, appended, loc, message: (origin: string, data: unknown) => listeners.message!({ origin, data }) };
}

describe("switching computers in the installed app", () => {
	test("the installed app opens the other computer in a frame and stays on its own address; picking this computer there closes it", () => {
		const s = shell(true);
		s.prGo("https://mini:8445/?did=d1");
		expect(s.loc.href).toBe("https://mac:8443/");
		expect(s.appended.length).toBe(1);
		expect(s.appended[0].firstElementChild.src).toBe("https://mini:8445/?did=d1");
		s.message("https://evil.example", { dotz: "peer-pick", url: MAC.url });   // not one of this owner's computers: ignored
		expect(s.PRF.node).not.toBeNull();
		s.message(MINI.url, { dotz: "peer-pick", url: MAC.url });
		expect(s.PRF.node).toBeNull();
		expect(s.appended[0].removed).toBe(true);
	});

	test("a browser tab goes to the other computer's address as before", () => {
		const s = shell(false);
		s.prGo("https://mini:8445/?did=d1");
		expect(s.loc.href).toBe("https://mini:8445/?did=d1");
		expect(s.appended.length).toBe(0);
	});
});
