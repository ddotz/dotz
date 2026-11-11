import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, idleState, json, run, waitFor } from "./test-web.ts";
import { SPLIT_SHOTS } from "./split-shots.ts";

// Split panes (web/js/43-panes*.js) on a wide window: the second pane puts #split in place of the one section, the active pane holds the real
// #v-chat, the others are mirrors; the divider resizes, a closed pane gives the page back, an event for a pane that is not active lands in its mirror.
const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, i)).toISOString();
const lane = (name: string) => ({ name, status: "working", live: true, session: name });
const history = (target: string) => Array.from({ length: 6 }, (_, i) => ({ ts: at(i), kind: "out", source: "orchestrator", target, text: `${target} 답변 ${i}` }));
const hub = fakeHub({
	stream: "fake",
	state: () => idleState({ lanes: [lane("가나"), lane("다라")] }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") { const t = url.searchParams.get("target") ?? "main"; return json({ target: t, events: history(t) }); }
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

const open = async () => {
	const v = await hub.view({ width: 1280, height: 800 }, "/#chat");
	await waitFor(v, `target === "main" && CV.placed && tl.querySelectorAll(".bm").length >= 1`);
	return v;
};
const split = async (v: Awaited<ReturnType<typeof open>>, t: string, side = "right") => {
	await run(v, `paneSplit(${JSON.stringify(t)}, "chat", ${JSON.stringify(side)})`);
	await waitFor(v, `document.querySelectorAll("#split .pane").length === paneCount() && document.querySelector("#split .pane.on") && CV.placed`);
};

test("the second pane builds #split side by side, and two are the most", async () => {
	const v = await open();
	expect(await ev(v, `paneCount()`)).toBe(0);
	expect(await ev(v, `!document.querySelector("#split")`)).toBe(true);

	await split(v, "lane:가나");
	expect(await ev(v, `paneList().map(p => [p.t, p.active])`)).toEqual([["main", false], ["lane:가나", true]]);
	expect(await ev(v, `[document.querySelectorAll("#v-chat").length, document.querySelectorAll("#text").length, $("#split").contains($("#v-chat")), $("#split").contains(convSide)]`)).toEqual([1, 1, true, true]);
	expect(await ev(v, `target`)).toBe("lane:가나");
	expect(await ev(v, `$("#split .pane:not(.on) .pane-hd .cv-hd-t").textContent.trim()`)).toBe(await ev(v, `targetName("main")`));
	expect(await ev(v, `$("#split .pane:not(.on) .pane-tl").textContent.includes("main 답변 5")`)).toBe(true);

	expect(await ev(v, `[PN.root.dir, !!$("#split .pane-col")]`)).toEqual(["row", false]);
	expect(await ev(v, `paneSplit("lane:다라", "chat", "bottom")`)).toBe("");
	expect(await ev(v, `paneSplit("worklog", "chat", "right")`)).toBe("");
	expect(await ev(v, `paneCount()`)).toBe(2);
	expect(SPLIT_SHOTS.map(s => s.name)).toEqual(["drag", "two"]);
});

test("a pane that is already open takes the focus instead of a second copy", async () => {
	const v = await open();
	await split(v, "lane:가나");
	await run(v, `paneSplit("main", "chat", "right")`);
	await waitFor(v, `target === "main" && $("#split .pane.on").dataset.id === paneList().find(p => p.t === "main").id`);
	expect(await ev(v, `paneCount()`)).toBe(2);
	expect(await ev(v, `paneReplace(paneList().find(p => !p.active).id, "lane:다라", "chat")`)).toBe(true);
	await waitFor(v, `paneList().some(p => p.t === "lane:다라") && $("#split .pane:not(.on) .cv-hd-t").textContent.includes(targetName("lane:다라"))`);
});

test("the divider resizes within its limits and a double click makes it half and half", async () => {
	const v = await open();
	await split(v, "lane:가나");
	const share = `(() => { const [a, b] = [...$("#split .pane-row").children].filter(n => n.classList.contains("pane")).map(n => n.getBoundingClientRect().width); return a / (a + b); })()`;
	expect(Math.abs((await ev<number>(v, share)) - 0.5)).toBeLessThan(0.02);
	await run(v, `const bar = $("#split .pane-bar"), r = bar.getBoundingClientRect(), y = r.top + r.height / 2;
		const fire = (type, x) => bar.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
		bar.setPointerCapture = () => {};
		fire("pointerdown", r.left + r.width / 2); fire("pointermove", r.left - 150); fire("pointerup", r.left - 150);`);
	const moved = await ev<number>(v, share);
	expect(moved).toBeLessThan(0.45);
	expect(moved).toBeGreaterThanOrEqual(0.2);
	await run(v, `$("#split .pane-bar").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
	await waitFor(v, `Math.abs((${share}) - 0.5) < 0.02`);
});

test("closing the panes gives the page back as it was", async () => {
	const v = await open();
	await split(v, "lane:가나");
	await run(v, `paneClose(paneList().find(p => !p.active).id)`);
	await waitFor(v, `!document.querySelector("#split")`);
	expect(await ev(v, `[paneCount(), $("#views").contains($("#v-chat")), $("#v-chat").contains(convSide), $("#v-chat").classList.contains("in-pane"), current, target]`)).toEqual([1, true, true, false, "chat", "lane:가나"]);
	expect(await ev(v, `$("#v-chat").hidden`)).toBe(false);
});

// The panes take the chat list column's width (owner answer 8f7c8c3d): while the split is on the column is folded to nothing, and the list is a layer over
// the panes' left from the active pane's 목록 button, which moves neither pane.
const W_ = `(() => { const w = n => n.getBoundingClientRect().width, p = [...document.querySelectorAll("#split .pane")]; return { list: w(convSide), card: w($("#cv-head")), col: $("#split") ? w($("#split .pane-side")) : -1, panes: p.map(w) }; })()`;
const RECTS = `[...document.querySelectorAll("#split .pane")].map(n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })`;
type Sizes = { list: number; card: number; col: number; panes: number[] };

test("while split the list column is folded and the panes share its width; split off gives the column back", async () => {
	const v = await open();
	const before = await ev<Sizes>(v, W_);
	await split(v, "lane:가나");
	const after = await ev<Sizes>(v, W_);
	expect(after.col).toBe(0);
	expect(after.panes.reduce((a, b) => a + b, 0)).toBeCloseTo(before.list + before.card, 0);
	await run(v, `paneClose(paneList().find(p => !p.active).id)`);
	await waitFor(v, `!document.querySelector("#split") && CV.placed`);
	const back = await ev<Sizes>(v, W_);
	expect(Math.abs(back.list - before.list)).toBeLessThan(0.5);
});

test("the 목록 button opens the chat list over the panes without moving either; a pick closes it and opens in the active pane; Esc and a press outside close it", async () => {
	const v = await open();
	await split(v, "lane:가나");
	const rects = await ev<number[][]>(v, RECTS);
	const btn = await ev<number[]>(v, `(() => { const b = $("#split .pane.on .pane-ls"), r = b.getBoundingClientRect(); return [r.width, r.height, b.getAttribute("aria-label") === "대화 목록" ? 1 : 0]; })()`);
	expect(btn).toEqual([44, 44, 1]);
	await run(v, `$("#split .pane.on .pane-ls").click()`);
	await waitFor(v, `$("#split").classList.contains("ls-open") && convSide.getBoundingClientRect().width > 0`);
	const lay = await ev<number[][]>(v, RECTS);
	for (const [i, r] of rects.entries()) for (const [j, n] of r.entries()) expect(Math.abs(n - lay[i]![j]!)).toBeLessThan(0.5);
	expect(await ev(v, `Math.round(convSide.getBoundingClientRect().width)`)).toBe(280);
	await run(v, `document.querySelector('#chat-convo .cv-row[data-t="lane:다라"]').click()`);
	await waitFor(v, `!$("#split").classList.contains("ls-open") && target === "lane:다라"`);
	expect(await ev(v, `paneList().map(p => p.t + (p.active ? "*" : ""))`)).toEqual(["main", "lane:다라*"]);
	await run(v, `$("#split .pane.on .pane-ls").click()`);
	await waitFor(v, `$("#split").classList.contains("ls-open")`);
	await run(v, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
	await waitFor(v, `!$("#split").classList.contains("ls-open")`);
	await run(v, `$("#split .pane.on .pane-ls").click()`);
	await waitFor(v, `$("#split").classList.contains("ls-open")`);
	await run(v, `document.elementFromPoint(900, 400).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 900, clientY: 400, pointerId: 1, button: 0 }))`);
	await waitFor(v, `!$("#split").classList.contains("ls-open")`);
});

test("a message for a pane that is not active lands in its mirror; a notice for it is its head dot, not a toast", async () => {
	const connected = hub.nextStream();
	const v = await open();
	await connected;
	await split(v, "lane:가나");
	hub.push({ ts: at(30), kind: "out", source: "orchestrator", target: "main", text: "새 소식입니다" });
	await waitFor(v, `$("#split .pane:not(.on) .pane-tl").textContent.includes("새 소식입니다")`);
	await run(v, `paneFocus(paneList().find(p => p.t === "main").id)`);
	await waitFor(v, `target === "main" && CV.placed && tl.textContent.includes("새 소식입니다")`);
	hub.push({ ts: new Date().toISOString(), kind: "lane_report", lane: "가나", tone: "err", text: "확인이 필요해요" });
	await waitFor(v, `!$("#split .pane:not(.on) .pane-hd .dot").hidden`);
	expect(await ev(v, `$("#split .pane:not(.on) .pane-hd .dot").className`)).toContain("err");
	expect(await ev(v, `!document.querySelector(".ntf")`)).toBe(true);
});

test("the layout survives a reload; a narrow window shows the one section again", async () => {
	const v = await open();
	await split(v, "lane:가나");
	await v.navigate(`${hub.origin}/?again#chat`);
	await waitFor(v, `paneCount() === 2 && document.querySelectorAll("#split .pane").length === 2`);
	await v.resize(800, 800);
	await waitFor(v, `!document.querySelector("#split") && $("#views").contains($("#v-chat"))`);
	await v.resize(1280, 800);
	await waitFor(v, `document.querySelectorAll("#split .pane").length === 2`);
});

