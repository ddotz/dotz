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
			return { ctx: ctx.textContent, mark: ctx.querySelector(".tag").textContent, mail: document.querySelector('.tr-sec[data-sec="to"]').textContent, files: document.querySelector('.tr-sec[data-sec="att"] .dr-att .dr-fn').textContent + " (" + document.querySelector('.tr-sec[data-sec="att"] .dr-att .dr-fm').textContent + ")",
				order: !!(ctx.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING), buttons: [...document.querySelectorAll(".tr-acts .tr-b")].map(b => b.textContent) }`);
		expect(s.ctx).toContain("첫 번째 영상");
		expect(s.ctx).toContain("김민영-x9b");
		expect(s.ctx).toContain("10. 22. 오후 12:00");
		expect(s.ctx).toContain("문서 파일을 보내 주실 수 있을까요?");
		expect(s.mark).toBe("메일 초안 작성됨");
		expect(s.mail).toContain("kim@example.com");
		expect(s.files).toBe("독서3부.pdf (PDF · 1.2MB)");
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
		await waitFor(v, `document.querySelector('.tr-sec[data-sec="org"] .rq-ot') && document.querySelector('.tr-sec[data-sec="org"] .rq-ot').textContent.includes("문서를 받을 수 있을까요?")`);
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

// The four labelled parts of every card (30-triage.js trSec) and the richer list rows, against their own stub: a mail with two files, a comment, a mail with no file and
// no original, a mail whose address and file name are very long, and a mail whose words promise a file that is not there.
const LONG_TO = "very.long.recipient.address.that.keeps.going.and.going.and.going@extremely-long-domain-name-for-the-narrow-screen.example.com";
const LONG_FILE = "아주-긴-파일-이름-아주-긴-파일-이름-아주-긴-파일-이름-아주-긴-파일-이름-2026-분기-정산-최종-최종-수정본.pdf";
const mailCard = (ref: string, extra: Record<string, unknown>, draft: Record<string, unknown>) => ({ ref, to: "main", group: "i:mail", sendable: true, kind: "mail", info: [], question: `이 메일 답장을 보낼까요? (${ref})`, draft: { toLabel: "받는이", ...draft }, ...extra });
const CARDS2 = [
	mailCard("Rm1", { original: { from: "Sora Kim <sora@example.com>", at, subject: "견적 문의", text: "견적서를 보내 주실 수 있을까요?\n수량은 30개예요.", files: 0 }, account: { label: "업무 메일", many: true }, thread: { earlier: 2, newer: true } },
		{ to: "sora@example.com", cc: ["lee@example.com"], subject: "Re: 견적 문의", body: "견적서를 붙였어요.", rule: "견적 답장", attachments: [{ name: "견적서.pdf", size: "820KB" }, { name: "사양.xlsx", size: "42KB" }] }),
	mailCard("Rm2", {}, { to: "new@example.com", subject: "인사드립니다", body: "처음 연락드려요." }),
	mailCard("Rm3", { original: { from: LONG_TO, at, text: "긴 주소로 온 메일이에요.", files: 0 } }, { to: LONG_TO, subject: "Re: 긴 주소", body: "확인했어요.", attachments: [{ name: LONG_FILE, size: "2MB" }] }),
	mailCard("Rm4", { original: { from: "Sora Kim <sora@example.com>", at, text: "자료 부탁드려요.", cut: true, files: 0 } }, { to: "sora@example.com", subject: "Re: 자료", body: "자료를 첨부했어요.", attachIssues: ["본문에는 첨부했다고 쓰였는데 붙은 파일이 없어요"] }),
	{ ref: "Dc1", to: "main", group: "i:youtube", sendable: true, kind: "comment", comment: { ...COMMENT, mailMark: undefined }, info: [], question: "이 답글 올릴까요? (Dc1)", draft: { toLabel: "대상", to: "김민영-x9b 댓글", body: "고맙습니다." } },
];
const GROUPS2 = [{ key: "i:mail", label: "메일", count: 4, cards: CARDS2.slice(0, 4) }, { key: "i:youtube", label: "유튜브", count: 1, cards: [CARDS2[4]] }];
let reqs2: Req[] = [];
const hub2 = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		const p = url.pathname, m = /^\/api\/drafts\/(\w+)\/files$/.exec(p);
		if (p === "/api/approvals" && req.method === "GET") return json({ groups: GROUPS2, results: [], triageMin: 1 });
		if (p === "/api/approvals" && req.method === "POST") { reqs2.push({ method: "POST", path: p, body: (await req.json()) as Record<string, unknown> }); return json({ ok: true, sending: 1, toBot: 0 }); }
		if (m) return json({ files: (CARDS2.find(c => c.ref === m[1])!.draft as { attachments?: unknown[] }).attachments ?? [], tracked: true, editable: false, canAttach: false, library: false });
		if (p === "/api/drafts/Rm4/original") return json({ kind: "mail", from: "Sora Kim <sora@example.com>", text: "자료 부탁드려요.\n공유 폴더에 올려 주세요." });
		if (/^\/api\/drafts\/\w+\/original$/.test(p)) return json({ error: "no original" }, 404);
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/replies") return json({ items: [], failed: [], sent: [], stops: {} });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/integrations") return json({ items: [] });
	},
});
afterAll(() => { hub2.stop(); });
beforeEach(() => { reqs2 = []; });
const boot2 = async (v: View, list = false) => {
	const opened = hub2.nextStream();
	await v.navigate(`${hub2.origin}/`);
	await opened;
	await waitFor(v, `typeof TR !== "undefined" && S`);
	await run(v, `trLoad()`);
	await waitFor(v, `TR.groups.length === 2`);
	await run(v, `trOpen("*"); TR.list = ${list}; trPaint()`);
	await waitFor(v, `TR.h && document.querySelector(".tr .tr-body")`);
};
const showCard = async (v: View, i: number) => {
	await run(v, `TR.i = ${i}; TR.list = false; trPaint()`);
	await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "${i + 1}/5"`);
};
type Sec = { name: string; label: string; text: string };
const secs = (v: View) => q<Sec[]>(v, `return [...document.querySelectorAll(".tr-body .tr-sec")].map(s => ({ name: s.dataset.sec, label: s.firstChild.textContent, text: s.textContent }))`);
const LABELS = ["받는 사람", "원본", "답장", "첨부"];
// A question asked while the 빠른 처리 screen is open is drawn inside it (confirmInSheet, 02-basic-markdown.js), not as a separate <dialog>: its buttons sit in .dact.
const CF = ".dact";
const cfBtn = (label: string) => `[...document.querySelectorAll(${JSON.stringify(CF)})].flatMap(a => [...a.querySelectorAll("button")]).find(b => b.textContent === ${JSON.stringify(label)})`;
const secText = (all: Sec[], name: string) => all.find(s => s.name === name)!.text;

