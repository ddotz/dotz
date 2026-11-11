import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { realSetTimeout, realClearTimeout } from "./runtime/test-clock.ts";
import { fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The review queue (web/js/30-triage.js, key "*"): every waiting draft of every comment app and mail app, one card at a time, answered with
// Enter/1, 2/E, 3/X and moved with the arrows, run in a headless browser against a stubbed /api/approvals. Names and texts are placeholders.
type Req = { method: string; path: string; body: Record<string, unknown> | null };
const at = Date.UTC(2026, 9, 22, 3, 0);
const COMMENT = { source: "유튜브 댓글", post: "첫 번째 영상", link: null, who: "김민영-x9b", text: "문서 파일을 보내 주실 수 있을까요?", at, mailMark: { state: "drafted", label: "메일 초안 작성됨" } };
const CARDS = [
	{ ref: "Dxyz789", to: "main", group: "i:youtube", sendable: true, notice: "n1", kind: "comment", comment: COMMENT, info: [], question: "이 답글을 올리고 메일도 보낼까요? (Dxyz789)",
		draft: { toLabel: "대상", to: "김민영-x9b 댓글", body: "메일로 보내 드렸어요.", mail: { to: "kim@example.com", subject: "문서 파일", body: "첨부합니다.", attachments: [{ name: "독서3부.pdf", size: "1.2MB" }] } } },
	{ ref: "Rxyz234", to: "main", group: "i:mail", sendable: true, kind: "mail", info: [], question: "이 메일 답장을 보낼까요? (Rxyz234)",
		draft: { toLabel: "받는이", to: "teacher@example.com", subject: "Re: 회의 수업 문의", body: "문서를 확인해 주세요.", attachments: [{ name: "문서.pdf", size: "820KB" }] } },
	{ ref: "Dabc234", to: "main", group: "i:youtube", sendable: true, kind: "comment", comment: { ...COMMENT, who: "마바", text: "영어 자막도 있나요?", mailMark: undefined }, info: [], question: "이 답글 올릴까요? (Dabc234)",
		draft: { toLabel: "대상", to: "마바 댓글", body: "준비 중이에요." } },
];
const GROUPS = [{ key: "i:youtube", label: "유튜브", count: 2, cards: [CARDS[0], CARDS[2]] }, { key: "i:mail", label: "메일", count: 1, cards: [CARDS[1]] }];
let reqs: Req[] = [];
let hold: Promise<void> | null = null;   // a POST waits for this before it answers
let failNext = false;
let waiters: { n: number; res: () => void }[] = [];
const arrived = (n: number): Promise<void> => {
	if (reqs.length >= n) return Promise.resolve();
	return new Promise((res, rej) => {
		const t = realSetTimeout(() => rej(new Error(`only ${reqs.length} of ${n} answers arrived`)), 3500);
		waiters.push({ n, res: () => { realClearTimeout(t); res(); } });
	});
};
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/approvals" && req.method === "GET") return json({ groups: GROUPS, results: [], triageMin: 2 });
		if (p === "/api/approvals" && req.method === "POST") {
			reqs.push({ method: "POST", path: p, body: (await req.json()) as Record<string, unknown> });
			waiters = waiters.filter(w => (reqs.length >= w.n ? (w.res(), false) : true));
			if (hold) await hold;
			if (failNext) { failNext = false; return json({ error: "fail-text" }); }
			return json({ ok: true, sending: 1, toBot: 0 });
		}
		if (p === "/api/drafts/Rxyz234/original") return json({ kind: "mail", from: "teacher@example.com", subject: "회의 수업 문의", text: "문서를 받을 수 있을까요?" });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/replies") return json({ items: [], failed: [], sent: [], stops: {} });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/integrations") return json({ items: [] });
	},
});
afterAll(() => { hub.stop(); });
beforeEach(() => { reqs = []; waiters = []; hold = null; failNext = false; });

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const key = (v: View, k: string) => run(v, `document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true }))`);
const pos = (v: View) => q<string>(v, `return document.querySelector(".tr-pos").firstChild.textContent`);
const boot = async (v: View) => {
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof TR !== "undefined" && S`);
	await run(v, `trLoad()`);
	await waitFor(v, `TR.groups.length === 2`);
	await run(v, `trOpen("*")`);
	await waitFor(v, `TR.h && document.querySelector(".tr .tr-body")`);
};

const GROUPS_READY = `typeof TR !== "undefined" && S && RQ.loaded && TR.groups.length === 2`;
const openQueue = async (v: View) => {
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof TR !== "undefined" && S && RQ.loaded && NM.loaded`);
	await run(v, `trLoad()`);
	await waitFor(v, GROUPS_READY);
	await run(v, `go("monitoring", RQ_KEY)`);
	await waitFor(v, `current === "monitoring" && MON.sel === RQ_KEY && document.querySelectorAll(".rq-r").length === 3 && document.querySelector(".rq-fast:not([hidden])")`);
};
type Frame = { x: number; r: number; t: number; h: number; hdPl: number; hdPr: number; hdPt: number; hdPb: number; bodyPl: number; bodyPr: number; btnX: number };
// the box of a screen in the right column and its insets, relative to its own left edge, so two screens compare without pinning a number
const frame = (v: View, sel: string) => q<Frame>(v, `const root = document.querySelector(${JSON.stringify(sel)}), b = root.getBoundingClientRect(), cs = e => getComputedStyle(e), hd = cs(root.querySelector(".fs-hd")), body = cs(root.querySelector(".rq-sb, .fs-body")), btn = root.querySelector(".rq-acts button, .tr-acts button");
	return { x: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), h: Math.round(b.height), hdPl: parseFloat(hd.paddingLeft), hdPr: parseFloat(hd.paddingRight), hdPt: parseFloat(hd.paddingTop), hdPb: parseFloat(hd.paddingBottom), bodyPl: parseFloat(body.paddingLeft), bodyPr: parseFloat(body.paddingRight), btnX: Math.round(btn.getBoundingClientRect().left - b.left) }`);
