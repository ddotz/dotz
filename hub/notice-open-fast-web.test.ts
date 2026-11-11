import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on, type View } from "./test-web.ts";

// A tap on a push that had to start the app paints the message from this device's store (web/js/13-snapshot.js) before any answer of the network, and the
// network then updates the view in place. A long conversation draws its newest stretch; older stored rows join when asked for.
const ts = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, 0, i)).toISOString();
const says = (i: number) => ({ ts: ts(i), kind: "out", source: "orchestrator", target: "main", text: `메시지 ${i}번이에요.` });
const MAIN = Array.from({ length: 200 }, (_, i) => says(i));
const AT = ts(190);
const notice = { id: "n1", kind: "message", tone: "", cls: "conv", read: false, title: "땃쥐", text: "내용", open: "main", src: "main", ts: AT, updated: AT, at: AT };
let gate: Promise<void> | null = null, stateGate: Promise<void> | null = null, extra: unknown[] = [], histories = 0;
const hub = fakeHub({
	state: () => idleState(),
	api: async (_req, url) => {
		if (url.pathname === "/api/state" && stateGate) await stateGate;
		if (url.pathname === "/api/history") {
			histories++;
			if (gate) await gate;
			const before = url.searchParams.get("before");
			const all = url.searchParams.get("target") === "main" ? MAIN : [];
			return json({ target: "main", events: (before ? all.filter(e => e.ts < before) : all).slice(-Number(url.searchParams.get("limit") ?? 60)) });
		}
		if (url.pathname === "/api/activity") { if (gate) await gate; return json({ items: [], more: false, history: false }); }
		if (url.pathname === "/api/notices") { if (gate) await gate; return json({ unread: 1, items: [notice, ...extra] }); }
	},
});
afterAll(() => hub.stop());

const storeSnapshot = (view: View, msgs: unknown[]) => view.evaluate(`new Promise((res, rej) => {
	const q = indexedDB.open("dotz-snap", 1);
	q.onupgradeneeded = () => q.result.createObjectStore("conv");
	q.onerror = () => rej(q.error);
	q.onsuccess = () => { const tx = q.result.transaction("conv", "readwrite"); tx.objectStore("conv").put({ v: 1, t: "main", at: Date.now(), msgs: ${JSON.stringify(msgs)}, acts: [], hmore: true, amore: false, ahist: false, read: "" }, "main"); tx.oncomplete = () => { q.result.close(); res(1); }; };
})`);