describe("빠른 처리 card parts", async () => {
	const v = await hub2.view({ width: 1280, height: 900 });

	test("a mail reply with two files shows 받는 사람, 원본, 답장, 첨부 in that order, each with what the owner decides on", async () => {
		await boot2(v);
		await waitFor(v, `document.querySelectorAll('.tr-sec[data-sec="att"] a.dr-att').length === 2`);
		const all = await secs(v);
		expect(all.map(s => s.label)).toEqual(LABELS);
		expect(all.map(s => s.name)).toEqual(["to", "org", "reply", "att"]);
		expect(secText(all, "to")).toContain("sora@example.com");
		expect(secText(all, "to")).toContain("lee@example.com");
		expect(secText(all, "to")).toContain("Re: 견적 문의");
		expect(secText(all, "to")).toContain("업무 메일");
		expect(secText(all, "org")).toContain("Sora Kim");
		expect(secText(all, "org")).toContain("견적서를 보내 주실 수 있을까요?");
		expect(secText(all, "org")).toContain("새 메시지가 왔어요");
		expect(secText(all, "org")).toContain("앞선 메시지가 2개");
		expect(secText(all, "reply")).toContain("견적 답장");
		expect(await q<string>(v, `return document.querySelector('.tr-sec[data-sec="reply"] .tr-ta').value`)).toBe("견적서를 붙였어요.");
		const rows = await q<{ name: string; meta: string; href: string }[]>(v, `return [...document.querySelectorAll('.tr-sec[data-sec="att"] a.dr-att')].map(a => ({ name: a.querySelector(".dr-fn").textContent, meta: a.querySelector(".dr-fm").textContent, href: a.getAttribute("href") }))`);
		expect(rows.map(r => r.name)).toEqual(["견적서.pdf", "사양.xlsx"]);
		expect(rows.map(r => r.meta)).toEqual(["PDF · 820KB", "XLSX · 42KB"]);
		expect(rows[0]!.href).toContain("/api/drafts/Rm1/files/0");
		expect(await q<number>(v, `return document.querySelectorAll(".tr-body .tr-file").length`)).toBe(0);
	});

	test("a comment reply has the same four labels in the same order: the post and the comment it answers, the reply, and 첨부: 없음", async () => {
		await boot2(v);
		await showCard(v, 4);
		const all = await secs(v);
		expect(all.map(s => s.label)).toEqual(LABELS);
		expect(secText(all, "to")).toContain("김민영-x9b 댓글");
		expect(secText(all, "to")).toContain("첫 번째 영상");
		expect(secText(all, "org")).toContain("김민영-x9b");
		expect(secText(all, "org")).toContain("문서 파일을 보내 주실 수 있을까요?");
		expect(await q<string>(v, `return document.querySelector('.tr-sec[data-sec="reply"] .tr-ta').value`)).toBe("고맙습니다.");
		expect(secText(all, "att")).toContain("첨부: 없음");
	});

	test("a mail with no file says so, and a card with no original says so in one muted line", async () => {
		await boot2(v);
		await showCard(v, 1);
		await waitFor(v, `document.querySelector('.tr-sec[data-sec="org"] .tr-none') && document.querySelector('.tr-sec[data-sec="org"] .tr-none').textContent.includes("원본이 없어요")`);
		const all = await secs(v);
		expect(all.map(s => s.label)).toEqual(LABELS);
		expect(secText(all, "org")).toBe("원본답하는 원본이 없어요");
		expect(secText(all, "att")).toContain("첨부: 없음");
		expect(await q<number>(v, `return document.querySelectorAll('.tr-sec[data-sec="org"] .rq-orig').length`)).toBe(0);
	});

	test("the reason behind 확인이 필요해요 is visible text on the card and on its list row, not only a tooltip", async () => {
		await boot2(v);
		await showCard(v, 1);
		const why = "보냈는지 확인하지 못했어요";
		await run(v, `const c = TR.items[TR.i]; TR.done[trK(c)] = { state: "send", at: Date.now() }; trLive({ ref: c.ref, state: "unsure", text: ${JSON.stringify(why)}, at: Date.now() })`);
		await waitFor(v, `document.querySelector(".tr-why:not([hidden])")`);
		expect(await q<string>(v, `return document.querySelector(".tr-body .tr-why").textContent`)).toBe(why);
		await run(v, "TR.list = true; trPaint()");
		await waitFor(v, `document.querySelector(".tr-row .tr-why:not([hidden])")`);
		expect(await q<string>(v, `return document.querySelector(".tr-row .tr-why:not([hidden])").textContent`)).toBe(why);
	});

	test("a long mail arrives as its start in the list call and the card reads the whole text when it opens", async () => {
		await boot2(v);
		await showCard(v, 3);
		await waitFor(v, `document.querySelector('.tr-sec[data-sec="org"]').textContent.includes("공유 폴더에 올려 주세요.")`);
		expect(secText(await secs(v), "org")).not.toContain("앞부분만 보여요");
	});

	test("the warning that refuses 보내기 shows here with the same words, and 보내기 asks the same question: no leaves the card, yes sends 이대로 보내기", async () => {
		await boot2(v);
		await showCard(v, 3);
		expect(secText(await secs(v), "att")).toContain("본문에는 첨부했다고 쓰였는데 붙은 파일이 없어요");
		expect(await q<string>(v, `return document.querySelector('.tr-sec[data-sec="att"] .dr-warn').textContent`)).toContain("첨부 확인");
		const dialogBtn = cfBtn;
		await run(v, `document.querySelector(".tr-go").click()`);
		await waitFor(v, `${dialogBtn("이대로 보내기")}`);
		expect(await q<string>(v, `return document.querySelector(${JSON.stringify(CF)}).parentElement.textContent`)).toContain("본문에는 첨부했다고 쓰였는데 붙은 파일이 없어요");
		await run(v, `${dialogBtn("취소")}.click()`);
		await waitFor(v, `!document.querySelector(${JSON.stringify(CF)})`);
		expect(reqs2).toHaveLength(0);
		expect(await pos(v)).toBe("4/5");
		await run(v, `document.querySelector(".tr-go").click()`);
		await waitFor(v, `${dialogBtn("이대로 보내기")}`);
		await run(v, `${dialogBtn("이대로 보내기")}.click()`);
		await waitFor(v, `document.querySelector(".tr-pos").firstChild.textContent === "5/5"`);
		expect(reqs2.map(r => r.body)).toEqual([{ items: [{ ref: "Rm4", to: "main", n: 4, label: "이대로 보내기" }] }]);
	});

	test("in the list a row can be answered without opening it: recipient, two lines of the original that open on a press, the reply and the file names", async () => {
		await boot2(v, true);
		const rows = await q<{ head: string; org: string; orgClamp: boolean; body: string; files: string[]; none: string }[]>(v, `return [...document.querySelectorAll(".tr-row")].map(r => ({ head: r.querySelector(".tr-rq").textContent, org: (r.querySelector(".rq-ot") || {}).textContent || "", orgClamp: !!r.querySelector(".rq-orig.clamp"), body: r.querySelector(".tr-rb").textContent, files: [...r.querySelectorAll(".tr-file")].map(f => f.textContent), none: (r.querySelector(".tr-none") || {}).textContent || "" }))`);
		expect(rows).toHaveLength(5);
		expect(rows[0]!.head).toContain("sora@example.com");
		expect(rows[0]!.org).toContain("견적서를 보내 주실 수 있을까요?");
		expect(rows[0]!.orgClamp).toBe(true);
		expect(rows[0]!.body).toContain("견적서를 붙였어요.");
		expect(rows[0]!.files).toEqual(["견적서.pdf (820KB)", "사양.xlsx (42KB)"]);
		expect(rows[4]!.org).toContain("문서 파일을 보내 주실 수 있을까요?");
		expect(rows[4]!.none).toBe("첨부 없음");
		expect(rows[3]!.org).not.toContain("공유 폴더");
		await run(v, `document.querySelectorAll(".tr-row")[3].querySelector(".rq-orig").click()`);
		await waitFor(v, `document.querySelectorAll(".tr-row")[3].querySelector(".rq-ot").textContent.includes("공유 폴더에 올려 주세요.")`);
		await run(v, `document.querySelector(".tr-row .rq-orig").click()`);
		await waitFor(v, `!document.querySelector(".tr-row .rq-orig").classList.contains("clamp")`);
		expect(await q<string>(v, `return document.querySelector(".tr-row .rq-ot").textContent`)).toContain("수량은 30개예요.");
	});

	test("in the list, 보내기 on a card with a refused attachment asks first, and a yes sends it as 이대로 보내기", async () => {
		await boot2(v, true);
		await run(v, `document.querySelectorAll(".tr-row")[3].querySelector('.tr-sg[role="radio"]').click()`);
		await waitFor(v, `document.querySelectorAll(".tr-row")[3].querySelector(".tr-sg.on") && !document.querySelector(".tr-batch").disabled`);
		await run(v, `document.querySelector(".tr-batch").click()`);
		await waitFor(v, cfBtn("이대로 보내기"));
		await run(v, `${cfBtn("이대로 보내기")}.click()`);
		await waitFor(v, `document.querySelectorAll(".tr-row.locked").length === 1`);
		expect(reqs2.map(r => r.body)).toEqual([{ items: [{ ref: "Rm4", to: "main", n: 4, label: "이대로 보내기" }] }]);
	});
});

