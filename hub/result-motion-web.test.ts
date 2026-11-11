import { afterAll, describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { fakeHub, idleState, inbox, json, on } from "./test-web.ts";

// Result motion (web/js/01-motion.js motionGone, pressWait, motionAfter): a card leaves only after the hub said yes, folds away while the
// rows under it glide up, and the rows that glide take no tap until they stand still. Every wait is on a page event or state, never a sleep.
// The hub's answer to a posted decision waits for the test: answer(status) settles the oldest open POST /api/message.
const posts = inbox<string>();
const replies = inbox<(status: number) => void>();
const answer = async (status: number) => { await replies.until(r => r.length > 0, 5000, "a waiting POST"); replies.shift()!(status); };
let history: unknown[] = [];
// The 알림 screen's hub: three past notices; a dismiss is answered only when the test settles the gate (status), so the page can be seen while it waits.
const nsSeed = () => ["p1", "p2", "p3"].map((id, i) => ({ id, cls: "alert", kind: "alert", tone: "", title: `지난 경고 ${i + 1}번`, text: `지난 경고 ${i + 1}번`, open: "alert", src: "alert",
	at: `2026-11-03T00:0${i}:00.000Z`, ts: `2026-11-03T00:0${i}:00.000Z`, updated: `2026-11-03T00:0${i}:00.000Z`, read: true }));
let nsRows = nsSeed();
const nsPosts = inbox<string>();
const nsGate = () => { let resolve!: (status: number) => void; const promise = new Promise<number>(r => { resolve = r; }); return { promise, resolve }; };
let nsAnswer = nsGate();
const hub = fakeHub({
	state: idleState(),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/message" && req.method === "POST") {
			posts.push(String(((await req.json()) as { text?: string }).text));
			const status = await new Promise<number>(r => replies.push(r));
			return status === 200 ? json({ ok: true }) : json({ error: "연결이 끊겼어요" }, status);
		}
		if (p === "/api/notices" && req.method === "GET") return json({ items: nsRows, unread: 0, gone: [] });
		const m = /^\/api\/notices\/([^/]+)\/dismiss$/.exec(p);
		if (!m || req.method !== "POST") return undefined;
		nsPosts.push(m[1]!);
		const status = await nsAnswer.promise;
		if (status !== 200) return json({ error: "안 됐어요" }, status);
		nsRows = nsRows.filter(n => n.id !== m[1]);
		return json({ ok: true, unread: 0 });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

// A plain list of three cards with a button each, drawn into the app page (the helpers are global there).
const LIST = `const box = document.createElement("div"); box.id = "rm-list"; box.style.cssText = "position:fixed;inset:0 auto auto 0;width:390px;z-index:99;background:var(--bg)";
	box.innerHTML = [1, 2, 3].map(i => '<div class="card rm-c" id="rm-' + i + '" style="height:120px"><button type="button" class="btn" id="rm-b' + i + '">보내기</button></div>').join("");
	document.body.append(box); window.rmHits = []; for (const b of box.querySelectorAll("button")) b.onclick = () => rmHits.push(b.id);`;
await view.navigate(`${hub.origin}/`);
await waitFor(`typeof motionGone === "function" && typeof S !== "undefined"`);
await run(`window.rmMM = matchMedia`);
const fresh = async (reduced = false) => {
	await run(`document.getElementById("rm-list")?.remove(); window.matchMedia = ${reduced ? `q => /reduced-motion/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : rmMM(q)` : "rmMM"}`);
	await run(LIST);
};

describe("motionGone", () => {
	test("the card leaves the DOM when its motion ends, the next card glides into its place and takes no tap while it moves", async () => {
		await fresh();
		const top1 = await ev<number>(`document.getElementById("rm-1").getBoundingClientRect().top`);
		const b1 = await ev<{ x: number; y: number }>(`(() => { const r = document.getElementById("rm-b1").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		// Subscribe to the end first, then start the leave.
		await run(`window.rmGone = new Promise(r => document.addEventListener("motion-gone", e => r(e.detail.el.id), { once: true })); window.rmLeave = motionGone(document.getElementById("rm-1"))`);
		// Mid-motion: card 1 is still there, lifted out and inert to taps; card 2 has its final box but is drawn where it was, and is inert.
		expect(await ev(`!!document.getElementById("rm-1") && document.getElementById("rm-1").dataset.gone === "1"`)).toBe(true);
		expect(await ev(`document.getElementById("rm-2").inert`)).toBe(true);
		expect(await ev(`document.getElementById("rm-2").getAnimations().length`)).toBe(1);
		// Held near its end, card 2's button is under the spot where card 1's button was: a real tap there must not press it.
		await run(`for (const a of document.getAnimations()) { a.pause(); a.currentTime = 200; }`);
		expect(await ev<number>(`Math.abs(document.getElementById("rm-b2").getBoundingClientRect().top - ${b1.y}) < 30`)).toBe(true);
		await view.click(b1.x, b1.y);
		expect(await ev(`rmHits`)).toEqual([]);
		await run(`for (const a of document.getAnimations()) a.finish()`);
		expect(await view.evaluate(`rmGone`)).toBe("rm-1");
		expect(await ev(`!!document.getElementById("rm-1")`)).toBe(false);
		expect(await ev(`document.getElementById("rm-2").inert`)).toBe(false);
		expect(await ev<number>(`Math.round(document.getElementById("rm-2").getBoundingClientRect().top)`)).toBe(Math.round(top1));
	});

	test("focus inside the leaving card goes to the card that took its place", async () => {
		await fresh();
		await run(`document.getElementById("rm-b1").focus(); window.rmGone = new Promise(r => document.addEventListener("motion-gone", () => r(1), { once: true })); motionGone(document.getElementById("rm-1"))`);
		await view.evaluate(`rmGone`);
		expect(await ev(`document.activeElement && document.activeElement.id`)).toBe("rm-b2");
	});

	test("with reduced motion the card is gone at once, without an animation", async () => {
		await fresh(true);
		await run(`window.rmN = 0; document.addEventListener("motion-gone", () => rmN++); motionGone(document.getElementById("rm-1"))`);
		expect(await ev(`[!!document.getElementById("rm-1"), rmN, document.getElementById("rm-2").getAnimations().length]`)).toEqual([false, 1, 0]);
	});

	test("a redraw of the list asked for while a card leaves waits for it, and only the last one runs", async () => {
		await fresh();
		await run(`window.rmDraws = []; const box = document.getElementById("rm-list"); window.rmGone = new Promise(r => document.addEventListener("motion-gone", () => r(1), { once: true })); motionGone(document.getElementById("rm-1"));
			window.rmWaited = [motionAfter(box, () => rmDraws.push("a")), motionAfter(box, () => rmDraws.push("b"))]`);
		expect(await ev(`[rmWaited, rmDraws]`)).toEqual([[true, true], []]);
		await view.evaluate(`rmGone`);
		expect(await ev(`rmDraws`)).toEqual(["b"]);
		expect(await ev(`motionAfter(document.getElementById("rm-list"), () => 0)`)).toBe(false);
	});

	test("pressWait keeps the width, says what it does, takes no second press, and its undo gives the button back", async () => {
		await fresh();
		const w = await ev<number>(`document.getElementById("rm-b1").offsetWidth`);
		await run(`window.rmUndo = pressWait(document.getElementById("rm-b1"), "보내는 중…")`);
		expect(await ev(`[document.getElementById("rm-b1").textContent, document.getElementById("rm-b1").disabled, document.getElementById("rm-b1").getAttribute("aria-busy")]`)).toEqual(["보내는 중…", true, "true"]);
		expect(await ev<number>(`document.getElementById("rm-b1").offsetWidth`)).toBeGreaterThanOrEqual(w);
		await run(`rmUndo()`);
		expect(await ev(`[document.getElementById("rm-b1").textContent, document.getElementById("rm-b1").disabled, document.getElementById("rm-b1").hasAttribute("aria-busy")]`)).toEqual(["보내기", false, false]);
	});
});

// The 알림 screen (31-notices-screen.js): the x of a past notice posts first; the row folds away only after the hub said yes.
describe("notices: result motion", () => {
	const row = (id: string) => `#v-notices .list[data-g="past"] .nsc-r[data-nid="${id}"]`;
	const xOf = (id: string) => `${row(id)} .nsc-x`;
	// The same three rows on the screen before every test (the page is the one the helper tests use).
	const open = async () => {
		nsRows = nsSeed(); nsPosts.length = 0; nsAnswer = nsGate();
		await run(`window.matchMedia = rmMM; document.getElementById("rm-list")?.remove(); document.querySelectorAll(".snack").forEach(n => n.remove()); go("notices"); loadNotices()`);
		await waitFor(`current === "notices" && NT.items.length === 3 && document.querySelectorAll("#v-notices .list[data-g] .nsc-r").length === 3`);
	};
	// The hub answers; on OK the page's end-of-motion event is subscribed first.
	const answer = async (status: number) => {
		if (status === 200) await run(`window.nsGone = new Promise(r => document.addEventListener("motion-gone", e => r(e.detail.el.dataset.nid), { once: true }))`);
		nsAnswer.resolve(status);
	};

	test("after the x and before the hub answers, the row is still there and its button is off", async () => {
		await open();
		await run(`document.querySelector(${JSON.stringify(xOf("p2"))}).click()`);
		await nsPosts.until(p => p.length === 1, 4000, "dismiss post");
		expect(await ev(`[!!document.querySelector(${JSON.stringify(row("p2"))}), document.querySelector(${JSON.stringify(xOf("p2"))}).disabled, document.querySelector(${JSON.stringify(xOf("p2"))}).getAttribute("aria-busy"), NT.items.length]`)).toEqual([true, true, "true", 3]);
		await answer(200);
		await view.evaluate(`nsGone`);
	});

	test("on OK the row leaves when its motion ends", async () => {
		await open();
		await run(`document.querySelector(${JSON.stringify(xOf("p2"))}).click()`);
		await nsPosts.until(p => p.length === 1, 4000, "dismiss post");
		await answer(200);
		expect(await view.evaluate(`nsGone`)).toBe("p2");
		expect(await ev(`[!!document.querySelector(${JSON.stringify(row("p2"))}), document.querySelectorAll("#v-notices .list[data-g=past] .nsc-r").length, NT.items.map(n => n.id)]`)).toEqual([false, 2, ["p1", "p3"]]);
	});

	test("on a failure the row stays, the failure toast shows and the button comes back", async () => {
		await open();
		await run(`document.querySelector(${JSON.stringify(xOf("p2"))}).click()`);
		await nsPosts.until(p => p.length === 1, 4000, "dismiss post");
		await answer(500);
		await waitFor(`document.querySelector(".snack.bad")`);
		expect(await ev(`[!!document.querySelector(${JSON.stringify(row("p2"))}), document.querySelector(${JSON.stringify(xOf("p2"))}).disabled, document.querySelector(${JSON.stringify(xOf("p2"))}).hasAttribute("aria-busy"), NT.items.length, document.querySelector(".snack.bad span").textContent]`)).toEqual([true, false, false, 3, "알림을 지우지 못했어요"]);
	});

	test("two quick taps send one request", async () => {
		await open();
		await run(`const b = document.querySelector(${JSON.stringify(xOf("p2"))}); b.click(); b.click()`);
		await nsPosts.until(p => p.length === 1, 4000, "dismiss post");
		await answer(200);
		await view.evaluate(`nsGone`);
		expect([...nsPosts]).toEqual(["p2"]);
	});

	test("with reduced motion the row is gone right after the answer, with no animation running", async () => {
		await open();
		await run(`window.matchMedia = q => /reduced-motion/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : rmMM(q)`);
		await run(`document.querySelector(${JSON.stringify(xOf("p2"))}).click()`);
		await nsPosts.until(p => p.length === 1, 4000, "dismiss post");
		await answer(200);
		expect(await view.evaluate(`nsGone`)).toBe("p2");
		expect(await ev(`[!!document.querySelector(${JSON.stringify(row("p2"))}), document.querySelector("#v-notices .nsc-l").getAnimations({ subtree: true }).length]`)).toEqual([false, 0]);
	});
});

// The decision dock above the composer (web/js/10-decision-card.js): a question with two choices in the main conversation.
const ASK_AT = "2026-11-11T01:00:00.000Z";
const askEvent = { ts: ASK_AT, kind: "out", source: "orchestrator", target: "main", text: "[ask] 어느 쪽으로 할까요?\n\n결정: 어느 쪽으로 할까요?\n**1) 왼쪽 길**\n가까워요.\n**2) 오른쪽 길**\n넓어요." };
const openDock = async (reduced = false) => {
	history = [askEvent];
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && typeof S !== "undefined" && S`);
	if (reduced) await run(`const real = matchMedia; window.matchMedia = q => /reduced-motion/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q)`);
	await run(`openTarget("main", "chat")`);
	await waitFor(`!document.getElementById("dcard").hidden && document.querySelectorAll("#dcard .dc-row").length === 2`);
};
const ownerAnswered = () => emit("inbox", { ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", target: "main", text: "1) 왼쪽 길" });

describe("decision dock: result motion", () => {
	test("before the hub answers the card stays with its rows off; two taps send one answer", async () => {
		await openDock();
		const n = posts.length;
		await run(`const b = document.querySelector("#dcard .dc-row"); b.click(); b.click()`);
		await posts.until(p => p.length === n + 1, 5000, "one POST /api/message");
		await waitFor(`[...document.querySelectorAll("#dcard .dc-row")].every(b => b.disabled)`);
		expect(await ev(`!document.getElementById("dcard").hidden`)).toBe(true);
		expect(posts.length).toBe(n + 1);
		await run(`window.dkGone = new Promise(r => document.addEventListener("motion-gone", e => r(e.detail.el.id), { once: true }))`);
		await answer(200);
		ownerAnswered();
		expect(await view.evaluate(`dkGone`)).toBe("dcard");
		expect(await ev(`[document.getElementById("dcard").hidden, document.getElementById("dcard").style.position, document.getElementById("dcard").hasAttribute("aria-hidden")]`)).toEqual([true, "", false]);
	});

	test("a refused answer keeps the card, says why, and gives the rows back", async () => {
		await openDock();
		await run(`document.querySelector("#dcard .dc-row").click()`);
		await waitFor(`[...document.querySelectorAll("#dcard .dc-row")].every(b => b.disabled)`);
		await answer(500);
		await waitFor(`!!document.querySelector(".snack.bad")`);
		await waitFor(`[...document.querySelectorAll("#dcard .dc-row")].every(b => !b.disabled)`);
		expect(await ev(`[document.getElementById("dcard").hidden, !!document.querySelector("#dcard [data-gone], #dcard[data-gone]")]`)).toEqual([false, false]);
	});

	test("with reduced motion the answered card is hidden at once", async () => {
		await openDock(true);
		await run(`document.querySelector("#dcard .dc-row").click(); window.dkN = 0; document.addEventListener("motion-gone", () => dkN++)`);
		await waitFor(`[...document.querySelectorAll("#dcard .dc-row")].every(b => b.disabled)`);
		await answer(200);
		ownerAnswered();
		await waitFor(`dkN === 1`);
		expect(await ev(`[document.getElementById("dcard").hidden, document.getElementById("dcard").getAnimations().length]`)).toEqual([true, 0]);
	});
});