// A pane looks and measures the same whether it is the active one or not (docs/split-panes.md 비활성 칸): same head, timeline, composer frame and
// model / effort / context line, each pane with its own conversation's strips, and no outline around the active pane.
const todo = (text: string) => ({ phases: [{ name: "", tasks: [{ content: text, status: "in_progress" }] }] });
const sub = (id: string) => ({ id, status: "running", started_at: 1, description: id });
const long = (target: string) => Array.from({ length: 40 }, (_, i) => ({ ts: at(i), kind: "out", source: "orchestrator", target, text: `${target} 답변 ${i}` }));
const frameHub = fakeHub({
	stream: "fake",
	state: () => idleState({ lanes: [{ ...lane("가나"), status: "working" }, lane("다라")] }),
	api: (_req, url) => {
		const p = url.pathname, t = url.searchParams.get("target") ?? "main";
		if (p === "/api/history") return json({ target: t, events: long(t) });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/todo") return json(todo(t === "main" ? "왼쪽 할 일" : "오른쪽 할 일"));
		if (p === "/api/subagents") return json({ sources: { orchestrator: [sub("a1")], "lane:가나": [sub("b1"), sub("b2")] } });
		if (p === "/api/queue") return json({ items: [{ id: "q1", target: "main", text: "왼쪽 대기" }, { id: "q2", target: "lane:가나", text: "오른쪽 대기" }] });
		if (p === "/api/models") return json({ orchestrator: { model: "anthropic/claude-opus-5-5", thinking: "medium" }, lanes: [{ name: "가나", model: "anthropic/claude-sonnet-5-5", thinking: "high" }, { name: "다라", model: "anthropic/claude-sonnet-5-5", thinking: "low" }], pickable: [], available: [], thinking_levels: ["low", "medium", "high"] });
		if (p === "/api/context") return json({ processes: [{ name: "orchestrator", kind: "orchestrator", running: true, tokens: 80000, window: 200000, percent: 40 }, { name: "가나", kind: "lane", running: true, tokens: 140000, window: 200000, percent: 70 }], conversations: [] });
		return undefined;
	},
});
afterAll(() => frameHub.stop());