describe("빠른 처리 card parts at 390", async () => {
	const v = await hub2.view({ width: 390, height: 844 });
	const inside = (sel: string) => q<{ over: string[]; body: number }>(v, `const w = document.querySelector(".tr-body"), r = w.getBoundingClientRect(), over = [...w.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getBoundingClientRect().right > r.right + 0.5).map(e => e.className); return { over, body: w.scrollWidth - w.clientWidth }`);

	test("a very long recipient and a very long file name stay inside the screen on a card", async () => {
		await boot2(v);
		await showCard(v, 2);
		await waitFor(v, `document.querySelector('.tr-sec[data-sec="att"] a.dr-att')`);
		const r = await inside(".dr-chip, .dr-att, .dr-fn, .rq-orig, .dr-sub");
		expect(r.over).toEqual([]);
		expect(r.body).toBeLessThanOrEqual(0);
		expect(await q<string>(v, `return document.querySelector('.tr-sec[data-sec="att"] .dr-fn').textContent`)).toBe(LONG_FILE);
	});

	test("and in the list", async () => {
		await boot2(v, true);
		const r = await inside(".tr-rq, .tr-file, .rq-orig, .tr-files");
		expect(r.over).toEqual([]);
		expect(r.body).toBeLessThanOrEqual(0);
	});
});