const TRBOX = ".tr-pane, .fs-card.tr";
const still = (v: View) => waitFor(v, `document.getAnimations().length === 0`);

describe("빠른 처리 in the 모니터링 frame at 1280", async () => {
	const v = await hub.view({ width: 1280, height: 900 });

	test("opens in the right column with the reply card's edges and insets, the list stays at the left, and there is no backdrop", async () => {
		await openQueue(v);
		await run(v, `document.querySelector(".rq-r .tx").click()`);
		await waitFor(v, `RQ.sheet && RQ.sheet.pane && document.querySelector(".rq-pane .rq-acts")`);
		await still(v);
		const reply = await frame(v, ".rq-pane");
		await run(v, `RQ.sheet.close()`);
		await waitFor(v, `!RQ.sheet && !document.querySelector(".rq-pane") && document.querySelectorAll(".rq-r").length === 3`);
		await run(v, `document.querySelector(".rq-fast").click()`);
		await waitFor(v, `TR.h && document.querySelector(".tr-acts") && document.querySelector(".tr-ta")`);
		await still(v);
		const tr = await frame(v, TRBOX);
		expect({ x: tr.x, r: tr.r, t: tr.t }).toEqual({ x: reply.x, r: reply.r, t: reply.t });
		expect({ hdPl: tr.hdPl, hdPr: tr.hdPr, hdPt: tr.hdPt, hdPb: tr.hdPb, bodyPl: tr.bodyPl, bodyPr: tr.bodyPr, btnX: tr.btnX }).toEqual({ hdPl: reply.hdPl, hdPr: reply.hdPr, hdPt: reply.hdPt, hdPb: reply.hdPb, bodyPl: reply.bodyPl, bodyPr: reply.bodyPr, btnX: reply.btnX });
		const side = await q<{ backdrops: number; on: string; w: number; inView: boolean }>(v, `const row = document.querySelector("#mon-side .cv-row.on"), b = row.getBoundingClientRect(); return { backdrops: document.querySelectorAll(".fs-bd, dialog[open]").length, on: row.textContent, w: b.width, inView: b.left >= 0 && b.right <= innerWidth }`);
		expect(side.backdrops).toBe(0);
		expect(side.on).toContain("답장 대기");
		expect(side.w).toBeGreaterThan(0);
		expect(side.inView).toBe(true);
	});

	test("the row of the card being answered is the marked one; Esc, the app's back and the browser's back each close it one step", async () => {
		await openQueue(v);
		await run(v, `document.querySelector(".rq-fast").click()`);
		await waitFor(v, `TR.h && document.querySelector(".tr-acts")`);
		await key(v, "ArrowRight");
		const ref = await q<string>(v, `return TR.items[TR.i].ref`);
		expect(await q<string>(v, `return RQ.mark`)).toBe(`t:main|${ref}`);
		const close = {
			esc: `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`,
			back: `document.querySelector("#back").click()`,
			history: `history.back()`,
		};
		for (const how of ["esc", "back", "history"] as const) {
			await run(v, close[how]);
			await waitFor(v, `!TR.h && !RQ.sheet && document.querySelectorAll(".rq-r").length === 3`);
			const st = await q<{ current: string; sel: string; marked: string[] }>(v, `return { current, sel: MON.sel, marked: [...document.querySelectorAll(".rq-r.on")].map(r => r.dataset.qr) }`);
			expect(st).toEqual({ current: "monitoring", sel: "replies", marked: [`t:main|${ref}`] });
			if (how !== "history") { await run(v, `document.querySelector(".rq-fast").click()`); await waitFor(v, `TR.h && document.querySelector(".tr-acts")`); await key(v, "ArrowRight"); }   // opened again at the first card: the same one as before is the second
		}
	});

	test("the shortcuts answer from the screen but stay silent while a text field elsewhere holds the focus", async () => {
		await openQueue(v);
		await run(v, `document.querySelector(".rq-fast").click()`);
		await waitFor(v, `TR.h && document.querySelector(".tr-acts")`);
		await run(v, `const i = document.createElement("input"); i.id = "elsewhere"; document.body.append(i); i.focus();
			for (const init of [{ key: "1" }, { key: "x" }, { key: "ArrowRight" }, { key: "Enter", metaKey: true }]) i.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }))`);
		expect(await pos(v)).toBe("1/3");
		expect(reqs).toHaveLength(0);
		await run(v, `document.querySelector("#elsewhere").remove(); TR.h.box.focus()`);
		await run(v, `TR.h.box.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }))`);
		await arrived(1);
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "2/3"`);
		expect(reqs[0]!.body).toEqual({ items: [{ ref: "Dxyz789", to: "main", n: 1, label: "보내기" }] });
		await run(v, `TR.h.close()`);
	});
});

describe("빠른 처리 list choices", async () => {
	const v = await hub.view({ width: 390, height: 844 });
	const openList = async () => {
		await openQueue(v);
		await run(v, `document.querySelector(".rq-fast").click()`);
		await waitFor(v, `TR.h && document.querySelector(".tr-acts")`);
		await run(v, `document.querySelector(".tr-tog").click()`);
		await waitFor(v, `document.querySelectorAll(".tr-row .tr-seg").length === 3`);
	};

	test("at 390 it is the whole screen, with no key hint and every action at least 44 tall", async () => {
		await openQueue(v);
		await run(v, `document.querySelector(".rq-fast").click()`);
		await waitFor(v, `TR.h && document.querySelector(".tr-acts")`);
		await still(v);
		const one = await q<{ box: number[]; vw: number; vh: number; backdrop: number; hint: string; small: string[] }>(v, `const r = document.querySelector(".fs-card.tr").getBoundingClientRect(), k = document.querySelector(".tr-keys");
			return { box: [r.left, r.top, r.width, r.height].map(Math.round), vw: innerWidth, vh: innerHeight, backdrop: document.querySelectorAll(".tr-pane").length, hint: k ? getComputedStyle(k).display : "none", small: [...document.querySelectorAll(".tr button, .tr textarea")].filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).map(b => b.className + ":" + b.textContent.trim()) }`);
		expect(one.box).toEqual([0, 0, one.vw, one.vh]);
		expect(one.backdrop).toBe(0);
		expect(one.hint).toBe("none");
		expect(one.small.filter(s => !s.startsWith("tr-ta") && !s.includes("tr-tog") && !s.includes("fs-x") && !s.includes("tr-note"))).toEqual([]);
		await run(v, `document.querySelector(".tr-tog").click()`);
		await waitFor(v, `document.querySelectorAll(".tr-row .tr-seg").length === 3`);
		const list = await q<{ hint: string; segs: { h: number; cls: string; bg: string; w: number }[] }>(v, `const k = document.querySelector(".tr-keys"); return { hint: k ? getComputedStyle(k).display : "none", segs: [...document.querySelectorAll(".tr-row")[0].querySelectorAll(".tr-sg")].map(b => ({ h: Math.round(b.getBoundingClientRect().height), cls: b.className, bg: getComputedStyle(b).backgroundColor, w: Math.round(b.getBoundingClientRect().width) })) }`);
		expect(list.hint).toBe("none");
		expect(list.segs).toHaveLength(3);
		for (const sg of list.segs) expect(sg.h).toBeGreaterThanOrEqual(44);
		expect(new Set(list.segs.map(sg => sg.cls)).size).toBe(1);   // one control for the three choices, none of them filled before a press
		expect(new Set(list.segs.map(sg => sg.bg)).size).toBe(1);
		expect(new Set(list.segs.map(sg => sg.w)).size).toBe(1);
		await run(v, `TR.h.close()`);
	});

	test("no choice is marked before a press, and the third choice only leaves the card waiting: its word says so and it posts nothing", async () => {
		await openList();
		const before = await q<{ marked: number; words: string[]; checked: string[] }>(v, `return { marked: document.querySelectorAll(".tr-sg.on").length, words: [...document.querySelectorAll(".tr-row")[0].querySelectorAll(".tr-sg")].map(b => b.textContent), checked: [...document.querySelectorAll(".tr-sg")].map(b => b.getAttribute("aria-checked")).filter(c => c === "true") }`);
		expect(before.marked).toBe(0);
		expect(before.checked).toEqual([]);
		expect(before.words).toEqual(["보내기", "고치기", "건너뛰기"]);
		await run(v, `const rows = document.querySelectorAll(".tr-row"); rows[0].querySelectorAll(".tr-sg")[2].click()`);
		await waitFor(v, `document.querySelectorAll(".tr-row")[0].querySelectorAll(".tr-sg")[2].getAttribute("aria-checked") === "true"`);
		await run(v, `document.querySelectorAll(".tr-row")[1].querySelectorAll(".tr-sg")[0].click()`);
		await waitFor(v, `!document.querySelector(".tr-batch").disabled`);
		await run(v, `document.querySelector(".tr-batch").click()`);
		await arrived(1);
		expect(reqs).toHaveLength(1);
		expect(reqs[0]!.body).toEqual({ items: [{ ref: "Dabc234", to: "main", n: 1, label: "보내기" }] });   // the skipped card (Dxyz789) and the unchosen one are not in it
		await run(v, `TR.h.close()`);
	});
});

describe("review queue", async () => {
	const v = await hub.view({ width: 390, height: 844 });

	test("a comment card shows the post, the quoted comment with who and when, the linked mail and its files above the draft", async () => {
		await boot(v);
		expect(await pos(v)).toBe("1/3");
		const s = await q<{ ctx: string; mark: string; mail: string; files: string; order: boolean; buttons: string[] }>(v, `
			const ctx = document.querySelector(".tr-cmt"), ta = document.querySelector(".tr-ta");
			return { ctx: ctx.textContent, mark: ctx.querySelector(".tag").textContent, mail: document.querySelector(".tr-mail").textContent, files: document.querySelector(".tr-mail .tr-file").textContent,
				order: !!(ctx.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING), buttons: [...document.querySelectorAll(".tr-acts .tr-b")].map(b => b.textContent) }`);
		expect(s.ctx).toContain("첫 번째 영상");
		expect(s.ctx).toContain("김민영-x9b");
		expect(s.ctx).toContain("10. 22. 오후 12:00");
		expect(s.ctx).toContain("문서 파일을 보내 주실 수 있을까요?");
		expect(s.mark).toBe("메일 초안 작성됨");
		expect(s.mail).toContain("kim@example.com");
		expect(s.files).toBe("독서3부.pdf (1.2MB)");
		expect(s.order).toBe(true);
		expect(s.buttons).toEqual(["보내기", "고치기", "보내지 않기"]);
		expect(await q<string>(v, `return document.querySelector(".tr-ft").textContent`)).not.toContain("null");   // a missing hint is no node, not the word null
	});

	test("1 sends and moves on at once, X drops, the mail card shows the incoming mail, and the end shows what happened", async () => {
		await boot(v);
		await key(v, "1");
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "2/3"`);
		await arrived(1);
		expect(reqs.map(r => r.body)).toEqual([{ items: [{ ref: "Dxyz789", to: "main", n: 1, label: "보내기" }] }]);
		await key(v, "x");
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "3/3"`);
		await arrived(2);
		expect(reqs[1]!.body).toEqual({ items: [{ ref: "Dabc234", to: "main", n: 3, label: "보내지 않기" }] });
		await waitFor(v, `document.querySelector(".tr-org .tr-otx") && document.querySelector(".tr-org .tr-otx").textContent.includes("문서를 받을 수 있을까요?")`);
		await key(v, "Enter");
		await waitFor(v, `document.querySelector(".tr-sumlist")`);
		await arrived(3);
		expect(reqs[2]!.body).toEqual({ items: [{ ref: "Rxyz234", to: "main", n: 1, label: "보내기" }] });
		const rows = await q<string[]>(v, `return [...document.querySelectorAll(".tr-sumlist li")].map(li => li.textContent)`);
		expect(rows).toEqual(["보내지 않았어요1건", "보내는 중2건"]);
	});

	test("2 asks what to change and sends the note; the arrows only move between cards", async () => {
		await boot(v);
		await key(v, "ArrowRight");
		expect(await pos(v)).toBe("2/3");
		await key(v, "k");
		expect(await pos(v)).toBe("1/3");
		await key(v, "2");
		await waitFor(v, `document.querySelector(".tr-note")`);
		await run(v, `const t = document.querySelector(".tr-note"); t.value = "더 짧게"; t.dispatchEvent(new Event("input")); document.querySelector(".tr-go").click()`);
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "2/3"`);
		await arrived(1);
		expect(reqs).toHaveLength(1);
		expect(reqs[0]!.body).toEqual({ items: [{ ref: "Dxyz789", to: "main", n: 2, label: "고치기", note: "더 짧게" }] });
	});

	test("a press waits for the answer: buttons stay in place disabled, one request on a double press, the next card only after it", async () => {
		await boot(v);
		await waitFor(v, `document.querySelector(".fs-bd").getAnimations({ subtree: true }).every(a => a.playState !== "running")`);   // the phone sheet slides up for 220 ms: a button read mid-slide sits lower than it does at rest
		let release = () => {};
		hold = new Promise<void>(res => { release = res; });
		const before = await q<number[]>(v, `return [...document.querySelectorAll(".tr-acts .tr-b")].map(b => Math.round(b.getBoundingClientRect().top))`);
		await run(v, `const b = document.querySelector(".tr-go"); b.click(); b.click()`);
		await waitFor(v, `document.querySelector(".tr-go").disabled`);
		const mid = await q<{ pos: string; tops: number[]; off: boolean[]; done: string }>(v, `return { pos: document.querySelector(".tr-pos").firstChild.textContent, tops: [...document.querySelectorAll(".tr-acts .tr-b")].map(b => Math.round(b.getBoundingClientRect().top)), off: [...document.querySelectorAll(".tr-acts .tr-b")].map(b => b.disabled), done: document.querySelector(".tr-sum").textContent }`);
		expect(mid.pos).toBe("1/3");
		expect(mid.tops).toEqual(before);
		expect(mid.off).toEqual([true, true, true]);
		expect(mid.done).toContain("0건");
		release();
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "2/3"`);
		expect(reqs).toHaveLength(1);
	});

	test("a failed answer keeps the owner on that card, uncounted, with the reason in the footer and the buttons usable again", async () => {
		await boot(v);
		failNext = true;
		await run(v, `document.querySelector(".tr-go").click()`);
		await waitFor(v, `document.querySelector(".tr-fail")`);
		const s = await q<{ pos: string; done: string; off: boolean; chip: boolean; fail: string }>(v, `return { pos: document.querySelector(".tr-pos").firstChild.textContent, done: document.querySelector(".tr-sum").textContent, off: document.querySelector(".tr-go").disabled, chip: !!document.querySelector(".tr-q .tr-st.err"), fail: document.querySelector(".tr-ft .tr-fail").textContent }`);
		expect(s.pos).toBe("1/3");
		expect(s.done).toContain("0건");
		expect(s.off).toBe(false);
		expect(s.chip).toBe(true);
		expect(s.fail).toContain("fail-text");
		await run(v, `document.querySelector(".tr-go").click()`);
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "2/3"`);
		expect(reqs).toHaveLength(2);
	});

	// A repaint is held while a field is typed in, but never one that moves to another card: the next press must answer the card on screen.
	test("Cmd+Enter in a card's text sends it and draws the next card, so the next press answers the card on screen", async () => {
		await boot(v);
		const press = () => run(v, `const t = document.querySelector(".tr-ta"); t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }))`);
		await press();
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "2/3" && document.querySelector(".tr-ta").value === "준비 중이에요."`);
		await arrived(1);
		await press();
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "3/3"`);
		await arrived(2);
		expect(reqs.map(r => (r.body!.items as { ref: string }[])[0]!.ref)).toEqual(["Dxyz789", "Dabc234"]);
	});
});