// What a pane measures, by its conversation: the rects (x, y, width, height; null while hidden) of the frame's parts, the timeline's scroll, the visible chips.
const MEASURE = `(() => {
	const r = n => { const b = n && n.getBoundingClientRect(); return b && (b.width || b.height) ? [b.x, b.y, b.width, b.height] : null; };
	const out = {};
	for (const p of paneList()) {
		const pane = document.querySelector('#split .pane[data-id="' + p.id + '"]'), q = s => pane.querySelector(s), msgs = pane.querySelectorAll(".tl-in .bm");
		out[p.t] = { active: pane.classList.contains("on"), scroll: q(".timeline").scrollTop, text: pane.textContent,
			rect: { title: r(q(".cv-head .cv-hd-t")), head: r(q(".cv-head")), timeline: r(q(".timeline")), message: r(msgs[msgs.length - 1]), todo: r(q(".todo")), subs: r(q(".runline .rs-subs")), queue: r(q(".qd")),
				runline: r(q(".runline")), composer: r(q(".composer")), input: r(q(".sendrow")), send: r(q(".sendrow > .ib")), chips: r(q(".cbar")) },
			chips: [...pane.querySelectorAll(".cbar .cchip")].filter(n => r(n)).map(n => n.textContent.trim()), strips: { todo: q(".todo").textContent, subs: q(".runline .rs-subs").textContent, queue: [...pane.querySelectorAll(".timeline .qd")].map(n => n.textContent).join("|") } };
	}
	return out; })()`;
