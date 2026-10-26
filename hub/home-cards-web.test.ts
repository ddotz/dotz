import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 홈 cards in a headless browser against a fake gateway that keeps the owner's card files in memory: 카드 추가 / 수정… / 삭제… write
// through /api/custom/cards with the gateway's error shown at its field, a card that failed to load keeps its ⋯ menu, a mouse drag
// that Esc cancels leaves the layout as it was, and on a phone (390px) a long press lifts a card and a drop reorders the column,
// while a finger that moves first scrolls. 앞으로 / 뒤로 옮기기 in the ⋯ menu does the same without a gesture.
const lanes = [{ name: "lane0", status: "idle", live: true, alive: true }];
type Spec = { title: string; text?: string; view?: string; note?: string };
let files: Record<string, Spec> = {};
let failNext = "";
const cardView = (id: string, s: Spec) => ({ id, file: `cards/${id}.json`, title: s.title, view: s.view ?? "text", ...(s.note ? { note: s.note } : {}), order: 0, render: false, rev: "1", actions: [], data: s.text });
const listed = () => [...Object.entries(files).map(([id, s]) => cardView(id, s)), { id: "broken", file: "cards/broken.json", error: "JSON을 읽을 수 없어요: Unexpected end" }];
const reset = () => {
	files = { memo: { title: "메모", text: "첫 줄" }, todo: { title: "할 일", view: "list", text: undefined } };
	failNext = "";
};

const live = process.env.DOTZ_WEB_LIVE;
beforeAll(() => { process.env.DOTZ_WEB_LIVE = "1"; });
afterAll(() => { if (live === undefined) delete process.env.DOTZ_WEB_LIVE; else process.env.DOTZ_WEB_LIVE = live; });