describe("opening from a push", () => {
	test("the tapped message shows from the store with the network held, and the answer updates the view in place", async () => {
		const view = await hub.view({ width: 390, height: 844 }, "/#home");
		const { waitFor, ev, run } = on(view);
		await waitFor(`NT.loaded`);
		await storeSnapshot(view, MAIN.slice(-60));
		let release!: () => void;
		gate = new Promise(r => { release = r; });
		await view.navigate(`${hub.origin}/?m=${encodeURIComponent(AT)}&i=n1#chat/main`);
		await waitFor(`tl.querySelector(".nt-hl") && timeline.clientHeight`);
		const held = await ev<{ at: string; seen: boolean; pending: boolean }>(`(() => {
			const m = tl.querySelector(".nt-hl").closest("[data-ts]"), r = m.getBoundingClientRect(), a = timeline.getBoundingClientRect();
			return { at: m.dataset.ts, seen: r.bottom > a.top && r.top < a.bottom, pending: !ts("main").hLoaded };
		})()`);
		expect(held).toEqual({ at: AT, seen: true, pending: true });
		await run(`window.__row = tl.querySelector('[data-ts="${AT}"]');`);
		MAIN.push(says(201));
		release();
		gate = null;
		await waitFor(`ts("main").hLoaded && tl.querySelector('[data-ts="${ts(201)}"]')`);
		const after = await ev<{ top: boolean; loading: boolean; hl: boolean; pin: string }>(`(() => {
			const m = tl.querySelector('[data-ts="${AT}"]'), r = m.getBoundingClientRect(), a = timeline.getBoundingClientRect();
			return { top: r.bottom > a.top && r.top < a.bottom, loading: /불러오는 중/.test(tl.innerText), hl: !!m.closest(".nt-hl") || !!m.querySelector(".nt-hl"), pin: CV.pinTs };
		})()`);
		expect(after).toEqual({ top: true, loading: false, hl: true, pin: AT });
		MAIN.pop();
	});

	test("a redraw of the conversation while the glow is on keeps it on the tapped message", async () => {
		const view = await hub.view({ width: 390, height: 844 }, "/#home");
		const { waitFor, ev, run } = on(view);
		await waitFor(`NT.loaded`);
		await storeSnapshot(view, MAIN.slice(-60));
		let release!: () => void;
		gate = new Promise(r => { release = r; });
		await view.navigate(`${hub.origin}/?m=${encodeURIComponent(AT)}&i=n1#chat/main`);
		await waitFor(`tl.querySelector(".nt-hl") && timeline.clientHeight`);
		await run(`renderAll();`);   // what an answer of the network does to the timeline: every row is drawn anew
		const hl = await ev<string>(`(tl.querySelector(".nt-hl")?.closest("[data-ts]") || {}).dataset?.ts || ""`);
		release();
		gate = null;
		expect(hl).toBe(AT);
	});

	test("a long conversation draws its newest stretch, and the top of the view brings the older stored rows", async () => {
		const view = await hub.view({ width: 390, height: 844 }, "/#chat/main");
		const { waitFor, ev, run } = on(view);
		await waitFor(`ts("main").hLoaded && tl.querySelector("[data-ts]")`);
		await waitFor(`CV.placed`);
		const drawn = await ev<number>(`tl.querySelectorAll("[data-ts]").length`);
		expect(drawn).toBeLessThanOrEqual(50);
		await run(`loadOlderMsgs();`);
		await waitFor(`tl.querySelectorAll("[data-ts]").length > ${drawn}`);
		expect(await ev<number>(`CV.from.length`)).toBe(0);
	});

	test("a stored row the first answer does not hold leaves the view", async () => {
		const view = await hub.view({ width: 390, height: 844 }, "/#home");
		const { waitFor, ev } = on(view);
		await waitFor(`NT.loaded`);
		const ghost = { ...says(195), ts: new Date(Date.UTC(2026, 9, 20, 1, 3, 15, 500)).toISOString(), text: "지워진 메시지" };
		await storeSnapshot(view, [...MAIN.slice(-60), ghost].sort((a, b) => a.ts.localeCompare(b.ts)));
		let release!: () => void;
		gate = new Promise(r => { release = r; });
		await view.navigate(`${hub.origin}/?seed=1#chat/main`);
		await waitFor(`CV.seeded && tl.textContent.includes("지워진 메시지")`);
		release();
		gate = null;
		await waitFor(`ts("main").hLoaded && !tl.textContent.includes("지워진 메시지")`);
		expect(await ev<boolean>(`ts("main").msgs.some(e => e.text === "지워진 메시지")`)).toBe(false);
	});

	test("a computer switch lands on 홈 drawn from the last visit with every answer held, and reads the conversation after the state", async () => {
		const ask = { ...notice, id: "n2", kind: "message", tone: "ask", title: "물어볼 게 있어요", text: "확인해 주세요" };
		extra = [ask];
		const view = await hub.view({ width: 390, height: 844 }, "/#home");
		const { waitFor, ev } = on(view);
		await waitFor(`NT.loaded && S`);
		await ev(`(async () => {
			S.auth = [{ id: "pending-login" }];
			await snapHomeSave();
			const rec = await new Promise(res => { const q = indexedDB.open("dotz-snap", 1); q.onsuccess = () => { const g = q.result.transaction("conv").objectStore("conv").get("~home"); g.onsuccess = () => { q.result.close(); res(g.result); }; }; });
			window.__kept = { auth: rec.state.auth, asks: rec.notices.length };
		})()`);
		await waitFor(`window.__kept`);
		expect(await ev<{ auth: unknown[]; asks: number }>(`window.__kept`)).toEqual({ auth: [], asks: 1 });
		let release!: () => void;
		gate = stateGate = new Promise(r => { release = r; });
		histories = 0;
		await view.navigate(`${hub.origin}/`);
		await waitFor(`S && S.seeded && $("#home-now").textContent.includes("물어볼 게 있어요")`);
		expect(await ev<boolean>(`!NT.loaded`)).toBe(true);
		expect(histories).toBe(0);
		release();
		gate = stateGate = null;
		await waitFor(`S && !S.seeded && NT.loaded && ts("main").hLoaded`);
		expect(histories).toBeGreaterThan(0);
		extra = [];
	});

	test("a device that lost its pairing keeps no stored conversation, even as the page leaves", async () => {
		const view = await hub.view({ width: 390, height: 844 }, "/#chat/main");
		const { waitFor, ev } = on(view);
		await waitFor(`ts("main").hLoaded`);
		await storeSnapshot(view, MAIN.slice(-60));
		await ev(`(async () => { snapForget(); await snapSave("main"); return 1; })()`);
		await waitFor(`indexedDB.databases().then(l => !l.some(d => d.name === "dotz-snap"))`);
	});
});