type Rect = number[] | null;
type Frame = { active: boolean; scroll: number; text: string; rect: Record<string, Rect>; chips: string[]; strips: Record<string, string> };
const measure = (v: Awaited<ReturnType<typeof open>>) => ev<Record<string, Frame>>(v, MEASURE);
// Every rect of a pane that moved by more than half a pixel between two measurements, with how far.
const moved = (a: Frame, b: Frame) => {
	const out: Record<string, number> = {};
	for (const k of Object.keys(a.rect)) {
		const [x, y] = [a.rect[k], b.rect[k]];
		const d = x && y ? Math.max(...x.map((n, i) => Math.abs(n - y[i]!))) : x === y ? 0 : 99999;
		if (d > 0.5) out[k] = Math.round(d * 10) / 10;
	}
	if (Math.abs(a.scroll - b.scroll) > 0.5) out.scroll = Math.round(Math.abs(a.scroll - b.scroll));
	return out;
};
const frameOpen = async () => {
	const v = await frameHub.view({ width: 1280, height: 800 }, "/#chat");
	await waitFor(v, `target === "main" && CV.placed && tl.querySelectorAll(".bm").length >= 40 && !!M && !!C && TD.by.main && Object.keys(SUBS).length === 2 && QUEUE.length === 2`);
	await run(v, `paneSplit("lane:가나", "chat", "right")`);
	await waitFor(v, `paneCount() === 2 && target === "lane:가나" && CV.placed && !!document.querySelector("#split .pane:not(.on) .pane-chat .cbar .cchip:not([hidden])") && TD.by["lane:가나"] && $("#split .pane.on .todo").textContent.includes("오른쪽") && $("#split .pane.on .cv-head .cv-hd-t").textContent.trim() === targetName(target)`);
	return v;
};
const focusPane = async (v: Awaited<ReturnType<typeof open>>, t: string) => {
	await run(v, `paneFocus(paneList().find(p => p.t === ${JSON.stringify(t)}).id)`);
	await waitFor(v, `target === ${JSON.stringify(t)} && CV.placed && !!document.querySelector("#split .pane:not(.on) .pane-chat .cbar .cchip:not([hidden])") && $("#split .pane.on .todo").textContent.length > 0 && $("#split .pane.on .cv-head .cv-hd-t").textContent.trim() === targetName(target)`);
};

test("moving the active pane changes nothing in either pane: head, timeline, message, composer, info line and strips stay put", async () => {
	const v = await frameOpen();
	const right = await measure(v);
	await focusPane(v, "main");
	const left = await measure(v);
	expect([right["main"]!.active, right["lane:가나"]!.active, left["main"]!.active, left["lane:가나"]!.active]).toEqual([false, true, true, false]);
	expect(moved(right["main"]!, left["main"]!)).toEqual({});
	expect(moved(right["lane:가나"]!, left["lane:가나"]!)).toEqual({});
	// the model / effort / context line is there in both panes at once, with the pane's own conversation's values
	for (const f of [right, left]) {
		expect(f["main"]!.rect.chips).not.toBeNull();
		expect(f["lane:가나"]!.rect.chips).not.toBeNull();
		expect(f["main"]!.chips.some(c => c.includes("40%"))).toBe(true);
		expect(f["lane:가나"]!.chips.some(c => c.includes("70%"))).toBe(true);
		expect(f["main"]!.chips).not.toEqual(f["lane:가나"]!.chips);
	}
	expect(right["main"]!.chips).toEqual(left["main"]!.chips);
	expect(right["lane:가나"]!.chips).toEqual(left["lane:가나"]!.chips);
});

test("each pane shows its own conversation's todo strip, subagent line and queue, active or not", async () => {
	const v = await frameOpen();
	for (const side of ["lane:가나", "main"]) {
		if (side === "main") await focusPane(v, "main");
		const f = await measure(v);
		const [l, r] = [f["main"]!.strips, f["lane:가나"]!.strips];
		expect([l.todo.includes("왼쪽 할 일"), l.todo.includes("오른쪽"), l.queue.includes("왼쪽 대기"), l.queue.includes("오른쪽"), l.subs.includes("1"), l.subs.includes("2")]).toEqual([true, false, true, false, true, false]);
		expect([r.todo.includes("오른쪽 할 일"), r.todo.includes("왼쪽"), r.queue.includes("오른쪽 대기"), r.queue.includes("왼쪽"), r.subs.includes("2"), r.subs.includes("1")]).toEqual([true, false, true, false, true, false]);
		expect(f["main"]!.text.includes("오른쪽 할 일")).toBe(false);
		expect(f["lane:가나"]!.text.includes("왼쪽 할 일")).toBe(false);
	}
});