const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		if (p === "/custom.js") return new Response(Bun.file(new URL("../web/custom.js", import.meta.url).pathname), { headers: { "content-type": "text/javascript" } });
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: listed(), projects: [], routines: [], links: [], errors: [] });
		const m = /^\/api\/custom\/cards(?:\/([^/]+))?$/.exec(p);
		if (m) {
			const id = m[1] && decodeURIComponent(m[1]);
			if (failNext) { const e = failNext; failNext = ""; return json({ error: e }, 400); }
			if (req.method === "GET" && id) return files[id] ? json({ id, file: `cards/${id}.json`, spec: files[id] }) : json({ id, file: `cards/${id}.json`, raw: "{", error: "JSON을 읽을 수 없어요" });
			if (req.method === "DELETE" && id) { delete files[id]; return json({ ok: true, id }); }
			const b = (await req.json()) as Spec & { id?: string };
			const nid = id ?? b.id ?? `card-${Object.keys(files).length + 1}`;
			files[nid] = { title: b.title, text: b.text, view: b.view, note: b.note };
			return json(cardView(nid, files[nid]));
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

const view = new Bun.WebView({ width: 1100, height: 800 } as ConstructorParameters<typeof Bun.WebView>[0]);
afterAll(() => { view.close(); server.stop(true); });

const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else setTimeout(tick, 30); }; tick(); })`);
const frames = (n = 12) => view.evaluate(`new Promise(r => { let i = 0; const f = () => ++i >= ${n} ? r(1) : requestAnimationFrame(f); f(); })`);
const boot = async () => {
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await view.evaluate(`localStorage.clear()`);
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`current === "home" && S && document.querySelector('.bi[data-id="custom:memo"] .card')`);
	await frames();
};
// a reload that keeps the saved layout (boot clears it, so a check after boot only passed when the old page wrote it back in time)
const reload = async () => {
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`current === "home" && S && document.querySelector('.bi[data-id="custom:memo"] .card')`);
	await frames();
};
const order = () => view.evaluate(`homeBoard.order().join(",")`) as Promise<string>;
const layout = () => view.evaluate(`localStorage.getItem("dotz-board-home")`) as Promise<string | null>;
const clickText = (sel: string, text: string) => view.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(n => n.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error("no " + ${JSON.stringify(text)}); b.click(); })()`);
const fill = (field: string, value: string) => view.evaluate(`(() => { const i = document.querySelector('dialog[open] [data-f="${field}"] .fi'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const menuPick = async (id: string, label: string) => {
	await view.evaluate(`document.querySelector('.bi[data-id="${id}"] .ch .ib').click()`);
	await waitFor(`document.querySelector(".menu")`);
	await clickText(".menu .mi", label);
};

describe("홈 cards at 1100px", () => {
	test("카드 추가 writes a new card, which lands on the board; the gateway's error is shown at its field", async () => {
		reset();
		await view.resize?.(1100, 800);
		await boot();
		await clickText(".bbar .btn", "카드 추가");
		await waitFor(`document.querySelector('dialog[open] [data-f="title"] .fi')`);
		await fill("title", "새 카드");
		await fill("text", "내용");
		await fill("link", "ftp://x");
		failNext = "link는 https:// 또는 #으로 시작해야 해요";
		await clickText("dialog[open] .btn", "저장");
		await waitFor(`document.querySelector("dialog[open] .cu-ferr").textContent.startsWith("link")`);
		expect(await view.evaluate(`document.querySelector('dialog[open] [data-f="link"] .fi').getAttribute("aria-invalid")`)).toBe("true");
		await fill("link", "");
		await clickText("dialog[open] .btn", "저장");
		await waitFor(`!document.querySelector("dialog[open]") && document.querySelector('.bi[data-id="custom:card-3"] h3')`);
		expect(await view.evaluate(`document.querySelector('.bi[data-id="custom:card-3"] h3').textContent`)).toBe("새 카드");
		expect(files["card-3"]).toMatchObject({ title: "새 카드", text: "내용" });
	});

	test("수정… opens the card's file in the editor and saves it in place; 삭제… asks first, then removes it", async () => {
		reset();
		await boot();
		await menuPick("custom:memo", "수정…");
		await waitFor(`document.querySelector('dialog[open] [data-f="title"] .fi') && document.querySelector('dialog[open] [data-f="title"] .fi').value === "메모"`);
		await fill("title", "메모 2");
		await clickText("dialog[open] .btn", "저장");
		await waitFor(`document.querySelector('.bi[data-id="custom:memo"] h3').textContent === "메모 2"`);
		await menuPick("custom:memo", "삭제…");
		await waitFor(`document.querySelector("dialog[open]") && document.querySelector("dialog[open]").textContent.includes("cards/memo.json")`);
		await clickText("dialog[open] .btn", "삭제");
		await waitFor(`!document.querySelector('.bi[data-id="custom:memo"]')`);
		expect(files.memo).toBeUndefined();
	});

	test("a card that failed to load has the same header with a ⋯ menu offering 수정… and 삭제…; an empty card uses the built-in empty line", async () => {
		reset();
		await boot();
		await waitFor(`document.querySelector('.bi[data-id="custom:broken"] .card')`);
		const labels = (await view.evaluate(`dotzCustom.menuActs("broken").map(a => a.label)`)) as string[];
		expect(labels).toContain("수정…");
		expect(labels).toContain("삭제…");
		expect(labels).not.toContain("새로고침");
		expect(await view.evaluate(`!!document.querySelector('.bi[data-id="custom:broken"] .ch .ib') && document.querySelector('.bi[data-id="custom:broken"] .tag.err').textContent`)).toBe("오류");
		const same = JSON.parse((await view.evaluate(`JSON.stringify((() => {
			const s = sel => getComputedStyle(document.querySelector(sel));
			const pick = c => [c.paddingTop, c.paddingLeft, c.borderRadius, c.fontSize, c.color];
			return [pick(s('.bi[data-id="custom:todo"] .hc-none')), pick(s('.bi[data-id="notices:worklog"] .hc-none')), pick(s('.bi[data-id="custom:memo"] .card')), pick(s('.bi[data-id="main"] .card'))];
		})())`)) as string) as string[][];
		expect(same[0]).toEqual(same[1]);
		expect(same[2]).toEqual(same[3]);
	});

	test("Esc during a mouse drag puts the card back and saves nothing", async () => {
		reset();
		await boot();
		const before = await layout();
		await view.evaluate(`(async () => {
			const ev = (type, x, y, t) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX: x, clientY: y }));
			const raf = () => new Promise(r => requestAnimationFrame(r));
			const h = document.querySelector('.bi[data-id="custom:memo"] .ch h3'), r = h.getBoundingClientRect(), x = r.left + 5, y = r.top + 5;
			ev("pointerdown", x, y, h);
			for (let i = 1; i <= 6; i++) { ev("pointermove", x - 60 * i, y - 40 * i, window); await raf(); }
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			ev("pointerup", x - 360, y - 240, window);
			await raf();
		})()`);
		await frames();
		expect(await layout()).toBe(before);
		expect(await view.evaluate(`!!document.querySelector(".bi.bdrag") || document.body.classList.contains("boarding")`)).toBe(false);
	});
});

describe("홈 cards at 390px", () => {
	const touch = (type: string, x: number, y: number, target = "window") => `${target}.dispatchEvent(new PointerEvent("${type}", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: ${x}, clientY: ${y} }))`;
	const headAt = (id: string) => view.evaluate(`(() => { const r = document.querySelector('.bi[data-id="${id}"] .ch h3').getBoundingClientRect(); return [r.left + 5, r.top + r.height / 2]; })()`) as Promise<[number, number]>;

	test("a finger that moves before the long press scrolls: no card is lifted", async () => {
		reset();
		await view.resize?.(390, 844);
		await boot();
		await view.evaluate(`document.querySelector('.bi[data-id="custom:memo"]').scrollIntoView({ block: "center" })`);
		const [x, y] = await headAt("custom:memo");
		await view.evaluate(`(() => { const h = document.querySelector('.bi[data-id="custom:memo"] .ch h3'); ${touch("pointerdown", x, y, "h")}; })()`);
		expect(await view.evaluate(`document.querySelector('.bi[data-id="custom:memo"]').classList.contains("bpress")`)).toBe(true);
		await view.evaluate(touch("pointermove", x, y - 30));
		expect(await view.evaluate(`document.querySelector('.bi[data-id="custom:memo"]').className`)).not.toMatch(/bpress|bdrag/);
		await view.evaluate(touch("pointercancel", x, y - 30));
	});

	test("a long press lifts the card and a drop below the next card moves it one place down, kept across a reload", async () => {
		reset();
		await boot();
		const ids = (await order()).split(",");
		const i = ids.findIndex((id, k) => id.startsWith("custom:") && k < ids.length - 1), mover = ids[i], next = ids[i + 1];
		await view.evaluate(`document.querySelector('.bi[data-id="${mover}"]').scrollIntoView({ block: "center" })`);
		await frames();
		const [x, y] = await headAt(mover);
		await view.evaluate(`(() => { const h = document.querySelector('.bi[data-id="${mover}"] .ch h3'); ${touch("pointerdown", x, y, "h")}; })()`);
		await waitFor(`document.querySelector('.bi[data-id="${mover}"]').classList.contains("bdrag")`);
		const dy = (await view.evaluate(`document.querySelector('.bi[data-id="${next}"]').getBoundingClientRect().height + 20`)) as number;
		for (let k = 1; k <= 4; k++) { await view.evaluate(touch("pointermove", x, y + (dy * k) / 4)); await frames(2); }
		await view.evaluate(touch("pointerup", x, y + dy));
		// the drop is applied on the board's own frame: wait for the order it produces, not a fixed number of frames
		await waitFor(`homeBoard.order().indexOf(${JSON.stringify(mover)}) === ${i + 1} && !document.querySelector(".bdrag")`);
		const after = (await order()).split(",");
		expect(after.indexOf(mover)).toBe(i + 1);
		expect(after[i]).toBe(next);
		await reload();
		expect((await order()).split(",").indexOf(mover)).toBe(i + 1);
	});

	test("Esc while lifted puts the card back; 앞으로 / 뒤로 옮기기 in the ⋯ menu moves it one place", async () => {
		reset();
		await boot();
		const start = await order(), i = start.split(",").indexOf("custom:todo");
		await view.evaluate(`document.querySelector('.bi[data-id="custom:todo"]').scrollIntoView({ block: "center" })`);
		await frames();
		const [x, y] = await headAt("custom:todo");
		await view.evaluate(`(() => { const h = document.querySelector('.bi[data-id="custom:todo"] .ch h3'); ${touch("pointerdown", x, y, "h")}; })()`);
		await waitFor(`document.querySelector('.bi[data-id="custom:todo"]').classList.contains("bdrag")`);
		await view.evaluate(touch("pointermove", x, y - 300));
		await frames(2);
		await view.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
		await view.evaluate(touch("pointerup", x, y - 300));
		await frames();
		expect(await order()).toBe(start);
		expect(await view.evaluate(`document.querySelector('.bi[data-id="custom:todo"]').style.transform`)).toBe("");
		await menuPick("custom:todo", "앞으로 옮기기");
		await frames();
		expect((await order()).split(",").indexOf("custom:todo")).toBe(i - 1);
		await menuPick("custom:todo", "뒤로 옮기기");
		await frames();
		expect(await order()).toBe(start);
	});
});