// What each pane's message box and send button show, by its conversation (the same query for the active pane and the mirrors).
const COMPOSER = `(() => {
	const out = {};
	for (const p of paneList()) {
		const pane = document.querySelector('#split .pane[data-id="' + p.id + '"]'), ta = pane.querySelector("textarea"), b = pane.querySelector(".sendrow > .ib"), cs = getComputedStyle(b);
		out[p.t] = { placeholder: ta.placeholder, look: [cs.backgroundColor, cs.color, cs.opacity], disabled: b.disabled, inert: b.getAttribute("aria-disabled"), tab: b.tabIndex };
	}
	return out; })()`;
type Cmp = { placeholder: string; look: string[]; disabled: boolean; inert: string | null; tab: number };

test("each pane's message box names its own conversation, and the same one whether its pane is active or not", async () => {
	const v = await frameOpen();
	const right = await ev<Record<string, Cmp>>(v, COMPOSER);
	await focusPane(v, "main");
	const left = await ev<Record<string, Cmp>>(v, COMPOSER);
	expect(right["main"]!.placeholder).toContain(await ev(v, `targetName("main")`));
	expect(right["lane:가나"]!.placeholder).not.toBe(right["main"]!.placeholder);
	expect(right["main"]!.placeholder).toBe(left["main"]!.placeholder);
	expect(right["lane:가나"]!.placeholder).toBe(left["lane:가나"]!.placeholder);
});

test("a pane's send button looks the same active or not (stop look included) and the inactive one is inert without `disabled`", async () => {
	const v = await frameOpen();
	const right = await ev<Record<string, Cmp>>(v, COMPOSER);
	await focusPane(v, "main");
	const left = await ev<Record<string, Cmp>>(v, COMPOSER);
	expect(right["main"]!.look).toEqual(left["main"]!.look);
	expect(right["lane:가나"]!.look).toEqual(left["lane:가나"]!.look);
	// the working conversation has the stop look, the idle one does not: the comparison above is not between two identical buttons
	expect(right["main"]!.look).not.toEqual(right["lane:가나"]!.look);
	// the mirror's button (main on the right state, lane:가나 on the left state)
	expect([right["main"]!.disabled, right["main"]!.inert, right["main"]!.tab]).toEqual([false, "true", -1]);
	expect([left["lane:가나"]!.disabled, left["lane:가나"]!.inert, left["lane:가나"]!.tab]).toEqual([false, "true", -1]);
});

test("the active pane has no accent outline, border or shadow; the others' title is --fg-3; switching starts no animation", async () => {
	const v = await frameOpen();
	const look = `(() => {
		const pane = $("#split .pane.on"), cs = getComputedStyle(pane), after = getComputedStyle(pane, "::after"), probe = document.body.appendChild(document.createElement("i")), c = v => (probe.style.color = v, getComputedStyle(probe).color);
		const out = { shadow: cs.boxShadow, outline: cs.outlineStyle, border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth], after: [after.content, after.boxShadow],
			quiet: getComputedStyle($("#split .pane:not(.on) .cv-hd-t")).color === c("var(--fg-3)"), strong: getComputedStyle($("#split .pane.on .cv-hd-t")).color === c("var(--fg)") };
		probe.remove(); return out; })()`;
	expect(await ev(v, look)).toEqual({ shadow: "none", outline: "none", border: ["0px", "0px", "0px", "0px"], after: ["none", "none"], quiet: true, strong: true });
	await run(v, `paneFocus(paneList().find(p => p.t === "main").id)`);
	// right after the switch, before any frame: no transition or animation that ends is running in the panes
	expect(await ev(v, `document.getAnimations().filter(a => a.effect && a.effect.getTiming().iterations !== Infinity && a.effect.target && a.effect.target.closest("#split")).map(a => a.transitionProperty || a.animationName)`)).toEqual([]);
});

test("a click in an inactive pane's composer makes it the active one with the caret in the box", async () => {
	const v = await frameOpen();
	await run(v, `$("#split .pane:not(.on) .sendrow").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }))`);
	await waitFor(v, `target === "main" && CV.placed && document.activeElement === $("#text") && $("#split .pane.on").contains($("#text"))`);
});
